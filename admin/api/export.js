// /api/export.js
// Full-fidelity data export for ad-hoc analysis. Returns EVERY item across
// EVERY user with all fields intact, plus owner context (name, email,
// trainingOptIn consent flag, account-created date) so the data can be
// sliced any way after the fact.
//
// Why this exists: there is no live query path into Firestore from outside
// the Admin SDK. This endpoint is the bridge — an admin pulls one JSON file
// from the dashboard and hands it off for analysis/formatting.
//
// SCOPE: items only (+ owner context). Does NOT dump purchase/credit ledgers.
//
// PII WARNING: this payload contains emails, purchase prices, seller names,
// and personal notes. It is for INTERNAL admin analysis only (covered by the
// "debugging and product-improvement" clause of the privacy policy). If you
// derive a TRAINING set from it, you must separately: filter to _trainingOptIn
// !== false, strip name/email/uid/prices/notes, and de-identify (no account
// linkage) — per the privacy policy. _trainingOptIn is included on every row
// precisely so that filter is possible.
//
// Base64 blobs (inline thumbnails / data: URIs) are stripped by default to
// keep the file lean — pass ?includeBlobs=1 to keep them. Image/Storage URLs
// are always preserved so image-presence filtering still works.
//
// Auth: same admin-email gate as the other endpoints.

function parseServiceAccount() {
  let raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!raw) throw new Error('FIREBASE_SERVICE_ACCOUNT not set');
  if (raw.includes('\\"')) {
    raw = raw.replace(/\\"/g, '"').replace(/\\\\/g, '\\');
  }
  return JSON.parse(raw);
}

// Recursively replace base64/data-URI/oversized strings with a short marker so
// the export doesn't balloon with image blobs. URLs (short) pass through.
function stripBlobs(value) {
  if (typeof value === 'string') {
    if (value.startsWith('data:') || value.length > 1500) {
      return `[blob omitted: ${value.length} chars]`;
    }
    return value;
  }
  if (Array.isArray(value)) return value.map(stripBlobs);
  if (value && typeof value === 'object') {
    const out = {};
    for (const k of Object.keys(value)) out[k] = stripBlobs(value[k]);
    return out;
  }
  return value;
}

