// POST /api/results  { county, rxcuis:[], quantities:{} }  — per-plan drug costs for a county.
// Edge-cached (caches.default) keyed by inputs + current ingest_run id; busts on a new quarter.
import { resultsHandler } from '../../lib/api/handlers.js';
import { envDb, closeDb, json, currentRunId, matchResults, cacheResults } from '../../lib/pages.js';
import { instrument, logRequest } from '../../lib/perf.js';

export async function onRequestPost({ request, env, waitUntil }) {
  const t0 = Date.now();
  let body;
  try { body = await request.json(); } catch { return json(400, { error: 'invalid JSON body' }); }
  let db;
  try {
    db = instrument(envDb(env));
    const runId = await currentRunId(db, waitUntil);
    const keyParts = { c: body && body.county, r: [...((body && body.rxcuis) || [])].map(String).sort(), q: (body && body.quantities) || {}, run: runId };

    const { cache, cacheKey, hit } = await matchResults(keyParts);
    if (hit) {
      logRequest({ path: '/api/results', ms: Date.now() - t0, dbMs: db.stats.dbMs, queries: db.stats.queries, status: 200, cache: 'HIT' });
      return hit;
    }

    const r = await resultsHandler(db, body);
    logRequest({ path: '/api/results', ms: Date.now() - t0, dbMs: db.stats.dbMs, queries: db.stats.queries, status: r.status, plans: r.body && r.body.planCount, cache: 'MISS' });
    return cacheResults(cache, cacheKey, r, waitUntil);
  } catch (e) {
    logRequest({ path: '/api/results', ms: Date.now() - t0, dbMs: db && db.stats ? db.stats.dbMs : 0, queries: db && db.stats ? db.stats.queries : 0, status: 500, error: String(e.message) });
    return json(500, { error: 'server error', detail: String(e.message) });
  } finally {
    closeDb(db, waitUntil);
  }
}
