// admin/api/credit_remediation.js — make whole the users the Deep
// double-charge bug overcharged. (S22, fixed in v5.99.)
//
// ── THE BUG, IN ONE LINE ────────────────────────────────────────────────────
// api/assess_deep.js stamped `creditsRemaining` on its result INSIDE the
// `if (wantsSSE)` branch, so the plain-JSON return shipped without it. The
// client keys on exactly that field: no field means "the server did not take
// the credit", so it decremented a SECOND time after the endpoint already had.
// Live since v5.19 (~18 Sept 2026), when server-side crediting shipped.
//
// ── WHY THE LEDGER CANNOT NAME THE VICTIMS EXACTLY ──────────────────────────
// The SERVER's debit writes a credit_events row. The CLIENT's extra decrement
// writes the user doc directly and logs NOTHING. So the second charge is
// invisible in the ledger, and there is no field anywhere recording whether a
// given request streamed. What the ledger CAN do is name everyone who ran a
// Deep in the window — which is the complete set of people who could possibly
// have been hit. Streaming clients (the desktop PWA) were never affected.
//
// So this is deliberately GENEROUS rather than precise: +1 credit to every
// account with at least one server-side Deep debit in the window. A desktop-only
// user gets a credit they did not lose. That is the correct way to be wrong
// here — the alternative is leaving real overcharges unrefunded to avoid
// over-refunding a few cents.
//
// ── SAFETY ──────────────────────────────────────────────────────────────────
//   • DRY RUN BY DEFAULT. Nothing is written without apply=1.
//   • IDEMPOTENT. Every grant writes a credit_events row labelled
//     'deep_doublecharge_fix'. A uid that already has one is skipped, so
//     running this twice cannot double-credit anyone.
//   • The grant goes through FieldValue.increment, so it cannot clobber a
//     balance that changed while this was running.
//
// GET  ?since=2026-09-18                 -> dry run: who, how many, total cost
// POST {since, apply:true}               -> grant
// GET  ?emails=1                         -> the email addresses of everyone
//                                           who actually received a grant
// POST {since, apply:true, perDeep:true} -> grant one per Deep instead of one
//                                           per account (fuller restitution,
//                                           and over-credits streaming users
//                                           proportionally more)

const GRANT_LABEL = 'deep_doublecharge_fix';
const DEFAULT_SINCE = '2026-09-18';   // v5.19 — server-side crediting shipped

