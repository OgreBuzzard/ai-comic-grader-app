// lib/unlimited.js — UNLIMITED GRADING (v6.79, Matt's spec 2026-11-20)
// =============================================================================
// WHAT IT IS
//
// A one-off purchase ($150 web / $149.99 in the apps) on sale from Black Friday
// (27 Nov 2026) to 31 Dec 2026. It grants 168 hours of assessments that do not
// charge credits. The 168 hours start at the FIRST assessment after purchase,
// not at the purchase. If the buyer has not started within 30 days, the week
// starts on its own on day 30 (stated in the Unlimited terms).
//
// The credit balance is NEVER touched while the week runs: assessments are
// simply not debited. When the week ends, the user is back on exactly the
// balance they had before it began. "Reverts to the credits they had" falls out
// of that for free; nothing is stored or restored.
//
// Comics and magazines only - cards are not announced (Matt). Callers pass an
// `unlimited` option only for the kinds below; the card endpoint never does.
//
// =============================================================================
// THE USER DOC
//
//   unlimited: {
//     purchasedAt, purchaseId, source,     // which purchase granted it
//     startBy,                              // purchasedAt + 30 days (ISO)
//     startedAt, endsAt,                    // set at the first covered assessment
//     uses, usesByKind: { main, deep, full, batch },
//     revokedAt, revokeReason               // a refund ends it
//   }
//   unlimitedBlocked: true                  // refunded once -> may not buy again
//   unlimitedHistory: [ ...past weeks ]     // a finished week, kept for admin
//
// Every covered assessment also writes users/{uid}/unlimited_uses/{auto}
// { at (ms), kind, imageHash }. Those rows are the rate-limit window AND the
// admin's per-week count.
//
// =============================================================================
// RATE LIMITS (Matt's list; numbers are the constants below)
//
//   Batch                       1 per hour, 3 per 24 hours.
//   Main / Deep / Full re-run   the SAME photos at most 3 more times an hour
//                               (the first run plus 3 re-runs). New photos are
//                               never limited. Post-Cleaning runs through Main
//                               and Deep, so it is covered by the same rule.
//
// "The same photos" is decided HERE, from a hash of the image bytes the request
// actually carries - never from anything the client says about itself.
//
// Over a limit the assessment is REFUSED (nothing run, nothing charged) with a
// message saying when it can run again. Falling back to spending credits would
// surprise people; refusing is the honest version of a limit.
//
// FAIL OPEN, as lib/credits.js does: if the rate-limit read fails, the
// assessment is covered. A Firestore blip must not cost an Unlimited buyer.

import crypto from 'node:crypto';

export const UNLIMITED_HOURS = 168;
export const UNLIMITED_START_WINDOW_DAYS = 30;
export const UNLIMITED_PRICE_CENTS = 15000;

// Sale window, US Pacific. The Buy screen and every grant path read these.
// Stored as UTC instants: 27 Nov 2026 00:00 PST = 08:00 UTC; the sale ends at
// the END of 31 Dec 2026 PST = 1 Jan 2027 08:00 UTC.
export const UNLIMITED_SALE_START = Date.parse('2026-11-27T08:00:00Z');
export const UNLIMITED_SALE_END = Date.parse('2027-01-01T08:00:00Z');

// One product id on both stores. App Store: a Non-Renewing Subscription.
// Google Play: a one-time (consumable) in-app product.
export const UNLIMITED_PRODUCT_ID = 'app.robograder.unlimited.week';

export const LIMIT_SAME_IMAGES_PER_HOUR = 4;   // first run + 3 re-runs
export const LIMIT_BATCH_PER_HOUR = 1;
export const LIMIT_BATCH_PER_DAY = 3;
export const UNLIMITED_KINDS = ['main', 'deep', 'full', 'batch'];

const HOUR = 3600 * 1000;

export function unlimitedOnSale(nowMs) {
  const n = Number.isFinite(nowMs) ? nowMs : Date.now();
  return n >= UNLIMITED_SALE_START && n < UNLIMITED_SALE_END;
}

/** A stable hash of the image payload a request carries. */
export function imageHashOf(...parts) {
  try {
    const h = crypto.createHash('sha256');
    for (const p of parts) h.update(typeof p === 'string' ? p : JSON.stringify(p == null ? null : p));
    return h.digest('hex').slice(0, 32);
  } catch (e) { return null; }
}

