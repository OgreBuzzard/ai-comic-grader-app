// test-concierge.mjs — v6.52
//
// Step 1 of the concierge flow: identity off the existing slabcheck Haiku call,
// and the gate that decides whether a book is worth the offer. No UI yet.
//
// The two things that must never regress:
//   1. the gate is the FMV tier at grade 0.5, not at a typical grade — the
//      offer must never cost more than the book is worth in ANY condition;
//   2. silence is the default. No identity, no FMV row, a bad parse or a throw
//      all mean no offer. A miss costs nothing; a wrong offer costs trust.
// Run: node test-concierge.mjs

import { readFileSync } from 'node:fs';

let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) { pass++; console.log('  ok    ' + n); } else { fail++; console.log('  FAIL  ' + n + (x ? '\n        ' + x : '')); } };

const html = readFileSync(new URL('./index.html', import.meta.url), 'utf8');
const assess = readFileSync(new URL('./api/assess.js', import.meta.url), 'utf8');

const i = html.indexOf('const CONCIERGE_MIN_TIER');
const j = html.indexOf('// ── end concierge gate');
if (i === -1 || j === -1 || j < i) {
  console.error('test-concierge: could not slice the gate out of index.html.\n'
    + 'Anchors are "const CONCIERGE_MIN_TIER" and the "end concierge gate" comment.\n'
    + 'If they moved this test is checking NOTHING. Fix the slice.');
  process.exit(1);
}
const src = html.slice(i, j) + '\nexport { conciergeGate, CONCIERGE_MIN_TIER, CONCIERGE_GATE_GRADE };\n';
const M = await import('data:text/javascript;base64,' + Buffer.from(src).toString('base64'));
const { conciergeGate, CONCIERGE_MIN_TIER, CONCIERGE_GATE_GRADE } = M;

// a stand-in FMV index: whatever grade it is asked for, it answers by title
function stubFMV(table) {
  globalThis.window = globalThis.window || {};
  window.matchFMV = (title, issue, grade) => {
    window._lastGrade = grade;
    const t = table[(title || '').toLowerCase() + '|' + issue];
    return t ? { tier: t, low: 0, high: 0 } : null;
  };
}
const KEYS = { 'amazing fantasy|15': 13, 'incredible hulk|181': 11, 'fantastic four|1': 13,
               'amazing spider-man|300': 4, 'the savage she-hulk|1': 3, 'web of spider-man|32': 2 };

// ── the threshold ─────────────────────────────────────────────────────────
ok('the bar is tier 3', CONCIERGE_MIN_TIER === 3, 'tier 3 is $50-$100');
ok('the gate grade is 0.5', CONCIERGE_GATE_GRADE === 0.5,
  'at 0.5 the book clears $50 in ANY condition — that is the whole argument for the number');

stubFMV(KEYS);
ok('a key qualifies', conciergeGate('Amazing Fantasy', '15').eligible);
ok('it asked the FMV index for grade 0.5, not a typical grade', window._lastGrade === 0.5,
  'got ' + window._lastGrade + ' — gating at 3.0 would offer 2 credits on a 1.0 copy worth less than that');
ok('tier 3 exactly is IN', conciergeGate('The Savage She-Hulk', '1').eligible,
  'the bar is >=, not >');
ok('tier 2 is out', !conciergeGate('Web of Spider-Man', '32').eligible);
ok('a below-bar book says why', conciergeGate('Web of Spider-Man', '32').reason === 'below-tier');
ok('the tier is reported either way', conciergeGate('Web of Spider-Man', '32').tier === 2);

// ── silence is the default ────────────────────────────────────────────────
ok('no title -> no offer', !conciergeGate(null, '15').eligible && conciergeGate(null, '15').reason === 'no-identity');
ok('no issue -> no offer', !conciergeGate('Amazing Fantasy', null).reason.includes('match')
  && !conciergeGate('Amazing Fantasy', null).eligible);
