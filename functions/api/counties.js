// GET /api/counties  — Missouri counties for the dropdown.
import { countiesHandler } from '../../lib/api/handlers.js';
import { envDb, json } from '../../lib/pages.js';

export async function onRequestGet({ env }) {
  try {
    const r = await countiesHandler(envDb(env));
    return json(r.status, r.body, { 'cache-control': 'public, max-age=3600', ...(r.headers || {}) });
  } catch (e) {
    return json(500, { error: 'server error', detail: String(e.message) });
  }
}
