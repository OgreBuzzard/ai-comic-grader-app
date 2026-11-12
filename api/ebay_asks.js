// api/ebay_asks.js — what SLABBED copies of this book are currently ASKING on eBay.
//
// ── READ THIS BEFORE CHANGING ANYTHING ──────────────────────────────────────
// THESE ARE NOT COMPS. eBay's sold-price data lives behind the Marketplace
// Insights API, which eBay staff describe as "highly limited and generally
// reserved for eBay's approved partners only". What the free Browse API gives
// is ACTIVE listings — what sellers are hoping for, on a population skewed
// toward books that have NOT sold, some of which have sat for months at
// fantasy prices.
//
// Everything below exists to stop that number being mistaken for a value:
//   - MEDIAN, never mean. One $5,000 Buy-It-Now moves a mean and does not move
//     a median, and eBay is full of exactly those.
//   - n is returned and the UI prints it. "9 listed, median $240" is a true
//     statement about supply. "$240" on its own is a valuation, and a wrong one.
//   - Fewer than MIN_LISTINGS and we return nothing at all. Three listings is
//     not a market.
//   - This feeds NOTHING. Not fmvTierOf, not the Deep gate, not the Full gate,
//     not the concierge gate, not the label. Nothing decides anything on an
//     asking price. If a future change wires this into a gate, that is the
//     change that needs an argument, not this file.
//
// GRADED ONLY, and that constraint is what makes this tractable at all
// (Matt, 2026-11-10). A raw listing's condition is a seller's adjective; a
// slab listing puts "CGC 9.4" in the title. The same regex both PROVES the
// listing is slabbed and EXTRACTS its grade, which is why graded-only works
// where graded-and-raw would be guesswork.

import { getAdminDb, verifyUidFromAuthHeader } from '../lib/batch_common.js';

const EBAY_OAUTH   = 'https://api.ebay.com/identity/v1/oauth2/token';
const EBAY_SEARCH  = 'https://api.ebay.com/buy/browse/v1/item_summary/search';
const SCOPE        = 'https://api.ebay.com/oauth/api_scope';

const MIN_LISTINGS = 3;        // below this we say nothing
const SEARCH_LIMIT = 50;
const CACHE_HOURS  = 24;

// The CGC ladder, which is what a slab label can say. Band widening steps
// along THIS, not along 0.5 increments — above 9.0 the real rungs are
// 9.0, 9.2, 9.4, 9.6, 9.8 and there is no 9.5.
const LADDER = [0.5, 1.0, 1.5, 1.8, 2.0, 2.5, 3.0, 3.5, 4.0, 4.5, 5.0, 5.5,
                6.0, 6.5, 7.0, 7.5, 8.0, 8.5, 9.0, 9.2, 9.4, 9.6, 9.8, 9.9, 10.0];

// ── OAuth ───────────────────────────────────────────────────────────────────
// Two-layer cache ON PURPOSE. Module scope survives only while a lambda stays
// warm; Vercel runs many, and a cold one per request would mint a new token
// every time and hit eBay's OAuth rate limit long before the 5,000/day Browse
// limit. Firestore is the shared layer every instance reads.
let _memToken = null;   // { token, expiresAt }

