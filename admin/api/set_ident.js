// admin/api/set_ident.js — Admin endpoint to correct an item's Title / Issue
// (and, for cards, the card name + number) from the dashboard without hand-
// editing Firestore. Primary use: fix titles/issue numbers Robograder read wrong
// on obscure books (e.g. Gold Key covers that don't print issue numbers clearly).
// POST { userId, itemId, title?, issue?, cardNumber? }
// Schema v3 stores title/issue under comicData, so we write with dot-paths.
// Admin-gated identically to set_state.js / rescore.js.

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

    const authHeader = req.headers.authorization || '';
    const m = authHeader.match(/^Bearer\s+(.+)$/);
    if (!m) return res.status(401).json({ error: 'Unauthorized' });

    let decoded;
    try { decoded = await getAuth().verifyIdToken(m[1]); }
    catch { return res.status(401).json({ error: 'Unauthorized' }); }

    const adminEmails = (process.env.ADMIN_EMAILS || '')
      .split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
    if (!adminEmails.includes((decoded.email || '').toLowerCase())) {
      return res.status(403).json({ error: 'Not an admin' });
    }

    const { userId, itemId, title, issue, cardNumber } = req.body || {};
    if (!userId || !itemId) {
      return res.status(400).json({ error: 'Missing userId or itemId' });
    }
    if (title == null && issue == null && cardNumber == null) {
      return res.status(400).json({ error: 'Nothing to update' });
    }

    const db = getFirestore();
    const itemRef = db.doc(`users/${userId}/items/${itemId}`);
    const snap = await itemRef.get();
    if (!snap.exists) return res.status(404).json({ error: 'Item not found' });

    const data = snap.data() || {};
    const isV3 = data.schemaVersion === 3 || !!data.comicData;
    const isCard = data.type === 'card';
    const prevTitle = (data.comicData && data.comicData.title) || data.title || '';
    const prevIssue = (data.comicData && data.comicData.issue) || data.issue || '';

    const upd = {
      identAdminSetAt: new Date().toISOString(),
      identAdminSetBy: decoded.email
    };
    if (title != null) {
      if (isV3) upd['comicData.title'] = String(title); else upd.title = String(title);
      if (isCard) upd['cardData.cardIdentification.name'] = String(title);
    }
    if (issue != null) {
      if (isV3) upd['comicData.issue'] = String(issue); else upd.issue = String(issue);
    }
    if (isCard) {
      const num = (cardNumber != null ? cardNumber : issue);
      if (num != null) upd['cardData.cardIdentification.number'] = String(num);
    }

    await itemRef.update(upd);

    // S21 cover-index: teach the corrected issue number to this cover's
    // fingerprint so future identical covers auto-number correctly. Comics only
    // (cards later); requires a coverHash stamped on the item at assess time.
    // Best-effort — the identity save above already succeeded regardless.
    try {
      const coverHash = data.coverHash;
      const finalTitle = title != null ? String(title) : prevTitle;
      const finalIssue = issue != null ? String(issue) : String(prevIssue || '');
      if (!isCard && coverHash && finalTitle && finalIssue) {
        const key = finalTitle.trim().toLowerCase().replace(/[\/#]/g, ' ').replace(/\s+/g, ' ').trim();
        if (key) {
          const publisher = (data.comicData && data.comicData.publisher) || data.publisher || '';
          const idxRef = db.doc(`cover_index/${key}`);
          const idxSnap = await idxRef.get();
          const prev = (idxSnap.exists && idxSnap.data() && Array.isArray(idxSnap.data().entries)) ? idxSnap.data().entries : [];
          const entries = prev.filter(e => e && e.phash && e.phash !== coverHash);
          entries.push({ issue: finalIssue, phash: coverHash, publisher, addedAt: new Date().toISOString() });
          await idxRef.set({ entries }, { merge: true });
        }
      }
    } catch (e) { /* non-fatal: identity already saved */ }

    return res.status(200).json({
      success: true,
      message: `Saved${title != null ? ` · title "${prevTitle}" → "${title}"` : ''}${issue != null ? ` · ${isCard ? 'no.' : 'issue'} "${prevIssue}" → "${issue}"` : ''}`
    });
  } catch (e) {
    return res.status(500).json({ error: e.message || 'Internal error' });
  }
}
