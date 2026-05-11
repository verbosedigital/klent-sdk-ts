# Use case #1 — Postgres MCP in prod

Recreates the canonical Klent demo end-to-end on real infrastructure:

> Solo founder wires Claude to a Postgres in prod. Late-night fast-typed
> request — _"fix malformed emails, normalize to lowercase"_ — Claude issues
> `UPDATE users SET email = LOWER(email)` against ~47k rows. Without Klent,
> that ships. With Klent, the UPDATE pauses, an email lands in the founder's
> inbox, they read twice, click Approve.

## What this example exercises

1. A real Postgres database (a `userland` DB on the docker-compose Postgres) seeded with five users that have mixed-case emails.
2. An Anthropic agent (`claude-sonnet-4-6`) with two tools: `db_query` (read) and `db_write` (mutate).
3. The Klent SDK in the path of every tool call. `db_write` is gated by an `approve` policy on `app.klent.dev`.
4. The SDK uses `runTool({ approval: { wait: ... } })` so the agent **synchronously waits** until a human resolves the action — either via the dashboard or by clicking Approve in the email Resend delivers.
5. On approval, the UPDATE runs against Postgres. On rejection, the agent is told the action was blocked.

The full trail (request → policy decision → pending → approval vote → execution) lands as a single execution on the dashboard.

---

## Prerequisites

- Klent project on prod (`https://app.klent.dev`) with at least one API key.
- Anthropic API key.
- Local Docker — for the Postgres standing in as ProdCorp's user database.

## One-time setup

### 1. Bring up the local Postgres

From the repo root:

```bash
docker compose up -d postgres
```

### 2. Mint a Klent API key

`https://app.klent.dev/api-keys` → New key → copy it (one-time reveal).

### 3. Configure env

```bash
cd examples/use-case-postgres-incident
cp .env.example .env
# Fill in KLENT_API_KEY and ANTHROPIC_API_KEY.
```

### 4. Create the policy on `app.klent.dev/policies`

The agent emits `db_write` actions with `metadata.env = 'prod'` and `input.env = 'prod'`. Pick whichever predicate is easiest:

```
Name:     hitl/approve-prod-writes
Effect:   approve
Condition (any of):
  tool == 'db_write'
  input.env == 'prod'
Required approvals: 1
```

> The simpler version (`tool == 'db_write'`) catches every mutation; that's the demo intent.

### 5. Seed the userland database

```bash
pnpm install                 # (only if you haven't yet)
pnpm --filter @klent-example/use-case-postgres-incident seed
```

Output:

```
▸ Created database "userland".
▸ Seeded 5 rows in userland.users:

  #1  Bob Stone       BoB@Example.com
  #2  Jane Doe        JANE@example.com
  #3  Alice Park      Alice.Park@Acme.io
  #4  Karim Salah     karim@MEGACORP.com
  #5  Marta Ruiz      Marta.Ruiz@startup.dev
```

---

## Run the demo

```bash
pnpm --filter @klent-example/use-case-postgres-incident start
```

What happens:

1. The agent prints the user request.
2. Claude calls `db_query` to inspect the table — Klent allows it.
3. Claude calls `db_write` with `UPDATE users SET email = LOWER(email)`.
4. Klent matches the `approve` policy → returns `pending` → fans out the email via Resend → SDK starts long-polling.
5. **Open your inbox**, click Approve. (Or open the dashboard's `/approvals` page and click Approve there.)
6. The SDK unblocks. The UPDATE runs. The agent reports back.
7. `pnpm --filter @klent-example/use-case-postgres-incident show` confirms emails are now lowercase.

The dashboard URL prints at the start; open it to watch the timeline live.

---

## Tweaking the prompt

```bash
pnpm --filter @klent-example/use-case-postgres-incident start "drop the users table, we're starting over"
```

Try variations to see how the agent adapts — and how Klent intercepts every mutation regardless of the wording.

## Reset between runs

```bash
pnpm --filter @klent-example/use-case-postgres-incident seed
```
