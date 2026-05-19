// admin/api/transfer_sweep.js  (deploy path → /api/transfer_sweep)
// ============================================================================
// S14 Phase 4 — hardening: on-demand expiry sweep.
//
// WHY on-demand (admin-triggered) and NOT a cron:
//   The lazy expiry skip already shipped in /api/transfer_pending means
//   recipients NEVER see an expired offer — expired pending transfers
//   are already invisible in the UI. The only thing this sweep does is
//   housekeeping: hard-mark those long-dead `pending` docs as 'expired'
//   and strip their heavy itemSnapshot/imageManifest so stale snapshots
//   don't sit in Firestore forever. That is purely storage hygiene with
//   ZERO user-facing impact, so it does not warrant introducing a
//   vercel.json cron block (a build-config change that can't be easily
//   tested in this no-terminal deploy model, and would add an always-on
//   secured endpoint for a cosmetic problem). Triggered from the admin
//   dashboard (or manually) whenever convenient. If automation is ever
//   wanted later, a cron can call THIS endpoint unchanged.
//
// Auth: admin only (Firebase ID token whose email ∈ ADMIN_EMAILS) — same
// model as the other admin endpoints.
//
// What it does:
//   - Find transfers where status == 'pending' AND createdAt older than
//     EXPIRY_DAYS (default 30). (Same cutoff the lazy skip uses, so the
//     UI and the sweep agree on what "expired" means.)
//   - For each: set status 'expired', resolvedAt = now, and DELETE the
//     heavy fields (itemSnapshot, imageManifest) to reclaim space while
//     keeping the lightweight audit shell (who→whom, when, why) — same
//     spirit as the other ledgers (a record survives, the payload does
//     not). Note we intentionally do NOT delete any Storage objects:
//     the SENDER still owns their copy at A's path (a pending transfer
//     never moved storage — copies only happen on accept). There is no
//     orphaned storage to clean here; only the Firestore snapshot.
//   - Chunked + idempotent: re-running is safe (already-expired docs
//     don't match the pending filter), and it processes in batches so a
//     large backlog doesn't exceed limits.
//
// Returns { ok:true, swept, scanned }.
// ============================================================================

import { initializeApp, getApps, cert } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';

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

const EXPIRY_DAYS = 30;          // MUST match transfer_pending.js lazy skip
const SCAN_LIMIT = 500;          // max docs examined per invocation

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  try {
    const authHeader = req.headers.authorization || '';
    const token = authHeader.startsWith('Bearer ')
      ? authHeader.slice(7) : null;
    if (!token) return res.status(401).json({ error: 'Missing bearer token' });

    const sa = parseServiceAccount();
    if (!getApps().length) initializeApp({ credential: cert(sa) });
    const auth = getAuth();
    const db = getFirestore();

    let decoded;
    try {
      decoded = await auth.verifyIdToken(token);
    } catch {
      return res.status(401).json({ error: 'Invalid token' });
    }
    const adminEmails = (process.env.ADMIN_EMAILS || '')
      .split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
    const callerEmail = (decoded.email || '').toLowerCase();
    if (!callerEmail || adminEmails.indexOf(callerEmail) === -1) {
      return res.status(403).json({ error: 'Not authorized' });
    }

    const cutoffIso = new Date(Date.now() - EXPIRY_DAYS * 86400 * 1000).toISOString();

    // Pending + created before cutoff. This is a composite query
    // (status ==, createdAt <) — see DEPLOY-TIME note in the design doc;
    // it needs its own composite index (auto-create link on first run).
    const snap = await db.collection('transfers')
      .where('status', '==', 'pending')
      .where('createdAt', '<', cutoffIso)
      .limit(SCAN_LIMIT)
      .get();

    let swept = 0;
    const scanned = snap.size;

    // Batch the updates (Firestore batch cap 500; we chunk at 400).
    let batch = db.batch();
    let inBatch = 0;
    for (const doc of snap.docs) {
      batch.update(doc.ref, {
        status: 'expired',
        resolvedAt: new Date().toISOString(),
        // Reclaim the heavy payload; keep the audit shell.
        itemSnapshot: FieldValue.delete(),
        imageManifest: FieldValue.delete(),
      });
      inBatch++;
      swept++;
      if (inBatch >= 400) {
        await batch.commit();
        batch = db.batch();
        inBatch = 0;
      }
    }
    if (inBatch > 0) await batch.commit();

    return res.status(200).json({
      ok: true,
      swept,
      scanned,
      note: scanned === SCAN_LIMIT
        ? 'Hit scan limit — run again to continue sweeping the backlog.'
        : 'Backlog clear.',
    });
  } catch (e) {
    return res.status(500).json({ error: (e && e.message) || 'unknown error' });
  }
}
