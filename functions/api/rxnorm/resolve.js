// POST /api/rxnorm/resolve  { rxcuis:[] }  — rxcui -> name + brand/generic, for the restore-code
// entry's per-line confirmation. Best-effort; degrades gracefully if RxNorm or the DB is down.
import { rxnormResolveHandler } from '../../../lib/api/handlers.js';
import { envDb, closeDb, json } from '../../../lib/pages.js';

export async function onRequestPost({ request, env, waitUntil }) {
  let body = {};
  try { body = await request.json(); } catch (_) { body = {}; }
  let db = null;
  try { db = envDb(env); } catch (_) { db = null; }
  try {
    const r = await rxnormResolveHandler(body, { fetch, db });
    return json(r.status, r.body, r.headers);
  } catch (e) {
    return json(502, { error: 'rxnorm upstream error', detail: String(e.message) });
  } finally {
    closeDb(db, waitUntil);
  }
}
