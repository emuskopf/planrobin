'use strict';
// Postgres adapter for the Cloudflare Pages Functions (Workers runtime) and Node.
// Exposes the SAME .query(sql, params) => { rows } interface as lib/db.js, so the typed
// tools run unchanged. Uses postgres.js, which works on Workers with the `nodejs_compat`
// compatibility flag. NEVER runs in the browser — the connection string stays server-side.
//
// For Supabase, point DATABASE_URL at the connection **pooler** (port 6543, transaction
// mode); prepare:false is required in that mode.

const postgres = require('postgres');

function makePgDb(connectionString) {
  const sql = postgres(connectionString, {
    max: 1,            // one socket per isolate; the pooler handles concurrency
    prepare: false,    // required for Supabase transaction-mode pooler
    idle_timeout: 20,
    ssl: 'require',
  });
  return {
    kind: 'postgres-js',
    query: async (text, params = []) => ({ rows: await sql.unsafe(text, params) }),
    end: () => sql.end({ timeout: 5 }),
  };
}

module.exports = { makePgDb };
