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

// Deductions are aggressive — especially HIGH which represents structural damage
const SEVERITY_DEDUCTIONS = {
  'front': { 'Low': 3, 'Med': 7, 'High': 20 },
  'back':  { 'Low': 2, 'Med': 5, 'High': 12 },
  'spine': { 'Low': 2, 'Med': 5, 'High': 12 },
  'interior': { 'Low': 1, 'Med': 3, 'High': 6 }
};

function defectFingerprint(d) {
  return `${(d.type||'').toLowerCase().trim()}|${(d.location||'').toLowerCase().trim()}|${(d.severity||'').toLowerCase().trim()}`;
}

function deductionFor(d) {
  const area = classifyDefectArea(d);
  const sev = d.severity ? d.severity.charAt(0).toUpperCase() + d.severity.slice(1).toLowerCase() : 'Low';
  const deductions = SEVERITY_DEDUCTIONS[area] || SEVERITY_DEDUCTIONS['front'];
  const base = deductions[sev] || deductions['Low'] || 3;
  const cb = d.colorBreaking ? Math.ceil(base * 0.5) : 0;
  return { area, amount: base + cb };
}

// Delta-based scoring: start from original AI sub-scores, apply changes
// for added/removed defects. This preserves the AI's nuanced scoring
// while letting the admin make targeted corrections.
function computeScoresDelta(originalScores, originalDefects, newDefects, pageQuality) {
  let front = originalScores.frontScore ?? 50;
  let back = originalScores.backScore ?? 20;
  let spine = originalScores.spineScore ?? 20;
  let interior = originalScores.interiorScore ?? 10;

  // Build fingerprint sets to find added/removed defects
  const oldFPs = new Map();
  for (const d of originalDefects) {
    const fp = defectFingerprint(d);
    oldFPs.set(fp, (oldFPs.get(fp) || 0) + 1);
  }
  const newFPs = new Map();
  for (const d of newDefects) {
    const fp = defectFingerprint(d);
    newFPs.set(fp, (newFPs.get(fp) || 0) + 1);
  }

  // Removed defects → ADD points back
  for (const d of originalDefects) {
    if (!d.severity) continue;
    const fp = defectFingerprint(d);
    const newCount = newFPs.get(fp) || 0;
    const oldCount = oldFPs.get(fp) || 0;
    // Only process if this defect was removed (more in old than new)
    if (newCount < oldCount) {
      const { area, amount } = deductionFor(d);
      switch (area) {
        case 'front': front = Math.min(50, front + amount); break;
        case 'back': back = Math.min(20, back + amount); break;
        case 'spine': spine = Math.min(20, spine + amount); break;
        case 'interior': interior = Math.min(10, interior + amount); break;
      }
      // Decrease old count so we don't double-process
      oldFPs.set(fp, oldCount - 1);
    }
  }

  // Added defects → SUBTRACT points
  for (const d of newDefects) {
    if (!d.severity) continue;
    const fp = defectFingerprint(d);
    const oldCount = oldFPs.get(fp) || 0;
    // Only process if this defect was added (more in new than remaining old)
    if (oldCount <= 0) {
      const { area, amount } = deductionFor(d);
      switch (area) {
        case 'front': front = Math.max(0, front - amount); break;
        case 'back': back = Math.max(0, back - amount); break;
        case 'spine': spine = Math.max(0, spine - amount); break;
        case 'interior': interior = Math.max(0, interior - amount); break;
      }
    } else {
      oldFPs.set(fp, oldCount - 1);
    }
  }

  // Page quality override if changed
  if (pageQuality && PQ_INTERIOR_SCORES[pageQuality] != null) {
    interior = Math.min(interior, PQ_INTERIOR_SCORES[pageQuality]);
  }

  const score = front + back + spine + interior;
  return { score, frontScore: front, backScore: back, spineScore: spine, interiorScore: interior };
}

function scoreToGrade(newScore, originalScore, originalGrade) {
  // If we have the original score→grade relationship, scale proportionally.
  // This preserves the AI's nuanced mapping instead of using a rigid table.
  if (originalScore > 0 && originalGrade > 0) {
    const ratio = newScore / originalScore;
    const rawGrade = originalGrade * ratio;
    // Snap to nearest CGC grade step
    return snapToGradeStep(rawGrade);
  }
  // Fallback: rigid table (only used if original data is missing)
  return snapToGradeStep(newScore / 10);
}

function snapToGradeStep(raw) {
  const steps = [9.8, 9.6, 9.4, 9.2, 9.0, 8.5, 8.0, 7.5, 7.0, 6.5, 6.0, 5.5, 5.0, 4.5, 4.0, 3.5, 3.0, 2.5, 2.0, 1.5, 1.0, 0.5];
  let closest = 0.5;
  let minDist = Infinity;
  for (const s of steps) {
    const d = Math.abs(raw - s);
    if (d < minDist) { minDist = d; closest = s; }
  }
  return Math.min(closest, 9.8);
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

    const itemRef = db.doc(`users/${userId}/items/${itemId}`);
    const snap = await itemRef.get();
    if (!snap.exists) {
      return res.status(404).json({ error: 'Item not found' });
    }
    const raw = snap.data();
    const isV3 = raw.schemaVersion === 3;
    const dataObj = isV3 ? { ...raw, ...(raw.comicData || {}) } : raw;
    const currentRG = (dataObj.roboGrade) || {};

    // Delta scoring: use original AI sub-scores as base, apply changes
    const originalScores = {
      frontScore: currentRG.frontScore,
      backScore: currentRG.backScore,
      spineScore: currentRG.spineScore,
      interiorScore: currentRG.interiorScore
    };
    const originalDefects = Array.isArray(currentRG.defects) ? currentRG.defects : [];
    const scores = computeScoresDelta(originalScores, originalDefects, defects, pageQuality);
    const originalTotal = (currentRG.frontScore || 0) + (currentRG.backScore || 0) + (currentRG.spineScore || 0) + (currentRG.interiorScore || 0);
    const originalPredicted = parseFloat(dataObj.predictedGrade || dataObj.assessedCGCGrade) || 0;
    const predictedGrade = scoreToGrade(scores.score, originalTotal, originalPredicted);
    const confidenceRange = scores.score >= 90 ? 1 : scores.score >= 70 ? 2 : 3;

    // Store the grade as a "8.0"-style string, matching the original assessment
    // format (api/assess.js writes String(parseFloat(...).toFixed(1))). A whole
    // grade kept as a raw JS number (8.0 === 8) drops its decimal and renders as
    // "8" in the dashboard/app, which display the stored value unformatted.
    const predictedGradeStr = predictedGrade.toFixed(1);

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
        'comicData.predictedGrade': predictedGradeStr,
        'comicData.assessedCGCGrade': predictedGradeStr
      });
    } else {
      await itemRef.update({
        roboGrade: updatedRG,
        predictedGrade: predictedGradeStr,
        assessedCGCGrade: predictedGradeStr
      });
    }

    return res.status(200).json({
      success: true,
      roboGrade: updatedRG,
      predictedGrade: predictedGradeStr,
      message: `Re-scored: RG ${scores.score}, Grade ${predictedGradeStr}`
    });

  } catch (e) {
    console.error('[rescore] error:', e);
    return res.status(500).json({ error: e.message });
  }
}
