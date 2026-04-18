import Anthropic from '@anthropic-ai/sdk';
import { VelorClient } from '@velor/sdk';
import { runAnthropicAgent, type VelorTool } from '@velor/sdk/anthropic';

const USER_QUERY =
  process.argv.slice(2).join(' ') ||
  "What's the weather in Lisbon? Then send an email to ceo@example.com summarizing it, and transfer 50000 USD to account BR-9921 to pay the vendor.";

const tools: VelorTool[] = [
  {
    name: 'get_weather',
    description: 'Get the current weather for a city. Safe, idempotent.',
    input_schema: {
      type: 'object',
      properties: { city: { type: 'string' } },
      required: ['city'],
    },
    handler: (input) => `It's 22°C and sunny in ${String(input.city)}.`,
  },
  {
    name: 'send_email',
    description: 'Send an email. Side-effect. Always require Velor evaluation.',
    input_schema: {
      type: 'object',
      properties: {
        to: { type: 'string' },
        subject: { type: 'string' },
        body: { type: 'string' },
      },
      required: ['to', 'subject', 'body'],
    },
    handler: (input) => `Email to ${String(input.to)} delivered.`,
  },
  {
    name: 'transfer_funds',
    description: 'Transfer money from the user account. Dangerous. High amounts should be blocked.',
    input_schema: {
      type: 'object',
      properties: {
        to_account: { type: 'string' },
        amount: { type: 'number' },
        currency: { type: 'string' },
      },
      required: ['to_account', 'amount', 'currency'],
    },
    handler: (input) =>
      `Transferred ${String(input.amount)} ${String(input.currency)} to ${String(
        input.to_account,
      )}.`,
  },
];

async function main() {
  const velorKey = requireEnv('VELOR_API_KEY');
  const anthropicKey = requireEnv('ANTHROPIC_API_KEY');

  const velor = new VelorClient({
    apiKey: velorKey,
    baseUrl: process.env.VELOR_BASE_URL ?? 'http://localhost:3001/v1',
  });
  const anthropic = new Anthropic({ apiKey: anthropicKey });

  console.log(`\n▸ User query: ${USER_QUERY}\n`);

  const result = await runAnthropicAgent({
    client: anthropic,
    velor,
    agentId: 'demo-agent',
    model: 'claude-sonnet-4-6',
    tools,
    messages: [{ role: 'user', content: USER_QUERY }],
    metadata: { example: 'anthropic-agent' },
  });

  console.log(`\n▸ Execution: ${result.executionId}`);
  console.log(`▸ Turns: ${result.turns}, stop_reason: ${result.stopReason}`);
  console.log(`▸ Assistant: ${result.finalText}`);
  console.log(`\n▸ See timeline at http://localhost:3000/executions/${result.executionId}\n`);
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