ok('empty strings -> no offer', !conciergeGate('', '').eligible);
ok('a book not in the index -> no offer', !conciergeGate('Some Indie Book', '1').eligible
  && conciergeGate('Some Indie Book', '1').reason === 'no-match');
{
  window.matchFMV = () => { throw new Error('boom'); };
  const r = conciergeGate('Amazing Fantasy', '15');
  ok('an FMV throw is swallowed, not propagated', !r.eligible && r.reason === 'fmv-threw',
    'this runs inside the camera walkthrough — it must never break a capture');
  delete window.matchFMV;
  ok('a missing FMV index -> no offer', conciergeGate('Amazing Fantasy', '15').reason === 'no-fmv-index');
  stubFMV(KEYS);
}

// ── the server half ───────────────────────────────────────────────────────
ok('slabcheck asks for title and issue', /"title" \(the series name exactly as printed/.test(assess));
ok('it is told to return null rather than guess', /set it to null rather than guessing/.test(assess));
ok('a card gets no identity', /For a card, set both to null/.test(assess));
ok('the issue is digits only', /\^\\\\d\{1,5\}\$/.test(assess) || /\/\^\\d\{1,5\}\$\//.test(assess),
  'a variant suffix like "15A" changes which FMV row applies and cannot be resolved here');
ok('the title is length-capped and must contain a letter',
  /t\.length <= 60 && \/\[A-Za-z\]\/\.test\(t\)/.test(assess));
ok('identity is returned to the client', /title: scTitle, issue: scIssue/.test(assess));
ok('identity is logged to the timing row', /idOk: !!\(scTitle && scIssue\)/.test(assess),
  'idOk is the number that decides whether the rest of the flow gets built');

// -- steps 4-6: the offer, the extended capture, the chained run (v6.66) ---
// Step 1 was instrumentation only and said so. This is the rest. What must not
// regress is the two things the spec is emphatic about: silence is still the
// default, and the modal never asserts a VALUE.
ok('the gate is evaluated at capture', /const _cg = conciergeGate\(r && r\.title, r && r\.issue\);/.test(html));
ok('the offer exists', html.includes('function conciergeOffer('));
ok('it is offered at the slab-check pause, before photos 2-4',
  /conciergeShouldOffer\(_slab\) && await conciergeOffer\(formData\._conciergeGate\)/.test(html));

{
  const modal = html.slice(html.indexOf('function conciergeOffer('),
                           html.indexOf('function conciergeShouldOffer('));
  ok('the modal names the book', modal.includes('gate && gate.title'));
  ok('the modal NEVER quotes a value', !/matchFMV|fmvTierOf|tier/i.test(modal),
    'quoting a dollar figure for a misread issue is a complaint, not an annoyance');
  ok('no banned brand words', !/\bAI\b|artificial intelligence|machine learning|neural/i.test(modal));
  ok('the cost is stated before the tap', /CONCIERGE_COST \+ ' credits/.test(modal));
  ok('dismissing the backdrop is a decline, not a hang', modal.includes('if (e.target === ov) finish(false)'));
}

{
  const guard = html.slice(html.indexOf('function conciergeShouldOffer('),
                           html.indexOf('function _conciergeEmptySlots('));
  ok('a slab or a card is never offered', guard.includes('slab.detected || slab.isCard'));
  ok('a book that already has Deep photos is never offered', guard.includes('formData.cornerImages'));
  ok('it is not offered without the credits for it', guard.includes('< CONCIERGE_COST'));
  ok('an ineligible gate is silent', guard.includes('if (!g || !g.eligible) return false;'));
}

ok('accepting extends the walkthrough to the full ten',
  /if \(_conciergeCapture\) \{[\s\S]{0,500}_nextKind = "corner"[\s\S]{0,400}_nextKind = "interiorCover"/.test(html));
ok('the flag is disarmed when the capture ends',
  html.includes('const _wasConcierge = _conciergeCapture;') && html.includes('if (_conciergeCapture) _conciergeCapture = false;'));
ok('Main starts itself only on a COMPLETE set',
  /if \(_m >= 4 && _c >= 4\)[\s\S]{0,300}await assessGrade\(\)/.test(html));
ok('a short capture stands the run down rather than charging for a partial set',
  /standing down[\s\S]{0,120}_conciergeRun = false/.test(html));
ok('the Deep follows the Main automatically',
  /if \(formData\._conciergeRun\) \{[\s\S]{0,200}_conciergeRun = false;[\s\S]{0,400}assessHighGrade\(\)/.test(html));

console.log('\n  ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
