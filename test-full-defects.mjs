// test-full-defects.mjs — v6.44
//
// A Full pass is the only pass that sees the six structural images, so it is
// the only one that can produce a staple / page / outer-edge defect AND the
// only one that could ever re-derive it. Main, Deep and Batch all replace
// roboGrade.defects wholesale with what their own photographs showed. Without
// the carry, every one of them deletes the Full's findings — silently, and in
// a way that looks exactly like the book not having those defects.
//
// The functions are SLICED out of index.html and api/assess_full.js rather
// than copied here, so this tests the shipping code.
// Run: node test-full-defects.mjs

import { readFileSync } from 'node:fs';

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ok    ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (extra ? '\n        ' + extra : '')); }
};

const slice = (src, from, to, what) => {
  const i = src.indexOf(from);
  const j = src.indexOf(to, i + from.length);
  if (i === -1 || j === -1) {
    throw new Error('test-full-defects: could not find ' + what + '. It has been renamed '
      + 'or moved and this test is now checking nothing. Fix the slice.');
  }
  return src.slice(i, j);
};

const html = readFileSync(new URL('./index.html', import.meta.url), 'utf8');
const clientSrc =
  slice(html, 'function fullDefectsOf(rg) {', 'function mergeRestorationFlags', 'the carry helpers')
  + '\nexport { fullDefectsOf, carryFullDefects };\n';
const { fullDefectsOf, carryFullDefects } =
  await import('data:text/javascript;base64,' + Buffer.from(clientSrc).toString('base64'));

const fullSrc = readFileSync(new URL('./api/assess_full.js', import.meta.url), 'utf8');
const serverSrc =
  slice(fullSrc, "const _FULL_DEFECT_CATEGORIES", '\nexport default async function handler', 'the sanitizer and the grade gate')
  + '\nexport { _sanitizeFullDefects };\n';
const { _sanitizeFullDefects, applyFullGradeGate } =
  await import('data:text/javascript;base64,' + Buffer.from(serverSrc).toString('base64'));

const cover = (n) => ({ type: 'Corner wear ' + n, category: 'Front', severity: 'Low' });
const structural = (n) => ({ type: 'Staple rust ' + n, category: 'Interior', severity: 'Low', fullAddition: true });

// ── the sanitizer ─────────────────────────────────────────────────────────
{
  const out = _sanitizeFullDefects([
    { type: 'Staple rust', location: 'top staple', measurement: '2mm', severity: 'Low', colorBreaking: false, category: 'Interior' },
  ]);
  ok('a well-formed entry survives and is stamped', out.length === 1 && out[0].fullAddition === true && out[0].deepAddition === false);
}
ok('a non-array is an empty list', _sanitizeFullDefects(null).length === 0 && _sanitizeFullDefects('x').length === 0);
ok('an entry with no type is dropped', _sanitizeFullDefects([{ location: 'somewhere' }]).length === 0);
ok('an unknown category becomes Interior',
  _sanitizeFullDefects([{ type: 'X', category: 'Staples' }])[0].category === 'Interior');
ok('an unknown severity becomes Low',
  _sanitizeFullDefects([{ type: 'X', severity: 'Catastrophic' }])[0].severity === 'Low');
ok('a real category is kept',
  _sanitizeFullDefects([{ type: 'X', category: 'Spine' }])[0].category === 'Spine');
ok('the list is capped at 6',
  _sanitizeFullDefects(Array.from({ length: 20 }, (_, i) => ({ type: 'D' + i }))).length === 6);
ok('a junk entry cannot break the shape',
  _sanitizeFullDefects([null, 5, { type: 'X', location: { nope: true } }]).length === 1
  && _sanitizeFullDefects([{ type: 'X', location: { nope: true } }])[0].location === '');
ok('an absurdly long string is truncated',
  _sanitizeFullDefects([{ type: 'X'.repeat(500) }])[0].type.length === 80);

// ── fullDefectsOf ─────────────────────────────────────────────────────────
ok('finds only the marked entries',
  fullDefectsOf({ defects: [cover(1), structural(1), cover(2), structural(2)] }).length === 2);
ok('a missing roboGrade is an empty list', fullDefectsOf(null).length === 0);
ok('a roboGrade with no defects is an empty list', fullDefectsOf({}).length === 0);

