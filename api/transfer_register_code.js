// api/transfer_register_code.js  (deploy path → /api/transfer_register_code)
// ============================================================================
// S14 FIX — the server-side half of Phase 1 that was missing.
//
// THE BUG THIS FIXES:
//   Phase 1 generates a 4-char transferCode CLIENT-SIDE at account
//   creation / backfill and writes it onto users/{uid}.transferCode.
//   But transfer_send resolves a recipient code by reading the
//   transfer_codes/{CODE} REVERSE INDEX — which the client can never
//   write (rules are Admin-SDK-only, correctly). Nothing ever created
//   that reverse-index entry for an auto-generated code, so every
//   auto-generated code was unresolvable ("No user with code XXXX").
//   Only the three vanity codes worked, because the vanity admin
//   endpoint explicitly wrote their reverse-index docs.
//
// WHAT THIS DOES:
//   Caller = the signed-in user (their own ID token). Idempotently
//   ensures THIS user has a working, unique reverse-index entry:
//     - If users/{uid}.transferCode exists AND transfer_codes/{that}
//       points at this uid → nothing to do (already good).
//     - If it exists but transfer_codes/{that} is missing → create the
//       reverse-index entry pointing at this uid (the common case for
//       every existing auto-generated code).
//     - COLLISION: if transfer_codes/{that} exists but points at a
//       DIFFERENT uid → the earliest claimant keeps the code; THIS user
//       is assigned a fresh unique code (generate → check → retry),
//       both users/{uid}.transferCode and the reverse index updated.
//     - If the user has no transferCode at all → assign a fresh unique
//       one (server-side, collision-checked).
//
//   The client calls this once on sign-in (fire-and-forget). After it
//   returns, the user's code is guaranteed resolvable by transfer_send.
//
// SECURITY: user-token auth (NOT admin). A user can only ever create /
// move their OWN reverse-index entry — uid comes from the verified
// token, never from the body. It cannot touch another user's code
// except to AVOID stealing one already claimed (earliest-claimant-wins).
// ============================================================================

import { initializeApp, getApps, cert } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore } from 'firebase-admin/firestore';

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

// MUST match the client ID_ALPHABET (index.html) and every other
// transfer endpoint. Excludes 0,1,O,U. I and L are included.
const ID_ALPHABET = '23456789ABCDEFGHIJKLMNPQRSTVWXYZ';

function randomCode() {
  let out = '';
  // Math.random is fine here — uniqueness is enforced by the
  // generate→check→retry loop against the reverse index, not by the
  // RNG quality. (Server has no Web Crypto without extra import; the
  // collision check is the real guarantee.)
  for (let i = 0; i < 4; i++) {
    out += ID_ALPHABET[Math.floor(Math.random() * ID_ALPHABET.length)];
  }
  return out;
}

function isValidCode(code) {
  if (typeof code !== 'string' || code.length !== 4) return false;
  for (const ch of code) if (ID_ALPHABET.indexOf(ch) === -1) return false;
  return true;
}

// Allocate a brand-new code that no transfer_codes doc holds yet.
// Bounded retry; the space is ~1.05M so collisions are astronomically
// unlikely at any realistic scale, but the loop is the correctness
// guarantee regardless.
async function allocateFreshCode(db, uid) {
  for (let attempt = 0; attempt < 20; attempt++) {
    const candidate = randomCode();
    const ref = db.collection('transfer_codes').doc(candidate);
    const snap = await ref.get();
    if (!snap.exists) {
      await ref.set({
        uid,
        vanity: false,
        claimedAt: new Date().toISOString(),
      });
      return candidate;
    }
    if ((snap.data() || {}).uid === uid) {
      // Already ours (shouldn't happen here, but idempotent-safe).
      return candidate;
    }
  }
  throw new Error('Could not allocate a unique code (retry exhausted)');
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  try {
    const authHeader = req.headers.authorization || '';
    const token = authHeader.startsWith('Bearer ')
      ? authHeader.slice(7) : null;
    if (!token) return res.status(401).json({ error: 'Sign-in required' });

    const sa = parseServiceAccount();
    if (!getApps().length) initializeApp({ credential: cert(sa) });
    const auth = getAuth();
    const db = getFirestore();

    let decoded;
    try {
      decoded = await auth.verifyIdToken(token);
    } catch {
      return res.status(401).json({ error: 'Invalid session' });
    }
    const uid = decoded.uid;

    const userRef = db.collection('users').doc(uid);
    const userSnap = await userRef.get();
    if (!userSnap.exists) {
      return res.status(404).json({ error: 'User document not found' });
    }
    const existing = (userSnap.data() || {}).transferCode;

    // Case A: user has a syntactically valid code already.
    if (isValidCode(existing)) {
      const codeRef = db.collection('transfer_codes').doc(existing);
      const codeSnap = await codeRef.get();

      if (!codeSnap.exists) {
        // The common fix: code exists on the user but no reverse index.
        // Claim it for this uid.
        await codeRef.set({
          uid,
          vanity: false,
          claimedAt: new Date().toISOString(),
        });
        return res.status(200).json({ ok: true, code: existing, action: 'reverse-index-created' });
      }

      const owner = (codeSnap.data() || {}).uid;
      if (owner === uid) {
        // Already correct end-to-end.
        return res.status(200).json({ ok: true, code: existing, action: 'already-ok' });
      }

      // COLLISION: someone else holds this code in the reverse index
      // (earliest claimant wins). Give THIS user a fresh unique code.
      const fresh = await allocateFreshCode(db, uid);
      await userRef.set({ transferCode: fresh }, { merge: true });
      return res.status(200).json({
        ok: true,
        code: fresh,
        action: 'reassigned-due-to-collision',
        previous: existing,
      });
    }

    // Case B: user has no valid code at all — allocate one.
    const fresh = await allocateFreshCode(db, uid);
    await userRef.set({ transferCode: fresh }, { merge: true });
    return res.status(200).json({ ok: true, code: fresh, action: 'allocated' });
  } catch (e) {
    return res.status(500).json({ error: (e && e.message) || 'unknown error' });
  }
}
