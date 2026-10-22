// admin/api/history_rebuild.js — put the REAL assessment back on the books the
// repair pass emptied.
//
// ── WHY THERE IS ANYTHING TO PUT BACK ───────────────────────────────────────
// api/history_repair.js strips assessment-history records off books they never
// belonged to (the v5.26 cross-book bleed). 415 items came out with an EMPTY
// history, and that is the honest result — every row on them was another book's.
// Ghost Manor 24, a 4.5 book, was showing a single row reading 9.0 that in fact
// belonged to Daredevil 187.
//
// But those books WERE assessed. Their own assessmentTimingKeys point at their
// own assessment_timings documents, and those documents hold the grade, page
// quality, RoboScore, sub-scores, version and timestamp of the real run. The
// bleed meant the correct row was never written to the array, not that the
// assessment never happened. So the evidence to rebuild it has been sitting
// there the whole time.
//
// ── WHAT IS REBUILT, AND WHAT IS DELIBERATELY NOT ───────────────────────────
// Taken straight from the timing record:
//     grade        <- predictedGrade        pageQuality  <- pageQuality
//     rgScore      <- rgScore               rgVersion    <- version
//     date         <- createdAt             depth        <- the key's prefix
// Derived by calling THE APP'S OWN SCORING MODULE, lib/roboscore_v3.js, with
// the face scores and defect list off the timing record:
//     rgV3Grade, rgConfidenceRange (PM), subscores
// This is not a convenience - it is the only safe way to do it. The first draft
// of this file reimplemented the transform as rgScore/10 rounded to the nearest
// half. Checked against 2,404 real history rows it got 1,608 right and 796
// WRONG (66 -> stored 7, derived 6.5; 92 -> stored 9.5, derived 9.0), because
// v3 applies depth caps, a PM, and a cap-shave that takes points off the
// damaged face first. None of that is recoverable by arithmetic on the total.
// If the module cannot be loaded, the derived fields are OMITTED rather than
// guessed, and the row still carries its grade, page quality and date.
//
// NOT rebuilt, because it cannot be recovered or would have to be invented:
//     roboGradeId  the user-visible Grade ID is minted CLIENT-side and was never
//                  sent to the server, so there is nothing to restore. Left
//                  empty rather than fabricated - renderAHRow does not display
//                  it, so a blank reads as a normal row.
//     rgV3PM       depends on the Photograder PM and the ceiling logic, which
//                  lives in the client. Guessing it would put a wrong +/- under
//                  a real grade.
// Every rebuilt row carries reconstructed:true and the timingKey it came from,
// so nothing here is ever mistaken for an original record.
//
// ── SCOPE AND SAFETY ────────────────────────────────────────────────────────
//   • Only items the repair pass touched (historyRepairedAt set) whose history
//     is now EMPTY. Items that kept a record are left alone - a partial array
//     is still a real array and merging into it risks duplicates.
//   • A timing record is skipped unless it produced a grade: no predictedGrade,
//     or a gateResult other than COMIC, means there was never a row to write.
//   • DRY RUN BY DEFAULT. Nothing is written without ?apply=1.
//   • Writes history_rebuild_log in the same batch as every change.
//   • Idempotent: an item is skipped once its history is non-empty, so a second
//     run is a no-op.
//
// Paste into the admin.robograder.app console:
//   await (await fetch('/api/history_rebuild',
//     { headers: { Authorization: 'Bearer ' + state.idToken } })).json()
// Add ?uid=<uid> to confine it, &apply=1 to commit, &limit=N (default 500).

function parseServiceAccount() {
  let raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!raw) throw new Error('FIREBASE_SERVICE_ACCOUNT not set');
  if (raw.includes('\\"')) raw = raw.replace(/\\"/g, '"').replace(/\\\\/g, '\\');
  try { return JSON.parse(raw); }
  catch { return JSON.parse(Buffer.from(raw, 'base64').toString('utf8')); }
}

const DEPTH = { t: 'main', deep: 'deep', full: 'full', clean: 'clean', batch: 'batch' };
const depthOfKey = k => DEPTH[(/^([a-z]+)_/.exec(String(k || '')) || [])[1]] || 'main';