async function getAppToken(db) {
  const now = Date.now();
  if (_memToken && _memToken.expiresAt > now + 60_000) return _memToken.token;

  if (db) {
    try {
      const snap = await db.collection('integrations').doc('ebay_token').get();
      const d = snap.exists ? snap.data() : null;
      if (d && d.token && d.expiresAt > now + 60_000) {
        _memToken = { token: d.token, expiresAt: d.expiresAt };
        return d.token;
      }
    } catch (e) { console.warn('[ebay] token cache read failed:', e.message); }
  }

  const id = (process.env.EBAY_CLIENT_ID || '').trim();
  const secret = (process.env.EBAY_CLIENT_SECRET || '').trim();
  if (!id || !secret) {
    const err = new Error('EBAY_CLIENT_ID / EBAY_CLIENT_SECRET not configured');
    err.code = 'no_keys';
    throw err;
  }
  const basic = Buffer.from(`${id}:${secret}`).toString('base64');
  const resp = await fetch(EBAY_OAUTH, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: `Basic ${basic}`
    },
    body: `grant_type=client_credentials&scope=${encodeURIComponent(SCOPE)}`
  });
  const text = await resp.text();
  if (!resp.ok) {
    const err = new Error(`eBay OAuth ${resp.status}: ${text.slice(0, 300)}`);
    err.code = 'oauth_failed';
    err.status = resp.status;
    throw err;
  }
  const j = JSON.parse(text);
  const expiresAt = now + ((j.expires_in || 7200) * 1000);
  _memToken = { token: j.access_token, expiresAt };
  if (db) {
    try {
      await db.collection('integrations').doc('ebay_token')
        .set({ token: j.access_token, expiresAt, updatedAt: new Date().toISOString() });
    } catch (e) { console.warn('[ebay] token cache write failed:', e.message); }
  }
  return j.access_token;
}

// ── parsing ─────────────────────────────────────────────────────────────────
// Proves slabbed AND extracts the grade in one pass. Deliberately strict:
//   "CGC 9.4"  "CBCS 8.5"  "PSA 10"  -> kept
//   "CGC graded"  "cgc ready"  "pressed for CGC"  -> rejected, no number
// A number is required, because a listing that merely mentions a grading
// company tells us nothing about condition.
const SLAB_RE = /\b(CGC|CBCS|PSA)\s*[:\-]?\s*(10(?:\.0)?|\d(?:\.\d)?)\b/i;

// ── REPRINTS AND FACSIMILES ────────────────────────────────────────────────
// Matt, 2026-11-12: "The more of a key a book is, the more likely it is that
// its listing is crowded with n-th printings or facsimile reprints. Filtering
// for CGC in the listing would weed out some, but not all. You'll still find
// facsimiles in CGC cases."
//
// That is exactly what made FF 1 come back at a $615 median. The GOLDEN RECORD
// reprints are the specific trap: 1966 reprints of JIM 83, ASM 1, Avengers 4
// and FF 1, slabbed by CGC, genuinely collectable, and selling in the low
// hundreds where the originals are five figures. They are indistinguishable
// from the real book by price band alone — only the title says so.
//
// Deliberately conservative. A false exclusion costs one listing out of fifty;
// a false INCLUSION drags the median toward a different book entirely, which
// is the failure actually observed. Terms that are ambiguous (a "variant", a
// "sketch cover") are NOT here — those are real copies of the real book.
const JUNK_RE = new RegExp([
  'facsimile', 'reprint', 'replica', 'reproduction', 'golden\\s*record',
  '(?:2nd|second|3rd|third|4th|fourth)\\s*print(?:ing)?',
  'lot\\s+of', 'set\\s+of', '\\bposter\\b', '\\bportfolio\\b',
  '\\bcanvas\\b', '\\bmagazine\\b', '\\bphotocopy\\b'
].join('|'), 'i');

export function isJunkListing(title) {
  return JUNK_RE.test(String(title || ''));
}

export function parseSlabGrade(title) {
  if (!title) return null;
  const m = String(title).match(SLAB_RE);
  if (!m) return null;
  const g = parseFloat(m[2]);
  if (!Number.isFinite(g) || g < 0.5 || g > 10) return null;
  return { company: m[1].toUpperCase(), grade: g };
}

export function median(nums) {
  if (!nums || !nums.length) return null;
  const a = nums.slice().sort((x, y) => x - y);
  const mid = a.length >> 1;
  return a.length % 2 ? a[mid] : +((a[mid - 1] + a[mid]) / 2).toFixed(2);
}

