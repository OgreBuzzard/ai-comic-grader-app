#!/usr/bin/env node
// check-native-bundles.mjs — assert that what Xcode and Android Studio will
// ACTUALLY COMPILE contains the current version and every feature that must not
// silently disappear.
//
// Usage:  node check-native-bundles.mjs [path-to-robograder-ios]   (default ../robograder-ios)
//
// WHY THIS EXISTS, and why check-web-bundle.mjs is not enough.
// There are two copy steps between a source edit and the app:
//
//   ai-comic-grader-app/index.html
//        |  make-ios-index.mjs / make-android-index.mjs      <-- STEP 2 / STEP 9
//        v
//   robograder-ios/web/index.html
//        |  npx cap sync ios / android                       <-- STEP 3 / STEP 10
//        v
//   ios/App/App/public/index.html          <-- what Xcode builds
//   android/app/src/main/assets/public/    <-- what Android Studio builds
//
// check-web-bundle.mjs validates the FIRST arrow only. On 2026-10-17 it printed
// a clean "web bundle is in sync with source" for an iOS archive whose bundled
// index.html was four weeks old, because STEP 3 had not run. That build (1.13
// build 23) was uploaded to Apple containing none of the release.
//
// This script looks at the END of the chain instead, so it catches BOTH a
// skipped sync AND a feature that went missing in a bad merge or revert.
//
// RUN IT IMMEDIATELY BEFORE ARCHIVE / GENERATE SIGNED BUNDLE. A red line here
// means do not build.

import fs from 'node:fs';
import path from 'node:path';
import { ROBOGRADE_VERSION } from './lib/version.js';

const ROOT = process.argv[2] || '../robograder-ios';

// ── FEATURES THAT MUST SURVIVE EVERY BUILD ───────────────────────────────────
// Add a line here when a fix is expensive to lose or was invisible when broken.
// Keep the marker a distinctive string from the shipped code, not a comment, so
// a revert cannot leave the comment behind and pass.
const FEATURES = [
  ['Android image save (Capacitor Filesystem+Share)', 'native save failed, falling back'],
  ['grade "(+)" ceiling mark',                        'ubadge-plus'],
  ['off-ladder grade guard wiring',                   'gradeAtCeiling'],
  ['FMV printing/variant classifier',                 'fmvPrintingSlug'],
  ['Watching entries may be shared',                  '_publicEligibleOwnership'],
  ['share text uses the v3 grade',                    '_v3share'],
];

// Platform deltas: [label, marker, mustBeInIos, mustBeInAndroid]
const DELTAS = [
  ['iOS StoreKit purchasing',  '_iosLoadPrices',            true,  false],
  ['Play Billing purchasing',  '_androidLoadPrices',        false, true ],
  ['WKWebView auth persistence', 'indexedDBLocalPersistence', true,  true ],
];

const SIBLINGS = ['robograde-panel.js', 'scan-animation.js', 'slab-detect.js', 'print-label.js'];

const TARGETS = [
  { name: 'iOS',     dir: path.join(ROOT, 'ios/App/App/public'),            isIos: true  },
  { name: 'Android', dir: path.join(ROOT, 'android/app/src/main/assets/public'), isIos: false },
];

let failed = 0;
const ok   = m => console.log('  \x1b[32mok\x1b[0m    ' + m);
const bad  = m => { failed++; console.log('  \x1b[31mFAIL\x1b[0m  ' + m); };

console.log(`\nchecking native bundles against source version ${ROBOGRADE_VERSION}\n`);

for (const t of TARGETS) {
  console.log(`${t.name} — ${t.dir}`);
  const idx = path.join(t.dir, 'index.html');

  if (!fs.existsSync(idx)) {
    bad(`index.html missing. Run: npx cap sync ${t.isIos ? 'ios' : 'android'}`);
    console.log('');
    continue;
  }

  const html = fs.readFileSync(idx, 'utf8');

  // 1. version stamp — the single clearest sign of a skipped sync
  if (html.includes(ROBOGRADE_VERSION)) {
    ok(`carries version ${ROBOGRADE_VERSION}`);
  } else {
    const found = (html.match(/\b5\.\d{1,2}\b/g) || []).sort().pop() || 'none found';
    bad(`version ${ROBOGRADE_VERSION} NOT in this bundle (newest stamp present: ${found}). `
        + `The generator ran but the sync did not — run: npx cap sync ${t.isIos ? 'ios' : 'android'}`);
  }

  // 2. the generated bundle must be at least as new as the source
  const srcM = fs.statSync('index.html').mtimeMs;
  if (fs.statSync(idx).mtimeMs >= srcM) ok('newer than ai-comic-grader-app/index.html');
  else bad('OLDER than ai-comic-grader-app/index.html — regenerate, then sync');

  // 3. features that must not silently disappear
  for (const [label, marker] of FEATURES) {
    if (html.includes(marker)) ok(label);
    else bad(`${label} — MISSING (looked for "${marker}")`);
  }

  // 4. the right platform variant landed here
  for (const [label, marker, wantIos, wantAndroid] of DELTAS) {
    const want = t.isIos ? wantIos : wantAndroid;
    const has  = html.includes(marker);
    if (has === want) ok(want ? label : `no ${label} (correct for ${t.name})`);
    else if (want)    bad(`${label} — MISSING from the ${t.name} bundle`);
    else              bad(`${label} — PRESENT in the ${t.name} bundle. The wrong generator ran last.`);
  }

  // 5. sibling scripts copied alongside
  for (const s of SIBLINGS) {
    const a = path.join(t.dir, s), b = s;
    if (!fs.existsSync(a)) { bad(`${s} missing from the bundle`); continue; }
    if (fs.readFileSync(a).equals(fs.readFileSync(b))) ok(s);
    else bad(`${s} differs from source — re-copy it, then sync`);
  }

  console.log('');
}

if (failed) {
  console.log(`\x1b[31m${failed} problem(s). DO NOT ARCHIVE.\x1b[0m`);
  console.log('Fix, then re-run. The usual cause is a skipped `npx cap sync`.\n');
  process.exit(1);
}
console.log('\x1b[32mAll checks passed — both native projects will build ' + ROBOGRADE_VERSION + '.\x1b[0m\n');
