// admin/api/rescore.js — Admin endpoint to recalculate RG score after defect edits
// POST { userId, itemId, defects: [...], pageQuality: "White" }
// Returns { roboGrade: { score, frontScore, backScore, spineScore, interiorScore, defects, ... }, predictedGrade }

import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

if (!getApps().length) {
  initializeApp({
    credential: cert({
      projectId: process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey: (process.env.FIREBASE_PRIVATE_KEY || '').replace(/\\n/g, '\n'),
    }),
  });
}
const db = getFirestore();

const ADMIN_EMAILS = ['matt@robograder.app', 'mrharding@gmail.com'];

// ── Deterministic score computation ─────────────────────────────────
// No API call needed — the deduction logic is rules-based.

const PQ_INTERIOR_SCORES = {
  'White': 10, 'Off-White to White': 9, 'Off-White': 8,
  'Cream to Off-White': 7, 'Cream': 5, 'Light Tan to Cream': 4,
  'Tan': 3, 'Light Tan': 3, 'Tanning': 3,
  'Brown': 2, 'Brittle': 1
};

// Which area does a defect belong to? Map location keywords.
function classifyDefectArea(d) {
  const loc = (d.location || '').toLowerCase();
  const type = (d.type || '').toLowerCase();
  // Page quality is always interior
  if (type.includes('page quality')) return 'interior';
  // Spine-related
  if (loc.includes('spine') || type.includes('spine')) return 'spine';
  // Back cover
  if (loc.includes('back cover') || loc.includes('back ') || loc === 'back') return 'back';
  // Interior
  if (loc.includes('interior') || loc.includes('centerfold') || loc.includes('staple')) return 'interior';
  // Default to front (front cover defects are most common)
  return 'front';
}

// Severity-based deductions (conservative defaults)
const SEVERITY_DEDUCTIONS = {
  'front': { 'Low': 2, 'Med': 5, 'High': 12 },
  'back':  { 'Low': 1, 'Med': 3, 'High': 7 },
  'spine': { 'Low': 1, 'Med': 4, 'High': 8 },
  'interior': { 'Low': 1, 'Med': 2, 'High': 4 }
};

function computeScores(defects, pageQuality) {
  let front = 50, back = 20, spine = 20, interior = 10;

  // Apply page quality to interior
  if (pageQuality && PQ_INTERIOR_SCORES[pageQuality] != null) {
    interior = PQ_INTERIOR_SCORES[pageQuality];
  }

  // Apply defect deductions
  for (const d of defects) {
    if (!d.severity) continue; // Page quality entries have empty severity
    const area = classifyDefectArea(d);
    const sev = d.severity.charAt(0).toUpperCase() + d.severity.slice(1).toLowerCase();
    const deductions = SEVERITY_DEDUCTIONS[area] || SEVERITY_DEDUCTIONS['front'];
    const deduct = deductions[sev] || deductions['Low'] || 2;
    
    // Extra deduction for color-breaking creases
    const extra = d.colorBreaking ? Math.ceil(deduct * 0.5) : 0;
    
    switch (area) {
      case 'front': front = Math.max(0, front - deduct - extra); break;
      case 'back': back = Math.max(0, back - deduct - extra); break;
      case 'spine': spine = Math.max(0, spine - deduct - extra); break;
      case 'interior': interior = Math.max(0, interior - deduct - extra); break;
    }
  }

  const score = front + back + spine + interior;
  return { score, frontScore: front, backScore: back, spineScore: spine, interiorScore: interior };
}

// RG score → CGC grade mapping
function scoreToGrade(score) {
  if (score >= 98) return 9.8;
  if (score >= 96) return 9.6;
  if (score >= 94) return 9.4;
  if (score >= 92) return 9.2;
  if (score >= 89) return 9.0;
  if (score >= 85) return 8.5;
  if (score >= 80) return 8.0;
  if (score >= 75) return 7.5;
  if (score >= 70) return 7.0;
  if (score >= 65) return 6.5;
  if (score >= 60) return 6.0;
  if (score >= 55) return 5.5;
  if (score >= 50) return 5.0;
  if (score >= 45) return 4.5;
  if (score >= 40) return 4.0;
  if (score >= 35) return 3.5;
  if (score >= 30) return 3.0;
  if (score >= 25) return 2.5;
  if (score >= 20) return 2.0;
  if (score >= 15) return 1.5;
  if (score >= 10) return 1.0;
  return 0.5;
}

// ── Handler ─────────────────────────────────────────────────────────

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    // Verify admin auth
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Missing auth token' });
    }
    const { getAuth } = await import('firebase-admin/auth');
    const token = authHeader.split('Bearer ')[1];
    const decoded = await getAuth().verifyIdToken(token);
    if (!ADMIN_EMAILS.includes(decoded.email)) {
      return res.status(403).json({ error: 'Not an admin' });
    }

    const { userId, itemId, defects, pageQuality } = req.body;
    if (!userId || !itemId || !Array.isArray(defects)) {
      return res.status(400).json({ error: 'Missing userId, itemId, or defects array' });
    }

    // Compute new scores from modified defects
    const scores = computeScores(defects, pageQuality);
    const predictedGrade = scoreToGrade(scores.score);
    const confidenceRange = scores.score >= 90 ? 1 : scores.score >= 70 ? 2 : 3;

    // Read current item from Firestore
    const itemRef = db.doc(`users/${userId}/items/${itemId}`);
    const snap = await itemRef.get();
    if (!snap.exists) {
      return res.status(404).json({ error: 'Item not found' });
    }
    const current = snap.data();
    const currentRG = current.roboGrade || {};

    // Build updated roboGrade
    const updatedRG = {
      ...currentRG,
      score: scores.score,
      frontScore: scores.frontScore,
      backScore: scores.backScore,
      spineScore: scores.spineScore,
      interiorScore: scores.interiorScore,
      defects: defects,
      confidenceRange: confidenceRange,
      // Mark as admin-edited
      adminEdited: true,
      adminEditedAt: new Date().toISOString(),
      adminEditedBy: decoded.email
    };

    // Write back to Firestore
    await itemRef.update({
      roboGrade: updatedRG,
      predictedGrade: predictedGrade,
      assessedCGCGrade: predictedGrade
    });

    return res.status(200).json({
      success: true,
      roboGrade: updatedRG,
      predictedGrade: predictedGrade,
      message: `Re-scored: RG ${scores.score}, Grade ${predictedGrade.toFixed(1)}`
    });

  } catch (e) {
    console.error('[rescore] error:', e);
    return res.status(500).json({ error: e.message });
  }
}
