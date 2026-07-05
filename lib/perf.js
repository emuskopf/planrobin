'use strict';
// Lightweight DB instrumentation — wraps a db handle's .query() to count round trips and sum
// the time spent in the database. Zero deps, no PII, safe on the Workers runtime. Used by the
// API routes (structured per-request log, visible in Cloudflare) and the perf measurement script.

function instrument(db) {
  const stats = { queries: 0, dbMs: 0 };
  const orig = db.query.bind(db);
  const wrapped = {
    ...db,
    stats,
    query: async (text, params) => {
      const t0 = Date.now();
      try { return await orig(text, params); }
      finally { stats.queries += 1; stats.dbMs += Date.now() - t0; }
    },
    // keep exec/end passthrough
    exec: db.exec ? db.exec.bind(db) : undefined,
    end: db.end ? db.end.bind(db) : undefined,
  };
  return wrapped;
}

// One structured line per API request. Cloudflare captures console.log; no third-party analytics.
function logRequest(meta) {
  try { console.log(JSON.stringify({ ev: 'api', ...meta })); } catch (_) { /* never throw from logging */ }
}

module.exports = { instrument, logRequest };
