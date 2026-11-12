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
  for (const it of (items || [])) {
    const parsed = parseSlabGrade(it.title);
    if (!parsed) continue;
    const price = parseFloat(
      (it.price && it.price.value) ||
      (it.currentBidPrice && it.currentBidPrice.value) || ''
    );
    if (!Number.isFinite(price) || price <= 0) continue;
    const cur = (it.price && it.price.currency) || 'USD';
    if (cur !== 'USD') continue;      // mixing currencies would be nonsense
    slabs.push({ grade: parsed.grade, company: parsed.company, price });
  }
  if (!slabs.length) return { n: 0, reason: 'no-slabbed-listings' };

  // One rung either side first. Widen to two only if that is too thin, and
  // SAY SO — a widened band is a weaker statement and the UI shows it.
  for (const rungs of [1, 2]) {
    const b = bandFor(grade, rungs);
    const inBand = slabs.filter(s => s.grade >= b.lo && s.grade <= b.hi);
    if (inBand.length >= MIN_LISTINGS) {
      const prices = inBand.map(s => s.price);
      return {
        n: inBand.length,
        median: median(prices),
        low: Math.min(...prices),
        high: Math.max(...prices),
        band: { lo: b.lo, hi: b.hi },
        widened: rungs > 1,
        grade
      };
    }
  }
  return { n: 0, reason: 'too-few-in-band', slabbedFound: slabs.length };
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
  if (!title || !issue || !Number.isFinite(grade)) {
    return res.status(400).json({ error: 'title, issue and grade are required' });
  }

  const db = await getAdminDb();
  const key = `${title}|${issue}|${grade}`.toLowerCase().replace(/[^a-z0-9|.\- ]/g, '').slice(0, 300);
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
  const url = new URL(EBAY_SEARCH);
  url.searchParams.set('q', `${title} ${issue} CGC`);
  url.searchParams.set('limit', String(SEARCH_LIMIT));
  url.searchParams.set('filter', 'buyingOptions:{FIXED_PRICE}');

  let items = [], upstream = null;
  try {
    const r = await fetch(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        'X-EBAY-C-MARKETPLACE-ID': 'EBAY_US',
        Accept: 'application/json'
      }
    });
    const text = await r.text();
    if (!r.ok) {
      console.error('[ebay] browse', r.status, text.slice(0, 400));
      return res.status(502).json({ error: 'ebay search failed', status: r.status,
        detail: text.slice(0, 400) });
    }
    upstream = JSON.parse(text);
    items = upstream.itemSummaries || [];
  } catch (e) {
    console.error('[ebay] browse threw:', e.message);
    return res.status(502).json({ error: 'ebay search failed', detail: e.message.slice(0, 300) });
  }

  const result = summarise(items, grade);
  result.searched = items.length;
  const fetchedAt = Date.now();

  if (db) {
    try {
      await db.collection('ebay_asks').doc(docId)
        .set({ key, result, fetchedAt, title, issue, grade });
    } catch (e) { console.warn('[ebay] asks cache write failed:', e.message); }
  }
  return res.status(200).json({ ...result, fetchedAt, cached: false });
}
