// admin/api/history_repair.js — strip assessment-history records off books they
// never belonged to.
//
// ── WHAT BROKE ──────────────────────────────────────────────────────────────
// `{ ...EMPTY }` in index.html was a SHALLOW spread, so every array in the
// blank-form template came out as a REFERENCE to the single array literal
// declared in EMPTY, not a copy. `formData.assessmentHistory.unshift(rec)`
// mutated EMPTY itself, and the next book started from EMPTY inherited every
// record filed under every previous book in that session. Fixed in v5.26 via
// blankForm(), which slices every array — but the shipped native binary at the
// time (1.12, App Store 2026-09-19) was compiled before the fix and kept
// corrupting data until 1.13 shipped on 2026-10-14. Measured 2026-10-22 against
// live Firestore: 495 grade IDs sitting on more than one distinct book, zero of
// them on a 1.13 item.
//
// ── WHY THIS CAN BE REPAIRED RATHER THAN GUESSED AT ─────────────────────────
// FIRST ATTEMPT, AND WHY IT FAILED. The plan was to read assessment_timings
// keyed by the roboGradeId. assess.js looks like it does that:
//     const key = (parsed.roboGrade && parsed.roboGrade.roboGradeId) || ... ||
//                 `t_${Date.now()}_${rand}`
// but `parsed` is the MODEL's response and the roboGradeId is minted CLIENT-side
// after the call, so the server never has one and the fallback always wins.
// Every timing key is t_<ms>_<rand> or deep_<ms>_<rand>. The first run of this
// endpoint resolved 0 of 495 IDs, which is exactly that.
//
// WHAT ACTUALLY WORKS. The item's own assessmentTimingKeys array carries the
// MILLISECOND TIMESTAMP of each call it really made, and a history entry stores
// the wall-clock `date` it was written. Those line up: on a sampled book the
// history entry lands 20-40s after its timing key, the gap being the call
// finishing and the record being written. Crucially, assessmentTimingKeys was
// never declared in the EMPTY template, so it was never part of the shallow-
// spread bleed — it is clean evidence about an item that history is not.
//
// THE RULE IS POSITIVE IDENTIFICATION, NOT ABSENCE. For a duplicated ID, look at
// every item carrying it and ask which ones have a timing key within 3 minutes
// of that entry's date. If EXACTLY ONE book matches, that book owns the record
// and it is stripped from the others. Zero matches or two-plus matches are left
// alone. Absence is never treated as proof, because assessmentTimingKeys is
// capped at the last 12 and older items have none at all — only 30% of all
// history entries match an own-key, so "unmatched" on its own means nothing.
// Measured on the 2026-10-17 catalogue: 450 of 489 duplicated IDs (92%) resolve
// this way, 30 have no matching carrier, 5 are ambiguous, 4 are BATCH.
//
// ── SAFETY ──────────────────────────────────────────────────────────────────
//   • DRY RUN BY DEFAULT. Nothing is written without ?apply=1.
//   • Every removed entry is copied to the history_repair_log collection with
//     its item path first, so any change can be reversed by hand.
//   • Only ENTRIES are removed. No item, field or image is ever deleted, and an
//     item whose every record was foreign correctly ends up with [].
//   • ?limit=N caps how many items are touched in one run (default 500).
//   • ?uid=<uid> confines the run to one account — do a single account first.
//
// ── USAGE ───────────────────────────────────────────────────────────────────
// These are HTTP routes on the admin site, NOT shell commands. Paste into the
// admin.robograder.app console:
//
//   await (await fetch('/api/history_repair',
//     { headers: { Authorization: 'Bearer ' + state.idToken } })).json()
//
// Add ?uid=<uid> to confine it to one account, &apply=1 to commit, &verbose=1
// for the per-item change list, &limit=N to cap items touched (default 500).
//
// Auth: same admin-email gate as the other admin endpoints.

