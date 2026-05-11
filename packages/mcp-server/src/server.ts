import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { KlentClient } from '@klent/sdk';
import type { EventType } from '@klent/schema';
import { z } from 'zod';

// Read the server's own version from `package.json` at runtime instead of
// hard-coding it inline. The MCP server's identity response surfaces this
// value to clients (Claude Desktop, Cursor, etc.) — keeping it in sync with
// the published npm version was an easy thing to forget on every bump.
// `dist/server.js` sits next to `package.json` after build, so the relative
// URL resolution works for both local dev (`dist/` adjacent to `package
// .json`) and published consumers.
const pkg = JSON.parse(
  readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'),
) as { version: string };

// Mirror the closed event-type enum so the MCP tool's input schema only
// accepts values the server will actually persist. Keep the literal list in
// sync with `eventTypeSchema` in `@klent/schema`; widening it without a
// schema change would just produce 422s at the API.
const EVENT_TYPES = [
  'decision',
  'action_requested',
  'action_executed',
  'action_blocked',
  'action_steered',
  'pending_approval',
  'approval_vote',
  'approval_resolved',
  'error',
] as const satisfies readonly EventType[];

export type Options = {
  apiKey: string;
  baseUrl?: string;
};

/**
 * Build the MCP server, register the four tools that mirror the most useful
 * `KlentClient` surface, and return it (caller is responsible for connecting
 * a transport — typically stdio).
 *
 * The whole shape stays "thin": every tool is a near-direct passthrough to
 * `@klent/sdk`. We don't try to hide the SDK's vocabulary because the MCP
 * client (an LLM) reads each tool's `description` and benefits from
 * matching what users will see in our docs.
 */
export function createKlentMcpServer(opts: Options): McpServer {
  const klent = new KlentClient({ apiKey: opts.apiKey, baseUrl: opts.baseUrl });

  const server = new McpServer(
    {
      name: 'klent-mcp',
      version: pkg.version,
    },
    {
      capabilities: {
        tools: {},
      },
    },
  );

  // ---------------------------------------------------------------------------
  // klent_start_execution
  // ---------------------------------------------------------------------------
  server.tool(
    'klent_start_execution',
    [
      'Start a Klent execution. One execution per agent run — every later',
      'tool call, decision, and event ties back to its execution_id and',
      'shows up in the dashboard timeline at app.klent.dev/executions/<id>.',
      'Call this once at the top of an agent loop and pass the returned id',
      'into klent_evaluate_action / klent_log_event for everything that',
      'follows.',
    ].join(' '),
    {
      agent_id: z
        .string()
        .min(1)
        .describe(
          "Stable identifier for the agent (e.g. 'support-bot', 'finance-agent-v2'). Used to filter and group executions in the dashboard.",
        ),
      metadata: z
        .record(z.unknown())
        .optional()
        .describe(
          'Free-form key/value object attached to the execution. Useful for caller context like { user_id, tenant, request_id }.',
        ),
    },
    async ({ agent_id, metadata }) => {
      const execution = await klent.startExecution({
        agent_id,
        metadata: metadata as Record<string, unknown> | undefined,
      });
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(execution, null, 2),
          },
        ],
      };
    },
  );

  // ---------------------------------------------------------------------------
  // klent_evaluate_action
  // ---------------------------------------------------------------------------
  server.tool(
    'klent_evaluate_action',
    [
      "Evaluate a proposed tool call against the project's active policies",
      'BEFORE executing it. Returns a decision: allow / deny / modify /',
      'approve / steer. The agent should obey the decision:',
      ' • allow → proceed unchanged.',
      ' • deny → do not run, surface the reason as a tool error.',
      ' • modify → apply `modifications` to the input, then proceed.',
      ' • approve → action paused; a `pending_action_id` is returned. Poll',
      '   it via klent_get_pending_action until a human resolves it.',
      ' • steer → run `redirect_to.tool` with `redirect_to.input` instead.',
      'This is the single most important call — it is the policy gate.',
    ].join(' '),
    {
      execution_id: z.string().min(1).describe('Execution id returned by klent_start_execution.'),
      tool: z
        .string()
        .min(1)
        .describe(
          "Tool the agent intends to call (e.g. 'send_email', 'transfer_funds', 'db_write').",
        ),
      input: z.record(z.unknown()).describe('The proposed input the agent would pass to the tool.'),
      metadata: z
        .record(z.unknown())
        .optional()
        .describe(
          'Optional per-call metadata. Merged into the action context for policy evaluation.',
        ),
    },
    async ({ execution_id, tool, input, metadata }) => {
      const decision = await klent.evaluateAction({
        execution_id,
        tool,
        input: input as Record<string, unknown>,
        metadata: metadata as Record<string, unknown> | undefined,
      });
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(decision, null, 2),
          },
        ],
      };
    },
  );

  // ---------------------------------------------------------------------------
  // klent_log_event
  // ---------------------------------------------------------------------------
  server.tool(
    'klent_log_event',
    [
      "Append an event to an execution's timeline. Most events the engine",
      'emits automatically (action_requested, action_blocked, action_executed,',
      'approval_resolved, etc.) when you call klent_evaluate_action — call',
      'this only for events the engine does not generate on its own. Most',
      'common case: `error` to record a tool failure that happened after the',
      'engine allowed the call.',
    ].join(' '),
    {
      execution_id: z.string().min(1).describe('Execution id to append to.'),
      type: z
        .enum(EVENT_TYPES)
        .describe(
          "Event tag from Klent's closed enum. Use `error` for runtime failures the engine did not see; the rest are mostly engine-emitted and rarely useful to log manually.",
        ),
      payload: z
        .record(z.unknown())
        .describe('Arbitrary JSON payload shown in the timeline event detail panel.'),
    },
    async ({ execution_id, type, payload }) => {
      // logEvent is fire-and-forget on the SDK side (buffered + batched), so
      // we explicitly flush before reporting back. Otherwise the LLM might
      // assume the event landed when it is still in the local queue.
      klent.logEvent({
        execution_id,
        type,
        payload: payload as Record<string, unknown>,
      });
      await klent.flush();
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({ ok: true }, null, 2),
          },
        ],
      };
    },
  );

  // ---------------------------------------------------------------------------
  // klent_get_pending_action
  // ---------------------------------------------------------------------------
  server.tool(
    'klent_get_pending_action',
    [
      'Read a pending action by id. Used after an evaluate returned an',
      "`approve` decision: the agent loops on this tool until the row's",
      'status flips to allowed/denied (a human resolved it from the',
      'dashboard or via email).',
      '',
      'Pass `wait_ms` (≤ 30000) to long-poll: the call holds the connection',
      'until the row is resolved or the budget elapses, which is much more',
      'efficient than a tight polling loop.',
    ].join('\n'),
    {
      pending_action_id: z
        .string()
        .min(1)
        .describe(
          'pending_action_id returned by klent_evaluate_action when decision was `approve`.',
        ),
      wait_ms: z
        .number()
        .int()
        .min(0)
        .max(30000)
        .optional()
        .describe(
          'If > 0, server holds the connection up to this many ms waiting for resolution. Defaults to 0 (single-shot read).',
        ),
    },
    async ({ pending_action_id, wait_ms }) => {
      const pending = await klent.getPendingAction(pending_action_id, {
        waitMs: wait_ms,
      });
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(pending, null, 2),
          },
        ],
      };
    },
  );

  return server;
}
