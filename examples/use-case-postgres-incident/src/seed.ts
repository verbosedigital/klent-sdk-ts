import postgres from 'postgres';

const userlandUrl =
  process.env.USERLAND_DATABASE_URL ?? 'postgres://klent:klent@localhost:5432/userland';

const adminUrl = userlandUrl.replace(/\/[^/]+$/, '/postgres');
const dbName = userlandUrl.match(/\/([^/]+)$/)?.[1] ?? 'userland';

async function main() {
  const admin = postgres(adminUrl, { max: 1, onnotice: () => {} });
  const exists = await admin`SELECT 1 FROM pg_database WHERE datname = ${dbName}`;
  if (exists.length === 0) {
    await admin.unsafe(`CREATE DATABASE "${dbName}"`);
    console.log(`▸ Created database "${dbName}".`);
  } else {
    console.log(`▸ Database "${dbName}" already exists.`);
  }
  await admin.end();

  const sql = postgres(userlandUrl, { max: 1, onnotice: () => {} });

  await sql`
    CREATE TABLE IF NOT EXISTS users (
      id serial PRIMARY KEY,
      name text NOT NULL,
      email text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    )
  `;

  await sql`TRUNCATE users RESTART IDENTITY`;

  const rows = [
    { name: 'Bob Stone', email: 'BoB@Example.com' },
    { name: 'Jane Doe', email: 'JANE@example.com' },
    { name: 'Alice Park', email: 'Alice.Park@Acme.io' },
    { name: 'Karim Salah', email: 'karim@MEGACORP.com' },
    { name: 'Marta Ruiz', email: 'Marta.Ruiz@startup.dev' },
  ];

  for (const r of rows) {
    await sql`INSERT INTO users (name, email) VALUES (${r.name}, ${r.email})`;
  }

  const all = await sql`SELECT id, name, email FROM users ORDER BY id`;
  console.log(`\n▸ Seeded ${all.length} rows in ${dbName}.users:\n`);
  for (const r of all) {
    console.log(`  #${r.id}  ${r.name.padEnd(14)}  ${r.email}`);
  }
  console.log('');

  await sql.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