function parseServiceAccount() {
  let raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!raw) throw new Error('FIREBASE_SERVICE_ACCOUNT not set');
  if (raw.includes('\\"')) raw = raw.replace(/\\"/g, '"').replace(/\\\\/g, '\\');
  try { return JSON.parse(raw); }
  catch { return JSON.parse(Buffer.from(raw, 'base64').toString('utf8')); }
}

// Every timing key is "<tier>_<13-digit ms>_<rand>" — t_, deep_, full_, clean_,
// batch_. The milliseconds are the only part we need.
const TOL_MS = 180000;   // 3 min: the history record is written 20-40s after the call
function keyMs(k) {
  const m = /^(?:t|deep|full|clean|batch)_(\d{13})_/.exec(String(k || ''));
  return m ? Number(m[1]) : null;
}
function entryMs(e) {
  const t = Date.parse((e && e.date) || '');
  return Number.isFinite(t) ? t : null;
}
const bookKey = (t, i) => String(t == null ? '' : t).toLowerCase().replace(/[^a-z0-9]/g, '')
                        + '|' + String(i == null ? '' : i).toLowerCase().replace(/[^a-z0-9]/g, '').replace(/^0+(?=.)/, '');

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
    if (!callerEmail || !adminEmails.includes(callerEmail)) {
      console.warn(`[history-repair] denied: ${callerEmail || '<no email>'}`);
      return res.status(403).json({ error: 'Forbidden' });
    }

    const q = req.query || {};
    const APPLY = q.apply === '1';
    const ONLY_UID = (q.uid || '').toString().trim() || null;
    const LIMIT = Math.min(parseInt(q.limit) || 500, 5000);
    const VERBOSE = q.verbose === '1';
    const db = getFirestore();

    // ── 1. read every item, remember where its history lives ────────────────
    const snap = await db.collectionGroup('items').get();
    const rows = [];
    for (const d of snap.docs) {
      const uid = d.ref.parent.parent.id;
      if (ONLY_UID && uid !== ONLY_UID) continue;
      const raw = d.data() || {};
      const v3 = raw.schemaVersion === 3;
      // assessmentHistory is in COMIC_DATA_FIELDS, so on a v3 document it lives
      // at comicData.assessmentHistory, NOT the top level. Writing to the wrong
      // one would silently do nothing (and leave a stray top-level field).
      const hist = v3 ? ((raw.comicData || {}).assessmentHistory) : raw.assessmentHistory;
      if (!Array.isArray(hist) || !hist.length) continue;
      const flat = v3 ? { ...raw, ...(raw.comicData || {}) } : raw;
      rows.push({ ref: d.ref, uid, v3, hist, title: flat.title, issue: flat.issue,
                  // never in COMIC_DATA_FIELDS, so top-level; flat covers both anyway
                  timingKeys: Array.isArray(flat.assessmentTimingKeys) ? flat.assessmentTimingKeys : [],
                  path: d.ref.path });
    }

    // ── 2. index every (roboGradeId -> the items carrying it) ──────────────
    const carriers = new Map();   // id -> [{row, entry}]
    for (const r of rows) {
      for (const e of r.hist) {
        const id = e && e.roboGradeId;
        if (!id) continue;
        if (!carriers.has(id)) carriers.set(id, []);
        carriers.get(id).push({ row: r, entry: e });
      }
    }

    // ── 3. resolve each duplicated id by POSITIVE identification ───────────
    // Which carrier items have a timing key within TOL_MS of this entry's date?
    // Exactly one distinct book -> that book owns the record. Anything else is
    // left alone. See the header for why absence proves nothing here.
    const ownerOf = new Map();    // id -> bookKey of the true owner
    const stats = {
      itemsScanned: rows.length, duplicatedIds: 0,
      resolvedIds: 0, unresolvedNoMatch: 0, unresolvedAmbiguous: 0, batchIds: 0,
      itemsToChange: 0, entriesToRemove: 0, itemsEmptiedOfHistory: 0
    };
    for (const [id, list] of carriers) {
      const bookSet = new Set(list.map(c => bookKey(c.row.title, c.row.issue)));
      if (bookSet.size < 2) continue;              // only on one book: nothing wrong
      stats.duplicatedIds++;
      if (String(id).startsWith('BATCH-')) { stats.batchIds++; continue; }
      const hits = new Set();
      for (const c of list) {
        const t = entryMs(c.entry);
        if (t == null) continue;
        const keys = (c.row.timingKeys || []).map(keyMs).filter(Boolean);
        if (keys.some(k => Math.abs(t - k) <= TOL_MS)) hits.add(bookKey(c.row.title, c.row.issue));
      }
      if (hits.size === 1) { ownerOf.set(id, [...hits][0]); stats.resolvedIds++; }
      else if (hits.size === 0) stats.unresolvedNoMatch++;
      else stats.unresolvedAmbiguous++;
    }

    // ── 4. decide what to strip ────────────────────────────────────────────
    const changes = [];
    for (const r of rows) {
      const mine = bookKey(r.title, r.issue);
      const keep = [], drop = [];
      for (const e of r.hist) {
        const id = e && e.roboGradeId;
        const owner = id ? ownerOf.get(id) : null;
        if (!owner || owner === mine) keep.push(e); else drop.push(e);
      }
      if (!drop.length) continue;
      stats.itemsToChange++;
      stats.entriesToRemove += drop.length;
      if (!keep.length) stats.itemsEmptiedOfHistory++;
      changes.push({ ref: r.ref, v3: r.v3, path: r.path, uid: r.uid,
                     book: `${r.title} #${r.issue}`, keep, drop });
      if (changes.length >= LIMIT) break;
    }

    // ── 5. write, if asked ──────────────────────────────────────────────────
    let applied = 0;
    if (APPLY) {
      for (let i = 0; i < changes.length; i += 200) {
        const slice = changes.slice(i, i + 200);
        const batch = db.batch();
        for (const c of slice) {
          // Log FIRST (in the same batch) so a removal is never unrecoverable.
          batch.set(db.collection('history_repair_log').doc(), {
            at: Date.now(), by: callerEmail, itemPath: c.path, uid: c.uid,
            book: c.book, removed: c.drop, keptCount: c.keep.length
          });
          batch.set(c.ref,
            c.v3 ? { comicData: { assessmentHistory: c.keep }, historyRepairedAt: Date.now() }
                 : { assessmentHistory: c.keep, historyRepairedAt: Date.now() },
            { merge: true });
        }
        await batch.commit();
        applied += slice.length;
      }
    }

    const out = {
      mode: APPLY ? 'APPLIED' : 'DRY RUN — nothing was written. Add ?apply=1 to commit.',
      scope: ONLY_UID ? `uid ${ONLY_UID}` : 'whole catalogue',
      limit: LIMIT,
      ...stats,
      itemsWritten: applied,
      note: 'An id is only acted on when EXACTLY ONE carrying book has a timing key within 3 minutes of the entry date. No match or several matches -> left exactly as it is. Absence is not evidence here: assessmentTimingKeys is capped at 12 and older items have none.'
    };
    if (VERBOSE) out.changes = changes.slice(0, 200).map(c => ({
      book: c.book, path: c.path, removing: c.drop.map(e => `${e.roboGradeId}/${e.grade}`), keeping: c.keep.length
    }));
    console.log(`[history-repair] ${out.mode} ${out.scope}: ${stats.entriesToRemove} entries off ${stats.itemsToChange} items (${stats.resolvedIds} resolved / ${stats.unresolvedNoMatch} no-match / ${stats.unresolvedAmbiguous} ambiguous / ${stats.batchIds} batch)`);
    return res.status(200).json(out);
  } catch (e) {
    console.error('[history-repair]', e && e.stack || e);
    return res.status(500).json({ error: 'repair failed', detail: String(e && e.message).slice(0, 300) });
  }
}
