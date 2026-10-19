// api/assess_clean_run.js — CLEANING COMPARE, server-orchestrated.
//
// WHY THIS EXISTS AND WHY IT LOOKS LIKE assess_batch_run.js (v5.68, 2026-10-19)
//
// A Cleaning Compare run is Main → Deep → compare. The first draft had the
// CLIENT make those three calls in sequence. That is the wrong place for them:
// a phone that locks, loses signal or is swiped away between call two and call
// three leaves the user charged two credits with an After grade and no
// comparison, and nothing to resume from. api/assess_batch_run.js already
// solved this exact shape — it calls /api/assess and then /api/assess_deep over
// HTTP from the server, with the user's own Authorization header — so this
// follows it rather than inventing a second pattern.
//
// Calling our own endpoints over HTTP is deliberate and is NOT accidental
// complexity: assess.js is ~2,200 lines and assess_deep.js ~1,450, and lifting a
// shared core out of them is a refactor neither needs. The same note is on
// assess_batch_run.js.
//
// ── WHY BOTH PASSES (Matt's correction, 2026-10-19) ────────────────────────
// assess_deep.js does not grade a book from scratch. It takes the 4 corner
// macros, the 2 interior covers, ONE front cover and the reference/bracket
// images, and REFINES an existing grade through `initialAssessment` — the
// bracket images it compares against are chosen from that initial grade. The
// After set is a fresh capture of a book with NO prior Main, so a Deep alone
// would have nothing to refine and seven of the ten photos would go unread.
//
// ── CREDITS: 2, and where they are taken ───────────────────────────────────
//   /api/assess       1 credit   (serverCredits: true)
//   /api/assess_deep  1 credit   (serverCredits: true)
//   /api/assess_clean 0 credits  (comparison only)
// This endpoint takes none itself. NO REFUND ON A DISAPPOINTING RESULT — the
// user is buying a verdict, not a bump (decision 1 of the spec) — but a FAILED
// run is not a verdict, so an error before the Main lands leaves them unbilled,
// and an error after it is reported with what was spent.
//
// ── PROGRESS, so the modal lights can tell the truth ───────────────────────
// Stage is written to `users/{uid}/meta/clean_run` after each step. That path is
// already owner-readable under the existing Firestore rules, so the client can
// subscribe to it with onSnapshot and light RUNNING MAIN and RUNNING DEEP on
// the real transitions — no new endpoint and no rules change. Matt said timed
// lights would be acceptable; they are not necessary, so this does it properly.
//
//   POST /api/assess_clean_run
//   { itemId, afterUrls: { main:[4], corner:[4], interiorCover:[2] },
//     before: {...}, identity: {...}, runNumber }
//   -> { after, comparison, creditsCharged, ms }
import process from 'node:process';
import { ROBOGRADE_VERSION } from '../lib/version.js';
import {
  CLIENT_SECRET, applyCors, getAdminDb, verifyUidFromAuthHeader, fetchAll
} from '../lib/batch_common.js';

// Each hop has its own 55s abort inside assess.js / assess_deep.js. This is the
// outer guard for a hop that never answers at all.
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
    if (!r.ok) throw new Error(`${label} ${r.status}: ${text.slice(0, 200)}`);
    let parsed;
    try { parsed = JSON.parse(text); } catch { throw new Error(`${label}: unparseable response`); }
    return { parsed, ms: Date.now() - t0 };
  } finally { clearTimeout(t); }
}

