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
import { readFileSync, existsSync, statSync } from 'fs';
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

// index.html is GENERATED (make-*-index.mjs applies platform deltas), so it can't
// be md5-compared against source. But the common mistake is forgetting to
// regenerate it before a build — catch that by mtime: if source index.html is
// newer than the staged web/index.html, the bundle is stale.
const webIndex = join(webDir, 'index.html');
if (existsSync('index.html') && existsSync(webIndex)) {
  if (statSync('index.html').mtimeMs > statSync(webIndex).mtimeMs) {
    console.log('✗ STALE: web/index.html is OLDER than source index.html — regenerate it (node make-android-index.mjs / make-ios-index.mjs) before building.');
    drift++;
  } else {
    console.log('✓ index.html (web bundle is up to date with source)');
  }
}

// Platform guard: web/index.html must carry the RIGHT platform's viewport-fit.
// iOS needs cover (Dynamic Island safe-area inset); Android/PWA use contain. Because
// Capacitor's webDir is a single shared folder, copying the Android bundle into the
// iOS project shipped a buried, barely-tappable top bar in 1.0.5. This catches that
// class of wrong-bundle mistake. Pass the target platform as the 2nd arg:
//   node check-web-bundle.mjs ../robograder-ios/web ios
//   node check-web-bundle.mjs ../robograder-ios/web android
const platform = process.argv[3];
if (platform && existsSync(webIndex)) {
  const want = platform === 'ios' ? 'viewport-fit=cover'
             : platform === 'android' ? 'viewport-fit=contain' : null;
  if (want) {
    const wi = readFileSync(webIndex, 'utf8');
    if (wi.includes(want)) {
      console.log(`✓ viewport-fit correct for ${platform} (${want})`);
    } else {
      console.log(`✗ WRONG BUNDLE: ${webIndex} does not contain ${want} — this looks like the other platform's bundle. Regenerate the ${platform} index before building.`);
      drift++;
    }
  }
}

console.log(`\nChecking ${refs.length} bundled sibling(s) against ${webDir}\n`);
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
