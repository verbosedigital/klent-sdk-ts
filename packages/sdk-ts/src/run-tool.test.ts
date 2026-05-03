import { describe, expect, it, vi } from 'vitest';
import type {
  EvaluateActionRequest,
  EvaluateActionResponse,
  LogEventRequest,
  PendingAction,
} from '@klent/schema';
import type { KlentClient } from './client.js';
import { runTool } from './run-tool.js';

function makeFakeClient(decision: EvaluateActionResponse) {
  const events: LogEventRequest[] = [];
  const evaluations: EvaluateActionRequest[] = [];

  const client = {
    logEvent: (body: LogEventRequest) => {
      events.push(body);
    },
    evaluateAction: vi.fn(async (body: EvaluateActionRequest) => {
      evaluations.push(body);
      return decision;
    }),
  } as unknown as KlentClient;

  return { client, events, evaluations };
}

/** Stub a client that scripts a sequence of pending-action poll responses. */
function makeFakePollingClient(decision: EvaluateActionResponse, pollResponses: PendingAction[]) {
  const events: LogEventRequest[] = [];
  const evaluations: EvaluateActionRequest[] = [];
  const polls: Array<{ id: string; waitMs: number }> = [];
  let pollIdx = 0;

  const client = {
    logEvent: (body: LogEventRequest) => {
      events.push(body);
    },
    evaluateAction: vi.fn(async (body: EvaluateActionRequest) => {
      evaluations.push(body);
      return decision;
    }),
    getPendingAction: vi.fn(async (id: string, opts: { waitMs?: number } = {}) => {
      polls.push({ id, waitMs: opts.waitMs ?? 0 });
      const next = pollResponses[pollIdx] ?? pollResponses[pollResponses.length - 1];
      pollIdx++;
      if (!next) throw new Error('no scripted poll response');
      return next;
    }),
  } as unknown as KlentClient;

  return { client, events, evaluations, polls };
}

describe('runTool', () => {
  it('returns allowed + logs action_executed on a successful execute', async () => {
    const { client, events } = makeFakeClient({
      decision: 'allow',
      matched_policy_id: null,
      modifications: null,
      redirect_to: null,
      pending_action_id: null,
      reason: null,
    });

    const result = await runTool(client, {
      execution_id: 'exec_1',
      tool: 'send_email',
      input: { to: 'a@b.com' },
      execute: () => 'ok',
    });

    expect(result.status).toBe('allowed');
    if (result.status === 'allowed') expect(result.output).toBe('ok');
    expect(events.map((e) => e.type)).toEqual(['action_requested', 'action_executed']);
  });

  it('returns denied and never calls execute', async () => {
    const execute = vi.fn(() => 'should not run');
    const { client, events } = makeFakeClient({
      decision: 'deny',
      matched_policy_id: 'pol_1',
      modifications: null,
      redirect_to: null,
      pending_action_id: null,
      reason: 'Blocked by test',
    });

    const result = await runTool(client, {
      execution_id: 'exec_1',
      tool: 'dangerous',
      input: {},
      execute,
    });

    expect(result.status).toBe('denied');
    if (result.status === 'denied') {
      expect(result.reason).toBe('Blocked by test');
      expect(result.matchedPolicyId).toBe('pol_1');
    }
    expect(execute).not.toHaveBeenCalled();
    // Only action_requested is logged by the client; action_blocked is server-side.
    expect(events.map((e) => e.type)).toEqual(['action_requested']);
  });

  it('applies modifications before execute on modify effect', async () => {
    const received: Record<string, unknown> = {};
    const { client } = makeFakeClient({
      decision: 'modify',
      matched_policy_id: 'pol_mod',
      modifications: [
        { field: 'cc', value: 'audit@example.com' },
        { field: 'headers.X-Audit', value: 'on' },
      ],
      redirect_to: null,
      pending_action_id: null,
      reason: null,
    });

    await runTool(client, {
      execution_id: 'exec_1',
      tool: 'send_email',
      input: { to: 'a@b.com', headers: {} },
      execute: (input) => {
        Object.assign(received, input);
        return 'sent';
      },
    });

    expect(received.to).toBe('a@b.com');
    expect(received.cc).toBe('audit@example.com');
    expect(received.headers).toEqual({ 'X-Audit': 'on' });
  });

  it('does not mutate the caller-provided input on modify', async () => {
    const { client } = makeFakeClient({
      decision: 'modify',
      matched_policy_id: 'pol_mod',
      modifications: [{ field: 'cc', value: 'audit@example.com' }],
      redirect_to: null,
      pending_action_id: null,
      reason: null,
    });

    const callerInput = { to: 'a@b.com' };
    await runTool(client, {
      execution_id: 'exec_1',
      tool: 'send_email',
      input: callerInput,
      execute: () => 'ok',
    });

    expect(callerInput).toEqual({ to: 'a@b.com' });
  });

  it('returns error and logs error event on thrown execute', async () => {
    const { client, events } = makeFakeClient({
      decision: 'allow',
      matched_policy_id: null,
      modifications: null,
      redirect_to: null,
      pending_action_id: null,
      reason: null,
    });

    const result = await runTool(client, {
      execution_id: 'exec_1',
      tool: 'flaky',
      input: {},
      execute: () => {
        throw new Error('boom');
      },
    });

    expect(result.status).toBe('error');
    if (result.status === 'error') {
      expect(result.error).toBeInstanceOf(Error);
      expect((result.error as Error).message).toBe('boom');
    }
    expect(events.map((e) => e.type)).toEqual(['action_requested', 'error']);
  });

  it('forwards metadata to every event and evaluation', async () => {
    const { client, events, evaluations } = makeFakeClient({
      decision: 'allow',
      matched_policy_id: null,
      modifications: null,
      redirect_to: null,
      pending_action_id: null,
      reason: null,
    });

    await runTool(client, {
      execution_id: 'exec_1',
      tool: 'x',
      input: {},
      execute: () => null,
      metadata: { tenant: 'acme' },
    });

    for (const evt of events) expect(evt.metadata).toEqual({ tenant: 'acme' });
    for (const evaluation of evaluations) expect(evaluation.metadata).toEqual({ tenant: 'acme' });
  });
});

