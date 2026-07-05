// GET /api/zip?zip=63011  — resolve a ZIP to its Missouri county/counties. Quarterly -> cache hard.
import { zipHandler } from '../../lib/api/handlers.js';
import { envDb, closeDb, json } from '../../lib/pages.js';
import { instrument, logRequest } from '../../lib/perf.js';

export async function onRequestGet({ request, env, waitUntil }) {
  const t0 = Date.now();
  let db;
  try {
    const zip = new URL(request.url).searchParams.get('zip');
    db = instrument(envDb(env));
    const r = await zipHandler(db, zip);
    logRequest({ path: '/api/zip', ms: Date.now() - t0, dbMs: db.stats.dbMs, queries: db.stats.queries, status: r.status });
    return json(r.status, r.body, { 'cache-control': 'public, max-age=86400, stale-while-revalidate=604800', ...(r.headers || {}) });
  } catch (e) {
    return json(500, { error: 'server error', detail: String(e.message) });
  } finally {
    closeDb(db, waitUntil);
  }
}
