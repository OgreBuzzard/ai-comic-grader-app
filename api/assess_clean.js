// api/assess_clean.js — POST-CLEANING COMPARISON. Text only, no images.
//
// WHY THIS ENDPOINT IS SMALL (v5.64, Matt + Claude, 2026-10-19)
//
// A Cleaning Compare run is THREE calls, and this is only the third:
//
//   1. /api/assess      — the 4 After main images. 1 credit.
//   2. /api/assess_deep — the 4 After corner macros + 2 After interior covers,
//                         with step 1's result as initialAssessment. 1 credit.
//   3. /api/assess_clean (here) — both RESULTS, as data, no images. FREE.
//
// Two credits total, which is what POST_CLEANING_ASSESSMENT_SPEC.md charges.
//
// ── WHY BOTH PASSES, AND NOT JUST A DEEP (Matt's correction, 2026-10-19) ───
// A first draft of this sent all 10 After photos to /api/assess_deep. That was
// wrong, and Matt caught it. assess_deep does not grade a book from scratch and
// does not look at 10 images: its message content is the 4 corner macros, the 2
// interior covers, ONE front cover, the reference covers and the grade-reference
// bracket. It REFINES an existing grade — it takes `initialAssessment` and
// adjusts from there, and the bracket images it compares against are chosen
// from that initial grade.
//
// The After set is a fresh capture of a book with no prior Main. There is no
// initial grade to refine, so a Deep alone would have had nothing to work from
// and seven of the ten photos would simply have gone unread. The After book has
// to be graded the way any book is graded: Main first, then Deep.
//
// Re-implementing either pass inside this file would mean a second copy of a
// pipeline that then drifts from the first. There is already one case of that
// in this codebase's history — the inline Main prompt versus
// lib/main_prompt.js — and it cost weeks. Two graders, each called once.
//
// ── WHAT THE MODEL IS AND IS NOT ASKED FOR ─────────────────────────────────
// The MODEL writes prose. The COUNTS ARE COMPUTED HERE, in code:
// resolved / survived / introduced, whether restoration appeared, and whether
// page quality moved more than one tier. Those numbers go on screen beside the
// grades, so they must be deterministic and reproducible — ask a model to count
// and the same two lists will give 7 one minute and 8 the next. This is the
// house rule: a decision that changes what a number means goes in the CODE.
//
// Signed-in users only. NO CREDIT: the two grading passes above have already
// taken the feature's 2 credits between them, and charging a third here would
// quietly make Cleaning Compare cost 3. No images either, so no prompt cache and
// nothing to keep warm — a run costs a fraction of a cent of input.
//
//   POST /api/assess_clean
//   { itemId, before: {...}, after: {...}, title, issue, runNumber }
//   -> { comparison: { writeUp, resolved, survived, introduced, counts,
//                      restorationAppeared, pageQualityMove, gradeDelta } }
import process from 'node:process';
import { ROBOGRADE_VERSION } from '../lib/version.js';
import { PRIMARY_MODEL, costOf } from '../lib/model.js';
import { anthropicWithRetry } from '../lib/anthropic_retry.js';
import { getAdminDb, verifyUidFromAuthHeader } from '../lib/batch_common.js';
import { reserveCredit, refundCredit, insufficientCreditsPayload } from '../lib/credits.js';

// Zero. See the header: /api/assess and /api/assess_deep take one each, and the
// spec's price for the whole feature is two. The reserve/refund plumbing below
// is kept so this can be given a price later without rebuilding it, but with
// CREDIT_COST at 0 nothing is debited whatever the client sends.
const CREDIT_COST = 0;

// ── PAGE QUALITY LADDER ────────────────────────────────────────────────────
// These are the six designations lib/main_prompt.js instructs the model to
// emit, lightest first, NOT the full CGC list. Use what the grader actually
// says; an aliased value that slips through maps in rather than breaking the
// comparison.
const PQ_LADDER = ['White', 'Off-White to White', 'Off-White', 'Cream to Off-White', 'Cream', 'Tan'];
const PQ_ALIASES = {
  'off white to white': 'Off-White to White',
  'ow/w': 'Off-White to White',
  'ow': 'Off-White',
  'off white': 'Off-White',
  'cream to off white': 'Cream to Off-White',
  'light tan to off-white': 'Cream',       // between Cream and Tan on CGC's list; nearest designation we use
  'light tan to off white': 'Cream',
  'brittle': 'Tan'
};
function pqIndex(v) {
  const raw = String(v || '').trim();
  if (!raw) return -1;
  const exact = PQ_LADDER.indexOf(raw);
  if (exact >= 0) return exact;
  const alias = PQ_ALIASES[raw.toLowerCase()];
  return alias ? PQ_LADDER.indexOf(alias) : -1;
}

