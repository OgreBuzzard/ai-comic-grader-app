// lib/insert_list.js  —  Mark Jewelers / Diamond Sales insert index.
//
// Mark Jewelers inserts (and the earlier Diamond Sales inserts) were advertising
// cards bound into the CENTER of comics distributed to U.S. military bases
// (PX/commissary copies), roughly 1971-1991. Only a small slice of the print run
// (~3-5%) carried one, so a verified insert is a scarce, desirable variant.
//
// Two layers here:
//   1. INSERT_BOOKS - CONFIRMED specific issues reported to carry an insert
//      (curated from collector-supplied lists). Matched by title + issue, with
//      optional per-entry `aliases` for alternate volume/title spellings.
//   2. INSERT_TITLES - a broader CANDIDATE index: titles whose era makes an
//      insert POSSIBLE. Used as a softer "could have one" hint.
//
// Titles use the app's canonical (post-normalizeTitle) spelling so they match
// stored book records; `aliases` cover ComicVine/volume variants. Matching uses
// the SAME normalization as the app's value-keys (lowercase, strip leading
// "the", collapse spaces; issue: strip "#" and leading zeros).
//
// Neither layer asserts a given COPY has an insert; that's what the Insert
// assessment verifies with two photos: (a) the insert itself, and (b) the top
// edge of the closed book showing the correct cover AND the insert protruding
// above the pages, proving the insert belongs to the book being graded.

export const INSERT_ERA = [1971, 1991]; // approximate outer bounds; refine as we learn

// Bump when curating; make-indexes.mjs stamps this into insert_index.json.
export const INSERT_INDEX_VERSION = '1.0.0';

// -- CONFIRMED specific issues (title + volume + issue) --
export const INSERT_BOOKS = [
  { title: 'Amazing Spider-Man',                          vol: 1,     issue: '154' },
  { title: 'Amazing Spider-Man',                          vol: 1,     issue: '191' },
  { title: 'Amazing Spider-Man',                          vol: 1,     issue: '258' },
  { title: 'Amazing Spider-Man',                          vol: 1,     issue: '322' },
  { title: 'Amazing Spider-Man',                          vol: 1,     issue: '326' },
  { title: 'Daredevil',                                   vol: 1,     issue: '124' },
  { title: 'Daredevil',                                   vol: 1,     issue: '148' },
  { title: 'Doctor Strange',                              vol: 1,     issue: '41' },
  { title: 'Doctor Strange',                              vol: 1,     issue: '50' },
  { title: 'Doctor Strange',                              vol: 1,     issue: '51' },
  { title: 'Fantastic Four',                              vol: 1,     issue: '302' },
  { title: 'Fury of Firestorm',                           vol: 2,     issue: '22', aliases: ['The Fury of Firestorm', 'The Fury of Firestorm: The Nuclear Man'] },
  { title: 'Green Lantern',                               vol: 2,     issue: '112' },
  { title: 'Green Lantern',                               vol: 2,     issue: '117' },
  { title: 'Marvel\'s Greatest Comics',                   vol: null,  issue: '89', aliases: ['Marvels Greatest Comics'] },
  { title: 'Peter Parker: The Spectacular Spider-Man',    vol: 1,     issue: '46', aliases: ['Peter Parker, The Spectacular Spider-Man', 'The Spectacular Spider-Man', 'Spectacular Spider-Man'] },
  { title: 'Peter Parker: The Spectacular Spider-Man',    vol: 1,     issue: '47', aliases: ['Peter Parker, The Spectacular Spider-Man', 'The Spectacular Spider-Man', 'Spectacular Spider-Man'] },
  { title: 'Saga of the Swamp Thing',                     vol: 2,     issue: '6', aliases: ['The Saga of the Swamp Thing', 'Saga of Swamp Thing', 'Swamp Thing'] },
  { title: 'Tomb of Dracula',                             vol: 1,     issue: '55' },
  { title: 'Web of Spider-Man',                           vol: 1,     issue: '55' },
  { title: 'Werewolf by Night',                           vol: 1,     issue: '12' },
  { title: 'Werewolf by Night',                           vol: 1,     issue: '19' },
];

