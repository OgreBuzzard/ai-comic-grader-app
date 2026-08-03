// api/referral.js — Referral Bonus.
//
// The ISSUER (a purchaser) enters the REFERRER's 4-char transferCode. For a
// valid, not-yet-consumed purchased tier we grant the tier bonus to the
// referrer, a flat +3 to the issuer, consume that tier, enqueue the referrer's
// on-load notification, and write an idempotent audit row.
//
//   POST { action:'status' }             -> { ok, eligible }           (button visibility)
//   POST { action:'issue', code:'ABCD' } -> { ok, tier, referrerCredits, issuerCredits, stillEligible }
//                                        or { error, reason:'self'|'not_found'|'none'|'format' }
//
// ESM note (matches verify_play/verify_iap): one static Node built-in import
// keeps Vercel treating this file as ESM; firebase-admin loads dynamically.
import process from 'node:process';

// Bonus to the REFERRER (the code owner), by tier. The issuer always gets +3.
const REFERRER_BONUS = { comic_stack: 5, comic_wall: 10, short_box: 50 };
const ISSUER_BONUS = 3;

// A purchase's tier is identified by its credit count — works across web
// (Stripe carries no productId), iOS, and Android. 5/20/100 are the only sizes.
const TIER_BY_CREDITS = { 5: 'comic_stack', 20: 'comic_wall', 100: 'short_box' };
const TIER_RANK = { short_box: 3, comic_wall: 2, comic_stack: 1 };

function parseServiceAccount() {
  let raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!raw) throw new Error('FIREBASE_SERVICE_ACCOUNT env var not set');
  if (raw.indexOf('\\"') !== -1) raw = raw.split('\\"').join('"').split('\\\\').join('\\');
  try { return JSON.parse(raw); }
  catch { return JSON.parse(Buffer.from(raw, 'base64').toString('utf8')); }
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const authHeader = req.headers.authorization || '';
    const idToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
    if (!idToken) return res.status(401).json({ error: 'Missing auth token' });

    const body = req.body || {};
    const action = body.action || 'issue';

    const { initializeApp, getApps, cert } = await import('firebase-admin/app');
    const { getAuth } = await import('firebase-admin/auth');
    const { getFirestore, FieldValue } = await import('firebase-admin/firestore');
    if (!getApps().length) initializeApp({ credential: cert(parseServiceAccount()) });

    const decoded = await getAuth().verifyIdToken(idToken);
    const uid = decoded.uid;                     // the issuer
    const db = getFirestore();

    // Which pack tiers has this account bought (production only)?
    const purchSnap = await db.collection('purchases').where('userId', '==', uid).get();
    const purchasedTiers = new Set();
    purchSnap.forEach(d => {
      const p = d.data() || {};
      if (p.refunded) return;                                        // refunded -> tier no longer owned
      if (p.environment && p.environment !== 'Production') return;    // skip sandbox/test buys
      const tier = TIER_BY_CREDITS[p.credits];
      if (tier) purchasedTiers.add(tier);
    });

    // Which tiers has this account already used for a referral?
    const issuerRef = db.collection('users').doc(uid);
    const issuerSnap = await issuerRef.get();
    const referralGiven = (issuerSnap.data() || {}).referralGiven || {};
    const available = [...purchasedTiers]
      .filter(t => !referralGiven[t])
      .sort((a, b) => TIER_RANK[b] - TIER_RANK[a]);                    // highest tier first

    if (action === 'status') {
      return res.status(200).json({ ok: true, eligible: available.length > 0 });
    }

    // action: 'issue'
    const code = String(body.code || '').trim().toUpperCase();
    if (code.length !== 4) return res.status(400).json({ error: 'Enter a valid 4-character code', reason: 'format' });
    if (!available.length) return res.status(400).json({ error: 'No referral bonus available', reason: 'none' });

    const codeSnap = await db.collection('transfer_codes').doc(code).get();
    const recipientUid = codeSnap.exists ? (codeSnap.data() || {}).uid : null;
    if (!recipientUid) return res.status(404).json({ error: "That code doesn't exist — try again.", reason: 'not_found' });
    if (recipientUid === uid) return res.status(400).json({ error: "That's your own code.", reason: 'self' });

    const tier = available[0];                    // highest unused tier
    const referrerBonus = REFERRER_BONUS[tier];
    const auditRef = db.collection('referrals').doc(`${uid}_${tier}`);   // idempotency: one referral per tier
    const recipientRef = db.collection('users').doc(recipientUid);

    let alreadyDone = false;
    await db.runTransaction(async (t) => {
      const a = await t.get(auditRef);
      if (a.exists) { alreadyDone = true; return; }
      const uSnap = await t.get(issuerRef);
      const given = (uSnap.data() || {}).referralGiven || {};
      if (given[tier]) { alreadyDone = true; return; }
      await t.get(recipientRef);                  // read recipient in-txn before writing

      const notif = {
        id: `${uid}_${tier}_${Date.now()}`,       // unique -> arrayUnion never dedupes a real bonus
        credits: referrerBonus,
        createdAt: new Date().toISOString(),
        kind: 'referral',
      };
      t.set(issuerRef, {
        referralGiven: { ...given, [tier]: true },
        assessmentCredits: FieldValue.increment(ISSUER_BONUS),
        totalReferralIssued: FieldValue.increment(ISSUER_BONUS),
      }, { merge: true });
      t.set(recipientRef, {
        assessmentCredits: FieldValue.increment(referrerBonus),
        totalReferralReceived: FieldValue.increment(referrerBonus),
        referralBonusQueue: FieldValue.arrayUnion(notif),
      }, { merge: true });
      t.set(auditRef, {
        issuerUid: uid,
        recipientUid,
        tier,
        referrerCredits: referrerBonus,
        issuerCredits: ISSUER_BONUS,
        reversed: false,
        createdAt: new Date().toISOString(),
      });
    });

    const stillEligible = available.slice(1).length > 0;   // after consuming the top tier
    if (alreadyDone) {
      return res.status(200).json({ ok: true, alreadyDone: true, stillEligible });
    }
    console.log(`[referral] ${uid} -> ${recipientUid} tier=${tier} (+${referrerBonus} referrer, +${ISSUER_BONUS} issuer)`);
    return res.status(200).json({ ok: true, tier, referrerCredits: referrerBonus, issuerCredits: ISSUER_BONUS, stillEligible });
  } catch (e) {
    console.error('[referral]', e && (e.stack || e.message || e));
    return res.status(400).json({ error: (e && e.message) || 'Referral failed' });
  }
}
