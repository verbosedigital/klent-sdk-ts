# @klent/sdk

TypeScript SDK for [Klent](https://klent.dev) — the control and observability
layer for AI agents.

Klent sits between your agent and the tools it calls. Every proposed tool
invocation flows through a policy engine that returns
**allow / deny / modify / approve / steer** in a few milliseconds. Every
decision and outcome lands on a per-execution timeline you can query, export,
and audit.

## Install

```bash
npm install @klent/sdk
# or
pnpm add @klent/sdk
```

Peer dependencies (install whichever your agent uses):

```bash
pnpm add @anthropic-ai/sdk    # for runAnthropicAgent
pnpm add openai               # for runOpenAIAgent
```

## Quick start

```ts
import { KlentClient, runTool } from '@klent/sdk';

const klent = new KlentClient({
  apiKey: process.env.KLENT_API_KEY!,
});

const result = await runTool(klent, {
  executionId: 'exec_123',
  toolName: 'send_email',
  input: { to: 'alice@example.com', subject: 'hi' },
  execute: async (input) => {
    // your real tool implementation
    return await sendEmail(input);
  },
});
```

`runTool` evaluates the action against your policies, applies any
modifications, runs your `execute` function only if allowed, logs every event
back to Klent, and returns either the tool's output, a denial reason, or a
pending approval handle.

## Anthropic / OpenAI orchestrators

```ts
import { runAnthropicAgent } from '@klent/sdk/anthropic';
import { runOpenAIAgent } from '@klent/sdk/openai';
```

Both wrap the model loop and route every tool call through Klent
automatically. See the [examples in the
repo](https://github.com/verbosedigital/klent/tree/main/examples) for full,
runnable demos.

## Docs

Full reference: <https://klent.dev/docs>

## License

Proprietary.
