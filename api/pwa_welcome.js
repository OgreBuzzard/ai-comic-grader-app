// api/pwa_welcome.js
//
// PWA "welcome" credit — ONE free assessment credit, granted at most ONCE
// per account, on a return visit to the web/PWA. Not for native (the client
// guards the call behind !Capacitor.isNativePlatform()).
//
// ONE-TIME ENFORCEMENT (bulletproof):
//   users/{uid}.pwaWelcomeGranted === true   -> never grant again, period.
//   (also honors the legacy nested flag pwaWelcome.granted === true so accounts
//    granted under the previous build are not granted a second time.)
// Flow:
//   call #1 (first sighting): record pwaFirstSeenMs, grant NOTHING.
//   later call, >= RETURN_GAP_MS after first sighting: grant +1, set the flag.
//
// Auth: Firebase ID token in Authorization: Bearer <token>. Body: none.

const CREDITS = 1;
const RETURN_GAP_MS = 15 * 60 * 1000; // anti-burst floor; set 0 for "any 2nd session"

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  try {
    const { initializeApp, getApps, cert } = await import('firebase-admin/app');
    const { getAuth } = await import('firebase-admin/auth');
    const { getFirestore } = await import('firebase-admin/firestore');
    if (!getApps().length) initializeApp({ credential: cert(parseServiceAccount()) });

    const authHeader = req.headers.authorization || '';
    const m = authHeader.match(/^Bearer\s+(.+)$/);
    if (!m) return res.status(401).json({ error: 'Unauthorized' });
    let decoded;
    try { decoded = await getAuth().verifyIdToken(m[1]); }
    catch { return res.status(401).json({ error: 'Unauthorized' }); }
    const uid = decoded.uid;
    if (!uid) return res.status(401).json({ error: 'Unauthorized' });

    const db = getFirestore();
    const userRef = db.collection('users').doc(uid);
    const auditRef = db.collection('pwa_welcome_grants').doc();

    let outcome = 'noop', newBalance = null;
    try {
      await db.runTransaction(async (tx) => {
        const snap = await tx.get(userRef);
        if (!snap.exists) throw new Error('USER_NOT_FOUND');
        const d = snap.data() || {};

        // Hard one-time gate — new flat flag OR legacy nested flag.
        const alreadyGranted = d.pwaWelcomeGranted === true
          || (d.pwaWelcome && d.pwaWelcome.granted === true);
        if (alreadyGranted) { outcome = 'already'; return; }

        const nowMs = Date.now();
        const nowIso = new Date(nowMs).toISOString();

        // First sighting can come from the new flat field or the legacy nested one.
        const firstSeenMs = (typeof d.pwaFirstSeenMs === 'number') ? d.pwaFirstSeenMs
          : (d.pwaWelcome && typeof d.pwaWelcome.firstSeenMs === 'number') ? d.pwaWelcome.firstSeenMs
          : null;

        if (firstSeenMs === null) {
          tx.update(userRef, { pwaFirstSeenMs: nowMs, pwaFirstSeenAt: nowIso });
          outcome = 'first';
          return;
        }
        if (nowMs - firstSeenMs < RETURN_GAP_MS) { outcome = 'too_soon'; return; }

        const prev = (typeof d.assessmentCredits === 'number') ? d.assessmentCredits : 0;
        newBalance = prev + CREDITS;
        tx.update(userRef, {
          assessmentCredits: newBalance,
          pwaWelcomeGranted: true,               // <-- the one-time flag
          pwaWelcomeGrantedAt: nowIso,
          pwaFirstSeenMs: firstSeenMs,
        });
        tx.set(auditRef, {
          userId: uid, userEmail: decoded.email || '', credits: CREDITS,
          reason: 'pwa_welcome_return_visit', previousBalance: prev, newBalance,
          grantedAt: nowIso, grantedAtMs: nowMs,
        });
        outcome = 'granted';
      });
    } catch (txErr) {
      if (txErr.message === 'USER_NOT_FOUND') return res.status(404).json({ error: 'User account not found.' });
      throw txErr;
    }

    if (outcome === 'granted') {
      console.log(`[pwa_welcome] ${decoded.email || uid} -> +${CREDITS} -> ${newBalance}`);
      return res.status(200).json({ ok: true, grantedNow: true, creditsGranted: CREDITS, newBalance });
    }
    return res.status(200).json({ ok: true, grantedNow: false, status: outcome });
  } catch (err) {
    console.error('[pwa_welcome] error:', err);
    return res.status(500).json({ error: err.message || 'Internal error' });
  }
}

function parseServiceAccount() {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!raw) throw new Error('FIREBASE_SERVICE_ACCOUNT env var not set');
  try { return JSON.parse(raw); }
  catch (e) {
    try { return JSON.parse(Buffer.from(raw, 'base64').toString('utf8')); }
    catch { throw new Error('FIREBASE_SERVICE_ACCOUNT could not be parsed'); }
  }
}
