import { describe, expect, it, vi } from 'vitest';
import type { EvaluateActionRequest, EvaluateActionResponse, LogEventRequest } from '@velor/schema';
import type { VelorClient } from './client.js';
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
  } as unknown as VelorClient;

  return { client, events, evaluations };
}

describe('runTool', () => {
  it('returns allowed + logs action_executed on a successful execute', async () => {
    const { client, events } = makeFakeClient({
      decision: 'allow',
      matched_policy_id: null,
      modifications: null,
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
