// GET /api/rxnorm/search?q=  — proxy + cache RxNorm product search (server-side only).
import { rxnormSearchHandler } from '../../../lib/api/handlers.js';
import { envDb, closeDb, json } from '../../../lib/pages.js';

export async function onRequestGet({ request, env, waitUntil }) {
  const q = new URL(request.url).searchParams.get('q');
  // db is best-effort here (used only to flag/sort products no plan covers).
  let db = null;
  try { db = envDb(env); } catch (_) { db = null; }
  try {
    // Cloudflare edge caches on the Cache-Control the handler returns; drug names change rarely.
    const r = await rxnormSearchHandler(q, { fetch, db });
    return json(r.status, r.body, r.headers);
  } catch (e) {
    return json(502, { error: 'rxnorm upstream error', detail: String(e.message) });
  } finally {
    closeDb(db, waitUntil);
  }
}
