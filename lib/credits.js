// lib/credits.js — SERVER-SIDE CREDIT FLOOR (S22, test note 9646)
// =============================================================================
// THE HOLE THIS CLOSES
//
// Until now, credits were enforced entirely in the browser. index.html checked
// `window._userCredits` before offering an assessment and called
// decrementCredit() AFTER the model had already answered. The grading endpoints
// themselves read the user doc only for `accountFlagged` / `assessmentLockedUntil`
// and never looked at `assessmentCredits` at all.
//
// So a signed-in user at zero credits who called /api/assess directly — or who
// ran a client with the check patched out, or simply had a stale balance in a
// tab left open — got a full Opus assessment for free, every time. Batch was the
// only endpoint that ever did this properly (api/assess_batch_start.js), because
// a batch fans out to five workers and a client-side decrement could not be made
// to correspond to it. This module is that transaction, generalized.
//
// =============================================================================
// TWO MODES, AND WHY
//
// reserveCredit() can either just CHECK the balance or CHECK AND DEBIT it. Which
// one happens is decided by the caller passing `debit`, and callers set that from
// a flag the CLIENT sends (`serverCredits: true`).
//
// That indirection is not ceremony. The iOS and Android builds bundle their own
// copy of index.html, so at any moment there are old native clients in the wild
// that will call decrementCredit() on success no matter what the server does. If
// the server also debited them, those users would be charged TWICE per
// assessment until they updated through the app stores — which is weeks.
//
//   • Old client (no `serverCredits` flag): server CHECKS only. The floor is
//     enforced — zero credits means a 402 and no model call — and the client's
//     own decrement stays the single source of the debit. No double charge.
//   • New client (sends `serverCredits: true`): server CHECKS AND DEBITS inside
//     a transaction and returns `creditsRemaining`. The client stops
//     decrementing and syncs its balance to that number instead.
//
// Check-only mode leaves one narrow race: a user with one credit who fires
// several requests at once can have them all pass the check before any
// client-side decrement lands. That costs one extra Opus call per extra request
// and takes deliberate effort. It disappears for every client that sends the
// flag, which is every client built from this commit forward.
//
// =============================================================================
// FAIL OPEN OR FAIL CLOSED
//
// INSUFFICIENT BALANCE fails CLOSED. That is the whole point.
//
// INFRASTRUCTURE TROUBLE fails OPEN — no service account, Firestore unreachable,
// no user doc yet, a legacy doc with no assessmentCredits field. Those users get
// their assessment. This matches what assess.js already does for the abuse check
// ("Fails open on infrastructure error ... so legitimate users aren't locked out
// by our problems"), and the alternative is that a Firestore blip stops every
// paying customer from grading. Every fail-open path logs loudly so it lands in
// the Vercel logs instead of passing silently.

const DEFAULT_COST = 1;

// Thrown ONLY for a genuine insufficient balance. Everything else fails open.
export class InsufficientCredits extends Error {
  constructor(balance, cost) {
    super('insufficient credits: have ' + balance + ', need ' + cost);
    this.code = 'insufficient_credits';
    this.balance = balance;
    this.cost = cost;
  }
}

/**
 * Enforce the credit floor, and optionally debit, BEFORE any model call.
 *
 * @param {object|null}  db          Firestore Admin instance, or null (fails open).
 * @param {string|null}  uid         Authenticated uid, or null (fails open).
 * @param {object}       opts
 * @param {number}       opts.cost   Credits this assessment costs. Default 1.
 * @param {boolean}      opts.debit  True to deduct inside the transaction.
 * @param {string}       opts.label  Short tag for log lines, e.g. 'main', 'deep'.
 *
 * @returns {Promise<{debited:boolean, remaining:number|null, skipped:string|null}>}
 * @throws  {InsufficientCredits} balance is known and below cost.
 */
export async function reserveCredit(db, uid, opts) {
  opts = opts || {};
  const cost = Number.isFinite(opts.cost) ? opts.cost : DEFAULT_COST;
  const debit = opts.debit === true;
  const label = opts.label || 'assess';

  if (cost <= 0) return { debited: false, remaining: null, skipped: 'free' };

  if (!db || !uid) {
    console.warn('[credits:' + label + '] FAIL-OPEN: no ' + (!db ? 'db' : 'uid') + ' — balance not enforced');
    return { debited: false, remaining: null, skipped: !db ? 'no_db' : 'no_uid' };
  }

  const uRef = db.collection('users').doc(uid);

  try {
    return await db.runTransaction(async tx => {
      const snap = await tx.get(uRef);

      if (!snap.exists) {
        // A signed-in user with no doc is mid-signup, or an account created
        // before the doc was written. Blocking here would break first use.
        console.warn('[credits:' + label + '] FAIL-OPEN: no user doc for ' + uid);
        return { debited: false, remaining: null, skipped: 'no_user_doc' };
      }

      const bal = Number(snap.data().assessmentCredits);

      if (!Number.isFinite(bal)) {
        console.warn('[credits:' + label + '] FAIL-OPEN: assessmentCredits missing/non-numeric for ' + uid);
        return { debited: false, remaining: null, skipped: 'no_balance_field' };
      }

      // The floor. This is the only path that fails closed.
      if (bal < cost) throw new InsufficientCredits(bal, cost);

      if (!debit) return { debited: false, remaining: bal, skipped: null };

      tx.update(uRef, { assessmentCredits: bal - cost });
      return { debited: true, remaining: bal - cost, skipped: null };
    });
  } catch (e) {
    if (e instanceof InsufficientCredits || (e && e.code === 'insufficient_credits')) throw e;
    // Transaction machinery failed (contention, network, permissions). Fail open.
    console.error('[credits:' + label + '] FAIL-OPEN: transaction error —', (e && e.message) || e);
    return { debited: false, remaining: null, skipped: 'tx_error' };
  }
}

/**
 * Give back credits THIS request debited. Best-effort and never throws — a
 * refund failure must not turn an already-failed assessment into a 500 as well.
 * Call ONLY when reserveCredit() reported debited:true.
 *
 * A failure here is the one case that costs the USER money, so it logs at error
 * level with the uid, which is what a manual correction needs.
 */
export async function refundCredit(db, uid, cost, label) {
  cost = Number.isFinite(cost) ? cost : DEFAULT_COST;
  label = label || 'assess';
  if (!db || !uid || !(cost > 0)) return false;
  try {
    const { FieldValue } = await import('firebase-admin/firestore');
    await db.collection('users').doc(uid).update({
      assessmentCredits: FieldValue.increment(cost)
    });
    console.log('[credits:' + label + '] refunded ' + cost + ' to ' + uid);
    return true;
  } catch (e) {
    console.error('[credits:' + label + '] REFUND FAILED — manual correction needed for uid ' + uid + ' (' + cost + ' credits):', (e && e.message) || e);
    return false;
  }
}

/** The 402 body. Shared so every endpoint answers a broke user identically. */
export function insufficientCreditsPayload(e, cost) {
  cost = Number.isFinite(cost) ? cost : DEFAULT_COST;
  const balance = (e && Number.isFinite(e.balance)) ? e.balance : 0;
  const need = (e && Number.isFinite(e.cost)) ? e.cost : cost;
  return {
    error: 'insufficient_credits',
    balance: balance,
    cost: need,
    message: need === 1
      ? 'You are out of credits. No assessment was run and nothing was charged.'
      : 'This assessment costs ' + need + ' credits. You have ' + balance + '. Nothing was charged.'
  };
}
