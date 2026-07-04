'use strict';
// Small helpers shared by the Cloudflare Pages Functions.

const { makePgDb } = require('./db_pg');

let _db = null; // reused across requests within the same Worker isolate

function envDb(env) {
  // Prefer the Hyperdrive binding (pooled at the edge); fall back to a direct DATABASE_URL.
  const hyper = env && env.HYPERDRIVE && env.HYPERDRIVE.connectionString;
  const url = hyper || (env && (env.DATABASE_URL || env.SUPABASE_DB_URL));
  if (!url) throw new Error('No database configured (Hyperdrive binding or DATABASE_URL)');
  if (!_db) _db = makePgDb(url, hyper ? { ssl: false } : {});
  return _db;
}

function json(status, body, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...headers },
  });
}

module.exports = { envDb, json };
