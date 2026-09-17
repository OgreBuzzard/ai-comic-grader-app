// api/assess_batch_run.js — Batch Assessment, step 2 of 3. ONE worker = ONE pass.
// Spec: claude/ASSESS_BATCH_SPEC.md v3.1 §3.1/§3.2.
//
// Runs one complete Main->Deep pass on the batch's book and writes its slot in
// batches/{batchId}. Charges nothing: the 3 credits were taken once in
// assess_batch_start. Never writes the item doc — the client persists the
// single BATCH history record when the batch completes.
//
// It calls /api/assess and /api/assess_deep over HTTP. That is SAFE and is not
// the v2 bug: both are stateless graders that verify the caller's token for
// abuse/lockout only, take no credits and write no item (verified 2026-09-14,
// see lib/batch_common.js header). The v2 bug was the CLIENT loop calling the
// client-side assessGrade()/assessHighGrade(), each of which re-uploaded every
// image, played the full animation and decremented a credit.
//
// This is deliberately NOT built on a lib/grade_core.js extraction. assess.js
// is a 2,142-line single handler and assess_deep.js is 983; pulling a shared
// core out of them (including four separate 55s abort sites) is a large
// untested refactor, and it buys no dollars and no correctness here — only the
// in-region re-POST of ~1.2MB of base64. If that latency turns out to matter,
// swap the two callGrader() calls for direct core calls; nothing else changes.

import { ROBOGRADE_VERSION } from '../lib/version.js';
import {
  CLIENT_SECRET, BATCH_FIXED_BRACKET, applyCors, getAdminDb, verifyUidFromAuthHeader,
  batchRef, fetchAll, passList
} from '../lib/batch_common.js';

// Our own 55s aborts live inside assess.js / assess_deep.js. This is the
// worker's outer bound on each hop; keep it above those so their own timeout
// (and its error message) wins rather than this one masking it.
const HOP_TIMEOUT_MS = 70000;

function baseUrlOf(req) {
  if (process.env.BATCH_BASE_URL) return process.env.BATCH_BASE_URL.replace(/\/$/, '');
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  const proto = req.headers['x-forwarded-proto'] || 'https';
  return `${proto}://${host}`;
}

async function callGrader(url, body, authHeader, label) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), HOP_TIMEOUT_MS);
  const t0 = Date.now();
  try {
    const r = await fetch(url, {
      method: 'POST',
      signal: ctrl.signal,
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',          // never SSE — we want one JSON body
        'x-client-secret': CLIENT_SECRET,
        ...(authHeader ? { Authorization: authHeader } : {})
      },
      body: JSON.stringify(body)
    });
    const text = await r.text();
    const ms = Date.now() - t0;
    if (!r.ok) throw new Error(`${label} ${r.status}: ${text.slice(0, 200)}`);
    let parsed;
    try { parsed = JSON.parse(text); } catch { throw new Error(`${label}: unparseable response`); }
    return { parsed, ms };
  } finally { clearTimeout(t); }
}

const rgOf = p => (p && p.roboGrade && typeof p.roboGrade.score === 'number') ? p.roboGrade.score : null;
const defsOf = p => Array.isArray(p && p.roboGrade && p.roboGrade.defects) ? p.roboGrade.defects : [];

