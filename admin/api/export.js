// /api/export.js
// Full-fidelity data export for ad-hoc analysis. Returns EVERY item across
// EVERY user with all fields intact, plus owner context (name, email,
// trainingOptIn consent flag, account-created date) so the data can be
// sliced any way after the fact.
//
// Why this exists: there is no live query path into Firestore from outside
// the Admin SDK. This endpoint is the bridge — an admin pulls one JSON file
// from the dashboard and hands it off for analysis/formatting.
//
// SCOPE: items only (+ owner context). Does NOT dump purchase/credit ledgers.
//
// PII WARNING: this payload contains emails, purchase prices, seller names,
// and personal notes. It is for INTERNAL admin analysis only (covered by the
// "debugging and product-improvement" clause of the privacy policy). If you
// derive a TRAINING set from it, you must separately: filter to _trainingOptIn
// !== false, strip name/email/uid/prices/notes, and de-identify (no account
// linkage) — per the privacy policy. _trainingOptIn is included on every row
// precisely so that filter is possible.
//
// Base64 blobs (inline thumbnails / data: URIs) are stripped by default to
// keep the file lean — pass ?includeBlobs=1 to keep them. Image/Storage URLs
// are always preserved so image-presence filtering still works.
//
// Auth: same admin-email gate as the other endpoints.

function parseServiceAccount() {
  let raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!raw) throw new Error('FIREBASE_SERVICE_ACCOUNT not set');
  if (raw.includes('\\"')) {
    raw = raw.replace(/\\"/g, '"').replace(/\\\\/g, '\\');
  }
  return JSON.parse(raw);
}

// Recursively replace base64/data-URI/oversized strings with a short marker so
// the export doesn't balloon with image blobs. URLs (short) pass through.
function stripBlobs(value) {
  if (typeof value === 'string') {
    if (value.startsWith('data:') || value.length > 1500) {
      return `[blob omitted: ${value.length} chars]`;
    }
    return value;
  }
  if (Array.isArray(value)) return value.map(stripBlobs);
  if (value && typeof value === 'object') {
    const out = {};
    for (const k of Object.keys(value)) out[k] = stripBlobs(value[k]);
    return out;
  }
  return value;
}

// Pull a URL out of an image entry (string or {url}). Ghost placeholders
// (the default art shipped with a fresh item) are treated as "not present".
function realImageUrl(entry) {
  const url = typeof entry === 'string' ? entry : (entry && entry.url) || '';
  if (!url) return null;
  if (/ghosts?\//i.test(url)) return null; // assets/ghosts/* placeholders
  return url;
}

function presenceCount(arr) {
  if (!Array.isArray(arr)) return 0;
  return arr.filter(e => realImageUrl(e)).length;
}

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { initializeApp, getApps, cert } = await import('firebase-admin/app');
    const { getAuth } = await import('firebase-admin/auth');
    const { getFirestore } = await import('firebase-admin/firestore');

    if (!getApps().length) {
      initializeApp({ credential: cert(parseServiceAccount()) });
    }

    // ── Auth gate ──────────────────────────────────────────────────────────
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
      console.warn(`[admin-export] denied: ${callerEmail || '<no email>'}`);
      return res.status(403).json({ error: 'Forbidden' });
    }

    const includeBlobs = req.query.includeBlobs === '1';
    const CAP = 25000; // safety ceiling; flagged if exceeded

    const db = getFirestore();

    // ── uid → owner context map ────────────────────────────────────────────
    const usersSnap = await db.collection('users').get();
    const owners = {};
    for (const doc of usersSnap.docs) {
      const d = doc.data();
      owners[doc.id] = {
        userName: d.displayName || d.email || '(no name)',
        userEmail: d.email || '',
        trainingOptIn: d.trainingOptIn !== false, // default true (opt-out model)
        accountCreatedAt: d.createdAt || null,
      };
    }

    // ── Every item, full fidelity ──────────────────────────────────────────
    const itemsSnap = await db.collectionGroup('items').get();
    const truncated = itemsSnap.size > CAP;
    const docs = truncated ? itemsSnap.docs.slice(0, CAP) : itemsSnap.docs;

    const items = docs.map(d => {
      const raw = d.data();
      // Hoist schemaVersion-3 nested data to the top level for easy querying,
      // without dropping the raw nested objects (nothing is lost).
      const flat = (raw.schemaVersion === 3)
        ? { ...raw, ...(raw.comicData || {}), ...(raw.cardData || {}) }
        : raw;

      const uid = d.ref.parent.parent.id;
      const owner = owners[uid] || {
        userName: '(unknown user)', userEmail: '', trainingOptIn: true, accountCreatedAt: null,
      };

      // Coarse image-presence summary. Raw arrays are still included below for
      // exact slot filtering once the taxonomy is validated against real data.
      const presence = {
        images: presenceCount(raw.images),
        cornerImages: presenceCount(raw.cornerImages),
        interiorImages: presenceCount(raw.interiorImages),
        // By main-array convention: [0]=front, [1]=back, [2]=page quality, [3]=raking.
        hasFront: !!realImageUrl((raw.images || [])[0]),
        hasBack: !!realImageUrl((raw.images || [])[1]),
      };

      const body = includeBlobs ? flat : stripBlobs(flat);

      return {
        _uid: uid,
        _itemId: d.id,
        _userName: owner.userName,
        _userEmail: owner.userEmail,
        _trainingOptIn: owner.trainingOptIn,
        _accountCreatedAt: owner.accountCreatedAt,
        _imagePresence: presence,
        ...body,
      };
    });

    return res.status(200).json({
      items,
      count: items.length,
      truncated,
      cap: CAP,
      includeBlobs,
      containsPII: true,
      generatedAt: new Date().toISOString(),
    });

  } catch (e) {
    console.error('[admin-export] error:', e);
    return res.status(500).json({ error: 'Export failed' });
  }
}
