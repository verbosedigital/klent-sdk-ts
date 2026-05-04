import type { KlentClient } from './client.js';

export type RunToolArgs<T> = {
  execution_id: string;
  tool: string;
  input: Record<string, unknown>;
  /** Called only if Klent's policy engine allows (or modifies) the action. */
  execute: (input: Record<string, unknown>) => Promise<T> | T;
  /**
   * For `steer`: called instead of `execute` when the engine redirects to a
   * different tool. Receives `(toolName, input)` for the substitute call.
   *
   * If omitted, `runTool` falls back to `execute` with the steered input. That
   * works when your `execute` is a single dispatcher that switches on tool
   * name — but if `execute` is bound to one tool, provide this so the redirect
   * actually changes target.
   */
  executeSteered?: (tool: string, input: Record<string, unknown>) => Promise<T> | T;
  /** Optional metadata attached to every event emitted by this call. */
  metadata?: Record<string, unknown>;
  /**
   * How to handle an `approve` decision.
   *
   * - omitted (default): return immediately with `{ status: 'pending', … }`.
   *   Caller is responsible for polling or building UI around the pending id.
   * - `{ wait: { timeoutMs, pollMs? } }`: block until a human resolves the
   *   action via the dashboard, or the budget elapses. On approval the tool
   *   runs and returns `'allowed'`. On rejection it returns `'denied'`. On
   *   timeout it returns `'pending'`.
   */
  approval?: {
    wait: {
      timeoutMs: number;
      /** Client-side poll interval. Ignored when long-poll is used. */
      pollMs?: number;
      /**
       * If true (default), the SDK uses the server's long-poll mode
       * (`?wait_ms=…`) to minimise round-trips. Set false for environments
       * (serverless, edge) where long-running connections are expensive.
       */
      useLongPoll?: boolean;
    };
  };
};

export type RunToolResult<T> =
  | { status: 'allowed'; output: T; matchedPolicyId: string | null }
  | { status: 'denied'; reason: string; matchedPolicyId: string }
  | {
      /** `approve` decision; caller did not opt into `wait` (or it timed out). */
      status: 'pending';
      pendingActionId: string;
      reason: string;
      matchedPolicyId: string | null;
    }
  | { status: 'error'; error: unknown };

/**
 * Wrap a single tool call with the full Klent decision loop:
 *   action_requested → evaluate → (action_executed | action_blocked) → error?
 *
 * Callers get one decision back instead of writing the five-step boilerplate by
 * hand. Works with any agent framework — pass whatever tool function you
 * already have to `execute`.
 */
export async function runTool<T>(
  klent: KlentClient,
  args: RunToolArgs<T>,
): Promise<RunToolResult<T>> {
  const { execution_id, tool, input, execute, executeSteered, metadata, approval } = args;

  klent.logEvent({
    execution_id,
    type: 'action_requested',
    payload: { tool, input },
    tool,
    metadata,
  });

  const decision = await klent.evaluateAction({
    execution_id,
    tool,
    input,
    metadata,
  });

  if (decision.decision === 'deny') {
    return {
      status: 'denied',
      reason: decision.reason ?? 'Denied by policy',
      matchedPolicyId: decision.matched_policy_id ?? 'unknown',
    };
  }

  // Steer: swap the tool itself. We surface the substitution via an
  // action_steered event before executing, so the dashboard timeline shows
  // the redirect even if the run later fails.
  if (decision.decision === 'steer') {
    const redirect = decision.redirect_to;
    if (!redirect) {
      return {
        status: 'error',
        error: new Error('Klent returned steer decision without redirect_to'),
      };
    }
    return runExecution(
      klent,
      { execution_id, tool: redirect.tool, input: redirect.input, metadata },
      executeSteered
        ? () => executeSteered(redirect.tool, redirect.input)
        : () => execute(redirect.input),
      decision.matched_policy_id,
    );
  }

  // Approve: park the action. Either return pending immediately or block
  // until a human resolves it via the dashboard.
  if (decision.decision === 'approve') {
    const pendingId = decision.pending_action_id;
    if (!pendingId) {
      return {
        status: 'error',
        error: new Error('Klent returned approve decision without pending_action_id'),
      };
    }

    if (!approval?.wait) {
      return {
        status: 'pending',
        pendingActionId: pendingId,
        reason: decision.reason ?? 'Awaiting human approval',
        matchedPolicyId: decision.matched_policy_id,
      };
    }

    const resolved = await waitForApproval(klent, pendingId, approval.wait);
    if (resolved.status === 'pending') {
      // Timed out — surface pending so caller can decide what to do.
      return {
        status: 'pending',
        pendingActionId: pendingId,
        reason: 'Approval wait timed out',
        matchedPolicyId: decision.matched_policy_id,
      };
    }
    if (resolved.status !== 'approved') {
      // rejected or expired — both block the action. note() is the human's
      // free-text reason from the dashboard, when present.
      return {
        status: 'denied',
        reason: resolved.note ?? `Approval ${resolved.status}`,
        matchedPolicyId: decision.matched_policy_id ?? 'unknown',
      };
    }
    // Approved — run with the input the resolver locked in (after applying
    // any modifications they staged). Falls back to the original input.
    const stagedMods = resolved.modifications;
    const finalInput =
      stagedMods && stagedMods.length > 0 ? applyModifications(input, stagedMods) : input;
    return runExecution(
      klent,
      { execution_id, tool, input: finalInput, metadata },
      () => execute(finalInput),
      decision.matched_policy_id,
    );
  }

  // Allow / modify: run the original tool, with modifications applied if any.
  const effectiveInput =
    decision.decision === 'modify' && decision.modifications
      ? applyModifications(input, decision.modifications)
      : input;

  return runExecution(
    klent,
    { execution_id, tool, input: effectiveInput, metadata },
    () => execute(effectiveInput),
    decision.matched_policy_id,
  );
}