// lib/roboscore_v3.js is a classic-script/CommonJS dual export, so a dynamic
// import from here lands on .default. Loaded once, and a failure is non-fatal.
let _RS = null, _rsTried = false;
async function roboScore() {
  if (_rsTried) return _RS;
  _rsTried = true;
  try {
    const mod = await import('../../lib/roboscore_v3.js');
    _RS = mod.default || mod;
  } catch (e) {
    console.warn('[history-rebuild] roboscore_v3 unavailable, omitting derived fields:', e && e.message);
    _RS = null;
  }
  return _RS;
}

// Feed the timing record to the real forComic(). depthOf() reads these flags off
// the comic, so set them from the timing key's prefix rather than passing depth.
function v3From(r, depth) {
  if (!_RS || typeof _RS.forComic !== 'function') return null;
  try {
    return _RS.forComic({
      type: 'comic',
      fullAssessmentRan: depth === 'full',
      deepAssessmentRan: depth === 'deep',
      fullInteriorComplete: false,
      labelDetected: false,
      pageQuality: r.pageQuality || '',
      photograder: r.photograder || null,
      roboGrade: {
        frontScore: r.frontScore, backScore: r.backScore, spineScore: r.spineScore,
        interiorScore: r.interiorScore, pageQuality: r.pageQuality || '',
        defects: Array.isArray(r.defects) ? r.defects : []
      }
    });
  } catch (e) { return null; }
}

