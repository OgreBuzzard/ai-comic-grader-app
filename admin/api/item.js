// /api/admin/item.js
// Full record for a single item, including all fields the dashboard renders.
//
// Query params:
//   uid — user UID (required)
//   id  — item id (required)
//
// Returns: { item: { ...all fields per spec... } }
//
// Auth: same admin-email gate.




// Helper: unescape if env var was double-escaped during paste.
function parseServiceAccount() {
  let raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!raw) throw new Error('FIREBASE_SERVICE_ACCOUNT not set');
  if (raw.indexOf('\\"') !== -1) {
    raw = raw.split('\\"').join('"');
    raw = raw.split('\\\\').join('\\');
  }
  return JSON.parse(raw);
}

// ── FMV (server-side mirror of the app's matchFMV, S20) ─────────────────────
// Ports index.html's _normalizeKeyTitle / _normalizeKeyIssue / matchFMV verbatim
// so the admin shows the exact same FMV the app computes. The compressed index
// (/fmv.json) is fetched from robograder.app and cached in module scope.
let _fmvCache = null, _fmvAt = 0;
async function getFmvIndex() {
  if (_fmvCache && Date.now() - _fmvAt < 10 * 60 * 1000) return _fmvCache; // 10-min cache
  try {
    const r = await fetch('https://robograder.app/fmv.json', { cache: 'no-store' });
    if (r.ok) { const data = await r.json(); if (data && data.books) { _fmvCache = data; _fmvAt = Date.now(); } }
  } catch (_) { /* keep any stale cache */ }
  return _fmvCache;
}
const _nkTitle = s => !s ? '' : s.toString().trim().replace(/\s+/g, ' ').replace(/^The\s+/i, '').toLowerCase();
const _nkIssue = s => s == null ? '' : s.toString().trim().replace(/^#/, '').replace(/^0+(\d)/, '$1');
// App-identical FMV key (mirror of index.html _fmvKeyOf) so manual overrides written
// from the dashboard collide with what the app looks up.
const _appNormTitle = s => !s ? '' : s.toString().trim().replace(/\s+/g,' ').replace(/^The\s+/i,'').toLowerCase();
function _appFmvKey(title, issue) {
  let t = (title == null ? '' : title.toString()).trim().replace(/\s+/g,' ');
  let i = (issue == null ? '' : issue.toString()).trim().replace(/^#/,'');
  const titleHasAnnual = /\bannual\b/i.test(t);
  const mA = i.match(/^\s*(?:annual|ann\.?)\s*#?\s*0*(\d+)\s*$/i);
  const mB = i.match(/^\s*A\s*0*(\d+)\s*$/i);
  if (titleHasAnnual) { t = t.replace(/\bannual\b/ig,'').replace(/\s+/g,' ').trim(); const num = mA ? mA[1] : (mB ? mB[1] : i.replace(/^0+(\d)/,'$1')); i = 'A'+num; }
  else if (mA) { i = 'A'+mA[1]; } else if (mB) { i = 'A'+mB[1]; } else { i = i.replace(/^0+(\d)/,'$1'); }
  t = t.replace(/^invincible\s+iron\s+man\b/i,'Iron Man');
  return _appNormTitle(t) + '|' + i;
}
let _fmvOvCache = {}, _fmvOvAt = 0;
async function getFmvOverrides(db, docId) {
  const now = Date.now();
  if (_fmvOvCache[docId] && (now - _fmvOvAt) < 60000) return _fmvOvCache[docId];
  try {
    const snap = await db.doc('fmv_dashboard/' + docId).get();
    _fmvOvCache[docId] = snap.exists ? (snap.data() || {}) : {};
    _fmvOvAt = now;
  } catch (_) { _fmvOvCache[docId] = _fmvOvCache[docId] || {}; }
  return _fmvOvCache[docId];
}
function matchFmv(idx, title, issue, grade, printing, year) {
  if (!idx || !idx.books) return null;
  if (printing && typeof printing === 'string') {
    const p = printing.toLowerCase();
    if (p.includes('facsimile') || p.includes('reprint')) return null;
  }
  const g = parseFloat(grade);
  if (!isFinite(g)) return null;
  let breaks = idx.books[_nkTitle(title) + '|' + _nkIssue(issue)];
  if (typeof breaks === 'number' && idx.curves) breaks = idx.curves[breaks];
  if (!Array.isArray(breaks) || !breaks.length) {
    // S20 blanket rule (mirrors the app): uncovered 1991+ books default to tier 1.
    const y = parseInt(year, 10);
    if (isFinite(y) && y >= 1991 && idx.tiers && idx.tiers['1']) {
      // The app's top grade (9.8) on a blanket book is worth more than the
      // $1-20 tier-1 floor; seat it at tier 2 ($20-50).
      const _bt = (g >= 9.8 && idx.tiers['2']) ? '2' : '1';
      const _bb = idx.tiers[_bt];
      return { tier: Number(_bt), low: _bb[0], high: _bb[1] };
    }
    return null;
  }
  let tier = breaks[0][1];
  for (const b of breaks) { if (g >= b[0]) tier = b[1]; else break; }
  const range = idx.tiers && idx.tiers[String(tier)];
  return range ? { tier, low: range[0], high: range[1] } : null;
}
const _fmvK = v => v == null ? '' : (v >= 1000 ? '$' + (v / 1000) + 'K' : '$' + v);
const fmtFmv = m => !m ? '' : (m.high == null ? _fmvK(m.low) + '+' : _fmvK(m.low) + '–' + _fmvK(m.high));

export default async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'DELETE') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { initializeApp, getApps, cert } = await import('firebase-admin/app');
    const { getAuth } = await import('firebase-admin/auth');
    const { getFirestore } = await import('firebase-admin/firestore');

    if (!getApps().length) {
      initializeApp({ credential: cert(parseServiceAccount()) });
    }

    // ── Auth gate ────────────────────────────────────────────────────────────
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
      console.warn(`[admin-item] denied: ${callerEmail || '<no email>'}`);
      return res.status(403).json({ error: 'Forbidden' });
    }

    // ── Params ───────────────────────────────────────────────────────────────
    const uid = (req.query.uid || '').toString().trim();
    const id = (req.query.id || '').toString().trim();
    if (!uid) return res.status(400).json({ error: 'uid required' });
    if (!id)  return res.status(400).json({ error: 'id required' });

    // ── Fetch ────────────────────────────────────────────────────────────────
    const db = getFirestore();

    // S20: admin delete of a junk/abuse entry. UI gates this behind a confirm.
    // Removes the Firestore item record (its Storage images are handled by the
    // separate orphaned-file cleanup — deleting the doc stops it cluttering the
    // dashboard and the export immediately).
    if (req.method === 'DELETE') {
      await db.collection('users').doc(uid).collection('items').doc(id).delete();
      return res.status(200).json({ ok: true, deleted: id });
    }
    const itemRef = db.collection('users').doc(uid).collection('items').doc(id);
    const itemDoc = await itemRef.get();
    if (!itemDoc.exists) return res.status(404).json({ error: 'Item not found' });

    const raw = itemDoc.data();
    // Flatten v3 nested shape — same pattern as lookup.js.
    const flat = (raw.schemaVersion === 3)
      ? { ...raw, ...(raw.comicData || {}), ...(raw.cardData || {}) }
      : raw;

    // ── Normalize image arrays to flat URL strings ───────────────────────────
    // v3 stores as [{url, source, capturedAt}]; pre-v3 as plain strings.
    const normImages = (arr) => {
      if (!Array.isArray(arr)) return [];
      return arr
        .map(e => (typeof e === 'string' ? e : (e && e.url) || null))
        .filter(Boolean);
    };
    const images = normImages(raw.images);
    const cornerImages = normImages(raw.cornerImages);
    // S20: Full/Restoration/Signature image sets — were fetched but never
    // returned, so they never rendered in the admin detail view.
    const interiorImages = normImages(raw.interiorImages);
    const interiorCoverImages = normImages(raw.interiorCoverImages); // S20 (#36): Deep interior covers
    const restorationImages = normImages(raw.restorationImages);
    const signatureImages = normImages(raw.signatureImages);

    // S20: assessing user's contact info for the detail view (name / email /
    // 4-char transferCode used as the short User ID + tap-to-email).
    let userName = '', userEmail = '', transferCode = '';
    try {
      const ud = (await db.collection('users').doc(uid).get()).data() || {};
      userEmail = ud.email || '';
      userName = ud.displayName || ud.email || '';
      transferCode = ud.transferCode || '';
    } catch (_) { /* user doc optional */ }

    // ── Compose response per Matt's spec ─────────────────────────────────────
    // Roughly the union of fields shown in the app's detail view, plus a few
    // useful admin-only fields (publicListing, dateAcquired, fmv).
    const rg = flat.roboGrade || {};
    const item = {
      // Identification
      id,
      uid,
      title: flat.title || '(untitled)',
      issue: flat.issue || '',
      issueDate: flat.issueDate || '',
      publisher: flat.publisher || '',
      // S14: printing (e.g. "Facsimile Reprint (2019)") surfaces in the
      // header pill row when populated. Empty string for typical
      // original-printing books.
      printing: flat.printing || '',

      // Assessment metadata
      roboGradeDate: flat.roboGradeDate || null,
      roboGradeId: flat.roboGradeId || '',
      // S21: client platform/version stamp (which build produced this item)
      clientPlatform: flat.clientPlatform || null,
      clientAppVersion: flat.clientAppVersion || null,
      clientSavedAt: flat.clientSavedAt || null,
      version: rg.version || null,

      // Grades.
      // S14: removed cgcAIGrade and psaAIGrade — those fields are never
      // populated on item docs (the assess.js response writes its CGC/PSA
      // predictions to assessedCGCGrade/assessedPSAGrade, not to those
      // legacy field names). The two were rendering as blank for every
      // item and confusing rather than informing.
      assessedCGCGrade: flat.assessedCGCGrade ?? null,
      assessedPSAGrade: flat.assessedPSAGrade ?? null,
      // Card MVP: type + the card's PREDICTED PSA (raw cards are not officially
      // graded) + the 4-axis card robograde, so the dashboard can render cards.
      type: raw.type || 'comic',
      predictedPSA: (flat.psaGrade != null ? flat.psaGrade : (flat.assessedPSAGrade != null ? flat.assessedPSAGrade : null)),
      cardRobograde: flat.robograde || null,
      score: rg.score ?? null,
      confidenceRange: rg.confidenceRange ?? null,
      frontScore: rg.frontScore ?? null,
      backScore: rg.backScore ?? null,
      spineScore: rg.spineScore ?? null,
      interiorScore: rg.interiorScore ?? null,
      defects: Array.isArray(rg.defects) ? rg.defects : [],
      pageQuality: rg.pageQuality || flat.pageQuality || null,

      // Notes
      aiGraderNotes: flat.aiGraderNotes || rg.graderNotes || '',
      aiAssessment: flat.aiAssessment || rg.aiAssessment || '',
      // S20 (#53): assessment write-up split by level.
      deepAssessment: flat.deepAssessment || '',
      fullAssessment: flat.fullAssessment || '',
      psaNotes: flat.psaNotes || rg.psaNotes || '',
      labelNotes: flat.labelNotes || '',
      keyInfo: flat.keyInfo || '',

      // ComicVine reference (persisted from assess.js for admin side-by-side
      // display + diagnosing wrong-volume pulls). Only present on assessments
      // run after the persistence change; older items will be null.
      referenceImageUrl: flat.referenceImageUrl || null,
      referenceVolume: flat.referenceVolume || null,
      referenceYear: flat.referenceYear ?? null,
      referenceComparison: flat.referenceComparison || rg.referenceComparison || null,

      // Optional assessment fields — display in admin when present.
      restorationFlags: Array.isArray(rg.restorationFlags) ? rg.restorationFlags : (Array.isArray(flat.restorationFlags) ? flat.restorationFlags : []),
      signatures: Array.isArray(rg.signatures) ? rg.signatures : (Array.isArray(flat.signatures) ? flat.signatures : []),
      officialCGCGrade: flat.officialCGCGrade ?? null,
      officialCGCCert: flat.officialCGCCert ?? null,
      officialPSAGrade: flat.officialPSAGrade ?? null,
      officialPSACert: flat.officialPSACert ?? null,
      officialPageQuality: flat.officialPageQuality ?? null,
      // S21: Photograder photo-quality grades (Focus/Lighting/Cropping/Angle). The
      // dashboard detail view renders `it.photograder` but this endpoint never
      // returned the field, so the Photograder section silently never showed.
      photograder: flat.photograder || rg.photograder || null,

      // Assessing user (admin contact)
      userName,
      userEmail,
      transferCode,

      // Images
      images,
      cornerImages,
      interiorImages,
      interiorCoverImages,
      // S20 (#50): restoration report text + flag for the admin detail view.
      restorationReport: flat.restorationReport || '',
      restorationFlag: !!flat.restorationFlag,
      restorationImages,
      signatureImages,

      // Ownership / pricing (useful for admin context)
      ownership: flat.ownership || '',
      seller: flat.seller || '',
      purchasePrice: flat.purchasePrice ?? null,
      askingPrice: flat.askingPrice ?? null,
      fmv: flat.fmv ?? null,
      dateAcquired: flat.dateAcquired || null,
      publicListing: !!flat.publicListing,
      enhance: flat.enhance || null,
    };

    // S20: compute FMV live (official grade if graded, else predicted grade).
    try {
      const idx = await getFmvIndex();
      const fmvGrade = item.officialCGCGrade || item.assessedCGCGrade; // || not ?? — official grade can be "" (empty)
      const fmvYear = parseInt((String(item.issueDate || '').match(/(19|20)\d\d/) || [])[0], 10);
      const m = matchFmv(idx, item.title, item.issue, fmvGrade, item.printing, fmvYear);
      item.fmvRange = m ? fmtFmv(m) : null;
      // Manual-entry support: app-style key + current curve (static + manual override).
      const _fk = _appFmvKey(item.title, item.issue);
      item.fmvKey = _fk;
      let _sc = (idx && idx.books) ? idx.books[_fk] : null;
      if (typeof _sc === 'number' && idx.curves) _sc = idx.curves[_sc];
      item.fmvCurve = Array.isArray(_sc) ? _sc : null;
      const _ov = await getFmvOverrides(db, item.type === 'card' ? 'cards' : 'comics');
      item.fmvManualCurve = (_ov && Array.isArray(_ov[_fk])) ? _ov[_fk] : null;
    } catch (_) { item.fmvRange = item.fmvRange || null; }

    return res.status(200).json({ item });

  } catch (e) {
    console.error('[admin-item] error:', e);
    return res.status(500).json({ error: 'Item fetch failed' });
  }
}
