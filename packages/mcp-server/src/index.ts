#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createKlentMcpServer } from './server.js';

/**
 * Entry point — read config from env, wire stdio transport, run forever.
 *
 * MCP CLI clients (Claude Desktop, Cursor, etc.) spawn this binary and
 * communicate over stdin/stdout via JSON-RPC framing. Anything we emit on
 * stdout that isn't JSON-RPC corrupts the protocol; user-facing logs go
 * to stderr.
 */
async function main(): Promise<void> {
  const apiKey = process.env.KLENT_API_KEY;
  if (!apiKey) {
    console.error(
      'klent-mcp: KLENT_API_KEY env var is required. Mint a key at https://app.klent.dev/api-keys',
    );
    process.exit(1);
  }

  const baseUrl = process.env.KLENT_API_URL || 'https://api.klent.dev/v1';

  const server = createKlentMcpServer({ apiKey, baseUrl });
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // The transport keeps the process alive on its own; once stdin closes
  // (parent process shut down) it will surface as a normal SIGPIPE/EOF
  // and the runtime exits cleanly.
}

main().catch((err) => {
  console.error('klent-mcp: fatal error', err);
  process.exit(1);
});
