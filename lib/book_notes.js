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
