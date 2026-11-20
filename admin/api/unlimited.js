// admin/api/unlimited.js — v6.79. Every Unlimited buyer and how many
// assessments their week has run (Matt: "my own view in admin on how many
// assessments each user has run with their Unlimited purchases"). Read only.
// Counts come from users/{uid}.unlimited.uses, incremented in the same
// transaction that covers each assessment (lib/unlimited.js).

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


  // v6.79: every account that has bought Unlimited, with what its week has run.
  try {
    const { getFirestore } = await import('firebase-admin/firestore');
    const db = getFirestore();
    const snap = await db.collection('users').where('unlimited.purchasedAt', '>', '').get();
    const now = Date.now();
    const rows = snap.docs.map(d => {
      const u = d.data() || {};
      const x = u.unlimited || {};
      const startBy = Date.parse(x.startBy || '') || null;
      let start = x.startedAt ? Date.parse(x.startedAt) : null;
      if (!start && startBy && now >= startBy) start = startBy;
      const end = start ? start + 168 * 3600 * 1000 : null;
      const status = x.revokedAt ? 'refunded' : !start ? 'not started' : now < end ? 'running' : 'ended';
      return {
        uid: d.id, name: u.displayName || u.email || d.id, email: u.email || null, transferCode: u.transferCode || null,
        status, purchasedAt: x.purchasedAt || null, source: x.source || null,
        startedAt: start ? new Date(start).toISOString() : null, endsAt: end ? new Date(end).toISOString() : null,
        startBy: x.startBy || null, uses: x.uses || 0, usesByKind: x.usesByKind || {},
        revokedAt: x.revokedAt || null, revokeReason: x.revokeReason || null,
        blocked: !!u.unlimitedBlocked, credits: u.assessmentCredits ?? null,
        pastWeeks: (Array.isArray(u.unlimitedHistory) ? u.unlimitedHistory : []).map(h => ({ purchasedAt: h.purchasedAt, uses: h.uses || 0, usesByKind: h.usesByKind || {}, revokedAt: h.revokedAt || null }))
      };
    }).sort((a, b) => String(b.purchasedAt).localeCompare(String(a.purchasedAt)));
    return res.status(200).json({ ok: true, count: rows.length, totalUses: rows.reduce((s, r) => s + r.uses, 0), rows });
  } catch (e) {
    return res.status(500).json({ error: String((e && e.message) || e) });
  }
}