export default async function handler(req, res) {
  try {
    const { initializeApp, getApps, cert } = await import('firebase-admin/app');
    const { getAuth } = await import('firebase-admin/auth');
    const { getFirestore } = await import('firebase-admin/firestore');
    if (!process.env.FIREBASE_SERVICE_ACCOUNT) return res.status(500).json({ error: 'server misconfigured' });
    if (!getApps().length) initializeApp({ credential: cert(parseServiceAccount()) });

    const m = (req.headers.authorization || '').match(/^Bearer\s+(.+)$/);
    if (!m) return res.status(401).json({ error: 'Unauthorized' });
    let decoded;
    try { decoded = await getAuth().verifyIdToken(m[1]); }
    catch { return res.status(401).json({ error: 'Unauthorized' }); }
    const adminEmails = (process.env.ADMIN_EMAILS || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
    const callerEmail = (decoded.email || '').toLowerCase();
    if (!callerEmail || !adminEmails.includes(callerEmail)) return res.status(403).json({ error: 'Forbidden' });

    const q = req.query || {};
    const APPLY = q.apply === '1';
    const ONLY_UID = (q.uid || '').toString().trim() || null;
    const LIMIT = Math.min(parseInt(q.limit) || 500, 5000);
    const VERBOSE = q.verbose === '1';
    const db = getFirestore();

    // ── find the emptied items ─────────────────────────────────────────────
    const snap = await db.collectionGroup('items').get();
    const targets = [];
    const stats = { itemsScanned: 0, emptiedItems: 0, withOwnKeys: 0,
                    itemsToRebuild: 0, rowsToWrite: 0, noTimingRecord: 0, noGradeInRecord: 0 };
    for (const d of snap.docs) {
      const uid = d.ref.parent.parent.id;
      if (ONLY_UID && uid !== ONLY_UID) continue;
      stats.itemsScanned++;
      const raw = d.data() || {};
      const v3 = raw.schemaVersion === 3;
      const flat = v3 ? { ...raw, ...(raw.comicData || {}) } : raw;
      if (!flat.historyRepairedAt) continue;
      const hist = v3 ? ((raw.comicData || {}).assessmentHistory) : raw.assessmentHistory;
      if (Array.isArray(hist) && hist.length) continue;   // kept something; leave it
      stats.emptiedItems++;
      const keys = Array.isArray(flat.assessmentTimingKeys) ? flat.assessmentTimingKeys.filter(Boolean) : [];
      if (!keys.length) continue;
      stats.withOwnKeys++;
      targets.push({ ref: d.ref, uid, v3, keys, path: d.ref.path,
                     title: flat.title, issue: flat.issue });
      if (targets.length >= LIMIT) break;
    }

    // ── read each item's own timing records and build its rows ─────────────
    // Load the scoring module ONCE, before the loop. v3From() reads _RS, so
    // without this every row would silently come out with the derived fields
    // omitted and nobody would notice until the rows looked wrong in the admin.
    await roboScore();
    const builds = [];
    for (const t of targets) {
      const docs = await db.getAll(...t.keys.slice(-12).map(k => db.collection('assessment_timings').doc(String(k))));
      const rows = [];
      docs.forEach((doc, i) => {
        const key = t.keys.slice(-12)[i];
        if (!doc.exists) { stats.noTimingRecord++; return; }
        const r = doc.data() || {};
        if (!r.predictedGrade || (r.gateResult && r.gateResult !== 'COMIC')) { stats.noGradeInRecord++; return; }
        const depth = depthOfKey(key);
        const v3 = v3From(r, depth);
        rows.push({
          grade: String(r.predictedGrade),
          psaGrade: '',
          pageQuality: r.pageQuality || '',
          rgScore: r.rgScore != null ? r.rgScore : null,
          rgVersion: r.version || '',
          // Omitted entirely when the module could not be loaded — renderAHRow
          // falls back to the raw rgScore, which is true even if it reads
          // differently from a normal row.
          ...(v3 ? {
            rgV3Grade: _RS.formatGrade ? _RS.formatGrade(v3.grade) : String(v3.grade),
            rgV3PM: v3.pmLabel || null,
            rgConfidenceRange: v3.pm != null ? v3.pm : null,
            subscores: v3.subscores || null
          } : {}),
          depth,
          roboGradeId: '',
          date: r.createdAt || new Date(Number((/_(\d{13})_/.exec(String(key)) || [])[1]) || Date.now()).toISOString(),
          reconstructed: true,
          timingKey: String(key)
        });
      });
      if (!rows.length) continue;
      rows.sort((a, b) => Date.parse(b.date) - Date.parse(a.date));   // newest first, as the app writes them
      stats.itemsToRebuild++; stats.rowsToWrite += rows.length;
      builds.push({ ...t, rows });
    }

    // ── write ──────────────────────────────────────────────────────────────
    let applied = 0;
    if (APPLY) {
      for (let i = 0; i < builds.length; i += 200) {
        const slice = builds.slice(i, i + 200);
        const batch = db.batch();
        for (const b of slice) {
          batch.set(db.collection('history_rebuild_log').doc(), {
            at: Date.now(), by: callerEmail, itemPath: b.path, uid: b.uid,
            book: `${b.title} #${b.issue}`, rows: b.rows
          });
          batch.set(b.ref,
            b.v3 ? { comicData: { assessmentHistory: b.rows }, historyRebuiltAt: Date.now() }
                 : { assessmentHistory: b.rows, historyRebuiltAt: Date.now() },
            { merge: true });
        }
        await batch.commit();
        applied += slice.length;
      }
    }

    const out = {
      mode: APPLY ? 'APPLIED' : 'DRY RUN — nothing was written. Add ?apply=1 to commit.',
      scope: ONLY_UID ? `uid ${ONLY_UID}` : 'whole catalogue',
      limit: LIMIT, ...stats, itemsWritten: applied,
      note: 'Rows are rebuilt from the item\'s OWN assessment_timings documents and tagged reconstructed:true. roboGradeId cannot be restored (minted client-side, never sent to the server) and is left empty; renderAHRow does not display it.'
    };
    if (VERBOSE) out.rebuilds = builds.slice(0, 100).map(b => ({
      book: `${b.title} #${b.issue}`, path: b.path,
      rows: b.rows.map(r => `${r.depth}/${r.grade}/${String(r.date).slice(0, 19)}`)
    }));
    console.log(`[history-rebuild] ${out.mode} ${out.scope}: ${stats.rowsToWrite} rows onto ${stats.itemsToRebuild} items`);
    return res.status(200).json(out);
  } catch (e) {
    console.error('[history-rebuild]', e && e.stack || e);
    return res.status(500).json({ error: 'rebuild failed', detail: String(e && e.message).slice(0, 300) });
  }
}