/**
 * Where an account stands.
 *   none     no purchase, or it was refunded
 *   pending  bought, week not started
 *   active   inside the 168 hours
 *   ended    the week is over
 */
export function unlimitedState(u, nowMs) {
  const now = Number.isFinite(nowMs) ? nowMs : Date.now();
  const x = u && u.unlimited;
  if (!x || !x.purchasedAt || x.revokedAt) return { status: 'none' };
  const startBy = Date.parse(x.startBy || '') || (Date.parse(x.purchasedAt) + UNLIMITED_START_WINDOW_DAYS * 24 * HOUR);
  let start = x.startedAt ? Date.parse(x.startedAt) : null;
  let autoStarted = false;
  if (!start && now >= startBy) { start = startBy; autoStarted = true; }
  if (!start) return { status: 'pending', startBy };
  const end = start + UNLIMITED_HOURS * HOUR;
  return { status: now < end ? 'active' : 'ended', startedAt: start, endsAt: end, startBy, autoStarted };
}

export class UnlimitedLimit extends Error {
  constructor(message, retryAtMs) {
    super(message);
    // Same code as an empty balance, so every endpoint's existing 402 branch
    // returns it without new plumbing. `reason` tells the client which it is.
    this.code = 'insufficient_credits';
    this.reason = 'unlimited_limit';
    this.retryAt = retryAtMs ? new Date(retryAtMs).toISOString() : null;
    this.balance = 0;
    this.cost = 0;
  }
}

function _fmtWait(ms) {
  const m = Math.max(1, Math.ceil(ms / 60000));
  if (m < 60) return m + ' minute' + (m === 1 ? '' : 's');
  const h = Math.ceil(m / 60);
  return h + ' hour' + (h === 1 ? '' : 's');
}

/**
 * Inside the caller's transaction, AFTER it has read the user doc: decide
 * whether Unlimited covers this assessment, enforce the limits, and queue the
 * writes. Returns null when Unlimited does not apply (charge as normal).
 * Throws UnlimitedLimit when it applies but a limit is hit.
 *
 * All reads happen before any write, as Firestore transactions require.
 */
export async function unlimitedCoverInTx(tx, db, uRef, userData, opts) {
  const kind = opts && opts.kind;
  if (!kind || !UNLIMITED_KINDS.includes(kind)) return null;
  const now = Date.now();
  const st = unlimitedState(userData, now);
  if (st.status !== 'pending' && st.status !== 'active') return null;

  const usesCol = uRef.collection('unlimited_uses');
  const hash = (opts && opts.imageHash) || null;
  let recent = [];
  try {
    const q = usesCol.where('at', '>=', now - 24 * HOUR);
    const snap = await tx.get(q);
    recent = snap.docs.map(d => d.data() || {});
  } catch (e) {
    console.warn('[unlimited] rate-limit read failed, covering (fail-open):', (e && e.message) || e);
    recent = [];
  }

  if (kind === 'batch') {
    const lastHour = recent.filter(r => r.kind === 'batch' && r.at >= now - HOUR);
    const lastDay = recent.filter(r => r.kind === 'batch');
    if (lastHour.length >= LIMIT_BATCH_PER_HOUR) {
      const retry = Math.min(...lastHour.map(r => r.at)) + HOUR;
      throw new UnlimitedLimit('Unlimited includes one Batch per hour. You can run the next one in ' + _fmtWait(retry - now) + '. Nothing was charged.', retry);
    }
    if (lastDay.length >= LIMIT_BATCH_PER_DAY) {
      const retry = Math.min(...lastDay.map(r => r.at)) + 24 * HOUR;
      throw new UnlimitedLimit('Unlimited includes three Batches per 24 hours. You can run the next one in ' + _fmtWait(retry - now) + '. Nothing was charged.', retry);
    }
  } else if (hash) {
    const same = recent.filter(r => r.kind === kind && r.imageHash === hash && r.at >= now - HOUR);
    if (same.length >= LIMIT_SAME_IMAGES_PER_HOUR) {
      const retry = Math.min(...same.map(r => r.at)) + HOUR;
      const what = kind === 'main' ? 'Main' : kind === 'deep' ? 'Deep' : 'Full';
      throw new UnlimitedLimit('Unlimited allows 3 re-runs of a ' + what + ' on the same photos per hour. Retake any photo to run it now, or try again in ' + _fmtWait(retry - now) + '. Nothing was charged.', retry);
    }
  }

  const { FieldValue } = await import('firebase-admin/firestore');
  const upd = {
    'unlimited.uses': FieldValue.increment(1),
    ['unlimited.usesByKind.' + kind]: FieldValue.increment(1),
    'unlimited.lastUseAt': new Date(now).toISOString()
  };
  let started = false;
  if (st.status === 'pending' || st.autoStarted) {
    const startMs = st.status === 'pending' ? now : st.startedAt;
    upd['unlimited.startedAt'] = new Date(startMs).toISOString();
    upd['unlimited.endsAt'] = new Date(startMs + UNLIMITED_HOURS * HOUR).toISOString();
    started = st.status === 'pending';
  }
  tx.update(uRef, upd);
  tx.set(usesCol.doc(), { at: now, kind, imageHash: hash, purchaseId: (userData.unlimited && userData.unlimited.purchaseId) || null });
  const endsAt = st.status === 'pending' ? now + UNLIMITED_HOURS * HOUR : st.endsAt;
  return { covered: true, started, endsAt: new Date(endsAt).toISOString() };
}

