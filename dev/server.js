'use strict';
// Local dev server — serves the static /site and the /api/* handlers, backed by the
// embedded PGlite database from Phase 0b. This is the SAME handler code the Cloudflare
// Pages Functions call, so what works here works deployed. No Cloudflare needed to develop.
//
//   PGLITE_DIR=.pglite node dev/server.js   (defaults to .pglite if present)

const http = require('http');
const fs = require('fs');
const path = require('path');
const { getDb } = require('../lib/db');
const H = require('../lib/api/handlers');

const ROOT = path.resolve(__dirname, '..');
const SITE = path.join(ROOT, 'site');
const PORT = process.env.PORT || 8788;
if (!process.env.DATABASE_URL && !process.env.PGLITE_DIR) process.env.PGLITE_DIR = path.join(ROOT, '.pglite');

const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.json': 'application/json' };
const rxCache = new Map();

function sendJson(res, r) {
  res.writeHead(r.status, { 'Content-Type': 'application/json; charset=utf-8', ...(r.headers || {}) });
  res.end(JSON.stringify(r.body));
}

function serveStatic(req, res) {
  let rel = decodeURIComponent(req.url.split('?')[0]);
  if (rel === '/') rel = '/index.html';
  const file = path.join(SITE, path.normalize(rel));
  if (!file.startsWith(SITE) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('Not found'); return;
  }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
}

async function main() {
  const db = await getDb();
  console.log(`DB backend: ${db.kind}`);

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    try {
      if (url.pathname === '/api/counties' && req.method === 'GET') return sendJson(res, await H.countiesHandler(db));
      if (url.pathname === '/api/meta' && req.method === 'GET') return sendJson(res, await H.metaHandler(db));
      if (url.pathname === '/api/rxnorm/search' && req.method === 'GET') {
        return sendJson(res, await H.rxnormSearchHandler(url.searchParams.get('q'), { fetch, cache: rxCache }));
      }
      if (url.pathname === '/api/results' && req.method === 'POST') {
        let raw = ''; for await (const c of req) raw += c;
        let body; try { body = JSON.parse(raw || '{}'); } catch { return sendJson(res, { status: 400, body: { error: 'invalid JSON' } }); }
        return sendJson(res, await H.resultsHandler(db, body));
      }
      if (url.pathname.startsWith('/api/')) return sendJson(res, { status: 404, body: { error: 'no such endpoint' } });
      return serveStatic(req, res);
    } catch (e) {
      console.error('handler error:', e);
      sendJson(res, { status: 500, body: { error: 'server error', detail: String(e.message) } });
    }
  });
  server.listen(PORT, () => console.log(`PlanRobin dev server on http://localhost:${PORT}`));
}

main().catch((e) => { console.error(e); process.exit(1); });