// ── DEFECT MATCHING ────────────────────────────────────────────────────────
// A defect is { type, location, measurement, severity, colorBreaking, category }.
// Two passes of the same book never word a defect identically, so matching on
// the full string finds nothing and every defect reads as "resolved and a new
// one appeared" — which would make this feature lie in the most flattering
// direction possible. Match on CATEGORY + a normalised TYPE instead: category
// is a closed set (Front/Back/Spine/Interior) and type is the stable noun.
//
// Deliberately NOT fuzzy beyond this. A near-miss that lands as "survived" is a
// cautious error; a near-miss that lands as "resolved" is the feature claiming
// the cleaner fixed something they did not touch.
// `cover` is a stopword: the CATEGORY already says Front/Back/Spine/Interior,
// so the word carries no information and only breaks matching.
const _TYPE_STOP = /\b(a|an|the|of|on|at|to|and|with|very|slight|slightly|light|lightly|minor|small|large|multiple|several|few|some|cover)\b/g;
function typeKey(d) {
  const t = String((d && d.type) || '').toLowerCase()
    .replace(_TYPE_STOP, ' ')
    .replace(/[^a-z ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  // Fold the commonest synonym pairs Matt confirmed in the defect index work
  // (handoff: "I'm certain all the defects you just listed map to defects in
  // that matrix under different names").
  const folded = t
    .replace(/\bstress lines?\b/, 'stress')
    .replace(/\bcreases?\b/, 'crease')
    .replace(/\btears?\b/, 'tear')
    .replace(/\bchips?\b/, 'chip')
    .replace(/\bbends?\b/, 'bend')
    .replace(/\bstains?\b/, 'stain')
    .replace(/\bspine wear\b/, 'wear')
    .replace(/\bedge wear\b/, 'wear')
    .replace(/\bcorner wear\b/, 'wear');
  // SORT THE TOKENS. Without this the key is word-order sensitive, and two
  // passes that say "Back cover tanning" and "Tanning, back cover" produce
  // different keys — which reads as one defect resolved AND one appeared. That
  // is the feature lying in the most flattering direction available, and a
  // test caught it on exactly the ASM 129 back-cover tanning that is the whole
  // reason this comparison exists. Sorting can only ever merge more, never
  // less, and a false "survived" is the cautious error.
  const sorted = folded.split(' ').filter(Boolean).sort().join(' ');
  return (String((d && d.category) || '?').toLowerCase() + '|' + sorted).trim();
}

function diffDefects(before, after) {
  const B = Array.isArray(before) ? before.filter(Boolean) : [];
  const A = Array.isArray(after) ? after.filter(Boolean) : [];
  const afterPool = A.map(d => ({ d, key: typeKey(d), taken: false }));
  const resolved = [], survived = [];
  for (const b of B) {
    const k = typeKey(b);
    const hit = afterPool.find(x => !x.taken && x.key === k);
    if (hit) {
      hit.taken = true;
      survived.push({ before: b, after: hit.d });
    } else {
      resolved.push(b);
    }
  }
  const introduced = afterPool.filter(x => !x.taken).map(x => x.d);
  return { resolved, survived, introduced };
}

const sev = d => String((d && d.severity) || '').trim().toLowerCase();
const isReal = d => sev(d) === 'high' || sev(d) === 'med' || sev(d) === 'medium';

function line(d) {
  const bits = [d && d.type, d && d.location, d && d.measurement].filter(Boolean).join(', ');
  const cb = (d && d.colorBreaking) ? ', colour-breaking' : '';
  return `- [${(d && d.category) || '?'}] ${bits || 'unspecified'} (${(d && d.severity) || '?'}${cb})`;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const { itemId = null, before = null, after = null, title = '', issue = '',
          runNumber = 1, serverCredits = false } = req.body || {};
  if (!before || !after) return res.status(400).json({ error: 'before and after results are both required' });

  const uid = await verifyUidFromAuthHeader(req);
  if (!uid) return res.status(401).json({ error: 'auth required' });

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'no ANTHROPIC_API_KEY' });

  let db = null;
  try { db = await getAdminDb(); } catch (e) { db = null; }

  // ── CREDIT ───────────────────────────────────────────────────────────────
  // Reserved BEFORE the model call and refunded if the call fails. There is no
  // refund for a disappointing RESULT — the user is buying a verdict, not a
  // bump (decision 1 of the spec) — but a 502 is not a verdict.
  let creditsRemaining = null, debited = false;
  if (serverCredits === true && CREDIT_COST > 0) {
    try {
      const r = await reserveCredit(db, uid, { cost: CREDIT_COST, debit: true, label: 'clean' });
      creditsRemaining = (r && r.remaining != null) ? r.remaining : null;
      debited = true;
    } catch (e) {
      return res.status(402).json(insufficientCreditsPayload(e, CREDIT_COST));
    }
  }

  // ── THE COMPUTED HALF ────────────────────────────────────────────────────
  const d = diffDefects(before.defects, after.defects);
  const counts = {
    resolved: d.resolved.length,
    survived: d.survived.length,
    introduced: d.introduced.length,
    resolvedReal: d.resolved.filter(isReal).length,
    introducedReal: d.introduced.filter(isReal).length
  };

  // Restoration: false before, true after. The spec's honesty constraint is
  // that this states what each PASS found, never what was done to the book —
  // so the field name says "appeared", and the wording downstream must too.
  const beforeRest = !!(before.restorationFlag || before.restorationHighConfidence);
  const afterRest  = !!(after.restorationFlag  || after.restorationHighConfidence);
  const restorationAppeared = !beforeRest && afterRest;

  // Page quality. A clean and press does not change interior paper tone, so a
  // move is not a result to show — it is a SIGNAL. One tier is assessment
  // noise (the parity round measured PQ tracking at slope 0.32 against 1.00).
  // More than one tier LIGHTER is consistent with bleaching or
  // deacidification, which is restoration, not cleaning.
  const pqB = pqIndex(before.pageQuality), pqA = pqIndex(after.pageQuality);
  const pqDelta = (pqB >= 0 && pqA >= 0) ? (pqB - pqA) : null;   // positive = lighter after
  const pageQualityMove = {
    before: before.pageQuality || null,
    after: after.pageQuality || null,
    tiers: pqDelta,
    suspicious: pqDelta != null && pqDelta > 1
  };

  const gB = parseFloat(before.grade), gA = parseFloat(after.grade);
  const gradeDelta = (isFinite(gB) && isFinite(gA)) ? +(gA - gB).toFixed(1) : null;

  // ── THE WRITTEN HALF ─────────────────────────────────────────────────────
  // The model is handed the computed diff and asked ONLY to explain it. It is
  // explicitly told the counts so it cannot contradict what is on screen.
  const prompt = `You are writing the "Post-Cleaning Assessment" section for a comic book that has been professionally cleaned and/or pressed. You are given the defect list from BEFORE the work and the defect list from AFTER, and a diff that has already been computed. Write the explanation. Do not recount anything.

BOOK: ${String(title || 'Unknown').trim()} ${String(issue || '').trim()}
RUN: ${runNumber}

GRADE: ${before.grade || '?'} before, ${after.grade || '?'} after${gradeDelta != null ? ` (${gradeDelta >= 0 ? '+' : ''}${gradeDelta})` : ''}
PAGE QUALITY: ${pageQualityMove.before || 'unknown'} before, ${pageQualityMove.after || 'unknown'} after

DEFECTS RESOLVED (present before, absent after) — ${counts.resolved}:
${d.resolved.length ? d.resolved.map(line).join('\n') : '(none)'}

DEFECTS SURVIVING (present in both) — ${counts.survived}:
${d.survived.length ? d.survived.map(x => line(x.before)).join('\n') : '(none)'}

DEFECTS NEWLY REPORTED (absent before, present after) — ${counts.introduced}:
${d.introduced.length ? d.introduced.map(line).join('\n') : '(none)'}

RESTORATION: ${beforeRest ? 'detected' : 'not detected'} before, ${afterRest ? 'detected' : 'not detected'} after.

WRITE 120-200 WORDS, plain prose, no headings, no bullet points. Rules, in order of importance:

1. BE HONEST WHEN NOTHING IMPROVED, OR WHEN THE GRADE FELL. Say so plainly and first. The person reading this paid for a verdict and there is no refund. A write-up that always finds improvement is worth nothing, and an encouraging one on a bad result is worse than nothing.
2. ${restorationAppeared ? 'RESTORATION LEADS. Restoration was not detected on the before photos and is detected on the after photos. State exactly that comparison — what each pass found. Do NOT say the book was restored, who restored it, or when. The before pass may simply have missed it; say so. This is the most important thing on the page.' : 'Do not speculate about restoration; none appeared.'}
3. Name what CHANGED, what did NOT, and what CANNOT. Creases, bends, dents, spine stress and non-colour-breaking handling wear generally press out. Tanning, foxing, staining and paper chemistry generally do not and will not, however many times the book is pressed. If something in the surviving list is in that second group, say it is not going to change.
4. A COLOUR-BREAKING DEFECT DOES NOT UN-BREAK. If a colour-breaking defect appears in the resolved list, treat it with suspicion: it is more likely a difference in detection between two photo sets than a repair. Say that rather than crediting it.
5. Newly reported defects are, likewise, more often a detection difference than damage caused by the work — unless they are severe. Do not accuse.
6. ${pageQualityMove.suspicious ? `PAGE QUALITY MOVED ${pqDelta} TIERS LIGHTER (${pageQualityMove.before} to ${pageQualityMove.after}). Cleaning and pressing do not lighten interior paper; that is chemistry. A move this large is consistent with bleaching or deacidification, which are restoration rather than cleaning. Raise it, carefully, as something the owner should be aware of — not as an accusation.` : 'Do not discuss page quality; it did not move meaningfully, which is expected.'}

Return ONLY the prose. No preamble, no JSON, no quotation marks around it.`;

  const t0 = Date.now();
  let writeUp = '', usage = {};
  try {
    const r = await anthropicWithRetry(
      () => fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({
          model: PRIMARY_MODEL,
          max_tokens: 700,
          messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }]
        })
      }),
      { deadlineMs: 45000, maxAttempts: 3, label: 'clean-compare' }
    );
    const j = await r.json();
    if (!r.ok) throw new Error(j.error ? j.error.message : ('HTTP ' + r.status));
    usage = j.usage || {};
    writeUp = ((j.content || []).find(c => c.type === 'text') || {}).text || '';
    writeUp = writeUp.trim();
  } catch (e) {
    if (debited) { try { await refundCredit(db, uid, CREDIT_COST, 'clean'); } catch (_) {} }
    return res.status(502).json({ error: 'comparison failed', detail: String(e && e.message || e) });
  }

  const costUsd = costOf(usage, PRIMARY_MODEL, null);

  // Timing row, same collection and shape as every other paid call, so this
  // shows up in the admin Logs and in the cost figures rather than being
  // invisible the way api/probe.js was until 5.63.
  (async () => {
    try {
      if (!db) return;
      const key = `clean_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      await db.collection('assessment_timings').doc(key).set({
        kind: 'clean', uid, itemId: itemId || null,
        createdAt: new Date().toISOString(),
        totalMs: Date.now() - t0,
        inputTokens: usage.input_tokens || 0,
        outputTokens: usage.output_tokens || 0,
        costUsd: Number(costUsd.toFixed(6)),
        responseModel: PRIMARY_MODEL,
        runNumber, gradeDelta,
        restorationAppeared, pqSuspicious: pageQualityMove.suspicious,
        version: ROBOGRADE_VERSION
      });
    } catch (e) { console.warn('[clean] timing write failed (non-fatal):', e && e.message); }
  })();

  return res.status(200).json({
    ok: true,
    version: ROBOGRADE_VERSION,
    comparison: {
      writeUp,
      counts,
      resolved: d.resolved,
      survived: d.survived.map(x => x.after),
      introduced: d.introduced,
      restorationAppeared,
      pageQualityMove,
      gradeDelta,
      runNumber,
      at: new Date().toISOString(),
      version: ROBOGRADE_VERSION
    },
    ...(debited ? { creditsCharged: CREDIT_COST, creditsRemaining } : {}),
    costUsd: Number(costUsd.toFixed(6)),
    ms: Date.now() - t0
  });
}
