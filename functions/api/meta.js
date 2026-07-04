// GET /api/meta  — data provenance from ingest_runs (never hardcoded).
import { metaHandler } from '../../lib/api/handlers.js';
import { envDb, closeDb, json } from '../../lib/pages.js';

export async function onRequestGet({ env, waitUntil }) {
  let db;
  try {
    db = envDb(env);
    const r = await metaHandler(db);
    return json(r.status, r.body, { 'cache-control': 'public, max-age=3600', ...(r.headers || {}) });
  } catch (e) {
    return json(500, { error: 'server error', detail: String(e.message) });
  } finally {
    closeDb(db, waitUntil);
  }
}
