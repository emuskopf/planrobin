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

// --- Edge cache (results endpoint) --------------------------------------------------------
// The data changes only QUARTERLY, so cache aggressively. Keyed by the search inputs AND the
// current ingest_run id — a new quarterly ingest changes the id, which changes every key, so
// the cache busts naturally (no purge needed). Uses caches.default (per edge location).
// Everything is fail-safe: if the Cache API is unavailable (e.g. the Node dev server) or any
// step throws, we silently skip caching and serve the live result.
const RESULTS_TTL = 60 * 60 * 24; // 24h ceiling; the ingest_run in the key busts sooner on a new quarter

function edgeCache() {
  try { return (typeof caches !== 'undefined' && caches.default) ? caches.default : null; } catch (_) { return null; }
}

async function sha256Hex(s) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

// Current completed ingest_run id, cached per-colo for 5 min so it costs ~0 DB queries but
// refreshes soon after a quarterly re-ingest (then every results key changes -> natural bust).
async function currentRunId(db, waitUntil) {
  const cache = edgeCache();
  const key = new Request('https://planrobin.internal/runid');
  if (cache) { try { const h = await cache.match(key); if (h) return await h.text(); } catch (_) {} }
  let id = '0';
  try {
    const r = await db.query("select id from ingest_runs where status='completed' order by id desc limit 1");
    id = String((r.rows[0] && r.rows[0].id) || '0');
  } catch (_) {}
  if (cache && typeof waitUntil === 'function') {
    try { waitUntil(cache.put(key, new Response(id, { headers: { 'cache-control': 'public, max-age=300' } }))); } catch (_) {}
  }
  return id;
}

// Look for a cached results response for these inputs. Returns { cache, cacheKey, hit } — `hit`
// is a Response (already tagged x-cache: HIT) or null. Caller stores via cacheResults().
async function matchResults(keyParts) {
  const cache = edgeCache();
  if (!cache) return { cache: null, cacheKey: null, hit: null };
  try {
    const h = await sha256Hex(JSON.stringify(keyParts));
    const cacheKey = new Request(`https://planrobin.internal/results/${h}`);
    const cached = await cache.match(cacheKey);
    if (cached) { const r = new Response(cached.body, cached); r.headers.set('x-cache', 'HIT'); return { cache, cacheKey, hit: r }; }
    return { cache, cacheKey, hit: null };
  } catch (_) { return { cache: null, cacheKey: null, hit: null }; }
}

// Build the response, store a copy in the edge cache (200s only), and return it (x-cache: MISS).
function cacheResults(cache, cacheKey, r, waitUntil) {
  const res = json(r.status, r.body, { 'cache-control': `public, max-age=${RESULTS_TTL}`, 'x-cache': 'MISS', ...(r.headers || {}) });
  if (cache && cacheKey && r.status === 200) {
    try { waitUntil(cache.put(cacheKey, res.clone())); } catch (_) {}
  }
  return res;
}

module.exports = { envDb, closeDb, json, currentRunId, matchResults, cacheResults, RESULTS_TTL };