export default async function handler(req, res) {
  if (applyCors(req, res)) return;
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { batchId, pass } = req.body || {};
  const n = parseInt(pass, 10);
  if (!batchId || !Number.isFinite(n) || n < 1) return res.status(400).json({ error: 'batchId and pass required' });

  const uid = await verifyUidFromAuthHeader(req);
  if (!uid) return res.status(401).json({ error: 'auth required' });
  const authHeader = req.headers.authorization || req.headers.Authorization || '';

  const db = await getAdminDb();
  if (!db) return res.status(500).json({ error: 'server not configured' });

  const bRef = batchRef(db, batchId);
  const bSnap = await bRef.get();
  if (!bSnap.exists) return res.status(404).json({ error: 'batch_not_found' });
  const batch = bSnap.data();
  if (batch.uid !== uid) return res.status(403).json({ error: 'not_your_batch' });
  if (n > (batch.n || 0)) return res.status(400).json({ error: 'pass_out_of_range' });

  const key = String(n);
  // Idempotency: a retried or duplicated worker call must not double-run a pass.
  const existing = (batch.passes || {})[key];
  if (existing && existing.stage && existing.stage !== 'queued' && existing.stage !== 'error') {
    return res.status(200).json({ ok: true, alreadyRunning: true, stage: existing.stage });
  }

  // Writes ONLY this worker's own pass, as its own Firestore field path
  // (`passes.<n>.<field>`). Two workers therefore never touch the same field
  // and cannot clobber each other. Patches are accumulated locally so a partial
  // update never has to re-read the shared doc.
  let _slot = { ...(existing || {}), pass: n };
  const setPass = async (patch) => {
    _slot = { ..._slot, ...patch };
    try {
      await bRef.update({ [`passes.${key}`]: _slot });
    } catch (e) { console.warn('[batch_run] slot write failed:', e && e.message); }
  };

  await setPass({ stage: 'loading', startedAt: new Date().toISOString() });
  // Diagnostic: when the client actually fanned out passes 2..N, so the
  // staggered schedule (spec §3.3 option C) can be checked against reality.
  if (n > 1 && !batch.fanoutAt) { try { await bRef.update({ fanoutAt: new Date().toISOString() }); } catch (e) {} }

  const base = baseUrlOf(req);
  const ident = batch.identity || {};
  const urls = batch.imageUrls || {};

  try {
    // ── images, straight from Storage (already 1200/q65) ────────────────────
    const [mainImgs, cornerImgs, icImgs] = await Promise.all([
      fetchAll(urls.main), fetchAll(urls.corner), fetchAll(urls.interiorCover)
    ]);
    const main = mainImgs.filter(Boolean);
    const corners = cornerImgs.filter(Boolean);
    const covers = icImgs.filter(Boolean);
    if (main.length < 2) throw new Error('could not load cover images');
    if (corners.length !== 4) throw new Error('could not load all 4 corner macros');

    // ── MAIN ────────────────────────────────────────────────────────────────
    await setPass({ stage: 'main' });
    const mainBody = {
      images: main,
      slotsFilled: { front: !!main[0], back: !!main[1], interior: !!main[2], raking: !!main[3] },
      grader: 'CGC',
      title: ident.title || '',
      issueNumber: String(ident.issue || ''),
      issueDate: ident.issueDate || '',
      labelDetected: !!ident.labelDetected,
      labelKind: ident.labelKind || '',
      // S22: Batch runs on a book that was identified on its ORIGINAL assessment
      // and has not changed since — same stored images, same book. Re-deriving
      // title / issue / date / publisher / printing five more times is pure
      // repeated work. knownIdentity hands assess.js the settled answer so
      // PHASE 0 skips identification. The GATE half of Phase 0 (COMIC /
      // NOT_COMIC / CROP_FAILURE) still runs — we are skipping identification,
      // not the safety check.
      // Adds a cache breakpoint after the images for this call only (see
      // assess.js). Ordinary user assessments never send this.
      cacheProfile: 'batch',
      knownIdentity: {
        title: ident.title || '',
        issue: String(ident.issue || ''),
        issueDate: ident.issueDate || '',
        publisher: ident.publisher || '',
        printing: ident.printing || ''
      }
    };
    const { parsed: M, ms: mainMs } = await callGrader(`${base}/api/assess`, mainBody, authHeader, 'assess');
    const mainRG = rgOf(M);

    // Recording the Main grade per pass is what makes the §4.3 fixed-bracket
    // question answerable later: Main spread vs Deep spread, from real batches.
    await setPass({
      stage: 'deep', mainRG, mainGrade: M.grade || null, mainMs,
      // Main's own subscores + PQ, so the client can quantize a v3 grade for the
      // MAIN half of the row animation. Without these the RG box sits blank
      // until Deep lands.
      mainSubscores: M.roboGrade ? {
        front: M.roboGrade.frontScore ?? null, back: M.roboGrade.backScore ?? null,
        spine: M.roboGrade.spineScore ?? null, interior: M.roboGrade.interiorScore ?? null
      } : null,
      mainPq: (M.roboGrade && M.roboGrade.pageQuality) || M.pageQuality || null,
      mainPm: (M.roboGrade && typeof M.roboGrade.confidenceRange === 'number') ? M.roboGrade.confidenceRange : null,
      mainTimingKey: (M._diagnostics && M._diagnostics.timingKey) || null
    });

    // ── DEEP ────────────────────────────────────────────────────────────────
    // initialAssessment.grade drives BOTH the ±2 grade-reference bracket and the
    // tier context in the Deep prompt. Feeding the batch's fixed anchor here (not
    // this pass's own Main grade) is what makes the Deep prefix byte-identical
    // across passes and therefore cacheable — the whole of §4.3, achieved without
    // touching assess_deep.js.
    //
    // roboGrade stays THIS pass's own Main, so the Deep floor rule still floors
    // against this pass's own Main rather than a batch-wide value. That preserves
    // per-pass divergence even with one shared bracket.
    const anchor = (BATCH_FIXED_BRACKET && batch.anchorGrade != null)
      ? String(batch.anchorGrade)
      : (M.grade || '');

    const deepBody = {
      initialAssessment: {
        title: M.title || ident.title || '',
        issue: M.issue || String(ident.issue || ''),
        issueDate: M.issueDate || ident.issueDate || '',
        publisher: M.publisher || ident.publisher || '',
        printing: M.printing || ident.printing || '',
        pageQuality: M.pageQuality || (M.roboGrade && M.roboGrade.pageQuality) || '',
        grade: anchor,
        graderNotes: '',
        aiAssessment: M.aiAssessment || '',
        labelNotes: M.labelNotes || '',
        keyInfo: M.keyInfo || '',
        enhance: M.enhance,
        labelDetected: !!M.labelDetected,
        roboGrade: M.roboGrade || {},
        photograder: M.photograder || null
      },
      cornerMacros: corners,
      interiorCovers: covers.length === 2 ? covers : [],
      frontCover: main[0] || null,
      title: ident.title || '',
      issueNumber: String(ident.issue || ''),
      cacheProfile: 'batch',
      // S22: passes 2..N write no deepAssessment and no defect list. The client
      // discards both — the book keeps the write-up and defects from its own
      // real Deep and the batch updates only RG / PG / PQ / subscores. Pass 1
      // stays full so deepAdded telemetry survives and one pass still looks like
      // a normal Deep. The directive is appended after §§CACHE_SPLIT§§ in
      // assess_deep.js, so the cached prefix is unchanged. Saving is modest
      // (~$0.01/pass) — see the note there.
      batchTerse: n >= 2,
      // ComicVine cover the original Main already resolved. Deep uses it only if
      // this issue has no curated reference_covers/ entry, and treats it as a
      // weak structural reference (see cvCoverNote in assess_deep.js).
      referenceImageUrl: (batch.refs && batch.refs.front) || null
    };
    const { parsed: D, ms: deepMs } = await callGrader(`${base}/api/assess_deep`, deepBody, authHeader, 'assess_deep');

    const rg = rgOf(D);
    const defects = defsOf(D);
    await setPass({
      stage: 'done',
      rg,
      grade: D.grade || null,
      pg: D.grade || null,
      pq: (D.roboGrade && D.roboGrade.pageQuality) || D.pageQuality || null,
      subscores: D.roboGrade ? {
        front: D.roboGrade.frontScore ?? null, back: D.roboGrade.backScore ?? null,
        spine: D.roboGrade.spineScore ?? null, interior: D.roboGrade.interiorScore ?? null
      } : null,
      pm: (D.roboGrade && typeof D.roboGrade.confidenceRange === 'number') ? D.roboGrade.confidenceRange : null,
      defectCount: defects.length,
      deepAdded: defects.filter(d => d && d.deepAddition === true).length,
      deepMs,
      deepTimingKey: (D._diagnostics && D._diagnostics.timingKey) || null,
      version: ROBOGRADE_VERSION,
      finishedAt: new Date().toISOString(),
      error: null
    });

    await maybeComplete(bRef);
    return res.status(200).json({ ok: true, pass: n, mainRG, rg });

  } catch (e) {
    console.error(`[batch_run] pass ${n} failed:`, e && e.message);
    await setPass({ stage: 'error', error: String((e && e.message) || 'unknown').slice(0, 300), finishedAt: new Date().toISOString() });
    await maybeComplete(bRef);
    return res.status(200).json({ ok: false, pass: n, error: String((e && e.message) || 'unknown').slice(0, 300) });
  }
}