/**
 * Execute the (possibly steered/modified) tool call, log the result event,
 * and translate exceptions into a structured error result. Shared between the
 * allow/modify path, the steer path, and the approved-after-wait path.
 */
async function runExecution<T>(
  klent: KlentClient,
  ctx: {
    execution_id: string;
    tool: string;
    input: Record<string, unknown>;
    metadata?: Record<string, unknown>;
  },
  invoke: () => Promise<T> | T,
  matchedPolicyId: string | null,
): Promise<RunToolResult<T>> {
  const start = performance.now();
  try {
    const output = await invoke();
    const duration_ms = Math.round(performance.now() - start);
    klent.logEvent({
      execution_id: ctx.execution_id,
      type: 'action_executed',
      payload: { tool: ctx.tool, output },
      duration_ms,
      tool: ctx.tool,
      metadata: ctx.metadata,
    });
    return { status: 'allowed', output, matchedPolicyId };
  } catch (err) {
    const duration_ms = Math.round(performance.now() - start);
    klent.logEvent({
      execution_id: ctx.execution_id,
      type: 'error',
      payload: {
        tool: ctx.tool,
        message: err instanceof Error ? err.message : String(err),
      },
      duration_ms,
      tool: ctx.tool,
      metadata: ctx.metadata,
    });
    return { status: 'error', error: err };
  }
}

type ApprovalOutcome =
  | { status: 'pending' }
  | { status: 'approved'; modifications: Array<{ field: string; value?: unknown }> | null }
  | { status: 'rejected' | 'expired'; note: string | null };

async function waitForApproval(
  klent: KlentClient,
  pendingId: string,
  cfg: { timeoutMs: number; pollMs?: number; useLongPoll?: boolean },
): Promise<ApprovalOutcome> {
  const useLongPoll = cfg.useLongPoll ?? true;
  const pollMs = cfg.pollMs ?? 1000;
  const deadline = Date.now() + cfg.timeoutMs;

  while (Date.now() < deadline) {
    const remaining = deadline - Date.now();
    // Server caps wait_ms at 30s — split a longer budget into chunks.
    const waitMs = useLongPoll ? Math.min(remaining, 30_000) : 0;
    const row = await klent.getPendingAction(pendingId, { waitMs });

    if (row.status === 'approved') {
      return { status: 'approved', modifications: row.modifications };
    }
    if (row.status === 'rejected' || row.status === 'expired') {
      return { status: row.status, note: row.resolution_note };
    }
    if (!useLongPoll) {
      // Client-side polling cadence.
      const remainingAfter = deadline - Date.now();
      if (remainingAfter <= 0) break;
      await sleep(Math.min(pollMs, remainingAfter));
    }
    // useLongPoll=true: server already waited; loop right back if budget left.
  }
  return { status: 'pending' };
}

function applyModifications(
  input: Record<string, unknown>,
  modifications: Array<{ field: string; value?: unknown }>,
): Record<string, unknown> {
  const next = structuredClone(input);
  for (const mod of modifications) {
    setByPath(next, mod.field, mod.value);
  }
  return next;
}

function setByPath(target: Record<string, unknown>, path: string, value: unknown): void {
  const parts = path.split('.');
  let cursor: Record<string, unknown> = target;
  for (let i = 0; i < parts.length - 1; i++) {
    const key = parts[i]!;
    const next = cursor[key];
    if (typeof next !== 'object' || next === null) {
      cursor[key] = {};
    }
    cursor = cursor[key] as Record<string, unknown>;
  }
  cursor[parts[parts.length - 1]!] = value;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
