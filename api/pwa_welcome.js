// api/pwa_welcome.js
//
// PWA "welcome back" credit. One free assessment credit granted the SECOND
// time (a genuine return visit) that a user signs in on the web / installed
// PWA. Purpose: nudge usage toward the web, where there is no app-store fee.
//
// NOT for native. The web/PWA client is the only caller — index.html guards
// the call behind !Capacitor.isNativePlatform(), so the iOS/Android bundles
// never hit this endpoint. There is no grade change and no purchase here.
//
// Auth: Firebase ID token in Authorization: Bearer <token>.
// Body: none required.
//
// How "second session, not first" is enforced — server-side, so clearing
// browser storage can't farm it:
//   users/{uid}.pwaWelcome = { firstSeenAt, firstSeenMs, granted, grantedAt }
//   - Call #1 (first PWA session): record firstSeenAt. NO credit.
//   - A later call, once (now - firstSeenMs) >= RETURN_GAP_MS: grant +1,
//     set granted=true. One-time forever (granted flag short-circuits).
//   The web client also self-limits to ONE call per browser session
//   (sessionStorage), so call #2 is genuinely a new session. RETURN_GAP_MS
//   is a light anti-burst floor so a same-sitting reload can't collect it
//   early; a real return visit clears it trivially. Set to 0 for a literal
//   "any second session, no time floor".
//
// Audit: every grant writes pwa_welcome_grants/{auto} (Admin-SDK-only, same
// access model as promo_redemptions/ and purchases/).

const CREDITS = 1;
const RETURN_GAP_MS = 15 * 60 * 1000; // 15 min anti-burst floor; tune freely

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  try {
    const { initializeApp, getApps, cert } = await import('firebase-admin/app');
    const { getAuth } = await import('firebase-admin/auth');
    const { getFirestore } = await import('firebase-admin/firestore');

    if (!getApps().length) {
      initializeApp({ credential: cert(parseServiceAccount()) });
    }

    // Auth gate
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

    let outcome = 'noop';
    let newBalance = null;

    try {
      await db.runTransaction(async (tx) => {
        const snap = await tx.get(userRef);
        if (!snap.exists) throw new Error('USER_NOT_FOUND');
        const data = snap.data();
        const w = (data.pwaWelcome && typeof data.pwaWelcome === 'object')
          ? data.pwaWelcome : {};

        // Already granted → nothing to do, ever.
        if (w.granted === true) { outcome = 'already'; return; }

        const nowMs = Date.now();
        const nowIso = new Date(nowMs).toISOString();

        // First PWA session we've seen: record it, grant nothing.
        if (typeof w.firstSeenMs !== 'number') {
          tx.update(userRef, {
            pwaWelcome: {
              firstSeenAt: nowIso,
              firstSeenMs: nowMs,
              granted: false,
            },
          });
          outcome = 'first';
          return;
        }

        // Return visit but too soon after the first sighting → wait.
        if (nowMs - w.firstSeenMs < RETURN_GAP_MS) { outcome = 'too_soon'; return; }

        // Genuine return visit → grant one-time.
        const prevCredits = (typeof data.assessmentCredits === 'number')
          ? data.assessmentCredits : 0;
        newBalance = prevCredits + CREDITS;

        tx.update(userRef, {
          assessmentCredits: newBalance,
          pwaWelcome: {
            firstSeenAt: w.firstSeenAt || nowIso,
            firstSeenMs: w.firstSeenMs,
            granted: true,
            grantedAt: nowIso,
          },
        });
        tx.set(auditRef, {
          userId: uid,
          userEmail: decoded.email || '',
          credits: CREDITS,
          reason: 'pwa_welcome_return_visit',
          previousBalance: prevCredits,
          newBalance: newBalance,
          firstSeenAt: w.firstSeenAt || null,
          grantedAt: nowIso,
          grantedAtMs: nowMs,
        });
        outcome = 'granted';
      });
    } catch (txErr) {
      if (txErr.message === 'USER_NOT_FOUND') {
        return res.status(404).json({ error: 'User account not found.' });
      }
      throw txErr;
    }

    if (outcome === 'granted') {
      console.log(`[pwa_welcome] ${decoded.email || uid} → +${CREDITS} credit → balance ${newBalance}`);
      return res.status(200).json({ ok: true, grantedNow: true, creditsGranted: CREDITS, newBalance });
    }
    // first / too_soon / already → no credit this call.
    return res.status(200).json({ ok: true, grantedNow: false, status: outcome });

  } catch (err) {
    console.error('[pwa_welcome] error:', err);
    return res.status(500).json({ error: err.message || 'Internal error' });
  }
}

// Service account loader — same pattern as redeem_promo.js / user.js.
function parseServiceAccount() {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!raw) throw new Error('FIREBASE_SERVICE_ACCOUNT env var not set');
  try {
    return JSON.parse(raw);
  } catch (e) {
    try {
      return JSON.parse(Buffer.from(raw, 'base64').toString('utf8'));
    } catch {
      throw new Error('FIREBASE_SERVICE_ACCOUNT could not be parsed');
    }
  }
}
