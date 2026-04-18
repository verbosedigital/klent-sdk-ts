import { describe, expect, it, vi } from 'vitest';
import type { EvaluateActionResponse, LogEventRequest, Execution } from '@velor/schema';
import type { VelorClient } from './client.js';
import { runOpenAIAgent, type VelorOpenAITool } from './openai.js';

type ScriptedChoice = {
  finish_reason: 'stop' | 'tool_calls' | 'length';
  message: {
    role: 'assistant';
    content: string | null;
    tool_calls?: Array<{
      id: string;
      type: 'function';
      function: { name: string; arguments: string };
    }>;
  };
};

function makeOpenAIStub(responses: Array<{ choices: ScriptedChoice[] }>) {
  let turn = 0;
  const snapshots: Array<{ messages: unknown[] }> = [];
  const create = vi.fn(async (args: { messages: unknown[] }) => {
    snapshots.push({ messages: JSON.parse(JSON.stringify(args.messages)) });
    const response = responses[turn];
    turn++;
    if (!response) throw new Error('No more scripted responses');
    return response;
  });
  const client = {
    chat: { completions: { create } },
  } as unknown as Parameters<typeof runOpenAIAgent>[0]['client'];
  return { client, create, snapshots };
}

function makeVelorStub(decisions: EvaluateActionResponse[] = []) {
  const events: LogEventRequest[] = [];
  let idx = 0;
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
    evaluateAction: vi.fn(async () => {
      const decision = decisions[idx] ?? {
        decision: 'allow',
        matched_policy_id: null,
        modifications: null,
        reason: null,
      };
      idx++;
      return decision;
    }),
    logEvent: (body: LogEventRequest) => events.push(body),
    flush: vi.fn(async () => {}),
  } as unknown as VelorClient;
  return { client, events };
}

describe('runOpenAIAgent', () => {
  it('single-turn without tool calls returns final text', async () => {
    const { client: openai } = makeOpenAIStub([
      {
        choices: [
          {
            finish_reason: 'stop',
            message: { role: 'assistant', content: 'Hi there' },
          },
        ],
      },
    ]);
    const { client: velor } = makeVelorStub();

    const result = await runOpenAIAgent({
      client: openai,
      velor,
      agentId: 'test',
      model: 'gpt-test',
      tools: [],
      messages: [{ role: 'user', content: 'hi' }],
    });

    expect(result.finishReason).toBe('stop');
    expect(result.finalText).toBe('Hi there');
    expect(result.turns).toBe(1);
  });

  it('executes a tool_call and continues', async () => {
    const { client: openai } = makeOpenAIStub([
      {
        choices: [
          {
            finish_reason: 'tool_calls',
            message: {
              role: 'assistant',
              content: null,
              tool_calls: [
                {
                  id: 'call_1',
                  type: 'function',
                  function: {
                    name: 'get_weather',
                    arguments: JSON.stringify({ city: 'Madrid' }),
                  },
                },
              ],
            },
          },
        ],
      },
      {
        choices: [
          {
            finish_reason: 'stop',
            message: { role: 'assistant', content: 'Clear in Madrid.' },
          },
        ],
      },
    ]);
    const { client: velor, events } = makeVelorStub([
      {
        decision: 'allow',
        matched_policy_id: null,
        modifications: null,
        reason: null,
      },
    ]);

    const tools: VelorOpenAITool[] = [
      {
        name: 'get_weather',
        description: 'weather',
        parameters: { type: 'object', properties: {} },
        handler: (input) => `Weather for ${String(input.city)}: clear`,
      },
    ];

    const result = await runOpenAIAgent({
      client: openai,
      velor,
      agentId: 'test',
      model: 'gpt-test',
      tools,
      messages: [{ role: 'user', content: 'weather' }],
    });

    expect(result.turns).toBe(2);
    expect(result.finishReason).toBe('stop');
    expect(events.map((e) => e.type)).toEqual([
      'decision',
      'action_requested',
      'action_executed',
      'decision',
    ]);
  });

  it('surfaces deny as a role:tool message with policy reason', async () => {
    const { client: openai, snapshots } = makeOpenAIStub([
      {
        choices: [
          {
            finish_reason: 'tool_calls',
            message: {
              role: 'assistant',
              content: null,
              tool_calls: [
                {
                  id: 'call_1',
                  type: 'function',
                  function: {
                    name: 'transfer',
                    arguments: JSON.stringify({ amount: 5e4 }),
                  },
                },
              ],
            },
          },
        ],
      },
      {
        choices: [
          {
            finish_reason: 'stop',
            message: { role: 'assistant', content: 'ok, not doing it.' },
          },
        ],
      },
    ]);
    const { client: velor } = makeVelorStub([
      {
        decision: 'deny',
        matched_policy_id: 'pol_cap',
        modifications: null,
        reason: 'Over the cap',
      },
    ]);

    const handler = vi.fn(() => 'ok');
    await runOpenAIAgent({
      client: openai,
      velor,
      agentId: 'test',
      model: 'gpt-test',
      tools: [
        {
          name: 'transfer',
          description: 'money',
          parameters: { type: 'object', properties: {} },
          handler,
        },
      ],
      messages: [{ role: 'user', content: 'transfer' }],
    });

    expect(handler).not.toHaveBeenCalled();

    const secondCallArgs = snapshots[1] as {
      messages: Array<{ role: string; content: string; tool_call_id?: string }>;
    };
    const lastMessage = secondCallArgs.messages[secondCallArgs.messages.length - 1]!;
    expect(lastMessage.role).toBe('tool');
    expect(lastMessage.tool_call_id).toBe('call_1');
    expect(lastMessage.content).toContain('Blocked by Velor policy');
    expect(lastMessage.content).toContain('Over the cap');
  });

  it('handles malformed tool_call arguments without crashing', async () => {
    const { client: openai, snapshots } = makeOpenAIStub([
      {
        choices: [
          {
            finish_reason: 'tool_calls',
            message: {
              role: 'assistant',
              content: null,
              tool_calls: [
                {
                  id: 'call_1',
                  type: 'function',
                  function: { name: 'get_weather', arguments: '{not-json}' },
                },
              ],
            },
          },
        ],
      },
      {
        choices: [
          {
            finish_reason: 'stop',
            message: { role: 'assistant', content: 'done' },
          },
        ],
      },
    ]);
    const { client: velor } = makeVelorStub([]);

    const result = await runOpenAIAgent({
      client: openai,
      velor,
      agentId: 'test',
      model: 'gpt-test',
      tools: [
        {
          name: 'get_weather',
          description: 'weather',
          parameters: { type: 'object', properties: {} },
          handler: () => 'sunny',
        },
      ],
      messages: [{ role: 'user', content: 'weather' }],
    });

    expect(result.finalText).toBe('done');
    const secondCallArgs = snapshots[1] as {
      messages: Array<{ role: string; content: string }>;
    };
    const lastMessage = secondCallArgs.messages[secondCallArgs.messages.length - 1]!;
    expect(lastMessage.role).toBe('tool');
    expect(lastMessage.content).toContain('Invalid JSON');
  });
});