/**
 * Grant Unlimited from a verified purchase, inside the caller's transaction,
 * after it has read the user doc (`userSnap`). Returns what happened:
 *   'granted'         the account now holds a week (pending until first use)
 *   'blocked_active'  a week is already pending or running - Matt: block it,
 *                     no extensions. The purchase is still recorded so it can
 *                     be refunded by hand.
 *   'blocked_refund'  this account refunded Unlimited before.
 * The client blocks both cases before the store sheet opens; these are the
 * server's answer if one gets through anyway (a race, a second device).
 */
export function grantUnlimitedInTx(tx, uRef, userSnap, info) {
  const now = Date.now();
  const u = userSnap && userSnap.exists ? (userSnap.data() || {}) : {};
  if (u.unlimitedBlocked) return 'blocked_refund';
  const st = unlimitedState(u, now);
  if (st.status === 'pending' || st.status === 'active') return 'blocked_active';
  const history = Array.isArray(u.unlimitedHistory) ? u.unlimitedHistory.slice(-9) : [];
  if (u.unlimited && u.unlimited.purchasedAt) history.push(u.unlimited);
  const rec = {
    unlimited: {
      purchasedAt: new Date(now).toISOString(),
      purchaseId: info.purchaseId || null,
      source: info.source || null,
      startBy: new Date(now + UNLIMITED_START_WINDOW_DAYS * 24 * HOUR).toISOString(),
      startedAt: null, endsAt: null, uses: 0, usesByKind: {},
      revokedAt: null, revokeReason: null
    },
    unlimitedHistory: history,
    everPurchased: true
  };
  if (userSnap && userSnap.exists) tx.update(uRef, rec); else tx.set(uRef, rec, { merge: true });
  return 'granted';
}

/**
 * A refund came through for an Unlimited purchase: end the week now and block
 * a repurchase. Only revokes if the refunded purchase is the CURRENT one.
 */
export async function revokeUnlimited(db, uid, purchaseId, reason) {
  if (!db || !uid) return false;
  const uRef = db.collection('users').doc(uid);
  let done = false;
  await db.runTransaction(async tx => {
    const s = await tx.get(uRef);
    if (!s.exists) return;
    const u = s.data() || {};
    const upd = { unlimitedBlocked: true };
    if (u.unlimited && (!purchaseId || u.unlimited.purchaseId === purchaseId) && !u.unlimited.revokedAt) {
      upd['unlimited.revokedAt'] = new Date().toISOString();
      upd['unlimited.revokeReason'] = reason || 'refund';
      done = true;
    }
    tx.update(uRef, upd);
  });
  console.log('[unlimited] refund for ' + uid + ' (' + (purchaseId || '?') + '): ' + (done ? 'week ended' : 'no current week') + ', repurchase blocked');
  return done;
}

/** How many assessments a purchase's week has run. For Apple's consumption ask and admin. */
export async function unlimitedUsesFor(db, uid, purchaseId) {
  try {
    const snap = await db.collection('users').doc(uid).collection('unlimited_uses').where('purchaseId', '==', purchaseId).get();
    return snap.size;
  } catch (e) { return null; }
}