export default async function handler(req, res) {
  if (applyCors(req, res)) return;
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const {
    itemId = null, afterUrls = null, before = null, identity = null, runNumber = 1
  } = req.body || {};

  if (!afterUrls || !Array.isArray(afterUrls.main) || afterUrls.main.length < 4) {
    return res.status(400).json({ error: 'afterUrls.main must hold the 4 After main images' });
  }
  if (!Array.isArray(afterUrls.corner) || afterUrls.corner.length < 4) {
    return res.status(400).json({ error: 'afterUrls.corner must hold the 4 After corner macros' });
  }
  if (!before) return res.status(400).json({ error: 'before result is required' });

  const uid = await verifyUidFromAuthHeader(req);
  if (!uid) return res.status(401).json({ error: 'auth required' });
  const authHeader = req.headers.authorization || req.headers.Authorization || '';

  const db = await getAdminDb();
  const base = baseUrlOf(req);
  const t0 = Date.now();

  // Progress. Owner-readable, so the client subscribes and lights the modal on
  // the real transitions. Best-effort: a failed stage write must never fail the
  // run — the lights are cosmetic, the grading is not.
  const stageRef = db ? db.collection('users').doc(uid).collection('meta').doc('clean_run') : null;
  const setStage = async (stage, extra) => {
    if (!stageRef) return;
    try {
      await stageRef.set({
        stage, itemId, runNumber, at: new Date().toISOString(),
        version: ROBOGRADE_VERSION, ...(extra || {})
      }, { merge: true });
    } catch (e) { /* non-fatal */ }
  };

  let creditsCharged = 0;
  try {
    await setStage('loading');

    // The ten After photos, fetched once here rather than shipped through the
    // request body — same as Batch. Keeps the payload small and means the
    // client never has to hold ten base64 blobs in memory on a phone.
    const [mainImgs, cornerImgs, icImgs] = await Promise.all([
      fetchAll(afterUrls.main.slice(0, 4)),
      fetchAll(afterUrls.corner.slice(0, 4)),
      fetchAll((afterUrls.interiorCover || []).slice(0, 2))
    ]);
    if (mainImgs.length < 4) throw new Error('could not fetch the 4 After main images');
    if (cornerImgs.length < 4) throw new Error('could not fetch the 4 After corner macros');

    // ── 1. MAIN on the After set ────────────────────────────────────────────
    await setStage('main');
    const mainBody = {
      images: mainImgs,
      title: (identity && identity.title) || '',
      issueNumber: String((identity && identity.issue) || ''),
      // knownIdentity is DELIBERATELY NOT SENT, and the reasoning is worth
      // keeping because the obvious choice is the wrong one.
      //
      // The book's identity IS already settled — same book, re-shot — so
      // knownIdentity looks made for this, and it skips PHASE 0's
      // re-derivation. But it also selects the `main_ki` cached prefix, which
      // is a DIFFERENT cache entry and the one the keep-warm ping deliberately
      // never warms (§78). Skipping identification saves roughly two cents; a
      // cold prefix costs roughly twenty-two. Sending it would have made every
      // Cleaning Compare Main a guaranteed ~$0.30 cold write to save ~$0.02.
      //
      // Without it this Main uses the ordinary `main` prefix, which is warm
      // ~88% of the time, and re-derives an identity it will agree with anyway.
      serverCredits: true
    };
    const { parsed: M } = await callGrader(`${base}/api/assess`, mainBody, authHeader, 'assess');
    creditsCharged += (typeof M.creditsCharged === 'number') ? M.creditsCharged : 1;

    // ── 2. DEEP on the After set, refining that Main ───────────────────────
    await setStage('deep', { afterMainGrade: M.grade || null });
    const deepBody = {
      initialAssessment: {
        title: M.title || (identity && identity.title) || '',
        issue: M.issue || String((identity && identity.issue) || ''),
        issueDate: M.issueDate || (identity && identity.issueDate) || '',
        publisher: M.publisher || (identity && identity.publisher) || '',
        printing: M.printing || (identity && identity.printing) || '',
        pageQuality: M.pageQuality || (M.roboGrade && M.roboGrade.pageQuality) || '',
        grade: M.grade || '',
        graderNotes: '',
        aiAssessment: M.aiAssessment || '',
        labelNotes: M.labelNotes || '',
        keyInfo: M.keyInfo || '',
        enhance: M.enhance,
        labelDetected: !!M.labelDetected,
        roboGrade: M.roboGrade || {},
        photograder: M.photograder || null
      },
      cornerMacros: cornerImgs,
      interiorCovers: icImgs.length === 2 ? icImgs : [],
      frontCover: mainImgs[0] || null,
      title: (identity && identity.title) || '',
      issueNumber: String((identity && identity.issue) || ''),
      referenceImageUrl: (identity && identity.referenceImageUrl) || null,
      serverCredits: true
    };
    const { parsed: D } = await callGrader(`${base}/api/assess_deep`, deepBody, authHeader, 'assess_deep');
    creditsCharged += (typeof D.creditsCharged === 'number') ? D.creditsCharged : 1;

    // The After result is the DEEP's — same as an ordinary book, where the Deep
    // refines the Main and the Deep's grade is the one that sticks.
    const after = {
      grade: D.grade || M.grade || null,
      roboGrade: D.roboGrade || M.roboGrade || {},
      pageQuality: D.pageQuality || (D.roboGrade && D.roboGrade.pageQuality)
                   || M.pageQuality || (M.roboGrade && M.roboGrade.pageQuality) || '',
      defects: (D.roboGrade && D.roboGrade.defects) || (M.roboGrade && M.roboGrade.defects) || [],
      restorationFlag: !!(D.restorationFlag || M.restorationFlag),
      restorationHighConfidence: !!(D.restorationHighConfidence || M.restorationHighConfidence),
      aiAssessment: D.aiAssessment || M.aiAssessment || '',
      deepAssessment: D.deepAssessment || '',
      gradeAtCeiling: !!D.gradeAtCeiling,
      _main: M, _deep: D
    };

    // ── 3. COMPARE. No images, no credit. ───────────────────────────────────
    await setStage('comparing', { afterGrade: after.grade || null });
    const { parsed: C } = await callGrader(`${base}/api/assess_clean`, {
      itemId,
      before,
      after,
      title: (identity && identity.title) || '',
      issue: String((identity && identity.issue) || ''),
      runNumber
    }, authHeader, 'assess_clean');

    await setStage('done', {
      afterGrade: after.grade || null,
      gradeDelta: (C.comparison && C.comparison.gradeDelta) != null ? C.comparison.gradeDelta : null,
      finishedAt: new Date().toISOString()
    });

    return res.status(200).json({
      ok: true,
      version: ROBOGRADE_VERSION,
      after,
      comparison: C.comparison || null,
      creditsCharged,
      creditsRemaining: (typeof D.creditsRemaining === 'number') ? D.creditsRemaining : null,
      ms: Date.now() - t0
    });

  } catch (e) {
    const msg = String((e && e.message) || e).slice(0, 300);
    await setStage('error', { error: msg, creditsCharged, finishedAt: new Date().toISOString() });
    // creditsCharged is reported so the client can say exactly what was spent.
    // DELIBERATELY NOT auto-refunded here: the Main and the Deep each refund
    // themselves when THEY fail, so a non-zero figure at this point means that
    // pass actually succeeded and produced a graded result. Handing the credit
    // back for work that was done would be the wrong correction, and silently
    // doing it would hide a failure that should be looked at.
    console.error('[clean_run] failed after', creditsCharged, 'credits:', msg);
    return res.status(502).json({ error: 'cleaning compare failed', detail: msg, creditsCharged });
  }
}
