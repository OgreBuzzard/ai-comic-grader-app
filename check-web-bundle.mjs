// check-web-bundle.mjs — guard against stale bundled sibling files.
//
// The iOS/Android apps bundle top-level JS/CSS referenced by index.html via
// <script src="/x.js"> / <link href="/x.css"> — loaded from the app's OWN assets,
// not the server. Regenerating index.html (make-*-index.mjs) does NOT restage
// these siblings, so they silently go stale in the app bundle. That is exactly
// how renderPhotograderPanel (robograde-panel.js) went missing in 1.0.4.
//
// Run this BEFORE every iOS/Android build. Exits non-zero if anything drifted.
//   node check-web-bundle.mjs [path-to-web-dir]   (default: ../robograder-ios/web)
import { readFileSync, existsSync } from 'fs';
import { createHash } from 'crypto';
import { join } from 'path';

const webDir = process.argv[2] || '../robograder-ios/web';
const src = readFileSync('index.html', 'utf8');

// Local (leading-slash) script/link refs are the bundled siblings. External CDN
// refs are full https:// URLs and won't match, so they're correctly ignored.
const refs = [...new Set(
  [...src.matchAll(/(?:src|href)="\/([a-zA-Z0-9_.\-]+\.(?:js|css))"/g)].map(m => m[1])
)];

const md5 = f => createHash('md5').update(readFileSync(f)).digest('hex');
let drift = 0;

console.log(`Checking ${refs.length} bundled sibling(s) against ${webDir}\n`);
for (const f of refs) {
  if (!existsSync(f)) { console.log(`skip (not a repo file): ${f}`); continue; }
  const staged = join(webDir, f);
  if (!existsSync(staged)) { console.log(`✗ MISSING in bundle: ${f}`); drift++; continue; }
  if (md5(f) !== md5(staged)) { console.log(`✗ STALE in bundle: ${f}  (repo differs from ${staged})`); drift++; }
  else console.log(`✓ ${f}`);
}

if (drift) {
  console.error(`\n${drift} bundled file(s) out of sync. Copy them into ${webDir} (and re-run npx cap copy) before building.`);
  process.exit(1);
}
console.log('\n✓ web bundle is in sync with source.');
