// Share-link state codec. State lives ENTIRELY in the URL fragment (#...), which browsers never
// send to a server — no logs, no analytics, consistent with "never stored". Versioned + compact
// (v1 = base64url of a small JSON) so future schema changes can still read old links.
// Loaded in the browser (window.PRShare) and require()-d by tests.
(function (global) {
  'use strict';

  function b64urlEncode(str) {
    const bytes = new TextEncoder().encode(str);
    let bin = '';
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }
  function b64urlDecode(s) {
    s = String(s).replace(/-/g, '+').replace(/_/g, '/');
    while (s.length % 4) s += '=';
    const bin = atob(s);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder().decode(bytes);
  }

  // state: { county: '26940', drugs: [ [rxcui, qty, name, kind], ... ] }
  // Returns the fragment payload (without a leading '#').
  function encode(state) {
    const payload = {
      v: 1,
      c: String((state && state.county) || ''),
      d: ((state && state.drugs) || []).map((x) => [String(x[0]), Number(x[1]) > 0 ? Number(x[1]) : 30, String(x[2] || ''), String(x[3] || '')]),
    };
    return 'v1.' + b64urlEncode(JSON.stringify(payload));
  }

  // Accepts a fragment with or without a leading '#'. Never throws.
  //   { ok:true, version, county, drugs:[{rxcui,qty,name,kind}] }  on success
  //   { ok:false, empty? , error? }                                otherwise
  function decode(fragment) {
    let f = String(fragment || '').trim();
    if (f.charAt(0) === '#') f = f.slice(1);
    if (!f) return { ok: false, empty: true };
    const dot = f.indexOf('.');
    const ver = dot >= 0 ? f.slice(0, dot) : '';
    if (ver !== 'v1') return { ok: false, error: 'unrecognized share-link version' };
    try {
      const obj = JSON.parse(b64urlDecode(f.slice(dot + 1)));
      if (!obj || obj.v !== 1) return { ok: false, error: 'malformed share link' };
      const drugs = (Array.isArray(obj.d) ? obj.d : [])
        .filter((x) => Array.isArray(x) && x[0])
        .map((x) => ({ rxcui: String(x[0]), qty: Number(x[1]) > 0 ? Number(x[1]) : 30, name: String(x[2] || ''), kind: String(x[3] || 'drug') }));
      return { ok: true, version: 1, county: String(obj.c || ''), drugs };
    } catch (e) {
      return { ok: false, error: 'could not read share link' };
    }
  }

  const api = { encode, decode };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else global.PRShare = api;
})(typeof window !== 'undefined' ? window : globalThis);
