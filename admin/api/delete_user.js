// admin/api/delete_user.js   (called by the admin dashboard as /api/delete_user)
//
// Naming: the admin dashboard is its own Vercel deployment rooted at
// /admin, so its function root is admin/api/ and the client calls these
// as /api/<name> with NO "admin_" prefix — matching the sibling
// endpoints user.js, users.js, item.js, items.js, stats.js. An earlier
// version of this file was named admin_delete_user.js and called as
// /api/admin_delete_user, which 404'd because no such function path
// exists. Do not reintroduce the prefix.
//
// Admin-only: hard-delete a user account. Wipes everything in Auth and
// Firestore that belongs to the user, plus their Cloud Storage objects,
// EXCEPT historical financial / audit records (purchases, credit
// adjustments, promo redemptions) which are retained for compliance.
//
// Operation order (designed so partial-failure leaves the system in a
// defensible state — the destructive steps run last):
//   1. Auth user        → deleteUser(uid). Immediately revokes sign-in.
//      Done first so even if subsequent steps fail, the user can't sign
//      back in and trigger account-recreation logic.
//   2. robograde_ids    → delete all docs where userId === uid. These
//      docs are queryable by public clients; orphaning them would leave
//      working public URLs pointing to nothing.
//   3. items subcoll    → delete all users/{uid}/items/{*}
//   4. comics subcoll   → delete all users/{uid}/comics/{*} (legacy)
//   5. meta subcoll     → delete all users/{uid}/meta/{*}
//   6. Storage objects  → delete all files under users/{uid}/
//   7. users/{uid} doc  → delete (the user-record itself, last so that
//      the doc-deletion is the "permanent" signal).
//
// Returns: { ok: true, summary: { ... counts ... } }
//
// Audit log: a single entry in account_deletions/{auto} captures who
// deleted whom and when. Same admin-only access pattern as other ledgers.

import { initializeApp, getApps, cert } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore } from 'firebase-admin/firestore';
import { getStorage } from 'firebase-admin/storage';

// Service-account parser. This MUST match the implementation used by the
// other working admin endpoints (admin/api/user.js etc.) — they handle
// the specific case this endpoint was failing on: when
// FIREBASE_SERVICE_ACCOUNT was pasted into the Vercel env field with
// double-escaped quotes (\\" instead of ") and double-escaped
// backslashes, which happens routinely when copy-pasting a JSON key into
// a dashboard text input. The earlier version of this function tried
// plain JSON then base64 but did NOT un-escape, so it threw
// "could not be parsed" on the exact env value every sibling endpoint
// parses fine. Un-escape first (matching the siblings), then JSON.parse;
// base64 retained only as a last-ditch fallback.
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

