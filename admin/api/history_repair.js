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
// The timing record's DOCUMENT KEY IS the roboGradeId (api/assess.js writes
// assessment_timings/<roboGradeId>), and each record stores the title and issue
// of the book it actually graded. So for any duplicated ID there is independent
// evidence of which book it belongs to. This endpoint reads that evidence and
// removes the entry from every item that does not match. Nothing is inferred
// from the item itself, and an ID with no timing record is LEFT ALONE — see
// UNRESOLVED below. A repair that guessed would be worse than the corruption,
// because it would look authoritative.
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
//   GET /api/history_repair                  dry run, whole catalogue
//   GET /api/history_repair?uid=<uid>        dry run, one account
//   GET /api/history_repair?apply=1&uid=...  write it
//   GET /api/history_repair?apply=1          write everything
//   &verbose=1   include the full per-item change list in the response
//
// Auth: same admin-email gate as the other admin endpoints.

function parseServiceAccount() {
  let raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!raw) throw new Error('FIREBASE_SERVICE_ACCOUNT not set');
  if (raw.includes('\\"')) raw = raw.replace(/\\"/g, '"').replace(/\\\\/g, '\\');
  try { return JSON.parse(raw); }
  catch { return JSON.parse(Buffer.from(raw, 'base64').toString('utf8')); }
}

// Title/issue matching has to tolerate how the two sides were written. The
// timing record stores what the MODEL returned ("Amazing Spider-Man"); the item
// stores what the user may since have edited ("Amazing Spider-Man " / "amazing
// spiderman"). Compare on letters and digits only, and strip leading zeros and
// a leading # from issues so "007", "#7" and "7" all match.
const normTitle = s => String(s == null ? '' : s).toLowerCase().replace(/[^a-z0-9]/g, '');
const normIssue = s => String(s == null ? '' : s).toLowerCase().replace(/[^a-z0-9]/g, '').replace(/^0+(?=.)/, '');
const keyOf = (t, i) => normTitle(t) + '|' + normIssue(i);

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
      rows.push({ ref: d.ref, uid, v3, hist, title: flat.title, issue: flat.issue, path: d.ref.path });
    }

    // ── 2. which grade IDs sit on more than one distinct book? ──────────────
    const books = new Map();   // roboGradeId -> Set("title|issue")
    for (const r of rows) {
      for (const e of r.hist) {
        const id = e && e.roboGradeId;
        if (!id) continue;
        if (!books.has(id)) books.set(id, new Set());
        books.get(id).add(keyOf(r.title, r.issue));
      }
    }
    const duplicated = new Set([...books.entries()].filter(([, s]) => s.size > 1).map(([id]) => id));

    // ── 3. ask the timing records who each one actually belongs to ──────────
    // Chunked gets; a missing doc is the UNRESOLVED case, not an error.
    const truth = new Map();   // roboGradeId -> "title|issue" or null
    const ids = [...duplicated];
    for (let i = 0; i < ids.length; i += 200) {
      const chunk = ids.slice(i, i + 200);
      const docs = await db.getAll(...chunk.map(id => db.collection('assessment_timings').doc(id)));
      docs.forEach((doc, k) => {
        const id = chunk[k];
        if (!doc.exists) return truth.set(id, null);
        const t = doc.data() || {};
        if (!t.title) return truth.set(id, null);
        truth.set(id, keyOf(t.title, t.issue));
      });
    }

    // ── 4. decide what to strip ─────────────────────────────────────────────
    const changes = [];
    const stats = {
      itemsScanned: rows.length,
      duplicatedIds: duplicated.size,
      resolvedIds: 0, unresolvedIds: 0, batchIds: 0,
      itemsToChange: 0, entriesToRemove: 0, itemsEmptiedOfHistory: 0
    };
    for (const id of duplicated) {
      if (String(id).startsWith('BATCH-')) { stats.batchIds++; continue; }
      if (truth.get(id)) stats.resolvedIds++; else stats.unresolvedIds++;
    }
    for (const r of rows) {
      const keep = [], drop = [];
      const mine = keyOf(r.title, r.issue);
      for (const e of r.hist) {
        const id = e && e.roboGradeId;
        // Not duplicated, no id at all, or a batch roll-up -> untouched.
        // UNRESOLVED (no timing record, or one with no title) -> untouched. We
        // know the entry is on at least two books and cannot tell which is
        // right; removing it from both would destroy a real record, and keeping
        // it on both is the state we already have. Reported, never guessed.
        if (!id || !duplicated.has(id) || String(id).startsWith('BATCH-') || !truth.get(id)) { keep.push(e); continue; }
        if (truth.get(id) === mine) keep.push(e); else drop.push(e);
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
      note: 'UNRESOLVED ids are left exactly as they are: the entry is on 2+ books and no timing record says which is right. Guessing would be worse than the corruption.'
    };
    if (VERBOSE) out.changes = changes.slice(0, 200).map(c => ({
      book: c.book, path: c.path, removing: c.drop.map(e => `${e.roboGradeId}/${e.grade}`), keeping: c.keep.length
    }));
    console.log(`[history-repair] ${out.mode} ${out.scope}: ${stats.entriesToRemove} entries off ${stats.itemsToChange} items (${stats.resolvedIds} resolved / ${stats.unresolvedIds} unresolved / ${stats.batchIds} batch)`);
    return res.status(200).json(out);
  } catch (e) {
    console.error('[history-repair]', e && e.stack || e);
    return res.status(500).json({ error: 'repair failed', detail: String(e && e.message).slice(0, 300) });
  }
}
