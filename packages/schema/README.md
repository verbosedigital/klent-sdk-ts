# @klent/schema

Zod schemas and TypeScript types for the [Klent](https://klent.dev) API —
shared between the SDK and server.

This package is the source of truth for every request and response that
crosses the Klent API boundary. If you're integrating with Klent directly,
you usually want `@klent/sdk` instead — it depends on this package and
exposes a higher-level client.

## Install

```bash
pnpm add @klent/schema
```

## Usage

```ts
import { evaluateActionRequest, type EvaluateActionResponse } from '@klent/schema';

const parsed = evaluateActionRequest.parse(payload);
```

## Docs

<https://klent.dev/docs>

## License

Proprietary.
