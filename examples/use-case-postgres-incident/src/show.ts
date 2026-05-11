import postgres from 'postgres';

const url = process.env.USERLAND_DATABASE_URL ?? 'postgres://klent:klent@localhost:5432/userland';

async function main() {
  const sql = postgres(url, { max: 1, onnotice: () => {} });
  const rows = await sql<{ id: number; name: string; email: string }[]>`
    SELECT id, name, email FROM users ORDER BY id
  `;
  console.log(`\nusers (${rows.length}):\n`);
  for (const r of rows) {
    console.log(`  #${r.id}  ${r.name.padEnd(14)}  ${r.email}`);
  }
  console.log('');
  await sql.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
