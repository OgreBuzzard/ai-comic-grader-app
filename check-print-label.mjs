// check-print-label.mjs — the two things that keep breaking print-label.js.
//
// 1. STRAY BACKTICK IN THE CSS. The whole stylesheet is one template literal,
//    so a backtick anywhere inside it - including in a COMMENT, which is where
//    it always happens, writing `gap: 14px` or `bottom` as if it were Markdown
//    - closes the string and corrupts the file. This has happened five times.
//    `node --check` does NOT catch it: node parses a .js file as CommonJS and
//    the damage still parses. Only an actual ESM import finds it.
//
// 2. A RULE SCOPED TO ONE LABEL FOR AN OBJECT THAT IS ON ALL OF THEM. Four
//    separate shipped bugs: the chip colour twice, the (+) mark, the price
//    face. Shared properties belong in the .rg-any block. This warns; it does
//    not fail, because some of these are legitimately per-variant.
//
//   node check-print-label.mjs
import fs from 'fs';

const FILE = process.argv[2] || 'print-label.js';
const s = fs.readFileSync(FILE, 'utf8');
let fail = 0;

// ── 1. backticks inside the CSS template literal ────────────────────────────
const open = s.indexOf('style.textContent = `');
if (open < 0) {
  console.log('  WARN  could not find the CSS template literal; skipping backtick check');
} else {
  const from = open + 'style.textContent = `'.length;
  const end = s.indexOf('`;', from);
  const css = s.slice(from, end < 0 ? s.length : end);
  const n = (css.match(/`/g) || []).length;
  if (n > 0) {
    fail++;
    console.log(`  FAIL  ${n} stray backtick(s) inside the CSS template literal`);
    let line = s.slice(0, from).split('\n').length;
    for (const part of css.split('\n')) {
      if (part.includes('`')) console.log(`        line ${line}: ${part.trim().slice(0, 90)}`);
      line++;
    }
    console.log('        Use \'single quotes\' in CSS comments, never backticks.');
  } else {
    console.log('  ok    no stray backticks in the CSS');
  }
}

// ── 2. the module actually imports ──────────────────────────────────────────
try {
  await import(new URL(FILE, `file://${process.cwd()}/`).href);
  console.log('  ok    module imports');
} catch (e) {
  fail++;
  console.log(`  FAIL  module does not import: ${e.message}`);
}

// ── 3. single-variant rules on shared elements (advisory) ───────────────────
const SHARED = ['.rg-price', '.rg-num', '.rg-plus', '.rg-stars', '.rg-word',
                '.rg-art', '.ttl', '.iss', '.prt', '.qrc', '.info-lower'];
const seen = new Map();
for (const m of s.matchAll(/(?:^|\n)\s*(\.rg-label[^\n{]*?)\{/g)) {
  for (const part of m[1].split(',').map(x => x.trim())) {
    if (!part.startsWith('.rg-label')) continue;
    const root = part.match(/^\.rg-label(-[a-z]+)?/)[0];
    const rest = part.slice(root.length).trim();
    if (!rest) continue;
    if (!seen.has(rest)) seen.set(rest, new Set());
    seen.get(rest).add(root);
  }
}
const warn = [];
for (const [rest, roots] of seen) {
  if (roots.size !== 1) continue;
  const only = [...roots][0];
  if (only === '.rg-label-card' || only === '.rg-label-large') continue;
  if (SHARED.some(k => rest.includes(k))) warn.push(`${only.padEnd(18)} ${rest}`);
}
if (warn.length) {
  console.log(`  WARN  ${warn.length} rule(s) scoped to ONE label for a shared element:`);
  for (const w of warn) console.log(`        ${w}`);
  console.log('        Shared properties (face, weight, colour) belong in .rg-any.');
  console.log('        Sizes and positions are legitimately per-variant - see LABEL_SHARED_STYLES.md.');
} else {
  console.log('  ok    no single-variant rules on shared elements');
}

console.log(fail ? '\nFAILED. Do not deploy.' : '\nOK.');
process.exit(fail ? 1 : 0);
