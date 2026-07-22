// /api/admin/download.js
// S20 (#42): same-origin image proxy for the dashboard's "Download all images".
//
// Firebase Storage download URLs (firebasestorage.googleapis.com/…?alt=media)
// do NOT send CORS headers unless the bucket has an explicit CORS config. The
// app renders images with <img>, which doesn't need CORS, so they display fine
// — but the dashboard's "Download all images" used fetch()+blob to force a
// save, and a cross-origin fetch of a non-CORS resource fails with the opaque
// "load failed" the user saw on image #1.
//
// This endpoint fetches the image SERVER-SIDE (where CORS does not apply) and
// streams the bytes back on the admin's own origin, so the dashboard's fetch is
// same-origin and always succeeds. Auth-gated identically to the other admin
// endpoints (Bearer ID token + admin-email allowlist), and the source URL is
// restricted to Google/Firebase storage hosts to prevent SSRF.

function parseServiceAccount() {
  let raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!raw) throw new Error('FIREBASE_SERVICE_ACCOUNT not set');
  if (raw.indexOf('\\"') !== -1) {
    raw = raw.split('\\"').join('"');
    raw = raw.split('\\\\').join('\\');
  }
  return JSON.parse(raw);
}

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { initializeApp, getApps, cert } = await import('firebase-admin/app');
    const { getAuth } = await import('firebase-admin/auth');
    if (!getApps().length) {
      initializeApp({ credential: cert(parseServiceAccount()) });
    }

    // ── Auth gate (same as items.js / item.js) ───────────────────────────────
    const auth = req.headers.authorization || '';
    const m = auth.match(/^Bearer\s+(.+)$/);
    if (!m) return res.status(401).json({ error: 'Unauthorized' });
    let decoded;
    try { decoded = await getAuth().verifyIdToken(m[1]); }
    catch { return res.status(401).json({ error: 'Unauthorized' }); }
    const adminEmails = (process.env.ADMIN_EMAILS || '')
      .split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
    const callerEmail = (decoded.email || '').toLowerCase();
    if (!callerEmail || !adminEmails.includes(callerEmail)) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    // ── Validate source URL (SSRF guard: storage hosts only) ─────────────────
    const url = (req.query.url || '').toString();
    let host;
    try { host = new URL(url).host.toLowerCase(); }
    catch { return res.status(400).json({ error: 'bad url' }); }
    const allowed =
      host === 'firebasestorage.googleapis.com' ||
      host === 'storage.googleapis.com' ||
      host.endsWith('.googleapis.com') ||
      host.endsWith('.appspot.com');
    if (!allowed) return res.status(400).json({ error: 'host not allowed' });

    // ── Fetch server-side (no CORS here) and stream back same-origin ─────────
    const r = await fetch(url);
    if (!r.ok) return res.status(502).json({ error: 'source fetch failed: ' + r.status });
    const ct = r.headers.get('content-type') || 'application/octet-stream';
    const buf = Buffer.from(await r.arrayBuffer());
    res.setHeader('Content-Type', ct);
    res.setHeader('Cache-Control', 'private, max-age=60');
    return res.status(200).send(buf);
  } catch (e) {
    console.error('[admin-download] error:', e);
    return res.status(500).json({ error: e.message || 'download failed' });
  }
}
