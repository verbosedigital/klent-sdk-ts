import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createKlentMcpServer } from './server.js';

/**
 * These tests boot the MCP server with an in-memory transport pair so we
 * exercise the real protocol round-trip (tool registration, JSON-RPC
 * dispatch, schema validation) — but mock `globalThis.fetch` so the SDK's
 * `KlentClient` reads fixtures instead of hitting the API.
 */

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

async function makeClient(): Promise<{ client: Client; cleanup: () => Promise<void> }> {
  const server = createKlentMcpServer({ apiKey: 'kk_test_dummy' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);

  const client = new Client({ name: 'test-client', version: '0.0.0' }, { capabilities: {} });
  await client.connect(clientTransport);

  return {
    client,
    cleanup: async () => {
      await client.close();
      await server.close();
    },
  };
}

type ToolResult = {
  content: Array<{ type: string; text: string }>;
};

describe('createKlentMcpServer', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('registers the four expected tools', async () => {
    const { client, cleanup } = await makeClient();
    try {
      const list = await client.listTools();
      const names = list.tools.map((t) => t.name).sort();
      expect(names).toEqual([
        'klent_evaluate_action',
        'klent_get_pending_action',
        'klent_log_event',
        'klent_start_execution',
      ]);
    } finally {
      await cleanup();
    }
  });

  it('klent_start_execution forwards to KlentClient.startExecution', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        jsonResponse({ id: 'exec_abc', agent_id: 'test-agent', status: 'running' }, 201),
      );
    vi.stubGlobal('fetch', fetchMock);

    const { client, cleanup } = await makeClient();
    try {
      const result = (await client.callTool({
        name: 'klent_start_execution',
        arguments: { agent_id: 'test-agent', metadata: { x: 1 } },
      })) as ToolResult;

      expect(fetchMock).toHaveBeenCalledOnce();
      const [url, init] = fetchMock.mock.calls[0]! as [string, RequestInit];
      expect(String(url)).toContain('/executions');
      expect(init.method).toBe('POST');
      const body = JSON.parse(init.body as string);
      expect(body).toEqual({ agent_id: 'test-agent', metadata: { x: 1 } });

      expect(result.content[0]!.type).toBe('text');
      expect(JSON.parse(result.content[0]!.text)).toEqual({
        id: 'exec_abc',
        agent_id: 'test-agent',
        status: 'running',
      });
    } finally {
      await cleanup();
    }
  });

  it('klent_evaluate_action forwards inputs and surfaces the decision', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        decision: 'deny',
        matched_policy_id: 'pol_xyz',
        modifications: null,
        reason: 'Matched policy "Block test"',
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const { client, cleanup } = await makeClient();
    try {
      const result = (await client.callTool({
        name: 'klent_evaluate_action',
        arguments: {
          execution_id: 'exec_abc',
          tool: 'send_email',
          input: { to: 'delivered@resend.dev' },
        },
      })) as ToolResult;

      expect(fetchMock).toHaveBeenCalledOnce();
      const [url, init] = fetchMock.mock.calls[0]! as [string, RequestInit];
      expect(String(url)).toContain('/actions/evaluate');
      expect(init.method).toBe('POST');

      const parsed = JSON.parse(result.content[0]!.text);
      expect(parsed.decision).toBe('deny');
      expect(parsed.matched_policy_id).toBe('pol_xyz');
    } finally {
      await cleanup();
    }
  });

  it('klent_log_event flushes the event buffer before returning ok', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ accepted: 1 }, 202));
    vi.stubGlobal('fetch', fetchMock);

    const { client, cleanup } = await makeClient();
    try {
      const result = (await client.callTool({
        name: 'klent_log_event',
        arguments: {
          execution_id: 'exec_abc',
          type: 'error',
          payload: { msg: 'tool blew up' },
        },
      })) as ToolResult;

      // After the handler runs we explicitly flush, so the events POST must
      // already have happened by the time we get the response.
      const flushedCall = fetchMock.mock.calls.find(([url]) => String(url).endsWith('/events'));
      expect(flushedCall).toBeDefined();

      expect(JSON.parse(result.content[0]!.text)).toEqual({ ok: true });
    } finally {
      await cleanup();
    }
  });

  it('klent_get_pending_action passes wait_ms through to the SDK', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        id: 'pact_123',
        status: 'pending',
        execution_id: 'exec_abc',
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const { client, cleanup } = await makeClient();
    try {
      await client.callTool({
        name: 'klent_get_pending_action',
        arguments: { pending_action_id: 'pact_123', wait_ms: 5000 },
      });

      const [url] = fetchMock.mock.calls[0]! as [string, RequestInit];
      expect(String(url)).toContain('/pending_actions/pact_123');
      expect(String(url)).toContain('wait_ms=5000');
    } finally {
      await cleanup();
    }
  });

  it('rejects klent_log_event with an unknown type', async () => {
    const { client, cleanup } = await makeClient();
    try {
      await expect(
        client.callTool({
          name: 'klent_log_event',
          arguments: {
            execution_id: 'exec_abc',
            type: 'not_a_real_type',
            payload: {},
          },
        }),
        // The MCP SDK validates against the registered schema and returns an
        // error result rather than throwing — but in either case the call
        // should not silently succeed.
      ).resolves.toMatchObject({
        isError: true,
      });
    } finally {
      await cleanup();
    }
  });
});
