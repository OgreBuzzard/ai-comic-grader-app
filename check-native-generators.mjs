// check-native-generators.mjs — v6.76
//
// Runs BOTH native bundle generators against index.html into a temp folder and
// fails if either one does. Nothing is written to the real bundles.
//
// WHY. The generators patch index.html by finding exact anchor strings, and
// stop if an anchor is missing or appears twice. On the night 1.16 was built,
// a comment in index.html containing the literal text of the head tag made
// the first anchor match twice, and the first anyone knew was STEP 2 failing
// mid-release. This is that failure moved to STEP 0, where it costs nothing.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rg-gen-'));
let bad = 0;
for (const [name, script] of [['iOS', 'make-ios-index.mjs'], ['Android', 'make-android-index.mjs']]) {
  try {
    execFileSync('node', [script, 'index.html', path.join(tmp, name + '.html')], { stdio: 'pipe', maxBuffer: 64 * 1024 * 1024 });
    console.log(`  ok    ${name} generator applies every delta`);
  } catch (e) {
    bad++;
    const out = String((e.stdout || '')) + String((e.stderr || ''));
    const fail = out.split('\n').filter(l => /FAIL/.test(l)).slice(0, 3).join('\n        ');
    console.log(`\x1b[31m  ✗     ${name} generator FAILED\x1b[0m\n        ${fail || out.slice(-300)}`);
  }
}
try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) {}
console.log(bad ? `\n\x1b[31m✗ ${bad} generator(s) cannot build from this index.html. Fix before STEP 2.\x1b[0m`
                : '\n✓ both native generators build cleanly from this index.html.');
process.exit(bad ? 1 : 0);
