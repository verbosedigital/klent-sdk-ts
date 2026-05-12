# Klent starter policy packs

Drop-in YAML policies for common agent scenarios. Apply them to your project on `app.klent.dev` via the dashboard's "New policy" form (paste the YAML), or via the API:

```bash
curl https://raw.githubusercontent.com/klentlabs/klent-sdk-ts/main/policies/finance-agent.yaml \
  | curl -X POST https://api.klent.dev/v1/projects/$PROJECT_ID/policies \
    -H "Authorization: Bearer $KLENT_API_KEY" \
    -H "Content-Type: application/yaml" \
    --data-binary @-
```

## What's here

| File                                           | Scenario                                                                                                                                                                      |
| ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`finance-agent.yaml`](./finance-agent.yaml)   | Money-moving tools (`transfer_funds`, `issue_refund`): block large amounts, rate-limit small ones, require human approval for anything touching prod.                         |
| [`dev-safe.yaml`](./dev-safe.yaml)             | Developer agents writing code or running shell commands: deny destructive commands (`rm -rf`, `DROP TABLE`), gate prod deploys behind approval, log everything.               |
| [`agent-sandbox.yaml`](./agent-sandbox.yaml)   | Generic sandbox for early-stage agents: shadow-mode logging, loop-guard against runaway agents, no enforcement (good for shipping observability before flipping policies on). |
| [`hitl-and-steer.yaml`](./hitl-and-steer.yaml) | Human-in-the-loop + steer examples: approve for one tool, steer (`tool_a` → `tool_b`) for another, multi-approver quorum.                                                     |

## Customising

Each YAML is structured as a list of policies — copy/paste/edit. Schema reference: [klent.dev/docs/concepts/policies](https://klent.dev/docs/concepts/policies). The full set of operators, effects, rate-limit / loop-guard clauses, and condition syntax is documented there.

## Contributing a starter pack

If you've got a Klent setup that solves a common scenario (legal review, healthcare access, SRE prod gates, customer-support refunds, etc.), open a PR adding the YAML here. Goal is to keep this directory as a curated library, not exhaustive — each file should be self-explanatory enough to copy without further reading.

## License

Apache-2.0. See [`LICENSE`](./LICENSE).