describe('runTool — steer', () => {
  it('runs the redirected tool with the redirect_to.input', async () => {
    let receivedTool: string | null = null;
    let receivedInput: unknown = null;
    const { client } = makeFakeClient({
      decision: 'steer',
      matched_policy_id: 'pol_steer',
      modifications: null,
      redirect_to: { tool: 'send_via_audit', input: { to: 'a@b.com', audit: true } },
      pending_action_id: null,
      reason: 'redirected',
    });

    const result = await runTool(client, {
      execution_id: 'exec_1',
      tool: 'send_email',
      input: { to: 'a@b.com' },
      execute: () => 'should not run for original tool',
      executeSteered: (tool, input) => {
        receivedTool = tool;
        receivedInput = input;
        return 'sent_via_audit';
      },
    });

    expect(result.status).toBe('allowed');
    if (result.status === 'allowed') expect(result.output).toBe('sent_via_audit');
    expect(receivedTool).toBe('send_via_audit');
    expect(receivedInput).toEqual({ to: 'a@b.com', audit: true });
  });

  it('falls back to execute() with steered input when no executeSteered is provided', async () => {
    let receivedInput: unknown = null;
    const { client } = makeFakeClient({
      decision: 'steer',
      matched_policy_id: 'pol_steer',
      modifications: null,
      redirect_to: { tool: 'doesnt_matter', input: { x: 42 } },
      pending_action_id: null,
      reason: null,
    });

    await runTool(client, {
      execution_id: 'exec_1',
      tool: 'orig',
      input: { x: 1 },
      execute: (input) => {
        receivedInput = input;
        return 'ok';
      },
    });
    expect(receivedInput).toEqual({ x: 42 });
  });

  it('returns error when steer decision lacks redirect_to (server bug)', async () => {
    const { client } = makeFakeClient({
      decision: 'steer',
      matched_policy_id: 'pol_steer',
      modifications: null,
      redirect_to: null,
      pending_action_id: null,
      reason: null,
    });
    const result = await runTool(client, {
      execution_id: 'exec_1',
      tool: 'x',
      input: {},
      execute: () => 'ok',
    });
    expect(result.status).toBe('error');
  });
});

