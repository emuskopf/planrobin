// POST /api/results  { county, rxcuis:[] }  — per-plan drug costs for a county.
import { resultsHandler } from '../../lib/api/handlers.js';
import { envDb, closeDb, json } from '../../lib/pages.js';

export async function onRequestPost({ request, env, waitUntil }) {
  let body;
  try { body = await request.json(); } catch { return json(400, { error: 'invalid JSON body' }); }
  let db;
  try {
    db = envDb(env);
    const r = await resultsHandler(db, body);
    return json(r.status, r.body, r.headers);
  } catch (e) {
    return json(500, { error: 'server error', detail: String(e.message) });
  } finally {
    closeDb(db, waitUntil);
  }
}
