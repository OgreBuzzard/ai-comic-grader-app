// check-paired-constants.mjs — do the numbers that live in TWO files still agree?
//
// WHY THIS EXISTS, in one case history:
//
//   v6.32 lowered the Full Assessment FMV gate from tier 6 ($500+) to tier 4
//   ($100+). The gate exists TWICE on purpose — once in index.html so the
//   button appears, and once in api/assess_full.js as a server backstop, added
//   precisely so the client could not be trusted. Only the client was changed.
//
//   Result: every $100–$499 book showed the Full button and the server refused
//   every one of them. Books above $500 still worked, so it failed for some
//   books and not others on the same deploy, and read as an outage rather than
//   a gate. It cost a day, and the day was spent by the one person who is also
//   support.
//
// A value duplicated across a client and a server is not a mistake — the
// server cannot trust the client, and the client cannot wait for the server to
// decide what to draw. The mistake is having no way to notice when the two
// stop agreeing. Nothing about editing one of them looks like editing the
// other.
//
// This is a dumb script on purpose: it reads both files as text, pulls one
// number or string out of each, and compares them. No parsing, no imports, no
// opinion about which is right — only whether they match.
//
//   node check-paired-constants.mjs
//
// ADDING A PAIR: when you duplicate a value across files, add it here in the
// same commit. If a pattern stops matching, that is a BLOCKER rather than a
// pass: a pair this script cannot see is a pair that will drift unwatched.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));

const PAIRS = [
  {
    what: 'Full Assessment FMV tier gate',
    why: 'client draws the button, server decides whether to honour it',
    a: { file: 'index.html',          re: /fmvTierOf\(item\)\s*>=\s*(\d+)/ },
    b: { file: 'api/assess_full.js',  re: /const\s+FULL_MIN_FMV_TIER\s*=\s*(\d+)/ }
  },
  {
    what: 'Batch credit cost',
    why: 'the price quoted on the button and the price actually charged',
    a: { file: 'index.html',                 re: /const\s+BATCH_CREDIT_COST\s*=\s*(\d+)/ },
    b: { file: 'lib/batch_common.js',        re: /const\s+BATCH_CREDIT_COST\s*=\s*(\d+)/ }
  },
  {
    what: 'Free UV checks per book',
    why: 'the client stops offering it; the server refuses it',
    a: { file: 'index.html',           re: /const\s+UV_CHECK_LIMIT\s*=\s*(\d+)/ },
    b: { file: 'api/assess_deep.js',   re: /const\s+UV_CHECK_LIMIT\s*=\s*(\d+)/ }
  },
  {
    what: 'The derived "Signature detected" label note',
    why: 'print-label.js derives it for the label, index.html for the screen',
    a: { file: 'index.html',      re: /const\s+SIGNATURE_LABEL_NOTE\s*=\s*'([^']+)'|const\s+SIGNATURE_LABEL_NOTE\s*=\s*"([^"]+)"/ },
    b: { file: 'print-label.js',  re: /_aln\.push\('([^']+)'\)/ }
  },
  {
    what: 'The PHOTOS / ASSESSMENT tab kill switch',
    why: 'turning tabs off in the app without the public page is a half-off state',
    a: { file: 'index.html',   re: /const\s+TABS_ENABLED\s*=\s*(true|false)/ },
    b: { file: 'public.html',  re: /const\s+PUB_TABS_ENABLED\s*=\s*(true|false)/ }
  }
];

const pull = (side) => {
  const p = path.join(ROOT, side.file);
  if (!fs.existsSync(p)) return { missing: true };
  const m = fs.readFileSync(p, 'utf8').match(side.re);
  if (!m) return { missing: true };
  // The first capture group that actually captured something.
  const v = m.slice(1).find(x => x != null);
  return { value: v };
};

let drift = 0, blind = 0;
console.log('checking values that live in more than one file\n');

