import type { ArgusClient } from './client.js';

export type RunToolArgs<T> = {
  execution_id: string;
  tool: string;
  input: Record<string, unknown>;
  /** Called only if Argus's policy engine allows (or modifies) the action. */
  execute: (input: Record<string, unknown>) => Promise<T> | T;
  /** Optional metadata attached to every event emitted by this call. */
  metadata?: Record<string, unknown>;
};

export type RunToolResult<T> =
  | { status: 'allowed'; output: T; matchedPolicyId: string | null }
  | { status: 'denied'; reason: string; matchedPolicyId: string }
  | { status: 'error'; error: unknown };

/**
 * Wrap a single tool call with the full Argus decision loop:
 *   action_requested → evaluate → (action_executed | action_blocked) → error?
 *
 * Callers get one decision back instead of writing the five-step boilerplate by
 * hand. Works with any agent framework — pass whatever tool function you
 * already have to `execute`.
 */
export async function runTool<T>(
  argus: ArgusClient,
  args: RunToolArgs<T>,
): Promise<RunToolResult<T>> {
  const { execution_id, tool, input, execute, metadata } = args;

  argus.logEvent({
    execution_id,
    type: 'action_requested',
    payload: { tool, input },
    metadata,
  });

  const decision = await argus.evaluateAction({
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

  const effectiveInput =
    decision.decision === 'modify' && decision.modifications
      ? applyModifications(input, decision.modifications)
      : input;

  const start = performance.now();
  try {
    const output = await execute(effectiveInput);
    const duration_ms = Math.round(performance.now() - start);
    argus.logEvent({
      execution_id,
      type: 'action_executed',
      payload: { tool, output },
      duration_ms,
      metadata,
    });
    return {
      status: 'allowed',
      output,
      matchedPolicyId: decision.matched_policy_id,
    };
  } catch (err) {
    const duration_ms = Math.round(performance.now() - start);
    argus.logEvent({
      execution_id,
      type: 'error',
      payload: {
        tool,
        message: err instanceof Error ? err.message : String(err),
      },
      duration_ms,
      metadata,
    });
    return { status: 'error', error: err };
  }
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
