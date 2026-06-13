// api/transfer_recv.js  (deploy path → /api/transfer_recv)
// ============================================================================
// Merged endpoint (S15 May 27) — consolidates the two receive-side transfer
// endpoints into one Vercel function to free a slot for api/assess_full.js.
// Combines what used to be transfer_pending.js + transfer_register_code.js.
// The four old transfer files (send / resolve / pending / register_code)
// were at 4/12 of the Hobby function budget; merging the two smaller ones
// brings us to 3/12 and makes room for Full Assessment.
//
// Routing: action comes from req.query.action (GET) or req.body.action (POST).
// Supported actions:
//   "pending"        — list pending transfers addressed to the caller, batched
//                      by sender. Accepts GET or POST. (was transfer_pending.js)
//   "register_code"  — ensure the caller's transferCode has a working reverse-
//                      index entry. Idempotent. POST only. (was transfer_register_code.js)
//
// The original handler logic for both is preserved byte-for-byte below; only
// the entry-point wrapper is new. If a future regression appears, this file
// can be split back into two by extracting handlePending() and
// handleRegisterCode() into their own files with the original names.
// ============================================================================

// firebase-admin is imported DYNAMICALLY inside setupAuth (below), matching
// the pattern used by api/assess.js / checkout.js. A static top-level import
// of firebase-admin/* fails on Vercel with "Failed to load the ES module" and
// 500s the function — the working endpoints all defer the import to runtime.

// ── shared helpers (deduplicated from the two source files) ─────────────────

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

// Common auth + admin setup. Returns { auth, db, uid } or sends an error
// response and returns null. Centralizing this means the two handlers don't
// each re-implement the same five lines.
async function setupAuth(req, res) {
  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!token) {
    res.status(401).json({ error: 'Sign-in required' });
    return null;
  }
  const sa = parseServiceAccount();
  const { initializeApp, getApps, cert } = await import('firebase-admin/app');
  const { getAuth } = await import('firebase-admin/auth');
  const { getFirestore } = await import('firebase-admin/firestore');
  if (!getApps().length) initializeApp({ credential: cert(sa) });
  const auth = getAuth();
  const db = getFirestore();
  let decoded;
  try {
    decoded = await auth.verifyIdToken(token);
  } catch {
    res.status(401).json({ error: 'Invalid session' });
    return null;
  }
  return { auth, db, uid: decoded.uid };
}

// ── handler: "pending" (was transfer_pending.js) ────────────────────────────
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

const EXPIRY_DAYS = 30;

async function handlePending(req, res) {
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed for action=pending' });
  }
  try {
    const ctx = await setupAuth(req, res);
    if (!ctx) return; // setupAuth already wrote the error response
    const { db, uid } = ctx;

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

// ── handler: "register_code" (was transfer_register_code.js) ────────────────
//
// THE BUG THIS FIXES (preserved from original):
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
//   ensures THIS user has a working, unique reverse-index entry.
//   See full doc in the original transfer_register_code.js header.
//
// SECURITY: user-token auth (NOT admin). A user can only ever create /
// move their OWN reverse-index entry — uid comes from the verified
// token, never from the body. It cannot touch another user's code
// except to AVOID stealing one already claimed (earliest-claimant-wins).

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

async function handleRegisterCode(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed for action=register_code' });
  }
  try {
    const ctx = await setupAuth(req, res);
    if (!ctx) return;
    const { db, uid } = ctx;

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

// ── handleSend (merged from transfer_send.js, S16 June 8) ──────────────────
// Create a PENDING transfer. Caller = User A (the giver).
// Body: { sourceItemId, toCode, action: "send" }

// ID_ALPHABET is already declared above (shared across the merged handlers) —
// the S15 merge accidentally redeclared it here, which is a parse-time
// duplicate-const error ("Failed to load the ES module" → 500). Removed.
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

async function handleSend(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  try {
    const ctx = await setupAuth(req, res);
    if (!ctx) return;
    const { db, uid: fromUid } = ctx;

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

    // Snapshot item + image manifest at SEND time.
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
      itemSnapshot: item,
      imageManifest,
      originalRoboGradeId: item.roboGradeId || null,
    };

    const ref = await db.collection('transfers').add(transferDoc);

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

// ── router ──────────────────────────────────────────────────────────────────

export default async function handler(req, res) {
  // CORS: the iOS Capacitor app calls this cross-origin (local file origin →
  // robograder.app) and preflights with OPTIONS + Authorization header. The
  // PWA is same-origin and never preflights. Answer the preflight first.
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, Accept, x-client-secret');
  res.setHeader('Access-Control-Max-Age', '86400');
  if (req.method === 'OPTIONS') return res.status(204).end();

  // Resolve action from query (GET-friendly) or body (POST).
  const queryAction = req.query && req.query.action;
  const bodyAction = req.body && req.body.action;
  const action = (queryAction || bodyAction || '').toString().toLowerCase();

  if (action === 'send') {
    return handleSend(req, res);
  }
  if (action === 'pending') {
    return handlePending(req, res);
  }
  if (action === 'register_code' || action === 'register-code' || action === 'registercode') {
    return handleRegisterCode(req, res);
  }
  return res.status(400).json({
    error: 'Unknown or missing action. Expected ?action=pending, action=register_code, or action=send.',
    receivedAction: action || null
  });
}
