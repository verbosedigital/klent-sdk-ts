import { describe, expect, it, vi } from 'vitest';
import type {
  EvaluateActionRequest,
  EvaluateActionResponse,
  Execution,
  LogEventRequest,
} from '@klent/schema';
import type { KlentClient } from './client.js';
import { runAnthropicAgent, type KlentTool } from './anthropic.js';

type ScriptedResponse = {
  stop_reason: 'end_turn' | 'tool_use' | 'max_tokens' | 'stop_sequence';
  content: Array<
    { type: 'text'; text: string } | { type: 'tool_use'; id: string; name: string; input: unknown }
  >;
};

function makeAnthropicStub(responses: ScriptedResponse[]) {
  let turn = 0;
  const snapshots: Array<{ messages: unknown[] }> = [];
  const create = vi.fn(async (args: { messages: unknown[] }) => {
    snapshots.push({ messages: JSON.parse(JSON.stringify(args.messages)) });
    const response = responses[turn];
    turn++;
    if (!response) throw new Error('No more scripted responses');
    return response;
  });
  const client = { messages: { create } } as unknown as Parameters<
    typeof runAnthropicAgent
  >[0]['client'];
  return { client, create, snapshots };
}

function makeVelorStub(decisions: EvaluateActionResponse[]) {
  const events: LogEventRequest[] = [];
  let decisionIdx = 0;
  const execution: Execution = {
    id: 'exec_test',
    project_id: 'proj_test',
    agent_id: 'test',
    status: 'running',
    started_at: '2026-04-18T00:00:00Z',
    ended_at: null,
    metadata: {},
  };
  const client = {
    startExecution: vi.fn(async () => execution),
    evaluateAction: vi.fn(async (_body: EvaluateActionRequest) => {
      const decision = decisions[decisionIdx] ?? {
        decision: 'allow',
        matched_policy_id: null,
        modifications: null,
        reason: null,
      };
      decisionIdx++;
      return decision;
    }),
    logEvent: (body: LogEventRequest) => {
      events.push(body);
    },
    flush: vi.fn(async () => {}),
  } as unknown as KlentClient;
  return { client, events };
}

