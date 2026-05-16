// api/redeem_promo.js
//
// Promo code redemption endpoint. POST a code, get credits.
//
// Auth: Firebase ID token in Authorization: Bearer <token>.
// Body: { code: string }
//
// Promo registry: server-side constant below. Each entry specifies:
//   code        — the literal code (uppercase, no whitespace; normalized
//                 from client input before comparison)
//   credits     — number of assessment credits granted on redemption
//   activeFrom  — ISO date string. Code is invalid before this instant.
//   expiresAt   — ISO date string. Code is invalid at or after this instant.
//   description — human-readable; surfaced in audit log + error messaging
//
// One-redemption-per-user is enforced via Firestore transaction: the user
// doc has a promosRedeemed: [code, code, ...] array; we check membership
// AND append in the same transaction as the credit increment so no race
// can let a code be redeemed twice.
//
// Audit trail: every redemption writes a promo_redemptions/{auto} doc
// with userId, code, credits, redeemedAt. Same access model as
// credit_adjustments/ and purchases/ — Admin SDK only, no client access.

// ── Promo registry ──────────────────────────────────────────────────────
//
// Dates are stored as ISO strings WITH explicit Pacific time offsets so the
// comparison math is unambiguous. May is in PDT (-07:00); November onward
// is in PST (-08:00). If a promo straddles a DST boundary, set both bounds
// in the appropriate offsets at the time you write the entry.
//
// FENCON26: Robograder convention promo for FenCon attendees. Active from
// 2026-05-15 (today) through midnight Pacific ending 2026-05-20 (three days
// after the convention closes Sunday May 17 — short tail to limit code
// leakage on social media). Grants 5 free assessments to anyone with the
// code. Naive multi-account farming is possible (one per user account is
// enforced; nothing stops a person creating multiple Gmail accounts).
// Acceptable risk for a convention promo — code will be physically present
// at the booth, expiry is short, blast radius is low.
const PROMOS = [
  {
    code:        'FENCON26',
    credits:     5,
    activeFrom:  '2026-05-15T00:00:00-07:00',  // Pacific midnight, start of May 15
    expiresAt:   '2026-05-21T00:00:00-07:00',  // Pacific midnight ending May 20
    description: 'FenCon 2026 attendee promo',
  },
];

function normalizeCode(s) {
  if (typeof s !== 'string') return '';
  return s.trim().toUpperCase().replace(/\s+/g, '');
}

function findActivePromo(code, nowIso) {
  const now = Date.parse(nowIso);
  if (!Number.isFinite(now)) return null;
  for (const p of PROMOS) {
    if (p.code !== code) continue;
    const start = Date.parse(p.activeFrom);
    const end   = Date.parse(p.expiresAt);
    if (!(Number.isFinite(start) && Number.isFinite(end))) continue;
    if (now < start) return { promo: p, status: 'not_yet_active' };
    if (now >= end)  return { promo: p, status: 'expired' };
    return { promo: p, status: 'active' };
  }
  return null;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  try {
    const { initializeApp, getApps, cert } = await import('firebase-admin/app');
    const { getAuth } = await import('firebase-admin/auth');
    const { getFirestore, FieldValue } = await import('firebase-admin/firestore');

    if (!getApps().length) {
      initializeApp({ credential: cert(parseServiceAccount()) });
    }

    // Auth gate
    const auth = req.headers.authorization || '';
    const m = auth.match(/^Bearer\s+(.+)$/);
    if (!m) return res.status(401).json({ error: 'Unauthorized' });
    let decoded;
    try { decoded = await getAuth().verifyIdToken(m[1]); }
    catch { return res.status(401).json({ error: 'Unauthorized' }); }

    const uid = decoded.uid;
    if (!uid) return res.status(401).json({ error: 'Unauthorized' });

    // Body
    const body = req.body || {};
    const code = normalizeCode(body.code);
    if (!code) return res.status(400).json({ error: 'Code is required.' });

    // Resolve promo. Distinguish unknown / not-yet-active / expired so
    // the client can show appropriate messaging.
    const nowIso = new Date().toISOString();
    const lookup = findActivePromo(code, nowIso);
    if (!lookup) {
      return res.status(400).json({ error: 'Invalid promo code.' });
    }
    if (lookup.status === 'not_yet_active') {
      return res.status(400).json({ error: 'This code is not yet active.' });
    }
    if (lookup.status === 'expired') {
      return res.status(400).json({ error: 'This code has expired.' });
    }
    const promo = lookup.promo;

    const db = getFirestore();
    const userRef = db.collection('users').doc(uid);
    const auditRef = db.collection('promo_redemptions').doc();

    let newBalance = null;
    try {
      await db.runTransaction(async (tx) => {
        const snap = await tx.get(userRef);
        if (!snap.exists) {
          throw new Error('USER_NOT_FOUND');
        }
        const data = snap.data();
        const already = Array.isArray(data.promosRedeemed)
          ? data.promosRedeemed.includes(code)
          : false;
        if (already) {
          throw new Error('ALREADY_REDEEMED');
        }
        const prevCredits = (typeof data.assessmentCredits === 'number')
          ? data.assessmentCredits
          : 0;
        newBalance = prevCredits + promo.credits;

        tx.update(userRef, {
          assessmentCredits: newBalance,
          promosRedeemed:    FieldValue.arrayUnion(code),
        });

        tx.set(auditRef, {
          userId:      uid,
          userEmail:   decoded.email || '',
          code:        code,
          credits:     promo.credits,
          description: promo.description,
          previousBalance: prevCredits,
          newBalance:      newBalance,
          redeemedAt:  new Date().toISOString(),
          redeemedAtMs: Date.now(),
        });
      });
    } catch (txErr) {
      if (txErr.message === 'USER_NOT_FOUND') {
        return res.status(404).json({ error: 'User account not found.' });
      }
      if (txErr.message === 'ALREADY_REDEEMED') {
        return res.status(400).json({ error: 'You have already redeemed this code.' });
      }
      throw txErr;
    }

    console.log(`[promo] ${decoded.email || uid} redeemed ${code} → +${promo.credits} credits → balance ${newBalance}`);
    return res.status(200).json({
      ok: true,
      creditsGranted: promo.credits,
      newBalance:     newBalance,
      code:           code,
    });

  } catch (err) {
    console.error('[promo] error:', err);
    return res.status(500).json({ error: err.message || 'Internal error' });
  }
}

// Service account loader. Same pattern as user.js / item.js — env var
// holds the JSON; we parse on cold start.
function parseServiceAccount() {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!raw) throw new Error('FIREBASE_SERVICE_ACCOUNT env var not set');
  try {
    return JSON.parse(raw);
  } catch (e) {
    // Some deploy paths base64-encode the JSON. Try that next.
    try {
      return JSON.parse(Buffer.from(raw, 'base64').toString('utf8'));
    } catch {
      throw new Error('FIREBASE_SERVICE_ACCOUNT could not be parsed');
    }
  }
}

// Also expose the promo registry shape for an unauthenticated "is any
// promo active right now" GET. The client uses this to decide whether to
// render the promo input on the Buy modal at all — no need to expose
// codes themselves, just whether the field should be visible.
//
// We don't actually wire a separate GET handler in this file; the client
// just checks against its own date-range mirror of the registry. The
// duplication is intentional: a one-line client check avoids a network
// round-trip, and the server is still authoritative on every redemption
// attempt.
