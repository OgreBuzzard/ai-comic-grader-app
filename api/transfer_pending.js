// api/transfer_pending.js  (deploy path → /api/transfer_pending)
// ============================================================================
// S14 Phase 3 — receive side, part 1.
//
// Caller = recipient (User B). Auth: their own Firebase ID token.
// Returns the pending transfers addressed to them, BATCHED BY SENDER
// (Matt Q4): one group per fromUid, each with a count and — only when a
// group is a single entry — the title/issue so the prompt can name it
// ("X sent you Amazing Spider-Man #14"); multi-entry groups omit names
// and just give the count ("X sent you 150 entries"). Matt's stated
// preference: name it when it's one, count-only when it's many.
//
// Lightweight: returns ONLY what the prompt needs (group → count, the
// single title/issue if count===1, and the transferIds in the group so
// the accept call can target the whole batch). Does NOT return the full
// itemSnapshot/imageManifest — that stays server-side until accept.
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

const EXPIRY_DAYS = 30;

export default async function handler(req, res) {
  // GET (no body needed) — but accept POST too for clients that prefer it.
  if (req.method !== 'GET' && req.method !== 'POST') {
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

    // Pending transfers addressed to this user.
    const snap = await db.collection('transfers')
      .where('toUid', '==', uid)
      .where('status', '==', 'pending')
      .get();

    const expiryCutoff = Date.now() - EXPIRY_DAYS * 86400 * 1000;
    const groups = {};  // fromUid → { count, transferIds, singleTitle, singleIssue }

    for (const doc of snap.docs) {
      const t = doc.data() || {};
      // Lazy expiry: a pending transfer older than the window is treated
      // as expired and skipped (Phase 4 sweep will hard-mark it; here we
      // just don't surface it so B never sees stale offers).
      const created = Date.parse(t.createdAt || '') || 0;
      if (created && created < expiryCutoff) continue;

      const k = t.fromUid || 'unknown';
      if (!groups[k]) {
        groups[k] = { fromUid: k, count: 0, transferIds: [], singleTitle: null, singleIssue: null };
      }
      const g = groups[k];
      g.count += 1;
      g.transferIds.push(doc.id);
      const snapItem = t.itemSnapshot || {};
      // Track a representative title only while the group is size 1; once
      // it grows past 1 we null it (prompt shows count only for many).
      if (g.count === 1) {
        // Schema v3 nests comic fields under comicData (the app flattens
        // this on read via flattenForApp). The raw snapshot here is the
        // stored nested doc, so read comicData first, fall back to top-
        // level for legacy v1/v2 flat items.
        const cd = snapItem.comicData || {};
        g.singleTitle = (cd.title || snapItem.title || 'entry').toString();
        const iss = cd.issue || snapItem.issue;
        g.singleIssue = iss ? String(iss) : null;
      } else {
        g.singleTitle = null;
        g.singleIssue = null;
      }
    }

    return res.status(200).json({
      ok: true,
      groups: Object.values(groups),
    });
  } catch (e) {
    return res.status(500).json({ error: (e && e.message) || 'unknown error' });
  }
}
