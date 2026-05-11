/**
 * Use case #1 — solo founder with Postgres MCP in prod.
 *
 * Recreates the canonical Klent demo end-to-end:
 *   1. The agent has db_query (read) and db_write (mutate) against a real
 *      "userland" Postgres standing in for ProdCorp's user database.
 *   2. The user asks Claude to "fix malformed emails — normalize to lowercase".
 *   3. Claude inspects the table, then issues an UPDATE on prod.
 *   4. Klent's `approve` policy parks the UPDATE, fans out an email via Resend.
 *   5. The SDK blocks (approval.wait) until the human clicks Approve.
 *   6. The UPDATE executes; the agent reports back what changed.
 *
 * Pitch: "If you give an LLM root access to your prod DB, you should be one
 * click away from undoing it."
 */
import Anthropic from '@anthropic-ai/sdk';
import { KlentClient, runTool } from '@klent/sdk';
import postgres from 'postgres';

const USER_QUERY =
  process.argv.slice(2).join(' ') ||
  'Our user emails got stored with random capitalization (BoB@Example.com etc). Please fix the malformed emails — normalize them all to lowercase. Production database, please proceed.';

const SYSTEM = `You are a database administrator AI for ProdCorp.
You have access to the production user database via two tools:
  - db_query: read-only SELECT statements
  - db_write: UPDATE / DELETE / INSERT statements (mutations)

Workflow:
  1. Inspect the data with db_query before mutating.
  2. When mutating, write a single targeted SQL statement.
  3. After the mutation runs, briefly summarise what changed.

Mark every mutation as production. Be concise.`;

const APPROVAL_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes

async function main() {
  const klentKey = requireEnv('KLENT_API_KEY');
  const anthropicKey = requireEnv('ANTHROPIC_API_KEY');
  const userlandUrl =
    process.env.USERLAND_DATABASE_URL ?? 'postgres://klent:klent@localhost:5432/userland';

  const klent = new KlentClient({
    apiKey: klentKey,
    baseUrl: process.env.KLENT_BASE_URL ?? 'https://api.klent.dev/v1',
  });
  const anthropic = new Anthropic({ apiKey: anthropicKey });
  const sql = postgres(userlandUrl, { max: 2, onnotice: () => {} });

  console.log(`\n▸ User: ${USER_QUERY}\n`);

  const execution = await klent.startExecution({
    agent_id: 'prodcorp-dba',
    metadata: { example: 'use-case-postgres-incident', model: 'claude-sonnet-4-6' },
  });
  console.log(`▸ Klent execution: ${execution.id}`);
  console.log(`▸ Timeline: ${dashboardUrl()}/executions/${execution.id}\n`);

  const tools: Anthropic.Tool[] = [
    {
      name: 'db_query',
      description: 'Run a read-only SELECT against the prod user database. Returns rows as JSON.',
      input_schema: {
        type: 'object',
        properties: { sql: { type: 'string', description: 'A single SELECT statement.' } },
        required: ['sql'],
      },
    },
    {
      name: 'db_write',
      description:
        'Run an UPDATE / DELETE / INSERT against the prod user database. Mutates real data — use sparingly.',
      input_schema: {
        type: 'object',
        properties: {
          sql: { type: 'string', description: 'A single UPDATE / DELETE / INSERT statement.' },
        },
        required: ['sql'],
      },
    },
  ];

  const messages: Anthropic.MessageParam[] = [{ role: 'user', content: USER_QUERY }];
  const maxTurns = 6;

  for (let turn = 1; turn <= maxTurns; turn++) {
    const resp = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 1024,
      system: SYSTEM,
      tools,
      messages,
    });

    klent.logEvent({
      execution_id: execution.id,
      type: 'decision',
      payload: {
        turn,
        stop_reason: resp.stop_reason,
        text: extractText(resp.content) || undefined,
      },
    });

    messages.push({ role: 'assistant', content: resp.content });

    if (resp.stop_reason === 'end_turn') {
      console.log(`\n▸ Assistant: ${extractText(resp.content)}\n`);
      break;
    }

    if (resp.stop_reason !== 'tool_use') {
      console.warn(`\n⚠ Unexpected stop_reason ${resp.stop_reason}; aborting loop.`);
      break;
    }

    const toolBlocks = resp.content.filter((b) => b.type === 'tool_use');
    const toolResults: Anthropic.ToolResultBlockParam[] = [];

    for (const block of toolBlocks) {
      if (block.type !== 'tool_use') continue;
      const input = block.input as { sql: string };

      console.log(`\n▸ Turn ${turn} — Claude wants to call ${block.name}:`);
      console.log(`    ${input.sql}`);

      const result = await runTool(klent, {
        execution_id: execution.id,
        tool: block.name,
        input: { sql: input.sql, env: 'prod' },
        metadata: { tool_use_id: block.id, env: 'prod' },
        execute: async (effective) => runSql(sql, block.name, effective.sql as string),
        approval: {
          wait: { timeoutMs: APPROVAL_TIMEOUT_MS, useLongPoll: true },
        },
      });

      if (result.status === 'denied') {
        console.log(`✗ Klent blocked ${block.name}: ${result.reason}`);
        toolResults.push({
          type: 'tool_result',
          tool_use_id: block.id,
          is_error: true,
          content: `Blocked by Klent policy: ${result.reason}`,
        });
      } else if (result.status === 'pending') {
        console.log(`⌛ Klent approval timed out for ${block.name} (${result.pendingActionId}).`);
        toolResults.push({
          type: 'tool_result',
          tool_use_id: block.id,
          is_error: true,
          content: `Awaiting human approval (pending_action_id=${result.pendingActionId})`,
        });
      } else if (result.status === 'error') {
        const msg = result.error instanceof Error ? result.error.message : String(result.error);
        console.log(`✗ ${block.name} failed: ${msg}`);
        toolResults.push({
          type: 'tool_result',
          tool_use_id: block.id,
          is_error: true,
          content: msg,
        });
      } else {
        console.log(
          `✓ ${block.name} executed (matched policy ${result.matchedPolicyId ?? 'none'}).`,
        );
        toolResults.push({
          type: 'tool_result',
          tool_use_id: block.id,
          content: JSON.stringify(result.output),
        });
      }
    }

    messages.push({ role: 'user', content: toolResults });
  }

  await klent.flush();
  await sql.end();
  console.log(`\n▸ Done. Open ${dashboardUrl()}/executions/${execution.id} to inspect.\n`);
}

async function runSql(sql: postgres.Sql, tool: string, statement: string): Promise<unknown> {
  if (tool === 'db_query') {
    if (!/^\s*select\b/i.test(statement)) {
      throw new Error('db_query is read-only — use db_write for mutations.');
    }
    const rows = await sql.unsafe(statement);
    return { rows };
  }
  if (tool === 'db_write') {
    if (/^\s*select\b/i.test(statement)) {
      throw new Error('db_write must mutate — use db_query for SELECT.');
    }
    const result = await sql.unsafe(statement);
    return { rowCount: result.count };
  }
  throw new Error(`Unknown tool: ${tool}`);
}

function extractText(blocks: Anthropic.ContentBlock[]): string {
  return blocks
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('\n')
    .trim();
}

function dashboardUrl(): string {
  const base = process.env.KLENT_BASE_URL ?? 'https://api.klent.dev/v1';
  if (base.includes('localhost')) return 'http://localhost:3000';
  return 'https://app.klent.dev';
}

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`Missing env: ${name}. Copy .env.example to .env and fill in values.`);
    process.exit(1);
  }
  return v;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