describe('runTool — approve', () => {
  it('returns pending immediately when approval.wait is omitted', async () => {
    const execute = vi.fn(() => 'should not run');
    const { client } = makeFakeClient({
      decision: 'approve',
      matched_policy_id: 'pol_hitl',
      modifications: null,
      redirect_to: null,
      pending_action_id: 'pact_1',
      reason: 'Needs human review',
    });

    const result = await runTool(client, {
      execution_id: 'exec_1',
      tool: 'transfer_funds',
      input: { amount: 9000 },
      execute,
    });

    expect(result.status).toBe('pending');
    if (result.status === 'pending') {
      expect(result.pendingActionId).toBe('pact_1');
      expect(result.reason).toBe('Needs human review');
    }
    expect(execute).not.toHaveBeenCalled();
  });

  it('runs the tool when wait resolves with approved', async () => {
    const approvedRow: PendingAction = {
      id: 'pact_1',
      project_id: 'proj_x',
      execution_id: 'exec_1',
      event_id: 'evt_1',
      tool: 'transfer_funds',
      input: { amount: 9000 },
      metadata: {},
      status: 'approved',
      matched_policy_id: 'pol_hitl',
      reason: 'Needs human review',
      modifications: null,
      requested_at: new Date().toISOString(),
      expires_at: null,
      resolved_at: new Date().toISOString(),
      resolved_by_user_id: 'user_1',
      resolution_note: 'looks fine',
    };
    const { client } = makeFakePollingClient(
      {
        decision: 'approve',
        matched_policy_id: 'pol_hitl',
        modifications: null,
        redirect_to: null,
        pending_action_id: 'pact_1',
        reason: 'Needs human review',
      },
      [approvedRow],
    );

    const result = await runTool(client, {
      execution_id: 'exec_1',
      tool: 'transfer_funds',
      input: { amount: 9000 },
      execute: () => 'transferred',
      approval: { wait: { timeoutMs: 5000, useLongPoll: true } },
    });

    expect(result.status).toBe('allowed');
    if (result.status === 'allowed') expect(result.output).toBe('transferred');
  });

  it('applies resolver-staged modifications before executing', async () => {
    let executedWith: unknown = null;
    const approvedRow: PendingAction = {
      id: 'pact_1',
      project_id: 'proj_x',
      execution_id: 'exec_1',
      event_id: null,
      tool: 'transfer_funds',
      input: { amount: 9000, to: 'acct_a' },
      metadata: {},
      status: 'approved',
      matched_policy_id: 'pol_hitl',
      reason: null,
      modifications: [{ field: 'amount', value: 5000 }],
      requested_at: new Date().toISOString(),
      expires_at: null,
      resolved_at: new Date().toISOString(),
      resolved_by_user_id: 'user_1',
      resolution_note: 'capped at 5k',
    };
    const { client } = makeFakePollingClient(
      {
        decision: 'approve',
        matched_policy_id: 'pol_hitl',
        modifications: null,
        redirect_to: null,
        pending_action_id: 'pact_1',
        reason: null,
      },
      [approvedRow],
    );

    await runTool(client, {
      execution_id: 'exec_1',
      tool: 'transfer_funds',
      input: { amount: 9000, to: 'acct_a' },
      execute: (input) => {
        executedWith = input;
        return 'ok';
      },
      approval: { wait: { timeoutMs: 5000 } },
    });
    expect(executedWith).toEqual({ amount: 5000, to: 'acct_a' });
  });

  it('returns denied when wait resolves with rejected', async () => {
    const rejectedRow: PendingAction = {
      id: 'pact_1',
      project_id: 'proj_x',
      execution_id: 'exec_1',
      event_id: null,
      tool: 'transfer_funds',
      input: {},
      metadata: {},
      status: 'rejected',
      matched_policy_id: 'pol_hitl',
      reason: null,
      modifications: null,
      requested_at: new Date().toISOString(),
      expires_at: null,
      resolved_at: new Date().toISOString(),
      resolved_by_user_id: 'user_1',
      resolution_note: 'too risky',
    };
    const { client } = makeFakePollingClient(
      {
        decision: 'approve',
        matched_policy_id: 'pol_hitl',
        modifications: null,
        redirect_to: null,
        pending_action_id: 'pact_1',
        reason: null,
      },
      [rejectedRow],
    );

    const result = await runTool(client, {
      execution_id: 'exec_1',
      tool: 'transfer_funds',
      input: {},
      execute: () => 'never runs',
      approval: { wait: { timeoutMs: 5000 } },
    });
    expect(result.status).toBe('denied');
    if (result.status === 'denied') expect(result.reason).toBe('too risky');
  });
});
