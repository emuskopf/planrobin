'use strict';
// Small helpers shared by the Cloudflare Pages Functions.

const { makePgDb } = require('./db_pg');

// Build a DB handle for THIS request. Do NOT memoize across requests: on the Workers
// runtime an I/O object (socket) created in one request cannot be used by another
// ("Cannot perform I/O on behalf of a different request"). With Hyperdrive, connecting
// per request is the intended, cheap pattern — Hyperdrive keeps the real pool warm.
function envDb(env) {
  const hyper = env && env.HYPERDRIVE && env.HYPERDRIVE.connectionString;
  const url = hyper || (env && (env.DATABASE_URL || env.SUPABASE_DB_URL));
  if (!url) throw new Error('No database configured (Hyperdrive binding or DATABASE_URL)');
  return makePgDb(url, hyper ? { ssl: false } : {});
}

// Close the connection after the response is sent (waitUntil keeps it in-request).
function closeDb(db, waitUntil) {
  if (!db || typeof db.end !== 'function') return;
  const p = Promise.resolve().then(() => db.end()).catch(() => {});
  if (typeof waitUntil === 'function') waitUntil(p);
}

function json(status, body, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...headers },
  });
}

module.exports = { envDb, closeDb, json };
