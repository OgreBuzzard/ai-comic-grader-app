// lib/book_notes.js
// Per-book grading notes that correct recurring MISREADS of a specific book's
// artwork or known production traits — things the grader tends to flag as a
// defect but which are intrinsic to the book. A matching note is injected into
// the assessment prompt BEFORE grading, so the correction reaches the model
// before it can (mis)score the trait.
//
// Disambiguation: the same issue number exists across reprints / limited /
// ongoing series, so entries are keyed by normalized title + issue + a YEAR
// RANGE. The note attaches only to the intended printing. Example below:
// Wolverine #1 of the 1988 ONGOING series gets the smoke-line note; the 1982
// four-issue LIMITED series #1 (a different book) does NOT. If the assessment
// request carries no usable year, a year-disambiguated note is skipped — better
// no note than the wrong printing's note.
//
// `appliesTo` lists the tiers whose pass actually LOOKS at the region the note
// is about, so a cover note isn't injected into the interior-only Full pass:
//   'main' — examines front / back / spine wide shots
//   'deep' — examines macro close-ups and hunts for NEW defects
//   'full' — examines INTERIOR pages only
//
// To add a note: copy an entry, set title / issue / yearRange, choose appliesTo,
// and write `note` as a direct instruction to the grader.

const NOTES = [
  {
    title: 'Wolverine',
    issue: '1',
    yearRange: [1987, 1991],            // 1988 ongoing series; excludes the 1982 limited series #1
    seriesLabel: 'Wolverine (1988 ongoing series)',
    appliesTo: ['main', 'deep'],        // a cover trait — not the interior-only Full pass
    note: 'There is a vertical smoke line running down the front cover that is part of the printed cover artwork. Do NOT read it as a large crease, spine defect, or any other condition flaw — it is intrinsic to the art, not damage.'
  },
  {
    title: 'Incredible Hulk',
    issue: '340',
    seriesLabel: 'Incredible Hulk #340 (1988, McFarlane Hulk vs. Wolverine cover)',
    appliesTo: ['main', 'deep'],
    note: 'The lower-left region of the front cover carries extremely dense, high-detail line work (Todd McFarlane art style). It frequently reads as a soft, non-color-breaking bend roughly 1 inch long. That is printed artwork, NOT damage. Do NOT record a bend, crease, or any condition defect in the lower-left cover region on the basis of that line work.'
  },
  {
    title: 'Amazing Spider-Man',
    issue: '238',
    seriesLabel: 'Amazing Spider-Man #238 (1983, first Hobgoblin)',
    appliesTo: ['main', 'deep'],
    note: 'Two intrinsic cover traits on this book, and NEITHER belongs anywhere in your output. (1) The artist signatures printed on the cover in the lower-left area near the UPC box are part of the printed ARTWORK — not handwriting, ink, marker, or an added marking. Do NOT record them as a defect, do NOT assign a severity, and do NOT mention them in the written assessment at all. Printed artist signatures appear on most covers and are not noteworthy; calling them out only confuses the reader. (2) The horizontal lines across the center of the cover are part of the artwork (Hobgoblin tearing Spider-Man\'s mask). Do NOT read them as horizontal bends, creases, or fold lines. Neither trait is damage.'
  },
  {
    title: 'Uncanny X-Men',
    issue: '142',
    seriesLabel: 'Uncanny X-Men #142 (1981, Days of Future Past pt. 2)',
    appliesTo: ['main', 'deep'],
    note: 'A horizontal line near the center of the front cover is a printed laser-blast streak that is part of the artwork. Do NOT read it as a bend, crease, or fold. It is intrinsic to the art, not damage.'
  },
  {
    title: 'Weird Science',
    issue: '20',
    seriesLabel: 'Weird Science #20 (EC)',
    appliesTo: ['main', 'deep'],
    note: 'The front cover art includes a glass-domed sleep chamber whose edge runs roughly horizontally across the cover. Do NOT read that edge as a bend, crease, or fold — it is a printed element of the artwork, not damage.'
  },
  {
    title: 'Spider-Man and His Amazing Friends',
    issue: '1',
    yearRange: [1981, 1982],            // Dec 1981 cover date
    seriesLabel: 'Spider-Man and His Amazing Friends #1 (Dec 1981)',
    appliesTo: ['main', 'deep'],
    note: 'The artist signatures on the front cover (John Romita Jr. and Al Milgrom) are PRINTED as part of the cover art. Do NOT read them as writing, ink, marker, or any added marking, and do NOT record them as a defect of any severity.'
  },
  {
    title: 'Transformers',
    issue: '16',
    yearRange: [2024, 2026],            // Skybound/Energon Universe run; #16 cover-dated Jan 2025
    seriesLabel: 'Transformers #16 (Skybound, Jan 2025)',
    appliesTo: ['main', 'deep'],
    note: 'The "spider crease" pattern and the scratch-like marks in the lower-right corner of the front cover are printed artwork. Do NOT read them as a crease, spider crease, scratches, abrasion, or surface damage of any kind.'
  },
  {
    title: 'Batman',
    issue: '227',
    appliesTo: ['main', 'deep'],
    note: 'The lower portion of the front cover art depicts smoke and atmospheric haze that is part of the printed artwork. Do NOT read it as soiling, staining, a substance, or any surface-condition defect. It is intrinsic to the art, not damage.'
  },
  {
    title: 'New Teen Titans',
    issue: '32',
    appliesTo: ['main', 'deep'],
    note: 'A marking on the front cover left edge, mid-lower area, is a printed artist signature that is part of the cover artwork. Do NOT read it as owner writing, an added signature, ink, or a defect, and do NOT record it as a Creator signature. It is printed art, present on every copy.'
  },
  {
    title: 'Justice League of America',
    issue: '202',
    appliesTo: ['main', 'deep'],
    note: 'A small code printed on the front cover left edge — a pencil-style "G-869", roughly 1/2 inch — is a printed production/distribution code that is part of the cover and appears on many copies. Do NOT read it as owner writing, an added signature, or a defect, and do NOT assign a severity.'
  },
  {
    title: 'Weird War Tales',
    issue: '52',
    appliesTo: ['main', 'deep'],
    note: 'A yellow "C-382" notation on the front cover, lower left near the spine, is a printed production/distribution code that is part of the cover. Do NOT read it as owner writing, an added signature, a stain, or a defect, and do NOT assign a severity.'
  },
  {
    title: 'Amazing Spider-Man',
    issue: '346',
    appliesTo: ['main', 'deep'],
    note: 'Two intrinsic cover traits, and NEITHER is damage. (1) The pen-line marks in the left/center black field (2-3 lines, several inches) are printed artist signatures that are part of the cover artwork — do NOT record them as writing on the cover, do NOT record them as a Creator signature, and do NOT assign a severity. (2) The scattered small white marks across the black field are part of the printed art (starfield/texture), NOT scuffing, color-breaks, or surface abrasion. Do NOT flag them as defects.'
  },
  {
    title: 'Avengers',
    issue: '350',
    appliesTo: ['main', 'deep', 'full'],
    note: 'A roughly 1/4" band of apparent tanning running the length of the front-cover OUTER edge is actually the visible edge of a printed FOLD-OUT page, not paper tanning or discoloration. Do NOT record it as tanning, toning, a stain, or any condition defect — it is intrinsic to the book\'s construction, not damage.'
  }
];

function norm(s) {
  return String(s == null ? '' : s).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}
function normIssue(n) {
  return String(n == null ? '' : n).trim().replace(/^#/, '').replace(/^0+(?=\d)/, '');
}
function coerceYear(y) {
  if (typeof y === 'number' && y > 1900) return y;
  const n = Number(y);
  return Number.isFinite(n) && n > 1900 ? n : null;
}

// Returns the note STRING for a matching book + tier, or null. `tier` is one of
// 'main' | 'deep' | 'full'; pass it so a note only fires for the tiers that look
// at the relevant region.
export function getBookNote(title, issueNumber, issueYear, tier) {
  const t = norm(title);
  const iss = normIssue(issueNumber);
  if (!t || !iss) return null;
  const yr = coerceYear(issueYear);
  for (const n of NOTES) {
    if (norm(n.title) !== t) continue;
    if (normIssue(n.issue) !== iss) continue;
    if (tier && Array.isArray(n.appliesTo) && !n.appliesTo.includes(tier)) continue;
    if (n.yearRange) {
      if (yr == null) continue;                         // can't disambiguate the printing → skip
      if (yr < n.yearRange[0] || yr > n.yearRange[1]) continue;
    }
    return n.note;
  }
  return null;
}
