// check-cors.mjs — v6.73
//
// THE BUG THIS EXISTS FOR. The native apps load from capacitor://localhost and
// call https://robograder.app, so any request carrying an Authorization header
// (or a JSON Content-Type) is cross-origin and the WebView sends an OPTIONS
// preflight first. An endpoint that answers OPTIONS with anything but 2xx
// silently kills the real request in the apps while working perfectly on the
// website, which is same-origin and never preflights. /api/credit_settle did
// exactly that from 1.15 (7 Nov 2026) until 6.73: no native assessment was
// ever confirmed, and the credit sweep refunded every one of them.
//
// WHAT IT CHECKS. Every /api/<name> the app calls (found in index.html, and in
// print-label.js / robograde-panel.js / scan-animation.js) must have a handler
// that answers OPTIONS: either `applyCors(req, res)` from lib/batch_common.js
// or an explicit `req.method === 'OPTIONS'` branch. Exit 1 on any miss.
//
// Run with the other STEP 0 checks before every native build.
import fs from 'node:fs';

// The native generators inject calls of their own (verify_iap, verify_play,
// ios-auth), so they are scanned too.
const CLIENT = ['index.html', 'print-label.js', 'robograde-panel.js', 'scan-animation.js',
                'make-ios-index.mjs', 'make-android-index.mjs']
  .filter(f => fs.existsSync(f));
const called = new Set();
for (const f of CLIENT) {
  const s = fs.readFileSync(f, 'utf8');
  for (const m of s.matchAll(/["'`]\/api\/([a-z0-9_\-]+)/gi)) if (!m[1].endsWith('_')) called.add(m[1]);
}
// Same-origin-only or no-auth GETs that never preflight are still required to
// pass: a GET with an Authorization header preflights too, so no exemptions.
let bad = 0, ok = 0;
for (const name of [...called].sort()) {
  const p = `api/${name}.js`;
  if (!fs.existsSync(p)) { console.log(`  ?     /api/${name} — called by the app, no ${p} (rewrite or removed?)`); continue; }
  const s = fs.readFileSync(p, 'utf8');
  const handles = /applyCors\s*\(\s*req/.test(s) || /req\.method\s*===?\s*['"]OPTIONS['"]/.test(s);
  if (handles) { ok++; console.log(`  ok    /api/${name}`); }
  else { bad++; console.log(`\x1b[31m  ✗     /api/${name} — does not answer the OPTIONS preflight; it will fail in the native apps\x1b[0m`); }
}
console.log(bad ? `\n\x1b[31m✗ ${bad} endpoint(s) the app calls cannot be reached from the native apps.\x1b[0m`
                : `\n✓ all ${ok} endpoint(s) the app calls answer the preflight.`);
process.exit(bad ? 1 : 0);
