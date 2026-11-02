// admin/api/credit_audit.js — the credit ledger for ONE user, in plain words.
//
// WHY THIS EXISTS. A user reported going from 2 credits to 0 across a single
// Deep that was supposed to be refunded. Answering that meant reading the
// credit_events collection, and the only route was the Firestore console —
// a filter UI Matt reasonably does not want to learn, on a database holding
// user data, to answer a question that recurs every time someone emails about
// a balance. Support questions should not require a console.
//
// READ ONLY. It writes nothing and changes nothing. The worst it can do is
// tell you a number you already own.
//
// lib/credits.js writes one credit_events row per debit and per refund:
//   { uid, delta, label, createdAt }   delta < 0 debit, > 0 refund
// This reads them back for one user, pairs them against the stored balance,
// and says whether they add up.

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
    if (!getApps().length) initializeApp({ credential: cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)) });
    const decoded = await getAuth().verifyIdToken(m[1].trim());
    callerEmail = String(decoded.email || '').toLowerCase();
    const adminEmails = (process.env.ADMIN_EMAILS || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
    if (!adminEmails.includes(callerEmail)) return res.status(403).json({ error: 'not an admin' });
  } catch (e) {
    return res.status(401).json({ error: 'auth failed', detail: String((e && e.message) || e) });
  }

  const src = (req.body && Object.keys(req.body).length) ? req.body : (req.query || {});
  const transferCode = String(src.transferCode || src.code || '').trim().toUpperCase();
  let uid = String(src.uid || '').trim();
  const hours = Number(src.hours) > 0 ? Number(src.hours) : 72;

  try {
    const { getFirestore } = await import('firebase-admin/firestore');
    const db = getFirestore();

    // transferCode is the 4-char code Matt and users actually speak in; uid is
    // the thing every other collection is keyed by. Resolve one to the other so
    // the caller can use whichever they have.
    let userDoc = null;
    if (!uid && transferCode) {
      const q = await db.collection('users').where('transferCode', '==', transferCode).limit(2).get();
      if (q.empty) return res.status(404).json({ error: 'no user with transferCode ' + transferCode });
      if (q.size > 1) {
        return res.status(409).json({
          error: 'transferCode ' + transferCode + ' is on more than one user',
          uids: q.docs.map(d => d.id),
          note: 'That is itself a bug worth chasing — the code is meant to be unique.'
        });
      }
      userDoc = q.docs[0]; uid = userDoc.id;
    } else if (uid) {
      const d = await db.collection('users').doc(uid).get();
      if (!d.exists) return res.status(404).json({ error: 'no user ' + uid });
      userDoc = d;
    } else {
      return res.status(400).json({ error: 'pass transferCode or uid' });
    }

    const u = userDoc.data() || {};
    const balance = Number.isFinite(u.assessmentCredits) ? u.assessmentCredits : null;

    // credit_events has no composite index on (uid, createdAt), and adding one
    // for a support lookup is not worth a deploy — so filter on uid only and
    // sort in memory. A single user's ledger is small.
    const snap = await db.collection('credit_events').where('uid', '==', uid).get();
    const all = snap.docs.map(d => ({ key: d.id, ...(d.data() || {}) }))
      .sort((a, b) => String(a.createdAt || '').localeCompare(String(b.createdAt || '')));

    const cutoff = Date.now() - hours * 3600 * 1000;
    const recent = all.filter(e => {
      const t = Date.parse(e.createdAt || '');
      return Number.isFinite(t) ? t >= cutoff : true;
    });

    const sum = arr => arr.reduce((n, e) => n + (Number(e.delta) || 0), 0);
    const debits  = all.filter(e => Number(e.delta) < 0);
    const refunds = all.filter(e => Number(e.delta) > 0);

    // A running balance makes a double-debit obvious to the eye: two debits in
    // a row with no grade between them, or a refund that never landed.
    let run = 0;
    const timeline = recent.map(e => {
      run += Number(e.delta) || 0;
      return {
        at: e.createdAt,
        delta: e.delta,
        label: e.label || 'assess',
        running: run
      };
    });

    const ledgerNet = sum(all);
    return res.status(200).json({
      ok: true,
      uid,
      transferCode: u.transferCode || null,
      email: u.email || null,
      storedBalance: balance,
      ledger: {
        events: all.length,
        debits: debits.length,
        refunds: refunds.length,
        netFromLedger: ledgerNet,
        note: 'netFromLedger is debits+refunds only. It will NOT equal the stored balance, '
            + 'because purchases, the 3 free welcome credits and promo grants do not all write here. '
            + 'Read the timeline for the shape, not the absolute number.'
      },
      hoursShown: hours,
      timeline,
      readThis:
        debits.length === 0
          ? 'No debits recorded at all for this user.'
          : (() => {
              // The question that prompted this endpoint: did one assessment
              // debit twice? Look for debits closer together than any real pair
              // of assessments could be.
              const close = [];
              for (let i = 1; i < debits.length; i++) {
                const a = Date.parse(debits[i - 1].createdAt || '');
                const b = Date.parse(debits[i].createdAt || '');
                if (Number.isFinite(a) && Number.isFinite(b) && (b - a) < 20000) {
                  close.push({ gapSeconds: Math.round((b - a) / 1000),
                               first: debits[i - 1].createdAt, second: debits[i].createdAt,
                               labels: [debits[i - 1].label, debits[i].label] });
                }
              }
              if (close.length) {
                return 'DOUBLE DEBIT. ' + close.length + ' pair(s) of debits land within 20 seconds of each '
                     + 'other, which no two real assessments can do. The client is decrementing on top of the '
                     + 'server. See `closeDebits`.';
              }
              return 'No double-debits found — every debit is more than 20s from the one before it. '
                   + 'If the balance is still wrong, the problem is a refund that never landed: compare '
                   + 'the refunds count against the number of Deeps that showed the refund icon.';
            })(),
      closeDebits: (() => {
        const out = [];
        for (let i = 1; i < debits.length; i++) {
          const a = Date.parse(debits[i - 1].createdAt || '');
          const b = Date.parse(debits[i].createdAt || '');
          if (Number.isFinite(a) && Number.isFinite(b) && (b - a) < 20000) {
            out.push({ gapSeconds: Math.round((b - a) / 1000),
                       first: { at: debits[i - 1].createdAt, label: debits[i - 1].label, delta: debits[i - 1].delta },
                       second: { at: debits[i].createdAt, label: debits[i].label, delta: debits[i].delta } });
          }
        }
        return out;
      })()
    });
  } catch (e) {
    return res.status(500).json({ error: 'audit failed', detail: String((e && e.message) || e) });
  }
}