// Pull a URL out of an image entry (string or {url}). Ghost placeholders
// (the default art shipped with a fresh item) are treated as "not present".
function realImageUrl(entry) {
  const url = typeof entry === 'string' ? entry : (entry && entry.url) || '';
  if (!url) return null;
  if (/ghosts?\//i.test(url)) return null; // assets/ghosts/* placeholders
  return url;
}

function presenceCount(arr) {
  if (!Array.isArray(arr)) return 0;
  return arr.filter(e => realImageUrl(e)).length;
}

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { initializeApp, getApps, cert } = await import('firebase-admin/app');
    const { getAuth } = await import('firebase-admin/auth');
    const { getFirestore } = await import('firebase-admin/firestore');

    if (!getApps().length) {
      initializeApp({ credential: cert(parseServiceAccount()) });
    }

    // ── Auth gate ──────────────────────────────────────────────────────────
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
      console.warn(`[admin-export] denied: ${callerEmail || '<no email>'}`);
      return res.status(403).json({ error: 'Forbidden' });
    }

    const includeBlobs = req.query.includeBlobs === '1';
    const CAP = 25000; // safety ceiling; flagged if exceeded

    // ── Query params (all optional) ────────────────────────────────────────
    // Filtering and projection happen in memory AFTER the collectionGroup read
    // (Firestore can't query across the schema-v3 nesting without composite
    // indexes), but only matching/projected rows are SHIPPED — so the download
    // stays small even though the read still scans. That's the scaling fix:
    // post-launch you pull a slice, not the whole DB.
    //   ?aggregate=1 (or ?count=1)  counts/summary only, NO item bodies (tiny)
    //   ?fields=a,b,c               project to these fields (+_uid,_itemId)
    //   ?minRG= ?maxRG=             filter on roboGrade.score
    //   ?minPG= ?maxPG=             filter on assessedCGCGrade
    //   ?title=                     case-insensitive substring on title
    //   ?type=comic|card            filter on item type
    //   ?since=ISO                  roboGradeDate/dateAdded on or after
    //   ?excludeUid=uid[,uid]       drop owner(s) (e.g. your own account)
    //   ?optInOnly=1                only trainingOptIn !== false
    //   ?limit=N                    cap returned rows (after filtering)
    const q = req.query;
    const lc = s => (s == null ? '' : String(s)).toLowerCase();
    const toNum = v => { const n = parseFloat(v); return Number.isFinite(n) ? n : null; };
    const minRG = toNum(q.minRG), maxRG = toNum(q.maxRG);
    const minPG = toNum(q.minPG), maxPG = toNum(q.maxPG);
    const since = q.since ? (Date.parse(q.since) || null) : null;
    const until = q.until ? (Date.parse(q.until) || null) : null; // upper bound (inclusive) for day/week/month/custom ranges
    const titleQ = q.title ? lc(q.title) : null;
    const typeQ = q.type ? lc(q.type) : null;
    const excludeUids = (q.excludeUid ? String(q.excludeUid).split(',') : [])
      .map(s => s.trim()).filter(Boolean);
    const optInOnly = q.optInOnly === '1';
    const fields = q.fields
      ? String(q.fields).split(',').map(s => s.trim()).filter(Boolean) : null;
    const aggregate = q.aggregate === '1' || q.count === '1';
    const limit = toNum(q.limit);
    const PII_FIELDS = ['_userName', '_userEmail', 'purchasePrice', 'salePrice',
      'askingPrice', 'notes', 'seller', 'graderNotes', 'cgcNotes', 'psaNotes'];

    const db = getFirestore();

    // ── uid → owner context map ────────────────────────────────────────────
    const usersSnap = await db.collection('users').get();
    const owners = {};
    for (const doc of usersSnap.docs) {
      const d = doc.data();
      owners[doc.id] = {
        userName: d.displayName || d.email || '(no name)',
        userEmail: d.email || '',
        trainingOptIn: d.trainingOptIn !== false, // default true (opt-out model)
        accountCreatedAt: d.createdAt || null,
      };
    }

    // ── Every item, full fidelity ──────────────────────────────────────────
    const itemsSnap = await db.collectionGroup('items').get();
    const truncated = itemsSnap.size > CAP;
    const docs = truncated ? itemsSnap.docs.slice(0, CAP) : itemsSnap.docs;

    const items = docs.map(d => {
      const raw = d.data();
      // Hoist schemaVersion-3 nested data to the top level for easy querying,
      // without dropping the raw nested objects (nothing is lost).
      const flat = (raw.schemaVersion === 3)
        ? { ...raw, ...(raw.comicData || {}), ...(raw.cardData || {}) }
        : raw;

      const uid = d.ref.parent.parent.id;
      const owner = owners[uid] || {
        userName: '(unknown user)', userEmail: '', trainingOptIn: true, accountCreatedAt: null,
      };

      // Coarse image-presence summary. Raw arrays are still included below for
      // exact slot filtering once the taxonomy is validated against real data.
      const presence = {
        images: presenceCount(raw.images),
        cornerImages: presenceCount(raw.cornerImages),
        interiorImages: presenceCount(raw.interiorImages),
        // By main-array convention: [0]=front, [1]=back, [2]=page quality, [3]=raking.
        hasFront: !!realImageUrl((raw.images || [])[0]),
        hasBack: !!realImageUrl((raw.images || [])[1]),
      };

      const body = includeBlobs ? flat : stripBlobs(flat);

      return {
        _uid: uid,
        _itemId: d.id,
        _userName: owner.userName,
        _userEmail: owner.userEmail,
        _trainingOptIn: owner.trainingOptIn,
        _accountCreatedAt: owner.accountCreatedAt,
        _imagePresence: presence,
        ...body,
      };
    });

    // ── Filter (in memory; only matching rows are shipped) ─────────────────
    const rgOf = it => {
      const r = it.roboGrade;
      const v = (r && typeof r === 'object') ? r.score : r;
      const n = parseFloat(v); return Number.isFinite(n) ? n : null;
    };
    const pgOf = it => { const n = parseFloat(it.assessedCGCGrade); return Number.isFinite(n) ? n : null; };
    const dateOf = it => Date.parse(it.roboGradeDate || it.dateAdded || it.dateAcquired || '') || null;

    let filtered = items.filter(it => {
      if (excludeUids.includes(it._uid)) return false;
      if (optInOnly && it._trainingOptIn === false) return false;
      if (typeQ && lc(it.type) !== typeQ) return false;
      if (titleQ && !lc(it.title).includes(titleQ)) return false;
      if (minRG != null || maxRG != null) {
        const rg = rgOf(it);
        if (rg == null) return false;
        if (minRG != null && rg < minRG) return false;
        if (maxRG != null && rg > maxRG) return false;
      }
      if (minPG != null || maxPG != null) {
        const pg = pgOf(it);
        if (pg == null) return false;
        if (minPG != null && pg < minPG) return false;
        if (maxPG != null && pg > maxPG) return false;
      }
      if (since != null) { const d = dateOf(it); if (d == null || d < since) return false; }
      if (until != null) { const d = dateOf(it); if (d == null || d > until) return false; }
      return true;
    });

    // ── Cost + duration join (assessment_timings) ─────────────────────────────
    // Each item stores assessmentTimingKeys — the reliable bridge to its timing
    // records, which carry per-run costUsd + totalMs (duration), plus the grade
    // and version to correlate. Batch-fetch only the referenced timing docs so
    // exports record cost + duration for every assessment run.
    try {
      const keySet = new Set();
      for (const it of filtered) (it.assessmentTimingKeys || []).forEach(k => k && keySet.add(k));
      const keys = [...keySet];
      const timingMap = {};
      for (let i = 0; i < keys.length; i += 300) {
        const refs = keys.slice(i, i + 300).map(k => db.collection('assessment_timings').doc(k));
        const snaps = refs.length ? await db.getAll(...refs) : [];
        for (const s of snaps) {
          if (!s.exists) continue;
          const t = s.data();
          timingMap[s.id] = {
            costUsd: t.costUsd ?? null,
            durationMs: t.totalMs ?? (t.phases && t.phases.totalMs) ?? null,
            model: t.model || null,
            version: t.version || null,
            rgScore: t.rgScore ?? null,
            predictedGrade: t.predictedGrade ?? null,
          };
        }
      }
      for (const it of filtered) {
        it._timings = (it.assessmentTimingKeys || [])
          .map(k => (timingMap[k] ? { key: k, ...timingMap[k] } : null))
          .filter(Boolean);
      }
    } catch (e) {
      // Non-fatal: if the timings read fails, the export still ships without them.
      console.warn('[admin-export] timings join skipped:', e.message);
    }

    const filtersApplied = {
      minRG, maxRG, minPG, maxPG, since: q.since || null, until: q.until || null, title: q.title || null,
      type: q.type || null, excludeUid: excludeUids, optInOnly, limit: limit ?? null,
    };

    // ── Aggregate mode: counts/summary only, NO bodies (tiny payload) ───────
    if (aggregate) {
      const normKey = it =>
        `${lc(it.title).replace(/\s+/g, ' ').trim()}|${lc(String(it.issue || '')).replace(/^#/, '').trim()}`;
      const titleCounts = {}, issueKeys = {}, users = new Set();
      let pgSum = 0, pgN = 0, rgSum = 0, rgN = 0, optIn = 0, optOut = 0;
      for (const it of filtered) {
        users.add(it._uid);
        const t = (it.title || '').trim();
        if (t) titleCounts[t] = (titleCounts[t] || 0) + 1;
        const k = normKey(it); issueKeys[k] = (issueKeys[k] || 0) + 1;
        const pg = pgOf(it); if (pg != null) { pgSum += pg; pgN++; }
        const rg = rgOf(it); if (rg != null) { rgSum += rg; rgN++; }
        if (it._trainingOptIn === false) optOut++; else optIn++;
      }
      const topTitles = Object.entries(titleCounts)
        .sort((a, b) => b[1] - a[1]).slice(0, 25).map(([title, count]) => ({ title, count }));
      const multiSubmissions = Object.entries(issueKeys)
        .filter(([, c]) => c >= 2).sort((a, b) => b[1] - a[1]).map(([key, count]) => ({ key, count }));
      return res.status(200).json({
        mode: 'aggregate',
        total: filtered.length,
        distinctUsers: users.size,
        avgPG: pgN ? +(pgSum / pgN).toFixed(2) : null,
        avgRG: rgN ? +(rgSum / rgN).toFixed(1) : null,
        pgCount: pgN, rgCount: rgN,
        optInBreakdown: { optIn, optOut },
        topTitles,
        multiSubmissions,
        filtersApplied,
        generatedAt: new Date().toISOString(),
      });
    }

    // ── Limit + projection ─────────────────────────────────────────────────
    if (limit != null) filtered = filtered.slice(0, limit);

    let out = filtered;
    if (fields) {
      out = filtered.map(it => {
        const o = { _uid: it._uid, _itemId: it._itemId };
        for (const f of fields) if (f in it) o[f] = it[f];
        return o;
      });
    }

    const containsPII = fields ? fields.some(f => PII_FIELDS.includes(f)) : true;

    return res.status(200).json({
      items: out,
      count: out.length,
      truncated,
      cap: CAP,
      includeBlobs,
      projected: !!fields,
      containsPII,
      filtersApplied,
      generatedAt: new Date().toISOString(),
    });

  } catch (e) {
    console.error('[admin-export] error:', e);
    return res.status(500).json({ error: 'Export failed' });
  }
}
