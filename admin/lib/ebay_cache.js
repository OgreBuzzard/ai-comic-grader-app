// admin/lib/ebay_cache.js — v6.68
//
// WHAT USERS ACTUALLY SAW, not a fresh lookup.
//
// Matt: "I want to see what prices are being shown to users." So this reads the
// `ebay_asks` CACHE and nothing else. It never calls eBay. Two reasons that is
// the right design and not a shortcut:
//
//   1. A fresh call would answer a different question. The app shows a cached
//      figure for 24 hours; a live call from admin could show a different
//      number from the one on the user's screen and be no use for auditing.
//   2. The Browse API has a 5,000/day quota. One call per row of an admin list
//      would burn it on a page nobody is buying anything from.
//
// A book with no row here has simply never been looked up — that is a real and
// common state (the app only asks when a detail view opens), not an error.
//
// KEYED ON title|issue AND NOT ON THE CACHE DOC ID. The doc id is a base64 of
// "title|issue|grade|year" built in api/ebay_asks.js, and reproducing it here
// means two copies of a normalisation that must agree forever — including the
// year extraction, which admin and the app do with different helpers. Rebuild
// that key slightly differently and admin silently shows nothing while the user
// sees a price, which is the exact failure this page exists to catch. The cache
// doc carries title, issue, grade and year as plain fields, so match on those.

const norm = s => String(s == null ? '' : s).trim().toLowerCase().replace(/\s+/g, ' ');

// v6.72: keyed on GRADE too. Keyed on title|issue alone, every copy of a book
// showed whichever grade was looked up last - all nine Iron Man 55s in admin
// carried the 6.0 copy's $654. A row for a different grade is a different
// number, so a book with no row AT ITS OWN GRADE shows nothing.
const gnorm = g => { const n = parseFloat(g); return Number.isFinite(n) ? String(n) : ''; };
export const ebayKey = (title, issue, grade) => norm(title) + '|' + norm(issue) + '|' + gnorm(grade);

// Every cached ask, newest-first per book. Returns a Map of key -> entry.
// `limit` caps the read; the collection holds one doc per (book, grade, year)
// ever asked for, so it is small, but it is not bounded by anything structural.
export async function loadEbayAsks(db, limit = 5000) {
  const out = new Map();
  if (!db) return out;
  try {
    // v6.72: newest first. An unordered .limit() reads in doc-id order, so once
    // the collection outgrows the limit it is arbitrary which books drop out.
    const snap = await db.collection('ebay_asks').orderBy('fetchedAt', 'desc').limit(limit).get();
    snap.forEach(doc => {
      const d = doc.data() || {};
      if (!d.result) return;
      const k = ebayKey(d.title, d.issue, d.grade);
      const prev = out.get(k);
      // Newest wins. A book re-asked at a different grade has two rows; the
      // recent one is the one the user most likely saw.
      if (!prev || (d.fetchedAt || 0) > (prev.fetchedAt || 0)) {
        out.set(k, { ...d.result, fetchedAt: d.fetchedAt || 0, grade: d.grade, year: d.year || null });
      }
    });
  } catch (e) {
    console.warn('[admin-ebay] cache read failed:', e.message);
  }
  return out;
}

// The SAME suppression rules _ebayAsksRender uses in the app, so "shown" here
// means shown there. The difference is that admin is told WHY something is
// hidden — a suppressed median with a 31x spread is the most interesting row on
// the page and showing nothing would waste it.
export function ebayDisplay(e) {
  if (!e) return null;
  if (!e.n || !e.median) {
    return { shown: false, why: e.reason || 'no result', text: null, n: 0 };
  }
  if (e.suspect) {
    return { shown: false, why: 'spread ' + (e.spreadRatio != null ? e.spreadRatio + 'x' : 'high'),
             text: '$' + Math.round(e.median).toLocaleString(), n: e.n };
  }
  return { shown: true, why: null, text: '$' + Math.round(e.median).toLocaleString(),
           n: e.n, widened: !!e.widened, grade: e.grade != null ? e.grade : null };
}
