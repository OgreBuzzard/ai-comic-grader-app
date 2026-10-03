// lib/defect_index.js
// Compact defect-impact index distilled from the CGC "Index of Defects" chart.
//
// For each defect: [yellowStart, redStart] on the CGC grade scale.
//   below yellowStart      → GREEN  : minimal impact; the book holds its grade.
//   yellowStart..redStart  → YELLOW : impact scales with the defect's severity.
//   redStart and above     → RED    : significant; the defect caps/reduces the grade.
//
// Read it the way the chart intends (inverse): a given defect matters MOST on a
// book that would otherwise grade at or above its redStart, and barely matters on
// a book already below its yellowStart. Example — distribution ink [5.0, 9.0]:
// it does little to a 4.5 book but significantly caps a 9.x book.
//
// Structural defects that cap the grade low regardless (missing piece, spine
// split, missing page/wrap) carry a very low redStart.

export const DEFECT_INDEX = {
  // chart order (top → bottom) for easy row-by-row verification
  "distribution ink":      [5.0, 9.0],
  "stress lines":          [5.0, 8.0],
  "bend":                  [5.0, 7.0],
  "stamp":                 [8.0, 9.0],
  "printer tear":          [7.5, 9.0],
  "soiling":               [7.0, 9.0],
  "bindery chip":          [7.0, 8.0],
  "bindery tear":          [7.0, 8.0],
  "crease":                [2.0, 4.0],
  "stain":                 [0.5, 2.5],
  "printer hole":          [8.0, 9.0],
  "rust stains":           [7.5, 9.0],
  "erasure mark":          [6.0, 8.0],
  "marvel tears":          [6.0, 8.0],
  "shadow":                [6.0, 8.0],
  "fingerprints":          [5.0, 8.0],
  "staple rust":           [4.0, 6.0],
  "staple tears":          [4.0, 6.0],
  "foxing":                [4.0, 6.0],
  "tanning":               [4.0, 6.0],
  "writing":               [4.0, 6.0],
  "tear":                  [2.0, 4.0],
  "missing piece cover":   [0.5, 0.5],
  "fade":                  [3.0, 7.0],
  "marvel chipping":       [4.0, 6.0],
  "spine roll":            [3.0, 5.0],
  "tape stain":            [2.0, 5.0],
  "spine split":           [0.5, 1.8],
  "sticker":               [7.0, 8.5],
  "name written on cover": [7.0, 9.0],
  "staple detached":       [4.0, 6.0],
  "tape":                  [2.0, 4.0],
  "staple holes":          [4.0, 5.5],
  "detached wrap":         [4.5, 5.5],
  "staple extra":   [4.0, 5.5],
  "detached page":         [2.5, 4.0],
  "staple removed":        [2.0, 3.5],
  "missing piece interior":[0.5, 2.0],
  "detached cover":        [2.0, 3.0],
  "missing page/wrap":     [0.5, 0.5],
};

// Terse single-block rendering for prompt injection. Keeps tokens minimal:
// "<defect> <yellowStart>/<redStart>", semicolon-separated, with a one-line legend.
export function defectIndexPromptBlock() {
  const legend =
    "DEFECT IMPACT INDEX (CGC). Each entry is <yellow>/<red>: the defect is minor " +
    "at/below <yellow>, severity-dependent between, and significant at/above <red> " +
    "— i.e. it caps or reduces a book that would otherwise grade at or above <red>. " +
    "Use only to sanity-check the ceiling for defects you actually observe.";
  const lines = Object.entries(DEFECT_INDEX)
    .map(([k, [y, r]]) => `${k} ${y}/${r}`)
    .join("; ");
  return legend + "\n" + lines;
}

// ── ALIASES (2026-10-02, Matt) ──────────────────────────────────────────────
// The index uses CGC's vocabulary. The model emits its own, and a strict string
// match across every eval round so far paired only 47% of reported defects to a
// row — which Claude first reported as a COVERAGE HOLE. It is not. Matt:
// "I'm certain all the defects you just listed map to defects in that matrix
// under different names. I think we're just being too strict in the wording."
//
// He is right, and it matters: edge wear, corner wear and spine wear are the
// three most-reported defect types in the whole eval corpus (213 / 175 / 97
// mentions) and they dominate exactly the 4.0–8.0 band where grading goes wrong.
// If the model cannot find their row, the index constrains nothing there.
//
// CONFIRMED BY MATT:
//   edge wear    -> marvel tears, marvel chipping   ("Same thing.")
//   spine stress -> stress lines
//   spine wear   -> spine ticks, which is the same defect; the chart has no
//                   "spine ticks" row, so stress lines is the nearest row
//
// CORNER WEAR — RESOLVED 2026-10-03, and the answer is "no row, on purpose".
//   Matt proposed bindery chip / bindery tear, reasoning from their 8.0–9.8 red
//   range. Rejected, for two reasons that point the same way:
//
//   1. Those rows are [7.0, 8.0] — GREEN BELOW 7.0. Mapping corner wear onto them
//      would tell the model corner wear is irrelevant under 7.0, which is the
//      exact band this whole effort is trying to raise defect load in, and corner
//      wear is the second-most-reported defect in the corpus (175 mentions). It
//      would make the problem worse.
//   2. Bindery defects are MANUFACTURING, and api/assess.js already excuses them
//      as such ("manufacturing piece-out (bindery, Marvel, or printer chip)
//      allowed; no handling-caused missing piece"). That is why they only bite at
//      8.0+: a trimming flaw costs nothing at 5.0 but does when you are claiming
//      9.4. Corner blunting is handling damage and behaves differently.
//
//   Corner wear is not missing from the system — it is in the other half of it.
//   lib/grade_definitions.js mentions corners 15 times across the CGC tier
//   descriptions. That is the division of labour on CGC's own page: this index
//   covers discrete named events, the grade ladder carries condition-of-the-book
//   wear. Matt still wants to check the book itself on what "bindery" covers.
//
//   (The chart prints "bindary"; this file uses the correct "bindery". Whoever
//   converted it fixed the typo silently — noted so nobody "corrects" it back.)
//
// This is rendered ONLY inside the S1 prompt variant (lib/ablation.js) so the
// live prompt is unchanged until the arm has been measured.
export const DEFECT_ALIASES = {
  "marvel tears":    ["edge wear", "edge chipping", "edge tear"],
  "marvel chipping": ["edge wear", "edge chipping", "chipping"],
  "stress lines":    ["spine stress", "spine stress lines", "spine wear", "spine ticks", "spine tick"],
  "missing piece cover": ["missing piece", "piece out", "paper loss", "chip out"],
  "tape stain":      ["tape residue"],
  "spine split":     ["spine separation"],
  "staple detached": ["staple pull", "popped staple"],
  "rust stains":     ["staple rust migration"],
};

// "<row> also covers: a, b, c" lines, for prompt injection.
export function defectAliasPromptBlock() {
  return Object.entries(DEFECT_ALIASES)
    .map(([row, alts]) => `${row} also covers: ${alts.join(', ')}`)
    .join('; ');
}
