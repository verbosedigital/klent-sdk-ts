import type OpenAI from 'openai';
import type { ArgusClient } from './client.js';
import { runTool } from './run-tool.js';

export interface ArgusOpenAITool<TInput = Record<string, unknown>, TOutput = unknown> {
  name: string;
  description: string;
  /** JSON Schema describing the function arguments. */
  parameters: Record<string, unknown>;
  handler: (input: TInput) => Promise<TOutput> | TOutput;
}

export interface RunOpenAIAgentOptions {
  client: OpenAI;
  argus: ArgusClient;
  agentId: string;
  model: string;
  messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[];
  tools: ArgusOpenAITool[];
  maxTurns?: number;
  metadata?: Record<string, unknown>;
}

export interface RunOpenAIAgentResult {
  executionId: string;
  messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[];
  finishReason: string | null;
  finalText: string;
  turns: number;
}

/**
 * Full-loop orchestrator for OpenAI tool-use agents with Argus in the path.
 *
 * Uses chat.completions. For each turn:
 *  1. Calls `chat.completions.create` and logs a `decision` event.
 *  2. For each `tool_calls[]` entry, calls `argus.runTool` (request → evaluate
 *     → execute-or-block → log). Denials become `role: 'tool'` messages with
 *     the policy reason so the model can adjust its plan.
 *  3. Stops when the model returns without tool calls.
 */
export async function runOpenAIAgent(opts: RunOpenAIAgentOptions): Promise<RunOpenAIAgentResult> {
  const { client, argus, agentId, model, tools, maxTurns = 8, metadata } = opts;

  const execution = await argus.startExecution({
    agent_id: agentId,
    metadata: { ...metadata, model, tool_count: tools.length },
  });

  const toolDefinitions: OpenAI.Chat.Completions.ChatCompletionTool[] = tools.map((t) => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    },
  }));

  const toolIndex = new Map(tools.map((t) => [t.name, t]));
  const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [...opts.messages];

  let finishReason: string | null = null;
  let finalText = '';
  let turns = 0;

  for (let turn = 1; turn <= maxTurns; turn++) {
    turns = turn;

    const llmStart = performance.now();
    const response = await client.chat.completions.create({
      model,
      messages,
      tools: toolDefinitions,
    });
    const llmDurationMs = Math.round(performance.now() - llmStart);

    const choice = response.choices[0];
    if (!choice) break;

    finishReason = choice.finish_reason;
    const assistantMessage = choice.message;
    const text = assistantMessage.content ?? '';

    argus.logEvent({
      execution_id: execution.id,
      type: 'decision',
      payload: {
        turn,
        finish_reason: finishReason,
        text: text || undefined,
      },
      duration_ms: llmDurationMs,
      metadata,
    });

    messages.push(assistantMessage);

    const toolCalls = assistantMessage.tool_calls ?? [];
    if (toolCalls.length === 0) {
      finalText = text;
      break;
    }

    for (const call of toolCalls) {
      if (call.type !== 'function') continue;

      const tool = toolIndex.get(call.function.name);
      if (!tool) {
        messages.push({
          role: 'tool',
          tool_call_id: call.id,
          content: `Unknown tool "${call.function.name}"`,
        });
        continue;
      }

      let input: Record<string, unknown>;
      try {
        input = JSON.parse(call.function.arguments || '{}');
      } catch (err) {
        messages.push({
          role: 'tool',
          tool_call_id: call.id,
          content: `Invalid JSON arguments: ${err instanceof Error ? err.message : String(err)}`,
        });
        continue;
      }

      const result = await runTool(argus, {
        execution_id: execution.id,
        tool: call.function.name,
        input,
        metadata: { ...metadata, tool_call_id: call.id },
        execute: (effectiveInput) => tool.handler(effectiveInput),
      });

      let content: string;
      if (result.status === 'denied') {
        content = `Blocked by Argus policy: ${result.reason}`;
      } else if (result.status === 'error') {
        content = result.error instanceof Error ? result.error.message : String(result.error);
      } else {
        content = typeof result.output === 'string' ? result.output : JSON.stringify(result.output);
      }

      messages.push({
        role: 'tool',
        tool_call_id: call.id,
        content,
      });
    }
  }

  await argus.flush();

  return {
    executionId: execution.id,
    messages,
    finishReason,
    finalText,
    turns,
  };
}
