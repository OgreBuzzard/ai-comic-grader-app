// check-index-syntax.mjs — does index.html still PARSE?
//
// WHY THIS EXISTS: index.html is ~970KB with ten inline <script> blocks, and
// `node --check index.html` is meaningless — node would parse the HTML as JS
// and fail on the first tag. So there was no syntax gate on the biggest file
// in the project at all, and a broken edit was only discoverable by loading
// the app. This is the index.html equivalent of the import test that catches
// a stray backtick in print-label.js.
//
// It extracts every inline block (skipping <script src=...>) and runs
// `node --check` on each, as a module when the tag says type="module".
//
// It is a SYNTAX gate, not a behaviour one: it cannot tell you a function is
// now unreachable or an id no longer exists. Run it after every edit to
// index.html, before anything else.
//
//   node check-index-syntax.mjs            (defaults to ./index.html)
//   node check-index-syntax.mjs some.html
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';

const target = process.argv[2] || 'index.html';
if (!fs.existsSync(target)) { console.error(`not found: ${target}`); process.exit(2); }
const s = fs.readFileSync(target, 'utf8');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'idxchk-'));
let n = 0, bad = 0;

for (const m of s.matchAll(/<script(?![^>]*\bsrc=)[^>]*>/g)) {
  const start = m.index + m[0].length;
  const end = s.indexOf('</script>', start);
  if (end < 0) continue;
  n++;
  const line = s.slice(0, m.index).split('\n').length;
  const isModule = /type\s*=\s*["']module["']/.test(m[0]);
  const f = path.join(tmp, `b${n}.${isModule ? 'mjs' : 'js'}`);
  fs.writeFileSync(f, s.slice(start, end));
  try {
    execFileSync(process.execPath, ['--check', f], { stdio: 'pipe' });
    console.log(`  ok    block ${n} (line ${line}${isModule ? ', module' : ''})`);
  } catch (e) {
    bad++;
    console.log(`  FAIL  block ${n} (line ${line}${isModule ? ', module' : ''})`);
    const err = (e.stderr || '').toString().trim().split('\n').slice(0, 6);
    for (const l of err) console.log(`        ${l}`);
  }
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${n} inline script block(s), ${bad} failing.`);
if (bad) { console.log('DO NOT DEPLOY.'); process.exit(1); }
