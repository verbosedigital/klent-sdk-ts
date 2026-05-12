# klent-sdk-ts

The TypeScript SDK, shared schema types, MCP server, starter policies, and example agents for [Klent](https://klent.dev) — the control + observability layer for AI agents in production.

Klent gates every tool call your agent makes against policies you define on the dashboard. Policies can `allow`, `deny`, `modify`, `steer` to a different tool, or pause for `approve` (human-in-the-loop, synchronous wait via dashboard or email). This repo is everything a developer needs to integrate Klent from TypeScript or any MCP-aware client; the server, dashboard, and API live in a separate private repo.

## Packages

| Package                                      | Description                                                                                       | npm                                                                                                       |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| [`@klent/sdk`](./packages/sdk-ts)            | TypeScript SDK — `KlentClient`, `runTool`, Anthropic + OpenAI agent orchestrators, event buffer.  | [![npm](https://img.shields.io/npm/v/@klent/sdk)](https://www.npmjs.com/package/@klent/sdk)               |
| [`@klent/schema`](./packages/schema)         | Zod schemas and TypeScript types for the Klent API. Consumed by the SDK and the (private) server. | [![npm](https://img.shields.io/npm/v/@klent/schema)](https://www.npmjs.com/package/@klent/schema)         |
| [`@klent/mcp-server`](./packages/mcp-server) | Stdio MCP server that exposes Klent's policy gate as four tools to any MCP-aware client.          | [![npm](https://img.shields.io/npm/v/@klent/mcp-server)](https://www.npmjs.com/package/@klent/mcp-server) |

## Examples

Runnable end-to-end agents wired through Klent — clone this repo and run them locally against your own project on `app.klent.dev`.

- [`examples/anthropic-agent`](./examples/anthropic-agent) — Anthropic agent loop with `runAnthropicAgent`.
- [`examples/openai-agent`](./examples/openai-agent) — OpenAI agent loop with `runOpenAIAgent`.
- [`examples/use-case-postgres-incident`](./examples/use-case-postgres-incident) — the canonical "agent + real Postgres + HITL via email" demo for use case #1.

## Starter policies

Drop-in policy packs you can apply against your own project. Browse [`policies/`](./policies) for `finance-agent.yaml`, `dev-safe.yaml`, `agent-sandbox.yaml`, `hitl-and-steer.yaml` — see [`policies/README.md`](./policies/README.md) for what each one does. Apply them via the dashboard at `app.klent.dev/policies/new` or via curl:

```bash
curl https://raw.githubusercontent.com/klentlabs/klent-sdk-ts/main/policies/finance-agent.yaml \
  | curl -X POST https://api.klent.dev/v1/projects/$PROJECT_ID/policies \
    -H "Authorization: Bearer $KLENT_API_KEY" \
    -H "Content-Type: application/yaml" \
    --data-binary @-
```

## Install (consumer use)

You don't need to clone this repo to use Klent — install the SDK from npm:

```bash
npm install @klent/sdk
# or
pnpm add @klent/sdk
```

Then:

```ts
import { KlentClient, runTool } from '@klent/sdk';

const klent = new KlentClient({ apiKey: process.env.KLENT_API_KEY! });
const execution = await klent.startExecution({ agent_id: 'my-agent' });

const result = await runTool(klent, {
  execution_id: execution.id,
  tool: 'transfer_funds',
  input: { amount: 50_000, currency: 'USD' },
  execute: transferFunds,
  approval: { wait: { timeoutMs: 30 * 60_000 } },
});
```

Full docs at [klent.dev/docs](https://klent.dev/docs).

## Develop (working on the SDK itself)

```bash
git clone https://github.com/klentlabs/klent-sdk-ts.git
cd klent-sdk-ts
pnpm install
pnpm build
pnpm test
```

Layout:

```
packages/
  sdk-ts/      → @klent/sdk
  schema/      → @klent/schema
  mcp-server/  → @klent/mcp-server
  tsconfig/    → @klent/tsconfig (shared internal config; not published)
examples/      → runnable agent demos (private workspaces, not published)
policies/      → YAML starter packs (consumed directly, not packaged)
```

`@klent/schema` is published independently because it's the canonical contract between the SDK and the (private) Klent server. Bumping it requires publishing first, then updating consumers on both sides.

## Publishing

- TypeScript SDK (`@klent/sdk` + `@klent/schema`): tag `sdk-ts-vX.Y.Z` → `.github/workflows/publish-sdk-ts.yml` publishes via npm OIDC trusted publisher with provenance.
- MCP server (`@klent/mcp-server`): tag `mcp-server-vX.Y.Z` → `.github/workflows/publish-mcp-server.yml` same pattern.

Pre-release tags (`X.Y.Z-alpha.N`, `X.Y.Z-rc.N`) publish to the `next` dist-tag; stable tags get `latest`.

## Project

- Product, docs, dashboard: [klent.dev](https://klent.dev)
- Issues for the SDK / schema / MCP server / policies / examples: this repo
- Issues for the API, dashboard, or product: <hello@klent.dev>

## License

Apache-2.0. See [`LICENSE`](./LICENSE).
