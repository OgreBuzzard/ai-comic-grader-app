// lib/coupon_index.js  —  books that commonly have a coupon / value-stamp /
// pin-up cut or torn out (the "Qualified" case CGC flags with a green label).
//
// When an item on this index is assessed, the app adds ONE extra image slot
// asking for a photo of the specific page where the often-removed piece lives.
// The Coupon assessment (1 credit) then checks present vs removed:
//   • present  → no change
//   • removed  → −5 to the Interior subscore, "coupon removed" in the printing
//                field, and the Predicted-Grade box is colored GREEN (Qualified)
//                instead of the usual blue.
//
// PRIMARY SOURCE = Marvel Value Stamps. Marvel bound a collectible stamp into an
// interior page of most Marvel titles cover-dated ~1974–1976 (Series A 1974–75,
// Series B 1975–76). Collectors cut them out, which "qualifies" the book. The
// highest-impact example by far is Incredible Hulk #181 (Wolverine's 1st full
// appearance) — a cut stamp there is a big value hit, so it's the flagship demo.
//
// This is a SEED list; Matt curates/expands. Each entry names the page to shoot
// and what's removable. `page` is the guidance shown in the new image slot.

export const COUPON_BOOKS = [
  {
    title: 'Incredible Hulk',
    issue: '181',
    yearRange: [1974, 1974],           // Nov 1974
    item: 'Marvel Value Stamp',
    page: 'the interior page carrying the Marvel Value Stamp (the stamp is often cut out)',
  },
  {
    title: 'Uncanny X-Men',
    issue: '8',
    item: 'coupon / pin-up (VERIFY exact piece + page)',
    page: 'the interior page with the removable coupon/pin-up',
  },
  // Expansion candidates (Matt to confirm issue-by-issue): other 1974–1976
  // Marvel Value Stamp keys (e.g. high-grade/high-pop ASM, FF, Avengers, X-Men,
  // Hulk of that window), and famous pull-out pin-ups/posters.
];

const _nt = s => !s ? '' : String(s).trim().replace(/\s+/g, ' ').replace(/^the\s+/i, '').toLowerCase();
const _ni = s => s == null ? '' : String(s).trim().replace(/^#/, '').replace(/^0+(?=\d)/, '');

// Returns the coupon entry for a title+issue, or null. Use to decide whether to
// add the extra image slot + enable the Coupon assessment.
export function couponEntry(title, issue) {
  const t = _nt(title), i = _ni(issue);
  if (!t || !i) return null;
  return COUPON_BOOKS.find(e => _nt(e.title) === t && _ni(e.issue) === i) || null;
}
