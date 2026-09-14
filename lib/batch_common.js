// lib/batch_common.js — shared plumbing for the Batch Assessment endpoints
// (assess_batch_start / assess_batch_run / assess_batch_status).
//
// Spec: claude/ASSESS_BATCH_SPEC.md v3.1. Read §3 before changing anything here.
//
// KEY ARCHITECTURAL FACT (established S22 by reading the code, and it is what
// makes this design simple): Batch only runs on a book that is already SAVED
// and already Main+Deep'd — that is the eligibility gate. Its images are
// therefore ALREADY in Firebase Storage, and index.html's processImagesForSave()
// uploads them through `compressImage(img, 1200, 0.65)` — the SAME compression
// the grading path uses. So the stored images are production-faithful and the
// phone does not need to upload anything for a Batch. `assess_batch_start`
// takes an itemId, not an image payload.
//
// A second fact this leans on: /api/assess and /api/assess_deep are STATELESS
// graders. They verify the caller's token for abuse/lockout only — they do NOT
// check credits, do NOT deduct credits (that is client-side in index.html) and
// do NOT write the item doc. Their only side effect is an assessment_timings
// row. Verified 2026-09-14. That is why a batch worker may call them directly:
// the v2 bug was the CLIENT loop calling the client-side assess functions (each
// of which uploaded, animated and decremented), not these endpoints.

export const BATCH_N = 5;
export const BATCH_CREDIT_COST = 3;

// Client secret the app already sends on grading calls; forwarded by workers so
// the worker->endpoint call is indistinguishable from a normal app call.
export const CLIENT_SECRET = '022dd9f3586314b52b283f86342ee839c74b0cafbb2ca925494205377815d47d';

// ── Firebase Admin ──────────────────────────────────────────────────────────
export async function getAdminDb() {
  try {
    if (!process.env.FIREBASE_SERVICE_ACCOUNT) return null;
    const { initializeApp, getApps, cert } = await import('firebase-admin/app');
    const { getFirestore } = await import('firebase-admin/firestore');
    if (!getApps().length) {
      initializeApp({ credential: cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)) });
    }
    return getFirestore();
  } catch (e) {
    console.error('[batch] Firebase Admin init failed:', e);
    return null;
  }
}

export async function verifyUidFromAuthHeader(req) {
  try {
    const auth = req.headers.authorization || req.headers.Authorization || '';
    const m = auth.match(/^Bearer\s+(.+)$/);
    if (!m) return null;
    const { getAuth } = await import('firebase-admin/auth');
    const { initializeApp, getApps, cert } = await import('firebase-admin/app');
    if (!getApps().length) {
      initializeApp({ credential: cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)) });
    }
    const decoded = await getAuth().verifyIdToken(m[1]);
    return decoded.uid;
  } catch (e) {
    console.error('[batch] Token verification failed:', e);
    return null;
  }
}

// ── CORS (mirrors assess.js / assess_deep.js exactly) ───────────────────────
export function applyCors(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, Accept, x-client-secret');
  res.setHeader('Access-Control-Max-Age', '86400');
  if (req.method === 'OPTIONS') { res.status(204).end(); return true; }
  return false;
}

// ── Item helpers ────────────────────────────────────────────────────────────
// Items live at users/{uid}/items/{itemId} (schema v3, nested per type).
export function itemRef(db, uid, itemId) {
  return db.collection('users').doc(uid).collection('items').doc(itemId);
}

export function comicOf(item) {
  return (item && (item.comicData || item)) || {};
}

const urlOf = x => (x && (x.url || (typeof x === 'string' ? x : null))) || null;

export function imageUrlsOf(item) {
  return {
    main:   (item.images || []).map(urlOf).filter(Boolean).slice(0, 4),
    corner: (item.cornerImages || []).map(urlOf).filter(Boolean).slice(0, 4),
    interiorCover: (item.interiorCoverImages || []).map(urlOf).filter(Boolean).slice(0, 2)
  };
}

