#!/usr/bin/env node
/*
 * sync-version.mjs — make lib/version.js the ONLY place a version is written.
 *
 * WHY THIS EXISTS
 * lib/version.js was created to be the single source of truth, and for the
 * SERVER it is: every api/* endpoint imports ROBOGRADE_VERSION. The browser
 * cannot import it — index.html and public.html are served as static files with
 * no build step — so each carries a hand-typed MIRROR of the number.
 *
 * Hand-typed mirrors drift. index.html sat at 5.16 against a 5.21 version.js
 * (caught in S22), and public.html sat at 5.25 against a 5.26 version.js
 * (caught at 5.27). The S22 fix added version INJECTION to make-ios-index.mjs
 * and make-android-index.mjs, which is why the NATIVE bundles cannot drift —
 * but those generators only touch index.html, so public.html was never covered
 * and the web PWA still depended on somebody remembering.
 *
 * This removes the remembering. Bump here, not in the files.
 *
 *   node sync-version.mjs 5.28     bump lib/version.js, stamp every mirror
 *   node sync-version.mjs          re-stamp mirrors from the current version.js
 *   node sync-version.mjs --check  change nothing; exit 1 if anything is adrift
 *
 * --check is the one to run before a deploy. It is also safe to run any time.
 *
 * Adding a surface: add a row to MIRRORS. Each row's `re` must match exactly
 * once, and must capture the version literal in group 1. A row that matches
 * zero times or more than once FAILS the run rather than silently skipping —
 * a mirror this script cannot see is a mirror that will strand.
 */
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const VERSION_FILE = path.join(ROOT, 'lib/version.js');
const VERSION_RE = /export const ROBOGRADE_VERSION = '([0-9]+\.[0-9]+)';/;

const MIRRORS = [
  { file: 'index.html',  what: 'PWA version line (primary)',
    re: /window\.RG_GRADING_VERSION = window\.RG_GRADING_VERSION \|\| "([0-9]+\.[0-9]+)";/ },
  { file: 'index.html',  what: 'PWA version line (render fallback)',
    re: /var base = "Robograder v" \+ \(window\.RG_GRADING_VERSION \|\| "([0-9]+\.[0-9]+)"\);/ },
  { file: 'index.html',  what: 'appVersion reported to the server',
    re: /appVersion: \(window\.RG_GRADING_VERSION \|\| "([0-9]+\.[0-9]+)"\),/ },
  { file: 'public.html', what: 'public listing page',
    re: /window\.RG_GRADING_VERSION = "([0-9]+\.[0-9]+)";/ },
];

const args = process.argv.slice(2);
const checkOnly = args.includes('--check');
const target = args.find(a => /^[0-9]+\.[0-9]+$/.test(a)) || null;
const bad = args.filter(a => a !== '--check' && a !== target);
if (bad.length) {
  console.error(`✗ unrecognised argument: ${bad.join(' ')}`);
  console.error('  usage: node sync-version.mjs [<x.yz>] [--check]');
  process.exit(2);
}
if (target && checkOnly) {
  console.error('✗ --check does not take a version. It compares; it never writes.');
  process.exit(2);
}

let vsrc = fs.readFileSync(VERSION_FILE, 'utf8');
const vm = vsrc.match(VERSION_RE);
if (!vm) {
  console.error('✗ could not find ROBOGRADE_VERSION in lib/version.js. Nothing was changed.');
  process.exit(1);
}
let version = vm[1];

if (target) {
  if (target === version) {
    console.log(`  lib/version.js is already ${version}; syncing mirrors only.`);
  } else {
    vsrc = vsrc.replace(VERSION_RE, `export const ROBOGRADE_VERSION = '${target}';`);
    fs.writeFileSync(VERSION_FILE, vsrc);
    console.log(`  ✓ lib/version.js  ${version} → ${target}`);
    version = target;
  }
}

let drift = 0, changed = 0, failed = 0;
const cache = new Map();
const read = f => {
  if (!cache.has(f)) cache.set(f, fs.readFileSync(path.join(ROOT, f), 'utf8'));
  return cache.get(f);
};

for (const m of MIRRORS) {
  let src;
  try { src = read(m.file); }
  catch { console.error(`  ✗ ${m.file} — cannot read (${m.what})`); failed++; continue; }

  const all = src.match(new RegExp(m.re.source, 'g')) || [];
  if (all.length !== 1) {
    console.error(`  ✗ ${m.file} — ${m.what}: pattern matched ${all.length} times, expected exactly 1.`);
    console.error('    The file changed shape. FIX THE PATTERN — do not leave this unmatched.');
    failed++;
    continue;
  }
  const found = src.match(m.re)[1];
  if (found === version) { console.log(`  ✓ ${m.file} — ${m.what}: ${found}`); continue; }

  drift++;
  if (checkOnly) {
    console.error(`  ✗ ADRIFT  ${m.file} — ${m.what}: ${found}, expected ${version}`);
  } else {
    cache.set(m.file, src.replace(m.re, (s, g) => s.replace(`"${g}"`, `"${version}"`)));
    changed++;
    console.log(`  ✓ ${m.file} — ${m.what}: ${found} → ${version}`);
  }
}

if (!checkOnly) for (const [f, src] of cache) fs.writeFileSync(path.join(ROOT, f), src);

if (failed) {
  console.error(`\n✗ ${failed} mirror pattern(s) could not be located. Treat this as a BLOCKER: a mirror this script cannot see is a mirror that will strand.`);
  process.exit(1);
}
if (checkOnly) {
  if (drift) { console.error(`\n✗ ${drift} mirror(s) adrift from lib/version.js (${version}). Run: node sync-version.mjs`); process.exit(1); }
  console.log(`\n✓ all ${MIRRORS.length} mirrors agree with lib/version.js (${version}).`);
} else {
  console.log(`\n✓ ${version} — ${changed} mirror(s) updated, ${MIRRORS.length - changed} already correct.`);
  console.log('  Native bundles take their version by injection at generate time; no action needed here.');
}
