// api/assess_batch_start.js — Batch Assessment, step 1 of 3.
// Spec: claude/ASSESS_BATCH_SPEC.md v3.1 §3.1.
//
// Takes an itemId — NOT an image payload. Batch only runs on an already-saved,
// already-Deep'd book, so its images are already in Firebase Storage at the
// same 1200/q65 compression the grader uses (index.html processImagesForSave).
// The phone uploads nothing. See lib/batch_common.js header.
//
// This endpoint is the ONE place credits are deducted for a batch: 3 credits,
// once, in a transaction, server-side. That differs from the rest of the app
// (single assessments decrement client-side in index.html) and is deliberate —
// a batch fans out to 5 workers and a client-side decrement could not be made
// to correspond to it.
//
// Returns fast (~1s). The CLIENT then drives the fan-out: it calls
// /api/assess_batch_run for pass 1, polls /api/assess_batch_status, and fires
// passes 2..N when pass 1's Main lands (with a 35s fallback). The fan-out lives
// in the client because a Vercel function cannot outlive its response, and the
// worker requests are tiny (batchId + pass number) now that images are not in
// the payload.

import { ROBOGRADE_VERSION } from '../lib/version.js';
import {
  BATCH_N, BATCH_CREDIT_COST, applyCors, getAdminDb, verifyUidFromAuthHeader,
  itemRef, comicOf, imageUrlsOf, checkEligibility, bracketAnchorGrade,
  newBatchDoc, batchRef, makeBatchId
} from '../lib/batch_common.js';

export default async function handler(req, res) {
  if (applyCors(req, res)) return;
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { itemId } = req.body || {};
  if (!itemId) return res.status(400).json({ error: 'itemId required' });

  const uid = await verifyUidFromAuthHeader(req);
  if (!uid) return res.status(401).json({ error: 'auth required' });

  const db = await getAdminDb();
  if (!db) return res.status(500).json({ error: 'server not configured' });

  // ── load item + verify it may be batched ──────────────────────────────────
  const iRef = itemRef(db, uid, itemId);
  const iSnap = await iRef.get();
  if (!iSnap.exists) return res.status(404).json({ error: 'item_not_found', message: 'Book not found.' });
  const item = iSnap.data();

  const elig = checkEligibility(item);
  if (!elig.ok) return res.status(400).json({ error: elig.reason, message: elig.message });

  const urls = imageUrlsOf(item);
  if (urls.main.length < 2) {
    return res.status(400).json({ error: 'images_missing', message: 'This book is missing its cover images.' });
  }
  if (urls.corner.length !== 4) {
    return res.status(400).json({ error: 'corners_missing', message: 'Batch needs all 4 corner macros from a Deep assessment.' });
  }

  // ── deduct 3 credits, once, atomically ────────────────────────────────────
  const uRef = db.collection('users').doc(uid);
  let remaining = null;
  try {
    remaining = await db.runTransaction(async tx => {
      const uSnap = await tx.get(uRef);
      if (!uSnap.exists) throw Object.assign(new Error('no user doc'), { code: 'no_account' });
      const u = uSnap.data();
      if (u.accountFlagged) throw Object.assign(new Error('flagged'), { code: 'account_flagged' });
      if (u.assessmentLockedUntil && new Date(u.assessmentLockedUntil).getTime() > Date.now()) {
        throw Object.assign(new Error('locked'), { code: 'temp_lockout' });
      }
      const bal = Number(u.assessmentCredits);
      if (!Number.isFinite(bal) || bal < BATCH_CREDIT_COST) {
        throw Object.assign(new Error('insufficient'), { code: 'insufficient_credits', balance: Number.isFinite(bal) ? bal : 0 });
      }
      tx.update(uRef, { assessmentCredits: bal - BATCH_CREDIT_COST });
      return bal - BATCH_CREDIT_COST;
    });
  } catch (e) {
    const code = e && e.code;
    if (code === 'insufficient_credits') {
      return res.status(402).json({ error: code, balance: e.balance ?? 0, cost: BATCH_CREDIT_COST,
        message: `Batch costs ${BATCH_CREDIT_COST} credits. You have ${e.balance ?? 0}.` });
    }
    if (code === 'account_flagged' || code === 'temp_lockout' || code === 'no_account') {
      return res.status(403).json({ error: code, message: 'This account cannot run an assessment right now.' });
    }
    console.error('[batch_start] credit transaction failed:', e);
    return res.status(500).json({ error: 'credit_failed', message: 'Could not reserve credits. Nothing was charged.' });
  }

  // ── write the batch doc ───────────────────────────────────────────────────
  const c = comicOf(item);
  const batchId = makeBatchId();
  const doc = newBatchDoc({
    uid, itemId, n: BATCH_N,
    version: ROBOGRADE_VERSION,
    anchorGrade: bracketAnchorGrade(item),
    refs: {
      front: item.referenceImageUrl || c.referenceImageUrl || null,
      back: item.referenceBackImageUrl || c.referenceBackImageUrl || null
    }
  });
  doc.creditsCharged = BATCH_CREDIT_COST;
  doc.identity = {
    title: c.title || '', issue: String(c.issue || ''), issueDate: c.issueDate || '',
    publisher: c.publisher || '', printing: c.printing || '',
    labelDetected: !!c.labelDetected, labelKind: c.labelKind || ''
  };
  doc.imageUrls = urls;

  try {
    await batchRef(db, batchId).set(doc);
  } catch (e) {
    // Refund rather than silently pocket the credits.
    console.error('[batch_start] batch doc write failed, refunding:', e);
    try {
      const { FieldValue } = await import('firebase-admin/firestore');
      await uRef.update({ assessmentCredits: FieldValue.increment(BATCH_CREDIT_COST) });
    } catch (e2) { console.error('[batch_start] REFUND FAILED — manual correction needed for uid', uid, e2); }
    return res.status(500).json({ error: 'batch_create_failed', message: 'Could not start the batch. Your credits were not charged.' });
  }

  return res.status(200).json({
    batchId, n: BATCH_N, creditsCharged: BATCH_CREDIT_COST,
    creditsRemaining: remaining, anchorGrade: doc.anchorGrade
  });
}
