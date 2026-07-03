// POST /api/results  { county, rxcuis:[] }  — per-plan drug costs for a county.
import { resultsHandler } from '../../lib/api/handlers.js';
import { envDb, json } from '../../lib/pages.js';

export async function onRequestPost({ request, env }) {
  let body;
  try { body = await request.json(); } catch { return json(400, { error: 'invalid JSON body' }); }
  try {
    const r = await resultsHandler(envDb(env), body);
    return json(r.status, r.body, r.headers);
  } catch (e) {
    return json(500, { error: 'server error', detail: String(e.message) });
  }
}
