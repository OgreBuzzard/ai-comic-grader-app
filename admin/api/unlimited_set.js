// admin/api/unlimited_set.js — v6.81. Grant, end or clear Unlimited on ONE
// account from admin, without a purchase. For Matt's testing and for support
// (comping a customer, undoing a test). Same user-doc fields lib/unlimited.js
// uses; the rules live there, this only writes the state.
//
//   GET/POST { uid }                      -> current state
//   POST { uid, action: 'grant' }         -> a fresh week, waiting for the
//                                            first assessment (purchaseId
//                                            'admin_<time>', source 'admin')
//   POST { uid, action: 'grant', startNow: true }  -> the week starts now
//   POST { uid, action: 'end' }           -> ends the current week now (NOT a
//                                            refund block)
//   POST { uid, action: 'clear' }         -> removes the week and any refund
//                                            block, so the account is as if it
//                                            never had Unlimited (history kept)
// Every change is stamped unlimitedAdminLog with who and when.

function parseServiceAccount() {
  let raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!raw) throw new Error('FIREBASE_SERVICE_ACCOUNT not set');
  if (raw.includes('\\"')) raw = raw.replace(/\\"/g, '"').replace(/\\\\/g, '\\');
  try { return JSON.parse(raw); }
  catch { return JSON.parse(Buffer.from(raw, 'base64').toString('utf8')); }
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  // Same auth bar as every other admin endpoint: a signed-in Firebase user
  // whose email is in ADMIN_EMAILS. That variable exists ONLY on the admin
  // deployment, which is why this file lives here and not in the main app.
  let callerEmail = '';
  try {
    const m = (req.headers.authorization || '').match(/^Bearer\s+(.+)$/);
    if (!m) return res.status(401).json({ error: 'auth required' });
    const { initializeApp, getApps, cert } = await import('firebase-admin/app');
    const { getAuth } = await import('firebase-admin/auth');
    if (!process.env.FIREBASE_SERVICE_ACCOUNT) return res.status(500).json({ error: 'server misconfigured: FIREBASE_SERVICE_ACCOUNT not set' });
    if (!getApps().length) initializeApp({ credential: cert(parseServiceAccount()) });
    const decoded = await getAuth().verifyIdToken(m[1].trim());
    callerEmail = String(decoded.email || '').toLowerCase();
    const adminEmails = (process.env.ADMIN_EMAILS || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
    if (!adminEmails.includes(callerEmail)) return res.status(403).json({ error: 'not an admin' });
  } catch (e) {
    return res.status(401).json({ error: 'auth failed', detail: String((e && e.message) || e) });
  }


  const src = (req.body && Object.keys(req.body).length) ? req.body : (req.query || {});
  const uid = String(src.uid || '').trim();
  const action = String(src.action || '').trim();
  if (!uid) return res.status(400).json({ error: 'uid required' });
  try {
    const { getFirestore, FieldValue } = await import('firebase-admin/firestore');
    const db = getFirestore();
    const uRef = db.collection('users').doc(uid);
    const snap = await uRef.get();
    if (!snap.exists) return res.status(404).json({ error: 'no such user' });
    const u = snap.data() || {};
    const H = 3600 * 1000, now = Date.now();
    const log = { at: new Date(now).toISOString(), by: callerEmail, action };
    if (action === 'grant') {
      const prev = u.unlimited && u.unlimited.purchasedAt ? u.unlimited : null;
      const history = Array.isArray(u.unlimitedHistory) ? u.unlimitedHistory.slice(-9) : [];
      if (prev) history.push(prev);
      const startNow = src.startNow === true || src.startNow === 'true';
      await uRef.update({
        unlimited: {
          purchasedAt: new Date(now).toISOString(), purchaseId: 'admin_' + now, source: 'admin',
          startBy: new Date(now + 30 * 24 * H).toISOString(),
          startedAt: startNow ? new Date(now).toISOString() : null,
          endsAt: startNow ? new Date(now + 360 * H).toISOString() : null,   // v6.82: 15 days
          uses: 0, usesByKind: {}, revokedAt: null, revokeReason: null
        },
        unlimitedHistory: history,
        unlimitedAdminLog: FieldValue.arrayUnion(log)
      });
    } else if (action === 'end') {
      if (!u.unlimited || !u.unlimited.purchasedAt) return res.status(400).json({ error: 'no Unlimited week on this account' });
      await uRef.update({ 'unlimited.revokedAt': new Date(now).toISOString(), 'unlimited.revokeReason': 'admin_end', unlimitedAdminLog: FieldValue.arrayUnion(log) });
    } else if (action === 'clear') {
      const history = Array.isArray(u.unlimitedHistory) ? u.unlimitedHistory.slice(-9) : [];
      if (u.unlimited && u.unlimited.purchasedAt) history.push(u.unlimited);
      await uRef.update({ unlimited: FieldValue.delete(), unlimitedBlocked: FieldValue.delete(), unlimitedHistory: history, unlimitedAdminLog: FieldValue.arrayUnion(log) });
    } else if (action) {
      return res.status(400).json({ error: 'unknown action ' + action });
    }
    const d = (await uRef.get()).data() || {};
    const x = d.unlimited || null;
    let status = 'none', endsAt = null;
    if (x && x.purchasedAt && !x.revokedAt) {
      const startBy = Date.parse(x.startBy || '') || 0;
      let start = x.startedAt ? Date.parse(x.startedAt) : null;
      if (!start && startBy && now >= startBy) start = startBy;
      if (!start) status = 'waiting for first assessment';
      else { const e = start + 360 * H; endsAt = new Date(e).toISOString(); status = now < e ? 'running' : 'ended'; }
    } else if (x && x.revokedAt) status = 'ended early (' + (x.revokeReason || '?') + ')';
    return res.status(200).json({ ok: true, uid, status, endsAt, unlimited: x, blocked: !!d.unlimitedBlocked });
  } catch (e) {
    return res.status(500).json({ error: String((e && e.message) || e) });
  }
}
