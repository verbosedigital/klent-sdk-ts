# @klent/mcp-server

Model Context Protocol (MCP) server for [Klent](https://klent.dev) — let any
MCP-aware client (Claude Desktop, Cursor, custom agents, etc.) gate tool
calls through Klent's policy engine.

## What you get

Four MCP tools that mirror the most useful surface of `@klent/sdk`:

| Tool                       | What it does                                                                         |
| -------------------------- | ------------------------------------------------------------------------------------ |
| `klent_start_execution`    | Open one tracked agent run. All later calls reference its `execution_id`.            |
| `klent_evaluate_action`    | Ask the policy engine: allow / deny / modify / approve / steer?                      |
| `klent_log_event`          | Append an event (e.g. `error`) to the timeline; most events the engine emits itself. |
| `klent_get_pending_action` | Read a HITL pending row, optionally long-polling until resolved.                     |

The decisions, events, and pending actions show up live at
`https://app.klent.dev/executions/<id>`.

## Install

You don't really install it — MCP clients spawn it on demand via `npx`.
Just give them the right config (below).

You'll need an API key from <https://app.klent.dev/api-keys>.

## Wire it into Claude Desktop

Edit your Claude Desktop config (`~/Library/Application Support/Claude/claude_desktop_config.json`
on macOS):

```json
{
  "mcpServers": {
    "klent": {
      "command": "npx",
      "args": ["-y", "@klent/mcp-server"],
      "env": {
        "KLENT_API_KEY": "kk_live_…"
      }
    }
  }
}
```

Restart Claude Desktop. The four tools appear in the MCP picker. From there
you can ask things like:

> "Start a Klent execution called `claude-desktop-session`, then evaluate
> `send_email` with input `{to: 'delivered@resend.dev'}` against my
> policies."

## Wire it into Cursor

Cursor's MCP config (Settings → MCP):

```json
{
  "klent": {
    "command": "npx",
    "args": ["-y", "@klent/mcp-server"],
    "env": {
      "KLENT_API_KEY": "kk_live_…"
    }
  }
}
```

## Custom MCP clients

Anything that speaks the MCP stdio JSON-RPC protocol works. Spawn the binary
with `KLENT_API_KEY` set in the environment, then negotiate per the protocol
spec.

## Configuration

| Env var         | Required | Default                    | Notes                                  |
| --------------- | -------- | -------------------------- | -------------------------------------- |
| `KLENT_API_KEY` | yes      | —                          | Per-project key from `/api-keys`.      |
| `KLENT_API_URL` | no       | `https://api.klent.dev/v1` | Override for self-hosted / Enterprise. |

## Why an MCP server

You already have `@klent/sdk` for TypeScript and `klent-sdk` for Python. Use
the SDK when you control the agent code. Use this MCP server when you don't:

- The agent runs in Claude Desktop / Cursor / another MCP host.
- A team wants to gate tool calls **declaratively** without redeploying the
  agent that owns those tools.
- You're testing policy authoring against a live LLM session.

It's a thin wrapper. The SDK is the source of truth.

## Reading the timeline

Whatever tools the LLM calls show up under
`https://app.klent.dev/executions/<id>` with full event history, decisions,
modifications, and approvals. Same dashboard your TS / Python agents use.

## Docs

Full reference: <https://klent.dev/docs>

## License

Apache-2.0. See [LICENSE](https://github.com/verbosedigital/klent-sdk-ts/blob/main/LICENSE).