// ── the carry: Main / Deep re-assess ──────────────────────────────────────
{
  const prior = { defects: [cover(1), structural(1), structural(2)] };
  const next  = { defects: [cover(9), cover(8)] };          // a Deep re-run
  carryFullDefects(prior, next);
  ok('a Deep re-assess keeps the Full findings',
    next.defects.length === 4 && fullDefectsOf(next).length === 2);
  ok("and keeps its OWN defects too",
    next.defects.filter(d => !d.fullAddition).length === 2
    && next.defects[0].type === 'Corner wear 9');
}
{
  const prior = { defects: [cover(1)] };
  const next  = { defects: [cover(9)] };
  carryFullDefects(prior, next);
  ok('nothing to carry leaves the list alone', next.defects.length === 1);
}
{
  // The Full itself re-running: its OWN fresh findings must win outright.
  const prior = { defects: [structural(1), structural(2)] };
  const next  = { defects: [cover(9), structural(7)] };
  carryFullDefects(prior, next);
  ok('a fresh Full result is not stacked on top of the old one',
    fullDefectsOf(next).length === 1 && fullDefectsOf(next)[0].type === 'Staple rust 7');
}
{
  const next = { defects: [cover(9)] };
  carryFullDefects(null, next);
  ok('a null prior is harmless', next.defects.length === 1);
  ok('a null next is returned unchanged', carryFullDefects({ defects: [structural(1)] }, null) === null);
}
{
  // Twice in a row must not duplicate: the second call sees them already there.
  const prior = { defects: [structural(1)] };
  const next  = { defects: [cover(9)] };
  carryFullDefects(prior, next);
  carryFullDefects(prior, next);
  ok('carrying twice does not duplicate', fullDefectsOf(next).length === 1 && next.defects.length === 2);
}

// ── the Batch swap, exactly as index.html performs it ─────────────────────
{
  const roboGrade = { defects: [cover(1), structural(1), structural(2)] };
  const pick = [cover(5), cover(6), structural(99)];   // a batch pass cannot really produce one, but
  const carried = fullDefectsOf(roboGrade);
  roboGrade.defects = pick.filter(d => d && d.fullAddition !== true).concat(carried);
  ok('a Batch keeps the Full findings and drops any impostor',
    roboGrade.defects.length === 4
    && fullDefectsOf(roboGrade).map(d => d.type).join() === 'Staple rust 1,Staple rust 2');
}

// ── the cap is not applied to structural defects ──────────────────────────
{
  const prior = { defects: [structural(1), structural(2), structural(3)] };
  const next  = { defects: Array.from({ length: 13 }, (_, i) => cover(i)) };   // a full Deep cap
  carryFullDefects(prior, next);
  ok('structural defects are appended BEYOND the 13-defect cap, never competing for a slot',
    next.defects.length === 16 && fullDefectsOf(next).length === 3);
}

// ── the grade gate ────────────────────────────────────────────────────────
// Matt's rule (2026-11-06): a Full leaves the grade alone more often than not.
// Lower ONLY on a new structural defect; raise ONLY from at-or-above the 9.6
// Deep ceiling with nothing new found. Enforced, not requested — until
// fullDefects existed there was no way to check the model against it.
const G = (grade, prior, n) => applyFullGradeGate(grade, prior, n);

ok('no new defect, grade held: stands', G(9.0, 9.0, 0).grade === 9.0 && G(9.0, 9.0, 0).blocked === null);
ok('new defect, grade lowered: stands', G(8.5, 9.0, 2).grade === 8.5 && G(8.5, 9.0, 2).blocked === null);
ok('9.6 prior, nothing found, raised to 9.8: stands',
  G(9.8, 9.6, 0).grade === 9.8 && G(9.8, 9.6, 0).blocked === null);
ok('9.8 prior, nothing found, held: stands', G(9.8, 9.8, 0).grade === 9.8);

ok('RAISE with a new defect is blocked', G(9.8, 9.6, 1).grade === 9.6 && /raise blocked/.test(G(9.8, 9.6, 1).blocked));
ok('RAISE from below 9.6 is blocked', G(9.6, 9.4, 0).grade === 9.4 && /below the 9.6/.test(G(9.6, 9.4, 0).blocked));
ok('RAISE from well below is blocked', G(8.0, 5.0, 0).grade === 5.0);
ok('DROP with no new defect is blocked',
  G(8.0, 9.0, 0).grade === 9.0 && /drop blocked/.test(G(8.0, 9.0, 0).blocked));
ok('DROP with a new defect from a low prior stands', G(4.0, 5.0, 1).grade === 4.0);

ok('a null grade is passed through untouched', G(null, 9.0, 0).grade === null);
ok('a missing prior cannot gate anything', G(9.8, NaN, 3).grade === 9.8 && G(9.8, NaN, 3).blocked === null);
ok('the boundary is inclusive: exactly 9.6 may raise', G(9.8, 9.6, 0).grade === 9.8);

console.log('\n' + pass + ' passed, ' + fail + ' failed.');
process.exit(fail ? 1 : 0);
