// api/assess_batch_status.js — Batch Assessment, step 3 of 3.
// Spec: claude/ASSESS_BATCH_SPEC.md v3.1 §3.1.
//
// Poll target for the client (1s). Deliberately a plain GET returning JSON
// rather than SSE: the client is already running an animation loop, five
// workers land out of order, and a dropped SSE stream mid-batch would be worse
// than a missed poll. It also means no firestore.rules change — the client
// never reads batches/{batchId} directly, this endpoint reads it with the Admin
// SDK and returns only that user's own batch.

import { applyCors, getAdminDb, verifyUidFromAuthHeader, batchRef } from '../lib/batch_common.js';

export default async function handler(req, res) {
  if (applyCors(req, res)) return;
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const batchId = (req.query && req.query.batchId) || (req.body && req.body.batchId);
  if (!batchId) return res.status(400).json({ error: 'batchId required' });

  const uid = await verifyUidFromAuthHeader(req);
  if (!uid) return res.status(401).json({ error: 'auth required' });

  const db = await getAdminDb();
  if (!db) return res.status(500).json({ error: 'server not configured' });

  const snap = await batchRef(db, batchId).get();
  if (!snap.exists) return res.status(404).json({ error: 'batch_not_found' });
  const b = snap.data();
  if (b.uid !== uid) return res.status(403).json({ error: 'not_your_batch' });

  // Don't cache a polling endpoint.
  res.setHeader('Cache-Control', 'no-store');

  return res.status(200).json({
    batchId,
    itemId: b.itemId,
    status: b.status,
    n: b.n,
    startedAt: b.startedAt,
    anchorGrade: b.anchorGrade ?? null,
    fixedBracket: b.fixedBracket !== false,
    version: b.version || null,
    fanoutAt: b.fanoutAt || null,
    passes: (b.passes || []).map(p => ({
      pass: p.pass,
      stage: p.stage,
      mainRG: p.mainRG ?? null,
      mainGrade: p.mainGrade ?? null,
      rg: p.rg ?? null,
      grade: p.grade ?? null,
      pq: p.pq ?? null,
      pm: p.pm ?? null,
      subscores: p.subscores ?? null,
      defectCount: p.defectCount ?? null,
      deepAdded: p.deepAdded ?? null,
      mainMs: p.mainMs ?? null,
      deepMs: p.deepMs ?? null,
      error: p.error ?? null
    })),
    average: b.average ?? null,
    low: b.low ?? null,
    high: b.high ?? null,
    completedPasses: b.completedPasses ?? null,
    mainSpread: b.mainSpread ?? null,
    deepSpread: b.deepSpread ?? null,
    completedAt: b.completedAt || null
  });
}