// Grade band, in LADDER RUNGS rather than numeric distance. One rung either
// side of 9.4 is 9.2-9.6; one rung either side of 4.5 is 4.0-5.0. Numeric
// distance would make those two mean different things.
export function bandFor(grade, rungs) {
  const i = LADDER.indexOf(grade);
  if (i === -1) {
    // Not a ladder value (a user-entered oddity). Fall back to numeric.
    return { lo: grade - rungs * 0.5, hi: grade + rungs * 0.5 };
  }
  return {
    lo: LADDER[Math.max(0, i - rungs)],
    hi: LADDER[Math.min(LADDER.length - 1, i + rungs)]
  };
}

export function summarise(items, grade) {
  const slabs = [];
  // `slabs` is also returned under `matched` when debug=1, so a wrong-looking
  // median can be explained by LOOKING at what matched instead of theorising
  // about it. That is how the first live call was diagnosed: FF 1 at 4.5 came
  // back with a median of $615 and a high of $20,900, and no real CGC 4.5
  // Fantastic Four #1 sells for $615 — so most of the band was something else.
  // Guessing at a filter without seeing the titles would have been a coin flip.
  for (const it of (items || [])) {
    const parsed = parseSlabGrade(it.title);
    if (!parsed) continue;
    if (isJunkListing(it.title)) continue;
    const price = parseFloat(
      (it.price && it.price.value) ||
      (it.currentBidPrice && it.currentBidPrice.value) || ''
    );
    if (!Number.isFinite(price) || price <= 0) continue;
    const cur = (it.price && it.price.currency) || 'USD';
    if (cur !== 'USD') continue;      // mixing currencies would be nonsense
    slabs.push({ grade: parsed.grade, company: parsed.company, price, title: it.title });
  }
  if (!slabs.length) return { n: 0, reason: 'no-slabbed-listings', matched: [] };

  // One rung either side first. Widen to two only if that is too thin, and
  // SAY SO — a widened band is a weaker statement and the UI shows it.
  for (const rungs of [1, 2]) {
    const b = bandFor(grade, rungs);
    const inBand = slabs.filter(s => s.grade >= b.lo && s.grade <= b.hi);
    if (inBand.length >= MIN_LISTINGS) {
      const prices = inBand.map(s => s.price);
      const med = median(prices);
      return {
        n: inBand.length,
        median: med,
        low: Math.min(...prices),
        high: Math.max(...prices),
        band: { lo: b.lo, hi: b.hi },
        widened: rungs > 1,
        grade,
        // SPREAD IS A DATA-QUALITY ALARM, not decoration. On a correctly
        // matched set of same-grade slabs the high should be a small multiple
        // of the median. When it is 30x, the band is full of DIFFERENT BOOKS
        // that happen to share a title and an issue number — a later volume's
        // #1, a reprint, a lot. The UI must not print a median flagged this
        // way as if it were trustworthy.
        spreadRatio: med > 0 ? +(Math.max(...prices) / med).toFixed(1) : null,
        suspect: med > 0 && (Math.max(...prices) / med) > 8,
        matched: inBand
      };
    }
  }
  return { n: 0, reason: 'too-few-in-band', slabbedFound: slabs.length, matched: slabs };
}