describe('runAnthropicAgent', () => {
  it('runs a single-turn conversation with no tool calls', async () => {
    const { client: anthropic, create } = makeAnthropicStub([
      {
        stop_reason: 'end_turn',
        content: [{ type: 'text', text: 'Hello there' }],
      },
    ]);
    const { client: klent, events } = makeVelorStub([]);

    const result = await runAnthropicAgent({
      client: anthropic,
      klent,
      agentId: 'test',
      model: 'claude-test',
      tools: [],
      messages: [{ role: 'user', content: 'hi' }],
    });

    expect(create).toHaveBeenCalledTimes(1);
    expect(result.stopReason).toBe('end_turn');
    expect(result.finalText).toBe('Hello there');
    expect(result.turns).toBe(1);
    expect(events.map((e) => e.type)).toEqual(['decision']);
  });

  it('executes a tool and feeds the result back', async () => {
    const { client: anthropic } = makeAnthropicStub([
      {
        stop_reason: 'tool_use',
        content: [
          {
            type: 'tool_use',
            id: 'tu_1',
            name: 'get_weather',
            input: { city: 'Lisbon' },
          },
        ],
      },
      {
        stop_reason: 'end_turn',
        content: [{ type: 'text', text: "It's sunny in Lisbon." }],
      },
    ]);
    const { client: klent, events } = makeVelorStub([
      {
        decision: 'allow',
        matched_policy_id: null,
        modifications: null,
        redirect_to: null,
        pending_action_id: null,
        reason: null,
      },
    ]);

    const tools: KlentTool[] = [
      {
        name: 'get_weather',
        description: 'weather',
        input_schema: { type: 'object', properties: {} },
        handler: (input) => `Weather for ${String(input.city)}: sunny`,
      },
    ];

    const result = await runAnthropicAgent({
      client: anthropic,
      klent,
      agentId: 'test',
      model: 'claude-test',
      tools,
      messages: [{ role: 'user', content: 'weather in Lisbon' }],
    });

    expect(result.turns).toBe(2);
    expect(result.stopReason).toBe('end_turn');

    const eventTypes = events.map((e) => e.type);
    // decision (turn 1) + action_requested + action_executed + decision (turn 2)
    expect(eventTypes).toEqual(['decision', 'action_requested', 'action_executed', 'decision']);
  });

  it('surfaces Klent deny as an is_error tool_result to the model', async () => {
    const { client: anthropic, snapshots } = makeAnthropicStub([
      {
        stop_reason: 'tool_use',
        content: [
          {
            type: 'tool_use',
            id: 'tu_1',
            name: 'transfer',
            input: { amount: 50000 },
          },
        ],
      },
      {
        stop_reason: 'end_turn',
        content: [{ type: 'text', text: "I can't — that's too much." }],
      },
    ]);
    const { client: klent } = makeVelorStub([
      {
        decision: 'deny',
        matched_policy_id: 'pol_limit',
        modifications: null,
        redirect_to: null,
        pending_action_id: null,
        reason: 'Exceeds daily limit',
      },
    ]);

    const handler = vi.fn(() => 'ok');
    const tools: KlentTool[] = [
      {
        name: 'transfer',
        description: 'money',
        input_schema: { type: 'object', properties: {} },
        handler,
      },
    ];

    const result = await runAnthropicAgent({
      client: anthropic,
      klent,
      agentId: 'test',
      model: 'claude-test',
      tools,
      messages: [{ role: 'user', content: 'transfer 50k' }],
    });

    expect(handler).not.toHaveBeenCalled();

    // The second LLM call must have received a user message with the
    // deny-as-tool-result content.
    const secondCallArgs = snapshots[1] as {
      messages: Array<{ role: string; content: unknown }>;
    };
    const lastUserMessage = secondCallArgs.messages[secondCallArgs.messages.length - 1]!;
    expect(lastUserMessage.role).toBe('user');
    const toolResults = lastUserMessage.content as Array<{
      type: string;
      is_error?: boolean;
      content: string;
    }>;
    expect(toolResults[0]?.is_error).toBe(true);
    expect(toolResults[0]?.content).toContain('Blocked by Klent policy');
    expect(toolResults[0]?.content).toContain('Exceeds daily limit');

    expect(result.finalText).toBe("I can't — that's too much.");
  });

  it('returns "Unknown tool" result when the model asks for a tool not in the list', async () => {
    const { client: anthropic, snapshots } = makeAnthropicStub([
      {
        stop_reason: 'tool_use',
        content: [
          {
            type: 'tool_use',
            id: 'tu_1',
            name: 'ghost_tool',
            input: {},
          },
        ],
      },
      {
        stop_reason: 'end_turn',
        content: [{ type: 'text', text: 'done' }],
      },
    ]);
    const { client: klent } = makeVelorStub([]);

    await runAnthropicAgent({
      client: anthropic,
      klent,
      agentId: 'test',
      model: 'claude-test',
      tools: [],
      messages: [{ role: 'user', content: 'use a ghost tool' }],
    });

    const secondCallArgs = snapshots[1] as {
      messages: Array<{ role: string; content: unknown }>;
    };
    const lastUserMessage = secondCallArgs.messages[secondCallArgs.messages.length - 1]!;
    const toolResults = lastUserMessage.content as Array<{
      is_error?: boolean;
      content: string;
    }>;
    expect(toolResults[0]?.is_error).toBe(true);
    expect(toolResults[0]?.content).toContain('Unknown tool "ghost_tool"');
  });

  it('stops at maxTurns even if the model keeps asking for tools', async () => {
    const neverEndingResponses = Array.from({ length: 10 }, () => ({
      stop_reason: 'tool_use' as const,
      content: [
        {
          type: 'tool_use' as const,
          id: `tu_${Math.random()}`,
          name: 'noop',
          input: {},
        },
      ],
    }));
    const { client: anthropic, create } = makeAnthropicStub(neverEndingResponses);
    const { client: klent } = makeVelorStub([]);

    const result = await runAnthropicAgent({
      client: anthropic,
      klent,
      agentId: 'test',
      model: 'claude-test',
      tools: [
        {
          name: 'noop',
          description: 'noop',
          input_schema: { type: 'object', properties: {} },
          handler: () => 'ok',
        },
      ],
      messages: [{ role: 'user', content: 'go' }],
      maxTurns: 3,
    });

    expect(create).toHaveBeenCalledTimes(3);
    expect(result.turns).toBe(3);
  });
});
