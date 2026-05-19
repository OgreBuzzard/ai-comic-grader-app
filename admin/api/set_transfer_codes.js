// admin/api/set_transfer_codes.js  (deploy path → /api/set_transfer_codes)
// ============================================================================
// ONE-SHOT admin endpoint: assign three specific vanity transfer codes to
// three existing accounts (Matt's request, pre-Phase-1 deploy).
//
//   548lUEZMQTPLvhhnQmQg8cHCNk33  → "MATT"
//   syqjSsJLQsSCdMkGTLYBzFh2aP23  → "RICK"
//   qjhj8GmW1wSKazX3aATiUlaZ2m13  → "PAVL"
//
// All three codes are valid in the system alphabet (23456789ABCDEFGHIJK
// LMNPQRSTVWXYZ — note I and L are allowed; only 0,1,O,U are excluded).
// Verified: M A T T / R I C K / P A V L — every char is in-alphabet.
//
// What it writes, per account, in a single batch:
//   1. users/{uid}.transferCode = CODE   (the code shown in Settings /
//      used by the Give flow)
//   2. transfer_codes/{CODE} = { uid, vanity:true, claimedAt }
//      — the Phase-2 reverse index. Writing it NOW means Phase 2's
//      uniqueness/claim logic and the code generator will treat MATT/
//      RICK/PAVL as already-taken and can never hand them to a random
//      new user. Reserving them up front closes the collision window
//      between this script running and Phase 2 shipping.
//
// IDEMPOTENT: re-running is safe. It overwrites the same values; if a
// reverse-index doc already exists pointing at the SAME uid it's a
// no-op-equivalent, and if it somehow points at a different uid the
// response flags it rather than silently stealing the code.
//
// SECURITY: same admin-only model as the other admin endpoints — requires
// a valid Firebase ID token whose email is in ADMIN_EMAILS. This is a
// privileged data-mutation endpoint; it must not be open.
// ============================================================================

import { initializeApp, getApps, cert } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore } from 'firebase-admin/firestore';

// Service-account parser — copied verbatim from the proven sibling
// (admin/api/delete_user.js / user.js). Do NOT "simplify" this; it
// handles the double-escaped-quote case that the Vercel env paste
// produces and that a naive JSON.parse fails on.
function parseServiceAccount() {
  let raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!raw) throw new Error('FIREBASE_SERVICE_ACCOUNT env var not set');
  if (raw.indexOf('\\"') !== -1) {
    raw = raw.split('\\"').join('"');
    raw = raw.split('\\\\').join('\\');
  }
  try {
    return JSON.parse(raw);
  } catch {
    try {
      return JSON.parse(Buffer.from(raw, 'base64').toString('utf8'));
    } catch {
      throw new Error('FIREBASE_SERVICE_ACCOUNT could not be parsed');
    }
  }
}

// The system alphabet — single source of truth, must match the client's
// ID_ALPHABET (index.html). Used here only to VALIDATE the vanity codes
// so we never persist a code the rest of the system would consider
// malformed.
const ID_ALPHABET = '23456789ABCDEFGHIJKLMNPQRSTVWXYZ';

const ASSIGNMENTS = [
  { uid: '548lUEZMQTPLvhhnQmQg8cHCNk33', code: 'MATT' },
  { uid: 'syqjSsJLQsSCdMkGTLYBzFh2aP23', code: 'RICK' },
  { uid: 'qjhj8GmW1wSKazX3aATiUlaZ2m13', code: 'PAVL' },
];

function validateCode(code) {
  if (typeof code !== 'string' || code.length !== 4) return false;
  for (const ch of code) {
    if (ID_ALPHABET.indexOf(ch) === -1) return false;
  }
  return true;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    // --- Admin auth gate (same model as other admin endpoints) ---
    const authHeader = req.headers.authorization || '';
    const token = authHeader.startsWith('Bearer ')
      ? authHeader.slice(7) : null;
    if (!token) {
      return res.status(401).json({ error: 'Missing bearer token' });
    }

    const sa = parseServiceAccount();
    if (!getApps().length) {
      initializeApp({ credential: cert(sa) });
    }
    const auth = getAuth();
    const db = getFirestore();

    let decoded;
    try {
      decoded = await auth.verifyIdToken(token);
    } catch {
      return res.status(401).json({ error: 'Invalid token' });
    }

    const adminEmails = (process.env.ADMIN_EMAILS || '')
      .split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
    const callerEmail = (decoded.email || '').toLowerCase();
    if (!callerEmail || adminEmails.indexOf(callerEmail) === -1) {
      return res.status(403).json({ error: 'Not authorized' });
    }

    // --- Validate all codes BEFORE writing anything ---
    for (const a of ASSIGNMENTS) {
      if (!validateCode(a.code)) {
        return res.status(400).json({
          error: `Code "${a.code}" is not valid in the system alphabet`,
        });
      }
    }

    const results = [];

    for (const { uid, code } of ASSIGNMENTS) {
      const userRef = db.collection('users').doc(uid);
      const userSnap = await userRef.get();
      if (!userSnap.exists) {
        results.push({ uid, code, status: 'SKIPPED — user doc not found' });
        continue;
      }

      // Reverse-index safety check: if transfer_codes/{CODE} already
      // exists and points at a DIFFERENT uid, do not steal it — report.
      const codeRef = db.collection('transfer_codes').doc(code);
      const codeSnap = await codeRef.get();
      if (codeSnap.exists) {
        const existingUid = (codeSnap.data() || {}).uid;
        if (existingUid && existingUid !== uid) {
          results.push({
            uid, code,
            status: `CONFLICT — code already claimed by ${existingUid}; left unchanged`,
          });
          continue;
        }
      }

      // If this user currently has a DIFFERENT (random) code, free its
      // reverse-index entry so we don't leave an orphan reservation.
      const prevCode = (userSnap.data() || {}).transferCode;
      const batch = db.batch();
      if (prevCode && prevCode !== code) {
        batch.delete(db.collection('transfer_codes').doc(prevCode));
      }

      batch.set(userRef, { transferCode: code }, { merge: true });
      batch.set(codeRef, {
        uid,
        vanity: true,
        claimedAt: new Date().toISOString(),
      });

      await batch.commit();
      results.push({
        uid, code,
        status: prevCode && prevCode !== code
          ? `OK — set to ${code} (freed previous code ${prevCode})`
          : `OK — set to ${code}`,
      });
    }

    return res.status(200).json({ ok: true, results });
  } catch (e) {
    return res.status(500).json({ error: (e && e.message) || 'unknown error' });
  }
}
