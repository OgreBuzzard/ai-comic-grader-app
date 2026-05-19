// api/transfer_send.js  (deploy path → /api/transfer_send)
// ============================================================================
// S14 Phase 2 — Give: create a PENDING transfer.
//
// Caller = User A (the giver). Authenticated by their own Firebase ID
// token (NOT admin-gated; any signed-in user can give their own item).
//
// Body: { sourceItemId, toCode }
//
// Does (all server-side, Admin SDK — bypasses client rules):
//   1. Verify A's ID token → fromUid.
//   2. Normalize + validate toCode against the system alphabet.
//   3. Resolve toCode → toUid via transfer_codes/{CODE}. 404 if none.
//   4. Reject self-transfer (toUid === fromUid).
//   5. Load A's item users/{fromUid}/items/{sourceItemId}. 404 if gone.
//      Reject the sample fixture explicitly (defense in depth — the
//      client already hides Give for it).
//   6. Rate-limit: max 250 pending+created sends per fromUid per hour.
//   7. Dedupe: if an identical (fromUid, sourceItemId, toUid) transfer
//      is already 'pending', return that one instead of creating a 2nd.
//   8. Snapshot the item + image manifest at SEND time and create
//      transfers/{auto} status:'pending'.
//
// Does NOT mutate A's item or B's account — that happens only on
// accept (transfer_resolve, Phase 3).
//
// Returns { ok:true, transferId, message }.
// ============================================================================

import { initializeApp, getApps, cert } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore } from 'firebase-admin/firestore';

// Service-account parser — verbatim from the proven sibling endpoints.
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

// Must match client ID_ALPHABET (index.html) and the vanity-code script.
const ID_ALPHABET = '23456789ABCDEFGHIJKLMNPQRSTVWXYZ';
const SAMPLE_ID = 'sample_unerring_robograder_1';
const RATE_LIMIT_PER_HOUR = 250;

function normalizeCode(raw) {
  const code = String(raw || '').trim().toUpperCase();
  if (code.length !== 4) return null;
  for (const ch of code) {
    if (ID_ALPHABET.indexOf(ch) === -1) return null;
  }
  return code;
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
      return res.status(401).json({ error: 'Invalid session — sign in again' });
    }
    const fromUid = decoded.uid;

    const { sourceItemId, toCode } = req.body || {};
    if (!sourceItemId || typeof sourceItemId !== 'string') {
      return res.status(400).json({ error: 'Missing sourceItemId' });
    }
    if (sourceItemId === SAMPLE_ID) {
      return res.status(400).json({ error: 'The sample comic cannot be given' });
    }
    const code = normalizeCode(toCode);
    if (!code) {
      return res.status(400).json({ error: 'Enter a valid 4-character code' });
    }

    // Resolve code → recipient uid.
    const codeSnap = await db.collection('transfer_codes').doc(code).get();
    if (!codeSnap.exists) {
      return res.status(404).json({ error: `No user with code ${code}` });
    }
    const toUid = (codeSnap.data() || {}).uid;
    if (!toUid) {
      return res.status(404).json({ error: `No user with code ${code}` });
    }
    if (toUid === fromUid) {
      return res.status(400).json({ error: "That's your own code" });
    }

    // Load A's item.
    const itemRef = db.collection('users').doc(fromUid)
      .collection('items').doc(sourceItemId);
    const itemSnap = await itemRef.get();
    if (!itemSnap.exists) {
      return res.status(404).json({ error: 'That entry no longer exists' });
    }
    const item = itemSnap.data() || {};

    // Rate limit: count this sender's sends in the trailing hour.
    const oneHourAgo = new Date(Date.now() - 3600 * 1000).toISOString();
    const recentSnap = await db.collection('transfers')
      .where('fromUid', '==', fromUid)
      .where('createdAt', '>=', oneHourAgo)
      .get();
    if (recentSnap.size >= RATE_LIMIT_PER_HOUR) {
      return res.status(429).json({
        error: 'Too many gives in the last hour — please wait a bit and retry',
      });
    }

    // Dedupe: existing pending transfer for the same (from,item,to)?
    const dupeSnap = await db.collection('transfers')
      .where('fromUid', '==', fromUid)
      .where('toUid', '==', toUid)
      .where('sourceItemId', '==', sourceItemId)
      .where('status', '==', 'pending')
      .limit(1)
      .get();
    if (!dupeSnap.empty) {
      return res.status(200).json({
        ok: true,
        transferId: dupeSnap.docs[0].id,
        message: `Already sent to ${code} — they just haven't accepted yet`,
        deduped: true,
      });
    }

    // Build the snapshot. Strip nothing here — Phase 3 (resolve) decides
    // final ownership/public state and re-IDs cert on accept. We DO
    // record the original roboGradeId so resolve can re-point the
    // registry. Image manifest = the stored object paths under A's item.
    const imageManifest = Array.isArray(item.images)
      ? item.images.filter(Boolean)
      : [];

    const transferDoc = {
      fromUid,
      toUid,
      toCode: code,
      status: 'pending',
      createdAt: new Date().toISOString(),
      resolvedAt: null,
      sourceItemId,
      // Snapshot at send time so A editing/deleting later doesn't change
      // what B receives (forked-not-synced from the moment of send).
      itemSnapshot: item,
      imageManifest,
      originalRoboGradeId: item.roboGradeId || null,
    };

    const ref = await db.collection('transfers').add(transferDoc);

    // Schema v3 stores comic fields nested under comicData (the app
    // flattens this via flattenForApp on read). transfer_send reads the
    // raw Firestore doc, so title/issue must be pulled from comicData
    // first, falling back to top-level for legacy v1/v2 (flat) items.
    const cd = item.comicData || {};
    const title = (cd.title || item.title || 'entry').toString();
    const issueRaw = cd.issue || item.issue;
    const issue = issueRaw ? ` #${issueRaw}` : '';
    return res.status(200).json({
      ok: true,
      transferId: ref.id,
      message: `Sent ${title}${issue} to ${code}. They'll see it next time they open the app.`,
    });
  } catch (e) {
    return res.status(500).json({ error: (e && e.message) || 'unknown error' });
  }
}