for (const pair of PAIRS) {
  const A = pull(pair.a), B = pull(pair.b);
  if (A.missing || B.missing) {
    blind++;
    const which = A.missing ? pair.a.file : pair.b.file;
    console.log(`  BLIND ${pair.what}`);
    console.log(`        pattern no longer matches in ${which}`);
    continue;
  }
  if (A.value !== B.value) {
    drift++;
    console.log(`  DRIFT ${pair.what}`);
    console.log(`        ${pair.a.file} says ${A.value}`);
    console.log(`        ${pair.b.file} says ${B.value}`);
    console.log(`        (${pair.why})`);
    continue;
  }
  console.log(`  ok    ${pair.what} — both ${A.value}`);
}

// ── v6.50: CHARGING AND SWEEPING MUST AGREE ───────────────────────────────
// Not a pair of constants, but the same failure in a different shape, and it
// belongs in the same gate: an endpoint that RESERVES a credit and does not
// stamp the pending fields on its success row is invisible to
// /api/credit_sweep. A charged assessment whose client never saves then keeps
// the credit with nothing anywhere able to give it back.
// That is exactly what happened to every Deep broken by the 6.41
// ReferenceError, while the sweep logged "scanned 0" ten minutes apart,
// because only api/assess.js had ever written those fields.
//
// EXEMPTIONS ARE EXPLICIT AND THEY HAVE TO STAY THAT WAY. An endpoint is only
// exempt because nothing settles it - it records no timing key on the item -
// so stamping it pending would refund every SUCCESSFUL run 15 minutes later.
// The fix for an exemption is to wire _recordTimingKey() through that flow and
// then remove it from this list, never to widen the list.
console.log('\nendpoints that charge a credit must be sweepable');
const CHARGERS = [
  { file: 'api/assess.js',           label: 'Main' },
  { file: 'api/assess_deep.js',      label: 'Deep' },
  { file: 'api/assess_full.js',      label: 'Full' },
  { file: 'api/assess_clean.js',     label: 'Post-Cleaning',
    exempt: 'records no timing key on the item — wire _recordTimingKey() first' },
  { file: 'api/assess_clean_run.js', label: 'Post-Cleaning runner',
    exempt: 'orchestrates Main + Deep, which stamp their own rows' },
  { file: 'api/assess_batch_run.js', label: 'Batch',
    exempt: 'the 3 credits are charged once by assess_batch_start; its passes cost 0' },
];
let unswept = 0;
for (const c of CHARGERS) {
  let src;
  try { src = fs.readFileSync(path.join(ROOT, c.file), 'utf8'); }
  catch { console.log(`  BLIND ${c.label} — cannot read ${c.file}`); blind++; continue; }
  const reserves = /reserveCredit\s*\(/.test(src);
  const stamps = /creditPendingAt/.test(src);
  if (!reserves) { console.log(`  ok    ${c.label} — charges nothing`); continue; }
  if (stamps) { console.log(`  ok    ${c.label} — charges and stamps pending`); continue; }
  if (c.exempt) { console.log(`  ok    ${c.label} — exempt: ${c.exempt}`); continue; }
  unswept++;
  console.log(`  UNSWEPT ${c.label} (${c.file})`);
  console.log('        reserves a credit and never writes creditPendingAt, so');
  console.log('        /api/credit_sweep cannot refund it when a client fails to save.');
}

console.log('');
if (unswept) {
  console.error(`✗ ${unswept} endpoint(s) charge a credit the sweep cannot see.`);
  console.error('  Stamp creditSettled / creditPendingUid / creditPendingCost /');
  console.error('  creditPendingLabel / creditPendingAt on the SUCCESS timing row — the one');
  console.error('  whose key is returned in _diagnostics.timingKey. Never on an error row:');
  console.error('  those have already refunded, and a pending stamp on a refund pays twice.');
  process.exit(1);
}
if (blind) {
  console.error(`✗ ${blind} pair(s) could not be read. Treat this as a BLOCKER: a pair this script`);
  console.error('  cannot see is a pair that will drift with nothing watching. Fix the pattern.');
}
if (drift) {
  console.error(`✗ ${drift} pair(s) disagree. One side was changed and the other was not.`);
}
if (drift || blind) process.exit(1);
console.log(`✓ all ${PAIRS.length} pairs agree.`);
