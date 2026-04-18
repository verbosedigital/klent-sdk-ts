import type Anthropic from '@anthropic-ai/sdk';
import type { VelorClient } from './client.js';
import { runTool } from './run-tool.js';

export interface VelorTool<TInput = Record<string, unknown>, TOutput = unknown> {
  name: string;
  description: string;
  input_schema: Anthropic.Tool.InputSchema;
  handler: (input: TInput) => Promise<TOutput> | TOutput;
}

export interface RunAnthropicAgentOptions {
  client: Anthropic;
  velor: VelorClient;
  agentId: string;
  model: string;
  messages: Anthropic.MessageParam[];
  tools: VelorTool[];
  maxTurns?: number;
  maxTokens?: number;
  system?: string;
  metadata?: Record<string, unknown>;
}

export interface RunAnthropicAgentResult {
  executionId: string;
  messages: Anthropic.MessageParam[];
  stopReason: Anthropic.Message['stop_reason'] | null;
  finalText: string;
  turns: number;
}

/**
 * Full-loop orchestrator for Anthropic tool-use agents with Velor in the path.
 *
 * For each turn:
 *  1. Calls `messages.create` and logs the reasoning step as a `decision` event.
 *  2. For each `tool_use` block, calls `velor.runTool` — which requests,
 *     evaluates, executes (or blocks), and logs the outcome.
 *  3. Feeds the tool results back as the next user message.
 *
 * Stops when the model returns `stop_reason === 'end_turn'` (or the turn cap
 * is hit). All timeline events land on a single Velor execution.
 */
export async function runAnthropicAgent(
  opts: RunAnthropicAgentOptions,
): Promise<RunAnthropicAgentResult> {
  const {
    client,
    velor,
    agentId,
    model,
    tools,
    maxTurns = 8,
    maxTokens = 1024,
    system,
    metadata,
  } = opts;

  const execution = await velor.startExecution({
    agent_id: agentId,
    metadata: { ...metadata, model, tool_count: tools.length },
  });

  const toolDefinitions: Anthropic.Tool[] = tools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.input_schema,
  }));

  const toolIndex = new Map(tools.map((t) => [t.name, t]));
  const messages: Anthropic.MessageParam[] = [...opts.messages];

  let stopReason: Anthropic.Message['stop_reason'] | null = null;
  let turns = 0;
  let finalText = '';

  for (let turn = 1; turn <= maxTurns; turn++) {
    turns = turn;

    const response = await client.messages.create({
      model,
      max_tokens: maxTokens,
      ...(system ? { system } : {}),
      tools: toolDefinitions,
      messages,
    });

    stopReason = response.stop_reason;
    const text = extractText(response.content);

    velor.logEvent({
      execution_id: execution.id,
      type: 'decision',
      payload: {
        turn,
        stop_reason: response.stop_reason,
        text: text || undefined,
      },
      metadata,
    });

    if (response.stop_reason !== 'tool_use') {
      finalText = text;
      break;
    }

    messages.push({ role: 'assistant', content: response.content });

    const toolResults: Anthropic.ToolResultBlockParam[] = [];

    for (const block of response.content) {
      if (block.type !== 'tool_use') continue;

      const tool = toolIndex.get(block.name);
      if (!tool) {
        toolResults.push({
          type: 'tool_result',
          tool_use_id: block.id,
          is_error: true,
          content: `Unknown tool "${block.name}"`,
        });
        continue;
      }

      const input = block.input as Record<string, unknown>;
      const result = await runTool(velor, {
        execution_id: execution.id,
        tool: block.name,
        input,
        metadata: { ...metadata, tool_use_id: block.id },
        execute: (effectiveInput) => tool.handler(effectiveInput),
      });

      if (result.status === 'denied') {
        toolResults.push({
          type: 'tool_result',
          tool_use_id: block.id,
          is_error: true,
          content: `Blocked by Velor policy: ${result.reason}`,
        });
      } else if (result.status === 'error') {
        toolResults.push({
          type: 'tool_result',
          tool_use_id: block.id,
          is_error: true,
          content:
            result.error instanceof Error ? result.error.message : String(result.error),
        });
      } else {
        toolResults.push({
          type: 'tool_result',
          tool_use_id: block.id,
          content: formatOutput(result.output),
        });
      }
    }

    messages.push({ role: 'user', content: toolResults });
  }

  await velor.flush();

  return {
    executionId: execution.id,
    messages,
    stopReason,
    finalText,
    turns,
  };
}

function extractText(content: Anthropic.ContentBlock[]): string {
  return content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('\n');
}

function formatOutput(output: unknown): string {
  if (typeof output === 'string') return output;
  try {
    return JSON.stringify(output);
  } catch {
    return String(output);
  }
}
