// GET /api/rxnorm/search?q=  — proxy + cache RxNorm product search (server-side only).
import { rxnormSearchHandler } from '../../../lib/api/handlers.js';
import { json } from '../../../lib/pages.js';

export async function onRequestGet({ request }) {
  const q = new URL(request.url).searchParams.get('q');
  try {
    // Cloudflare edge caches on the Cache-Control the handler returns; drug names change rarely.
    const r = await rxnormSearchHandler(q, { fetch });
    return json(r.status, r.body, r.headers);
  } catch (e) {
    return json(502, { error: 'rxnorm upstream error', detail: String(e.message) });
  }
}