// Mark the batch complete once no pass is still outstanding, and compute the
// summary. NO OUTLIER TRIMMING — every completed pass counts, always
// (ASSESS_BATCH_SPEC.md §6.1, decided 2026-09-13, reaffirmed 09-14). Any change
// here needs Matt's explicit say-so.
async function maybeComplete(bRef) {
  try {
    const snap = await bRef.get();
    const b = snap.data();
    if (!b || b.status === 'complete') return;
    const passes = passList(b);
    const outstanding = passes.filter(p => p.stage !== 'done' && p.stage !== 'error');
    if (outstanding.length) return;

    const done = passes.filter(p => p.stage === 'done' && typeof p.rg === 'number');
    const patch = { status: 'complete', completedAt: new Date().toISOString() };
    if (done.length) {
      const rgs = done.map(p => p.rg);
      patch.average = rgs.reduce((s, x) => s + x, 0) / rgs.length;   // raw 0-100, unrounded
      patch.low = Math.min(...rgs);
      patch.high = Math.max(...rgs);
      patch.completedPasses = done.length;
      const mains = passes.map(p => p.mainRG).filter(x => typeof x === 'number');
      if (mains.length > 1) {
        // Recorded so the §4.3 fixed-bracket question can be settled from real runs.
        patch.mainSpread = Math.max(...mains) - Math.min(...mains);
        patch.deepSpread = patch.high - patch.low;
      }
    } else {
      patch.status = 'failed';
    }
    await bRef.update(patch);
  } catch (e) { console.warn('[batch_run] completion write failed:', e && e.message); }
}
