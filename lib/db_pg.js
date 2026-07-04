'use strict';
// Postgres adapter for the Cloudflare Pages Functions (Workers runtime) and Node.
// Exposes the SAME .query(sql, params) => { rows } interface as lib/db.js, so the typed
// tools run unchanged. Uses postgres.js, which works on Workers with the `nodejs_compat`
// compatibility flag. NEVER runs in the browser — the connection string stays server-side.
//
// For Supabase, point DATABASE_URL at the connection **pooler** (port 6543, transaction
// mode); prepare:false is required in that mode.

// Interop: in Node, require('postgres') is the function; when esbuild bundles this for the
// Cloudflare Workers runtime it can come back as { default: fn }. Unwrap either shape.
const postgresLib = require('postgres');
const postgres = postgresLib.default || postgresLib;

function makePgDb(connectionString, opts = {}) {
  const sql = postgres(connectionString, {
    max: opts.max || 5,
    prepare: false,       // safe with poolers; avoids named prepared statements
    fetch_types: false,   // skip type-introspection round trips (important on Workers)
    idle_timeout: 20,
    // Hyperdrive's local endpoint doesn't use TLS; direct Supabase does. Caller decides.
    ssl: 'ssl' in opts ? opts.ssl : 'require',
  });
  return {
    kind: 'postgres-js',
    query: async (text, params = []) => ({ rows: await sql.unsafe(text, params) }),
    end: () => sql.end({ timeout: 5 }),
  };
}

module.exports = { makePgDb };
