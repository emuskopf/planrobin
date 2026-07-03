'use strict';
// Small helpers shared by the Cloudflare Pages Functions.

const { makePgDb } = require('./db_pg');

let _db = null; // reused across requests within the same Worker isolate

function envDb(env) {
  if (!env || !env.DATABASE_URL) throw new Error('DATABASE_URL is not configured on the server');
  if (!_db) _db = makePgDb(env.DATABASE_URL);
  return _db;
}

function json(status, body, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...headers },
  });
}

module.exports = { envDb, json };