// -- CANDIDATE index: titles that ran through the insert era --
export const INSERT_TITLES = [
  // Marvel
  { title: 'Amazing Spider-Man',        yearRange: [1971, 1991] },
  { title: 'New Mutants',               yearRange: [1983, 1991] },
  { title: 'Uncanny X-Men',             yearRange: [1971, 1991] },
  { title: 'Fantastic Four',            yearRange: [1971, 1991] },
  { title: 'Avengers',                  yearRange: [1971, 1991] },
  { title: 'Incredible Hulk',           yearRange: [1971, 1991] },
  { title: 'Iron Man',                  yearRange: [1971, 1991] },
  { title: 'Thor',                      yearRange: [1971, 1991] },
  { title: 'Captain America',           yearRange: [1971, 1991] },
  { title: 'Daredevil',                 yearRange: [1971, 1991] },
  { title: 'Marvel Team-Up',            yearRange: [1972, 1985] },
  { title: 'Marvels Greatest Comics',   yearRange: [1971, 1981] },
  // DC
  { title: 'Batman',                    yearRange: [1971, 1991] },
  { title: 'Detective Comics',          yearRange: [1971, 1991] },
  { title: 'Superman',                  yearRange: [1971, 1991] },
  { title: 'Action Comics',             yearRange: [1971, 1991] },
  { title: 'Justice League of America', yearRange: [1971, 1987] },
  { title: 'The Flash',                 yearRange: [1971, 1985] },
  { title: 'Adventure Comics',          yearRange: [1971, 1983] },
  { title: 'Wonder Woman',              yearRange: [1971, 1986] },
  { title: 'Kamandi',                   yearRange: [1972, 1978] },
  { title: 'Superboy',                  yearRange: [1971, 1984] },
  { title: "Ghosts",                    yearRange: [1971, 1982] },
  { title: 'The Shadow',                yearRange: [1973, 1975] },
];

const _nt = s => !s ? '' : String(s).trim().replace(/\s+/g, ' ').replace(/^the\s+/i, '').toLowerCase();
const _ni = s => s == null ? '' : String(s).trim().replace(/^#/, '').replace(/^0+(?=\d)/, '');

// Exact confirmed-issue lookup. Returns the INSERT_BOOKS entry or null. Checks
// each entry's title AND its aliases. Pass an optional vol to disambiguate
// titles that exist in more than one volume.
export function insertEntry(title, issue, vol) {
  const t = _nt(title), i = _ni(issue);
  if (!t || !i) return null;
  const titleHit = e => _nt(e.title) === t || (e.aliases || []).some(a => _nt(a) === t);
  const matches = INSERT_BOOKS.filter(e => _ni(e.issue) === i && titleHit(e));
  if (!matches.length) return null;
  if (vol != null) {
    const v = parseInt(vol, 10);
    const byVol = matches.find(e => e.vol === v);
    if (byVol) return byVol;
  }
  return matches[0];
}

// Could this title+year plausibly carry a Mark Jewelers / Diamond Sales insert?
// (Candidate-index check; use insertEntry() first for a confirmed hit.)
export function couldHaveInsert(title, issueYear) {
  const t = _nt(title);
  const y = parseInt(issueYear, 10);
  if (!t || !isFinite(y)) return false;
  const hit = INSERT_TITLES.find(e => _nt(e.title) === t);
  if (!hit) return false;
  const [lo, hi] = hit.yearRange || INSERT_ERA;
  return y >= lo && y <= hi;
}

// The two camera-slot directions for an insert book. Returns an array of
// { key, label, hint }: slot 1 = the insert itself; slot 2 = the top edge of
// the closed book with the cover and the protruding insert both in frame.
export function insertSlots() {
  return [
    {
      key: 'insert_spread',
      label: 'Insert - the card/spread',
      hint: 'Photograph the Mark Jewelers insert itself (the full ad card/spread) so its condition can be assessed.',
    },
    {
      key: 'insert_verify',
      label: 'Insert - top edge + cover',
      hint: 'Stand the closed comic up and shoot the top edge so the front cover is readable AND the insert is visible sticking up above the interior pages, proving the insert belongs to this exact book.',
    },
  ];
}