// ── Eligibility — server-side mirror of index.html isBatchEligible() ────────
// Reads PERSISTED fields only. The S21 bug was the client gate calling
// isDeepAssessmentComplete(), whose transient flags are lost on reload in Edit;
// do not reintroduce that dependency here.
export function checkEligibility(item) {
  if (!item) return { ok: false, reason: 'item_not_found', message: 'Book not found.' };
  if (item.type === 'card') return { ok: false, reason: 'cards_unsupported', message: 'Batch is for comics only.' };

  const c = comicOf(item);
  const corners = (item.cornerImages || []).filter(Boolean);
  const deepRan = corners.length >= 4 && !!(
    item.deepAssessment || c.deepAssessment ||
    item.deepAssessmentRan || c.deepAssessmentRan ||
    item.deepUnlocked || c.deepUnlocked ||
    item.highGradeUnlocked || c.highGradeUnlocked
  );
  if (!deepRan) {
    return { ok: false, reason: 'deep_required', message: 'Run a Deep assessment on this book first.' };
  }

  // Photograder gate: zero C grades, at most one B, across the four axes.
  const pg = item.photograder || c.photograder || (item.roboGrade && item.roboGrade.photograder) || null;
  if (pg) {
    const axes = ['focus', 'lighting', 'cropping', 'angle']
      .map(k => String(pg[k] || '').trim().toUpperCase())
      .filter(Boolean);
    const cs = axes.filter(g => g === 'C').length;
    const bs = axes.filter(g => g === 'B').length;
    if (cs > 0 || bs > 1) {
      return {
        ok: false, reason: 'photo_quality',
        message: 'Batch needs clean photos — at most one B and no C grades. Retake the flagged photo(s) and re-run Deep.'
      };
    }
  }
  return { ok: true };
}

// ── Grade-reference bracket, resolved ONCE per batch (spec §4.3) ────────────
// Deep normally derives its ±2 bracket from ITS OWN Main's grade. In a batch we
// fix one bracket from the item's stored grade so the Deep prefix is identical
// across passes and can be cached.
//
// ⚠ This is the §4.3 tension, and it is NOT settled: fixing the bracket removes
// a real source of pass-to-pass divergence. Each worker still records its own
// Main grade alongside its Deep grade, so the batch doc carries the evidence to
// answer it. If Deep spread comes back materially narrower than Main spread,
// set BATCH_FIXED_BRACKET = false and each pass reverts to its own bracket, at
// the cost of Deep prompt caching. One-line change, deliberately.
export const BATCH_FIXED_BRACKET = true;

export function bracketAnchorGrade(item) {
  const c = comicOf(item);
  const g = parseFloat(c.predictedGrade || c.assessedCGCGrade || '');
  return Number.isFinite(g) ? g : null;
}

// ── Batch doc shape ─────────────────────────────────────────────────────────
export function newBatchDoc({ uid, itemId, n, refs, anchorGrade, version }) {
  return {
    uid, itemId,
    n,
    status: 'running',
    startedAt: new Date().toISOString(),
    startedAtMs: Date.now(),
    version: version || null,
    anchorGrade: anchorGrade ?? null,
    fixedBracket: BATCH_FIXED_BRACKET,
    refs: refs || {},
    fanoutAt: null,          // set when passes 2..n are launched
    passes: Array.from({ length: n }, (_, i) => ({
      pass: i + 1, stage: 'queued',
      mainRG: null, mainGrade: null,
      rg: null, grade: null, pg: null, pq: null,
      subscores: null, defectCount: null, deepAdded: null,
      mainMs: null, deepMs: null, error: null,
      mainTimingKey: null, deepTimingKey: null
    })),
    average: null, low: null, high: null,
    completedAt: null
  };
}

export function batchRef(db, batchId) {
  return db.collection('batches').doc(batchId);
}

export function makeBatchId() {
  return 'b_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
}

// ── Image fetch (server-side, from Firebase Storage download URLs) ──────────
export async function fetchAsDataUrl(url, timeoutMs = 12000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { signal: ctrl.signal });
    if (!r.ok) throw new Error(`image ${r.status}`);
    const buf = Buffer.from(await r.arrayBuffer());
    const ct = (r.headers.get('content-type') || 'image/jpeg').split(';')[0].trim();
    const type = /^image\/(jpeg|png|gif|webp)$/.test(ct) ? ct : 'image/jpeg';
    return `data:${type};base64,` + buf.toString('base64');
  } finally { clearTimeout(t); }
}

// Fetch a set of URLs concurrently. Returns nulls in place of failures so the
// caller can decide whether the missing slot is fatal.
export async function fetchAll(urls, timeoutMs) {
  return Promise.all((urls || []).map(u =>
    fetchAsDataUrl(u, timeoutMs).catch(e => {
      console.warn('[batch] image fetch failed:', u && u.slice(0, 80), e && e.message);
      return null;
    })
  ));
}
