// lib/insert_index.js  —  Mark Jewelers / Diamond Sales insert candidate index
//
// Mark Jewelers inserts (and the earlier Diamond Sales inserts) were advertising
// cards bound into the CENTER of comics distributed to U.S. military bases
// (PX/commissary copies), roughly 1971–1991. Only a small slice of the print run
// (~3–5%) carried one, so a verified insert is a scarce, desirable variant.
//
// This is a CANDIDATE index — books whose era/title make an insert POSSIBLE. It
// does NOT assert a given copy has one; that's what the Insert assessment
// verifies (interior insert spread + the insert visible in the closed book with
// the correct front cover). Matt curates/expands this list.
//
// Seed list = the high-population titles most collected from this window: the
// top ~12 Marvel + top ~12 DC ongoing titles. ASM is the flagship example.

export const INSERT_ERA = [1971, 1991]; // approximate outer bounds; refine as we learn

// Titles that ran through the insert era and are commonly collected. yearRange
// can be narrowed per title later. `insertTypes` is what the assessment may
// stamp into the printing field when verified.
export const INSERT_TITLES = [
  // ── Marvel ──
  { title: 'Amazing Spider-Man',        yearRange: [1971, 1991] },
  { title: 'Spectacular Spider-Man',    yearRange: [1976, 1991] },
  { title: 'Uncanny X-Men',             yearRange: [1971, 1991] }, // "X-Men" pre-1991 normalizes to this
  { title: 'Fantastic Four',            yearRange: [1971, 1991] },
  { title: 'Avengers',                  yearRange: [1971, 1991] },
  { title: 'Incredible Hulk',           yearRange: [1971, 1991] },
  { title: 'Iron Man',                  yearRange: [1971, 1991] },
  { title: 'Thor',                      yearRange: [1971, 1991] },
  { title: 'Captain America',           yearRange: [1971, 1991] },
  { title: 'Daredevil',                 yearRange: [1971, 1991] },
  { title: 'Conan the Barbarian',       yearRange: [1971, 1991] },
  { title: 'Star Wars',                 yearRange: [1977, 1986] },
  // ── DC ──
  { title: 'Batman',                    yearRange: [1971, 1991] },
  { title: 'Detective Comics',          yearRange: [1971, 1991] },
  { title: 'Superman',                  yearRange: [1971, 1991] },
  { title: 'Action Comics',             yearRange: [1971, 1991] },
  { title: 'Justice League of America', yearRange: [1971, 1987] },
  { title: 'The Flash',                 yearRange: [1971, 1985] },
  { title: 'Green Lantern',             yearRange: [1971, 1988] },
  { title: 'Wonder Woman',              yearRange: [1971, 1986] },
  { title: 'New Teen Titans',           yearRange: [1980, 1988] },
  { title: 'Superboy',                  yearRange: [1971, 1984] },
  { title: "World's Finest Comics",     yearRange: [1971, 1986] },
  { title: 'The Brave and the Bold',    yearRange: [1971, 1983] },
];

const _nt = s => !s ? '' : String(s).trim().replace(/\s+/g, ' ').replace(/^the\s+/i, '').toLowerCase();

// Could this title+year plausibly carry a Mark Jewelers / Diamond Sales insert?
export function couldHaveInsert(title, issueYear) {
  const t = _nt(title);
  const y = parseInt(issueYear, 10);
  if (!t || !isFinite(y)) return false;
  const hit = INSERT_TITLES.find(e => _nt(e.title) === t);
  if (!hit) return false;
  const [lo, hi] = hit.yearRange || INSERT_ERA;
  return y >= lo && y <= hi;
}