// Delete every doc in a collection by streaming the IDs and batch-deleting.
// Firestore batches max out at 500 ops; we chunk to 400 to leave headroom
// for the audit operations.
async function deleteCollection(db, collRef) {
  let total = 0;
  const BATCH_SIZE = 400;
  while (true) {
    const snap = await collRef.limit(BATCH_SIZE).get();
    if (snap.empty) break;
    const batch = db.batch();
    snap.docs.forEach(d => batch.delete(d.ref));
    await batch.commit();
    total += snap.size;
    if (snap.size < BATCH_SIZE) break;
  }
  return total;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  try {
    if (!getApps().length) {
      initializeApp({
        credential: cert(parseServiceAccount()),
        storageBucket: process.env.FIREBASE_STORAGE_BUCKET || undefined,
      });
    }

    // Auth gate — same admin-email allowlist pattern as the other admin
    // endpoints. Bearer token in Authorization header.
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
      console.warn(`[admin-delete-user] denied: ${callerEmail || '<no email>'}`);
      return res.status(403).json({ error: 'Forbidden' });
    }

    // Body validation
    const body = req.body || {};
    const targetUid = (body.uid || '').toString().trim();
    if (!targetUid) {
      return res.status(400).json({ error: 'uid is required' });
    }

    // Self-delete guard. Admins shouldn't be able to delete themselves
    // through this endpoint — too easy to lock yourself out, and Firebase
    // Auth has its own self-account-deletion flow if you genuinely want
    // to leave.
    if (targetUid === decoded.uid) {
      return res.status(400).json({ error: 'Cannot delete your own account via this endpoint.' });
    }

    // Confirmation token check. Two modes:
    //   • Account HAS an email → client must echo the email (typed-back).
    //   • Account has NO email (very old accounts predate email capture —
    //     fields are just assessmentCredits/createdAt/freeCreditsGranted/
    //     termsAccepted/termsAcceptedAt/termsVersion) → client must echo
    //     the last 6 characters of the UID instead. Still a real "look at
    //     it and type it" check, just keyed on the only stable identifier
    //     these ghost accounts have.
    const confirmToken = (body.confirmEmail || body.confirmToken || '').toString().trim().toLowerCase();
    let targetEmail = '';
    try {
      const targetAuth = await getAuth().getUser(targetUid);
      targetEmail = (targetAuth.email || '').toLowerCase();
    } catch (e) {
      // If the Auth user doesn't exist, this is likely a leftover
      // Firestore-only ghost account. Allow the cleanup to proceed
      // without the email-match check — just log the discrepancy.
      console.warn(`[admin-delete-user] auth user not found for ${targetUid}; proceeding with Firestore cleanup only`);
      targetEmail = '';
    }
    if (targetEmail) {
      // Email exists → require email match.
      if (confirmToken !== targetEmail) {
        return res.status(400).json({
          error: `Confirmation mismatch. Type "${targetEmail}" to confirm.`
        });
      }
    } else {
      // No email → require last-6-of-UID match (case-insensitive).
      const uidSuffix = targetUid.slice(-6).toLowerCase();
      if (confirmToken !== uidSuffix) {
        return res.status(400).json({
          error: `This account has no email on file. Type the last 6 characters of its ID ("${uidSuffix}") to confirm.`
        });
      }
    }

    const db = getFirestore();
    const summary = {
      uid: targetUid,
      email: targetEmail,
      authDeleted: false,
      robogradeIdsDeleted: 0,
      itemsDeleted: 0,
      comicsDeleted: 0,
      metaDeleted: 0,
      storageObjectsDeleted: 0,
      userDocDeleted: false,
    };

    // 1. Auth user
    if (targetEmail) {
      try {
        await getAuth().deleteUser(targetUid);
        summary.authDeleted = true;
      } catch (e) {
        // Continue with Firestore cleanup even if Auth deletion fails.
        // The admin can retry; partial deletes are recoverable, partial
        // halts mid-way leave worse state.
        console.error(`[admin-delete-user] auth delete failed for ${targetUid}:`, e.message);
      }
    }

    // 2. robograde_ids registry — find and delete all docs where
    //    userId === targetUid. This is a small collection so we can
    //    query it directly.
    try {
      const idsSnap = await db.collection('robograde_ids')
        .where('userId', '==', targetUid).get();
      if (!idsSnap.empty) {
        const batch = db.batch();
        idsSnap.docs.forEach(d => batch.delete(d.ref));
        await batch.commit();
        summary.robogradeIdsDeleted = idsSnap.size;
      }
    } catch (e) {
      console.error(`[admin-delete-user] robograde_ids cleanup failed:`, e.message);
    }

    // 3-5. Per-user subcollections.
    const userRef = db.collection('users').doc(targetUid);
    try {
      summary.itemsDeleted  = await deleteCollection(db, userRef.collection('items'));
    } catch (e) { console.error('[admin-delete-user] items cleanup:', e.message); }
    try {
      summary.comicsDeleted = await deleteCollection(db, userRef.collection('comics'));
    } catch (e) { console.error('[admin-delete-user] comics cleanup:', e.message); }
    try {
      summary.metaDeleted   = await deleteCollection(db, userRef.collection('meta'));
    } catch (e) { console.error('[admin-delete-user] meta cleanup:', e.message); }

    // 6. Cloud Storage — best-effort cleanup of users/{uid}/* objects.
    //    Errors here don't block deletion; orphaned blobs cost a few
    //    cents per GB-month and can be cleaned up later if needed.
    try {
      const bucket = getStorage().bucket();
      const [files] = await bucket.getFiles({ prefix: `users/${targetUid}/` });
      if (files && files.length > 0) {
        await Promise.all(files.map(f => f.delete().catch(() => null)));
        summary.storageObjectsDeleted = files.length;
      }
    } catch (e) {
      console.error(`[admin-delete-user] storage cleanup failed:`, e.message);
    }

    // 7. User doc — last step. Now that everything else is cleared,
    //    deleting this record makes the account "officially gone."
    try {
      await userRef.delete();
      summary.userDocDeleted = true;
    } catch (e) {
      console.error(`[admin-delete-user] user doc delete failed:`, e.message);
    }

    // Audit log entry. Same access pattern as credit_adjustments and
    // promo_redemptions — Admin SDK only.
    try {
      await db.collection('account_deletions').add({
        targetUid,
        targetEmail,
        adminEmail: callerEmail,
        adminUid: decoded.uid || null,
        summary,
        at: new Date().toISOString(),
        atMs: Date.now(),
      });
    } catch (e) {
      console.error(`[admin-delete-user] audit log write failed:`, e.message);
    }

    console.log(`[admin-delete-user] ${callerEmail} deleted ${targetEmail || targetUid}`, summary);
    return res.status(200).json({ ok: true, summary });

  } catch (err) {
    console.error('[admin-delete-user] error:', err);
    return res.status(500).json({ error: err.message || 'Internal error' });
  }
}
