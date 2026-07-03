'use strict';
// Database access, one uniform API over two backends:
//   - Supabase / Postgres  when DATABASE_URL (or SUPABASE_DB_URL) is set  -> node-postgres
//   - embedded PGlite       otherwise (local dev, CI, hermetic tests)      -> @electric-sql/pglite
//
// Both speak the same Postgres SQL and the same $1,$2 placeholders, so the ingestion
// job and the query tools are written once and run against either. Returned shape from
// query() is always { rows }.

const fs = require('fs');
const path = require('path');

const MIGRATIONS_DIR = path.resolve(__dirname, '..', 'migrations');

async function getDb() {
  const url = process.env.DATABASE_URL || process.env.SUPABASE_DB_URL;
  if (url) {
    const { Client } = require('pg');
    // Managed Postgres (Supabase) generally requires TLS; allow opt-out with PGSSL=disable.
    const ssl = process.env.PGSSL === 'disable' ? false : { rejectUnauthorized: false };
    const client = new Client({ connectionString: url, ssl });
    await client.connect();
    return {
      kind: 'postgres',
      query: (sql, params) => client.query(sql, params),
      exec: (sql) => client.query(sql),
      end: () => client.end(),
    };
  }
  const { PGlite } = await import('@electric-sql/pglite');
  const dir = process.env.PGLITE_DIR || undefined; // undefined => in-memory (fresh)
  const db = new PGlite(dir);
  await db.waitReady;
  return {
    kind: 'pglite',
    query: (sql, params) => db.query(sql, params),
    exec: (sql) => db.exec(sql),
    end: () => db.close(),
  };
}

// Apply every migrations/*.sql in filename order. Idempotent (migrations use IF NOT EXISTS).
async function applyMigrations(db) {
  const files = fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();
  for (const f of files) {
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, f), 'utf8');
    await db.exec(sql);
  }
  return files;
}

module.exports = { getDb, applyMigrations, MIGRATIONS_DIR };
