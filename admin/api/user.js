// /api/admin/user.js
// Single user profile with full items list, plus admin-only writes.
//
// GET ?uid=...
//   Returns: { user: {...}, items: [...], publicRate: {...} }
//
// PATCH ?uid=...
//   Body: { assessmentCredits: number }
//   Returns: { ok: true, user: {...updated user...} }
//   Only assessmentCredits is currently writable; additional fields can be
//   added to the allowlist below as needed. Server enforces integer bounds.
//
// Auth: same admin-email gate for both methods.




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

// ── FMV (S20 #34): same port as admin/api/items.js so the user-detail item list
// shows the same value as the Items tab. Fetched once per request.
let _fmvCache = null, _fmvAt = 0;
async function getFmvIndex() {
  if (_fmvCache && Date.now() - _fmvAt < 10 * 60 * 1000) return _fmvCache;
  try {
    const r = await fetch('https://robograder.app/fmv_comics.json', { cache: 'no-store' });
    if (r.ok) { const data = await r.json(); if (data && data.books) { _fmvCache = data; _fmvAt = Date.now(); } }
  } catch (_) { /* keep stale cache */ }
  return _fmvCache;
}
const _nkTitle = s => !s ? '' : s.toString().trim().replace(/\s+/g, ' ').replace(/^The\s+/i, '').toLowerCase();
const _nkIssue = s => s == null ? '' : s.toString().trim().replace(/^#/, '').replace(/\.0$/, '').replace(/^0+(\d)/, '$1');
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
function matchFmv(idx, title, issue, grade, printing, year) {
  if (!idx || !idx.books) return null;
  if (printing && typeof printing === 'string') {
    const p = printing.toLowerCase();
    if (p.includes('facsimile') || p.includes('reprint')) return null;
  }
  const g = parseFloat(grade);
  if (!isFinite(g)) return null;
  const _key = _appFmvKey(title, issue);   // app-identical key (folds annuals -> A<n>, Invincible Iron Man -> Iron Man)
  let breaks;
  // Volume/year model + legacy year guard (mirrors the app & items.js) so guarded
  // books (e.g. modern Batman reusing Golden-Age issue numbers) price correctly.
  const _vols = idx.volumes && idx.volumes[_key];
  if (Array.isArray(_vols) && _vols.length) {
    const _vy = parseInt(year, 10); let _ci = null;
    if (isFinite(_vy)) { for (const _c of _vols) { if (_vy >= _c[1] && _vy <= _c[2]) { _ci = _c[0]; break; } } }
    breaks = (_ci != null && idx.curves) ? idx.curves[_ci] : null;
  } else {
    breaks = idx.books[_key];
    if (typeof breaks === 'number' && idx.curves) breaks = idx.curves[breaks];
    const _vg = idx.volumeGuards && idx.volumeGuards[_key];
    if (_vg && Array.isArray(breaks)) { const _vy = parseInt(year, 10); if (isFinite(_vy) && _vy > _vg) breaks = null; }
  }
  if (!Array.isArray(breaks) || !breaks.length) {
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
  if (req.method !== 'GET' && req.method !== 'PATCH') {
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
      console.warn(`[admin-user] denied: ${callerEmail || '<no email>'}`);
      return res.status(403).json({ error: 'Forbidden' });
    }

    // ── Params ───────────────────────────────────────────────────────────────
    const uid = (req.query.uid || '').toString().trim();
    if (!uid) return res.status(400).json({ error: 'uid required' });

    const db = getFirestore();
    const userRef = db.collection('users').doc(uid);

    // ── PATCH: write allowed fields + audit log entry, atomically ───────────
    // Currently the only writable field is assessmentCredits. To add more,
    // extend the validation block — each field needs its own type/range check
    // and its own line in the changeBits / audit entry below.
    if (req.method === 'PATCH') {
      const body = req.body || {};
      const update = {};

      if (Object.prototype.hasOwnProperty.call(body, 'assessmentCredits')) {
        const n = Number(body.assessmentCredits);
        // Reject non-integers, negatives, and unreasonably large values.
        // The 10,000 ceiling is well above any legitimate Pro purchase
        // (largest current package is 100 credits / $50). If we ever sell
        // larger packs this needs bumping.
        if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0 || n > 10000) {
          return res.status(400).json({
            error: 'assessmentCredits must be an integer between 0 and 10000'
          });
        }
        update.assessmentCredits = n;
      }

      if (Object.keys(update).length === 0) {
        return res.status(400).json({ error: 'No writable fields in body' });
      }

      // Atomic write: user doc update + audit log entry in a single
      // transaction. Either both succeed or both fail. Without this, a
      // user-doc update with a failed audit write would leave us with an
      // invisible adjustment; the reverse would leave a phantom audit
      // entry. The transaction reads the prior doc inside the same
      // transaction so the old→new delta in the audit log matches what
      // actually changed (handles the rare case where the user doc was
      // mutated between our prior read and our write).
      let auditWritten = null;   // captures the new doc id for the response
      let noOp = false;          // set true if before === after for the field
      try {
        await db.runTransaction(async (tx) => {
          const priorSnap = await tx.get(userRef);
          if (!priorSnap.exists) {
            throw new Error('USER_NOT_FOUND');
          }
          const before = priorSnap.data();

          // No-op guard: if every field in the update already matches the
          // stored value, skip both writes. Otherwise we'd create a junk
          // audit entry every time the admin opened the editor and tapped
          // SAVE without changing anything. We set a flag and bail out of
          // the transaction body (no writes performed → no commit cost).
          const isNoOp = Object.entries(update).every(
            ([k, v]) => before[k] === v
          );
          if (isNoOp) { noOp = true; return; }

          // Build one audit doc per PATCH call. Even when multiple fields
          // change in the same call (none today, but the schema is ready),
          // we record them as a single adjustment event — the per-field
          // breakdown is in the changes[] array.
          const nowMs = Date.now();
          const changes = Object.entries(update).map(([field, newValue]) => ({
            field,
            oldValue: before[field] ?? null,
            newValue,
            delta: (typeof before[field] === 'number' && typeof newValue === 'number')
              ? (newValue - before[field])
              : null
          }));

          const auditRef = db.collection('credit_adjustments').doc();
          tx.set(auditRef, {
            userId:     uid,
            adminEmail: callerEmail,
            adminUid:   decoded.uid || null,
            changes,
            // Convenience top-level mirrors for the most common single-field
            // case (assessmentCredits). Lets a dashboard query sort/filter on
            // these without unrolling the changes[] array.
            primaryField:    changes[0].field,
            primaryOldValue: changes[0].oldValue,
            primaryNewValue: changes[0].newValue,
            primaryDelta:    changes[0].delta,
            reason:     (typeof body.reason === 'string' ? body.reason : ''),
            at:         new Date(nowMs).toISOString(),
            atMs:       nowMs
          });
          auditWritten = auditRef.id;

          // S20 gift-credit marker: when the admin RAISES credits, stamp a
          // marker the app reads to show the "bestowed" pop-up. Only fires on
          // this manual-grant PATCH path — never on purchases (those credit via
          // the Stripe webhook / verify_iap, which don't touch this endpoint).
          if (typeof update.assessmentCredits === 'number') {
            const prevC = typeof before.assessmentCredits === 'number' ? before.assessmentCredits : 0;
            const delta = update.assessmentCredits - prevC;
            if (delta > 0) update.giftCredits = { amount: delta, at: new Date(nowMs).toISOString() };
          }

          // The user-doc update goes through the same transaction — both
          // commit together or both are rolled back. update() requires the
          // doc to exist (we verified above via priorSnap.exists).
          tx.update(userRef, update);
        });
      } catch (txErr) {
        if (txErr.message === 'USER_NOT_FOUND') {
          return res.status(404).json({ error: 'User not found' });
        }
        // Anything else: re-throw to the outer catch for a 500 response.
        throw txErr;
      }

      if (noOp) {
        return res.status(400).json({
          error: 'No change — new value matches current value'
        });
      }

      // Best-effort log line for at-a-glance Vercel inspection. The audit
      // log collection is the source of truth; this is just a convenience.
      const changeBits = Object.entries(update).map(([k, v]) =>
        `${k} → ${v}`
      ).join(', ');
      console.log(`[admin-user] ${callerEmail} updated ${uid}: ${changeBits} (audit ${auditWritten})`);

      // Fall through to GET-shaped response below so the dashboard can
      // re-render from the same payload shape it already handles, without
      // a second round-trip.
    }

    // ── Fetch user ───────────────────────────────────────────────────────────
    const userDoc = await userRef.get();
    if (!userDoc.exists) return res.status(404).json({ error: 'User not found' });

    const u = userDoc.data();
    const user = {
      uid,
      displayName: u.displayName || u.email || '(no name)',
      email: u.email || '',
      assessmentCredits: u.assessmentCredits || 0,
      totalPurchased: u.totalPurchased || 0,
      everPurchased: !!u.everPurchased,
      createdAt: u.createdAt || null,
      lastPurchaseDate: u.lastPurchaseDate || null,
      termsAccepted: !!u.termsAccepted,
      termsVersion: u.termsVersion || null,
      trainingOptIn: u.trainingOptIn !== false, // default true
    };

    // ── Fetch items ──────────────────────────────────────────────────────────
    // Compact rows for the list — full per-item detail comes from /item.js.
    // Flatten nested comicData/cardData so the dashboard doesn't have to.
    const itemsSnap = await userRef.collection('items').get();
    const fmvIdx = await getFmvIndex(); // S20 (#34)
    const items = itemsSnap.docs.map(d => {
      const raw = d.data();
      const flat = (raw.schemaVersion === 3)
        ? { ...raw, ...(raw.comicData || {}), ...(raw.cardData || {}) }
        : raw;
      // High-grade refinement run = corner images present.
      // raw.cornerImages preserved on either schema version since it lives
      // at the root, not inside comicData.
      const cornerArr = Array.isArray(raw.cornerImages) ? raw.cornerImages : [];
      const highGradeAssessed = cornerArr.filter(e =>
        typeof e === 'string' ? e : (e && e.url)
      ).length > 0;
      // S20 (#34): fields for the new list-row style (thumb, stars, FMV).
      let thumbUrl = null;
      const imgs0 = Array.isArray(raw.images) ? raw.images : [];
      if (imgs0.length) { const f = imgs0[0]; thumbUrl = typeof f === 'string' ? f : (f && f.url) || null; }
      const inlineThumb = flat.thumbnail || raw.thumbnail || null;
      const tier = (Array.isArray(raw.interiorImages) && raw.interiorImages.length) ? 3
                 : ((highGradeAssessed || flat.highGradeTier === true) ? 2 : 1);
      let fmvRange = null;
      try {
        const g = (flat.cgcGrade || flat.assessedCGCGrade); // || not ?? — cgcGrade is often "" (empty)
        const y = parseInt((String(flat.issueDate || '').match(/(19|20)\d\d/) || [])[0], 10);
        const mm = matchFmv(fmvIdx, flat.title, flat.issue, g, flat.printing, y);
        fmvRange = mm ? fmtFmv(mm) : null;
      } catch (_) { fmvRange = null; }
      return {
        id: d.id,
        title: flat.title || '(untitled)',
        issue: flat.issue || '',
        roboGradeDate: flat.roboGradeDate || null,
        roboGradeId: flat.roboGradeId || '',
        score: flat.roboGrade?.score ?? null,
        assessedCGCGrade: flat.assessedCGCGrade ?? null,
        assessedPSAGrade: flat.assessedPSAGrade ?? null,
        publicListing: !!flat.publicListing,
        highGradeAssessed,
        tier,
        thumbUrl,
        inlineThumb,
        fmvRange,
      };
    });

    // Sort items by most recent assessment first by default.
    items.sort((a, b) => {
      const am = Date.parse(a.roboGradeDate || '') || 0;
      const bm = Date.parse(b.roboGradeDate || '') || 0;
      return bm - am;
    });

    // Public-listing rate is the practical signal for "does this user
    // prefer public?" since the actual `publicByDefault` preference lives
    // in localStorage on their device, not in Firestore. With ≥3 items the
    // rate is a useful proxy; below that it's just noise.
    const publicCount = items.filter(it => it.publicListing).length;
    const publicRate = items.length > 0
      ? { publicCount, totalCount: items.length, percent: Math.round(100 * publicCount / items.length) }
      : null;

    return res.status(200).json({ user, items, publicRate });

  } catch (e) {
    console.error('[admin-user] error:', e);
    return res.status(500).json({ error: 'User fetch failed' });
  }
}
