// admin/api/rescore.js — Admin endpoint to recalculate RG score after defect edits
// POST { userId, itemId, defects: [...], pageQuality: "White" }
// Returns { roboGrade: updated, predictedGrade, message }

function parseServiceAccount() {
  let raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!raw) throw new Error('FIREBASE_SERVICE_ACCOUNT not set');
  if (raw.indexOf('\\"') !== -1) {
    raw = raw.split('\\"').join('"');
    raw = raw.split('\\\\').join('\\');
  }
  return JSON.parse(raw);
}

// ── Deterministic score computation (no API call, zero cost) ────────

const PQ_INTERIOR_SCORES = {
  'White': 10, 'Off-White to White': 9, 'Off-White': 8,
  'Cream to Off-White': 7, 'Cream': 5, 'Light Tan to Cream': 4,
  'Tan': 3, 'Light Tan': 3, 'Tanning': 3,
  'Brown': 2, 'Brittle': 1
};

function classifyDefectArea(d) {
  const loc = (d.location || '').toLowerCase();
  const type = (d.type || '').toLowerCase();
  if (type.includes('page quality')) return 'interior';
  if (loc.includes('spine') || type.includes('spine')) return 'spine';
  if (loc.includes('back cover') || loc.includes('back ') || loc === 'back') return 'back';
  if (loc.includes('interior') || loc.includes('centerfold') || loc.includes('staple')) return 'interior';
  return 'front';
}

const SEVERITY_DEDUCTIONS = {
  'front': { 'Low': 2, 'Med': 5, 'High': 12 },
  'back':  { 'Low': 1, 'Med': 3, 'High': 7 },
  'spine': { 'Low': 1, 'Med': 4, 'High': 8 },
  'interior': { 'Low': 1, 'Med': 2, 'High': 4 }
};

function computeScores(defects, pageQuality) {
  let front = 50, back = 20, spine = 20, interior = 10;
  if (pageQuality && PQ_INTERIOR_SCORES[pageQuality] != null) {
    interior = PQ_INTERIOR_SCORES[pageQuality];
  }
  for (const d of defects) {
    if (!d.severity) continue;
    const area = classifyDefectArea(d);
    const sev = d.severity.charAt(0).toUpperCase() + d.severity.slice(1).toLowerCase();
    const deductions = SEVERITY_DEDUCTIONS[area] || SEVERITY_DEDUCTIONS['front'];
    const deduct = deductions[sev] || deductions['Low'] || 2;
    const extra = d.colorBreaking ? Math.ceil(deduct * 0.5) : 0;
    switch (area) {
      case 'front': front = Math.max(0, front - deduct - extra); break;
      case 'back': back = Math.max(0, back - deduct - extra); break;
      case 'spine': spine = Math.max(0, spine - deduct - extra); break;
      case 'interior': interior = Math.max(0, interior - deduct - extra); break;
    }
  }
  return { score: front + back + spine + interior, frontScore: front, backScore: back, spineScore: spine, interiorScore: interior };
}

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
    const { initializeApp, getApps, cert } = await import('firebase-admin/app');
    const { getAuth } = await import('firebase-admin/auth');
    const { getFirestore } = await import('firebase-admin/firestore');

    if (!getApps().length) {
      initializeApp({ credential: cert(parseServiceAccount()) });
    }

    // Auth gate
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

    const { userId, itemId, defects, pageQuality } = req.body || {};
    if (!userId || !itemId || !Array.isArray(defects)) {
      return res.status(400).json({ error: 'Missing userId, itemId, or defects array' });
    }

    const db = getFirestore();
    const scores = computeScores(defects, pageQuality);
    const predictedGrade = scoreToGrade(scores.score);
    const confidenceRange = scores.score >= 90 ? 1 : scores.score >= 70 ? 2 : 3;

    const itemRef = db.doc(`users/${userId}/items/${itemId}`);
    const snap = await itemRef.get();
    if (!snap.exists) {
      return res.status(404).json({ error: 'Item not found' });
    }
    const raw = snap.data();
    // SchemaVersion 3 nests data inside comicData — write to the correct path
    const isV3 = raw.schemaVersion === 3;
    const dataObj = isV3 ? { ...raw, ...(raw.comicData || {}) } : raw;
    const currentRG = (dataObj.roboGrade) || {};

    const updatedRG = {
      ...currentRG,
      score: scores.score,
      frontScore: scores.frontScore,
      backScore: scores.backScore,
      spineScore: scores.spineScore,
      interiorScore: scores.interiorScore,
      defects: defects,
      confidenceRange: confidenceRange,
      adminEdited: true,
      adminEditedAt: new Date().toISOString(),
      adminEditedBy: decoded.email
    };

    // Write to the correct location based on schema version
    if (isV3) {
      await itemRef.update({
        'comicData.roboGrade': updatedRG,
        'comicData.predictedGrade': predictedGrade,
        'comicData.assessedCGCGrade': predictedGrade
      });
    } else {
      await itemRef.update({
        roboGrade: updatedRG,
        predictedGrade: predictedGrade,
        assessedCGCGrade: predictedGrade
      });
    }

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