// ── handler ─────────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'method not allowed' });
  }
  // Signed-in users only. This spends our Browse quota (5,000/day) and there
  // is no reason for it to be open to the internet.
  const uid = await verifyUidFromAuthHeader(req);
  if (!uid) return res.status(401).json({ error: 'auth required' });

  const q = req.query || {};
  const title = String(q.title || '').trim();
  const issue = String(q.issue || '').trim();
  const grade = parseFloat(q.grade);
  // Optional. A four-digit publication year; anything else is ignored rather
  // than rejected, because a bad year should weaken the query, not 400 it.
  const year = /^(19|20)\d{2}$/.test(String(q.year || '').trim()) ? String(q.year).trim() : null;
  if (!title || !issue || !Number.isFinite(grade)) {
    return res.status(400).json({ error: 'title, issue and grade are required' });
  }

  const db = await getAdminDb();
  // The year is part of the cache key: a result fetched with a year filter is
  // a different answer from one fetched without, and serving one for the other
  // would be silently wrong.
  const key = `${title}|${issue}|${grade}|${year || ''}`.toLowerCase().replace(/[^a-z0-9|.\- ]/g, '').slice(0, 300);
  const docId = Buffer.from(key).toString('base64url').slice(0, 400);

  if (db) {
    try {
      const snap = await db.collection('ebay_asks').doc(docId).get();
      const d = snap.exists ? snap.data() : null;
      if (d && d.fetchedAt && (Date.now() - d.fetchedAt) < CACHE_HOURS * 3600_000) {
        return res.status(200).json({ ...d.result, fetchedAt: d.fetchedAt, cached: true });
      }
    } catch (e) { console.warn('[ebay] asks cache read failed:', e.message); }
  }

  let token;
  try {
    token = await getAppToken(db);
  } catch (e) {
    console.error('[ebay] token:', e.message);
    return res.status(e.code === 'no_keys' ? 500 : 502)
      .json({ error: 'ebay auth failed', code: e.code || null, detail: e.message.slice(0, 300) });
  }

  // CGC in the query, not a filter: eBay has no "is slabbed" filter, and the
  // word is in essentially every slab listing's title. SLAB_RE does the real
  // work on the way back.
  // YEAR IN THE QUERY. Matt's suggestion and it is the right one: "If I were
  // searching eBay and trying to filter out reprints, I'd include the year of
  // publication in the title search, which we have." A 1961 in the query
  // excludes most later-printing noise that no exclusion list would catch.
  // BUT it is a keyword match, so it also drops legitimate listings that
  // simply do not mention the year — common on moderns. So it NARROWS FIRST
  // and falls back: same shape as the grade band widening, and for the same
  // reason. Two calls worst case against a 5,000/day budget.
  async function browse(useYear) {
    const url = new URL(EBAY_SEARCH);
    url.searchParams.set('q', `${title} ${issue} CGC${(useYear && year) ? ' ' + year : ''}`);
    url.searchParams.set('limit', String(SEARCH_LIMIT));
    url.searchParams.set('filter', 'buyingOptions:{FIXED_PRICE}');
    const r = await fetch(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        'X-EBAY-C-MARKETPLACE-ID': 'EBAY_US',
        Accept: 'application/json'
      }
    });
    const text = await r.text();
    if (!r.ok) {
      const err = new Error(text.slice(0, 400));
      err.status = r.status;
      throw err;
    }
    return JSON.parse(text).itemSummaries || [];
  }

  let items = [], result, yearUsed = false;
  try {
    if (year) {
      items = await browse(true);
      result = summarise(items, grade);
      yearUsed = true;
      if (result.n < MIN_LISTINGS) {
        const wide = await browse(false);
        const wideResult = summarise(wide, grade);
        if (wideResult.n >= MIN_LISTINGS) { items = wide; result = wideResult; yearUsed = false; }
      }
    } else {
      items = await browse(false);
      result = summarise(items, grade);
    }
  } catch (e) {
    console.error('[ebay] browse', e.status || '', e.message);
    return res.status(502).json({ error: 'ebay search failed', status: e.status || null,
      detail: String(e.message).slice(0, 400) });
  }

  result.searched = items.length;
  result.yearUsed = yearUsed;
  // The matched listings are for DIAGNOSIS ONLY and never reach the app UI.
  // They are kept out of the cached document too — they are the bulky part and
  // nothing in production reads them.
  const matched = result.matched || [];
  delete result.matched;
  if (String(q.debug || '') === '1') {
    result.sample = matched.slice(0, 25).map(m => ({
      grade: m.grade, company: m.company, price: m.price,
      title: String(m.title || '').slice(0, 110)
    }));
  }
  const fetchedAt = Date.now();

  if (db) {
    try {
      await db.collection('ebay_asks').doc(docId)
        .set({ key, result, fetchedAt, title, issue, grade, year: year || null });
    } catch (e) { console.warn('[ebay] asks cache write failed:', e.message); }
  }
  return res.status(200).json({ ...result, fetchedAt, cached: false });
}