// Copied VERBATIM from admin/api/history_repair.js. FIREBASE_SERVICE_ACCOUNT is
// NOT reliably plain JSON: depending on how it was pasted into Vercel it can
// arrive with escaped quotes, or base64-encoded. A bare
// JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT) throws on both, and because
// that call sits inside the auth try/catch it surfaces as "auth failed" - which
// is exactly the wrong diagnosis, since the token was fine. That is what this
// endpoint did on its first run.
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

  try {
    const m = (req.headers.authorization || '').match(/^Bearer\s+(.+)$/);
    if (!m) return res.status(401).json({ error: 'auth required' });
    const { initializeApp, getApps, cert } = await import('firebase-admin/app');
    const { getAuth } = await import('firebase-admin/auth');
    if (!process.env.FIREBASE_SERVICE_ACCOUNT) return res.status(500).json({ error: 'server misconfigured: FIREBASE_SERVICE_ACCOUNT not set' });
    if (!getApps().length) initializeApp({ credential: cert(parseServiceAccount()) });
    const decoded = await getAuth().verifyIdToken(m[1].trim());
    const email = String(decoded.email || '').toLowerCase();
    const admins = (process.env.ADMIN_EMAILS || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
    if (!admins.includes(email)) return res.status(403).json({ error: 'not an admin' });
  } catch (e) {
    return res.status(401).json({ error: 'auth failed', detail: String((e && e.message) || e) });
  }

  const src = (req.body && Object.keys(req.body).length) ? req.body : (req.query || {});
  const since = String(src.since || DEFAULT_SINCE);
  const apply = src.apply === true || src.apply === 'true' || src.apply === '1';
  const perDeep = src.perDeep === true || src.perDeep === 'true' || src.perDeep === '1';

  try {
    const { getFirestore, FieldValue } = await import('firebase-admin/firestore');
    const db = getFirestore();

    // ── EMAIL LIST MODE ─────────────────────────────────────────────────────
    // After the grant has run, Matt needs to write to the people who were made
    // whole. The authoritative list is the GRANT_LABEL rows this endpoint
    // wrote - not a re-derivation from the Deep debits, which would also
    // include anyone credited on a different run or skipped.
    // Email comes from the users doc; a ghost account whose doc has no email
    // falls back to Firebase Auth, and anything still missing is reported as
    // such rather than silently dropped, so the count always reconciles.
    if (src.emails === true || src.emails === 'true' || src.emails === '1') {
      const grants = await db.collection('credit_events').where('label', '==', GRANT_LABEL).get();
      const rows = [];
      const seen = new Set();
      for (const d of grants.docs) {
        const g = d.data() || {};
        if (!g.uid || seen.has(g.uid)) continue;
        seen.add(g.uid);
        rows.push({ uid: g.uid, granted: Number(g.delta) || 0, at: g.createdAt || null, deepsInWindow: g.deepsInWindow || null });
      }
      const { getAuth: _getAuth } = await import('firebase-admin/auth');
      for (const r of rows) {
        let email = null, name = null;
        try {
          const u = await db.collection('users').doc(r.uid).get();
          if (u.exists) { const ud = u.data() || {}; email = ud.email || null; name = ud.name || ud.displayName || null; }
        } catch (e) {}
        if (!email) {
          try { const au = await _getAuth().getUser(r.uid); email = au.email || null; name = name || au.displayName || null; } catch (e) {}
        }
        r.email = email; r.name = name;
      }
      const withEmail = rows.filter(r => r.email);
      const withoutEmail = rows.filter(r => !r.email);
      withEmail.sort((a, b) => a.email.localeCompare(b.email));
      return res.status(200).json({
        ok: true, mode: 'emails', label: GRANT_LABEL,
        accountsCredited: rows.length,
        withEmail: withEmail.length,
        withoutEmail: withoutEmail.length,
        emails: withEmail.map(r => r.email),
        emailList: withEmail.map(r => r.email).join(', '),
        rows: withEmail,
        missing: withoutEmail.map(r => r.uid),
        note: 'These are the accounts that actually received a ' + GRANT_LABEL
            + ' credit. Accounts with no email on file are legacy/ghost accounts '
            + 'and are listed under "missing" by uid.'
      });
    }

    // Every server-side Deep debit. label is set by lib/credits.js:
    // reserveCredit(..., label: 'deep'). Filter on label alone and window it in
    // memory — credit_events has no composite index and one is not worth a
    // deploy for a one-off remediation.
    const snap = await db.collection('credit_events').where('label', '==', 'deep').get();

    const byUid = new Map();
    for (const d of snap.docs) {
      const e = d.data() || {};
      if (!e.uid) continue;
      if (String(e.createdAt || '') < since) continue;
      if (!(Number(e.delta) < 0)) continue;           // debits only
      byUid.set(e.uid, (byUid.get(e.uid) || 0) + 1);
    }

    // Who has already been made whole.
    const prior = await db.collection('credit_events').where('label', '==', GRANT_LABEL).get();
    const alreadyDone = new Set(prior.docs.map(d => (d.data() || {}).uid).filter(Boolean));

    const targets = [];
    let skipped = 0;
    for (const [uid, deeps] of byUid.entries()) {
      if (alreadyDone.has(uid)) { skipped++; continue; }
      targets.push({ uid, deeps, grant: perDeep ? deeps : 1 });
    }
    targets.sort((a, b) => b.deeps - a.deeps);
    const totalCredits = targets.reduce((n, t) => n + t.grant, 0);

    if (!apply) {
      return res.status(200).json({
        ok: true, dryRun: true, since, perDeep,
        usersWithADeep: byUid.size,
        alreadyCredited: skipped,
        usersToCredit: targets.length,
        creditsToGrant: totalCredits,
        sample: targets.slice(0, 15),
        note: 'Nothing was written. Re-send with apply=1 to grant. '
            + 'Safe to run twice: anyone already carrying a ' + GRANT_LABEL
            + ' event is skipped.'
      });
    }

    let granted = 0, failed = 0;
    const errors = [];
    for (const t of targets) {
      try {
        await db.collection('users').doc(t.uid).update({
          assessmentCredits: FieldValue.increment(t.grant)
        });
        await db.collection('credit_events').doc(
          'ce_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8)
        ).set({
          uid: t.uid,
          delta: t.grant,
          label: GRANT_LABEL,
          createdAt: new Date().toISOString(),
          deepsInWindow: t.deeps,
          reason: 'Deep assessment double-charged on non-streaming clients between '
                + since + ' and the v5.99 fix.'
        });
        granted++;
      } catch (e) {
        failed++;
        if (errors.length < 10) errors.push({ uid: t.uid, detail: String((e && e.message) || e) });
      }
    }

    return res.status(200).json({
      ok: true, applied: true, since, perDeep,
      usersCredited: granted, creditsGranted: totalCredits,
      alreadyCreditedBefore: skipped, failed, errors,
      note: 'Each grant wrote a ' + GRANT_LABEL + ' row, so this is safe to re-run.'
    });
  } catch (e) {
    return res.status(500).json({ error: 'remediation failed', detail: String((e && e.message) || e) });
  }
}
