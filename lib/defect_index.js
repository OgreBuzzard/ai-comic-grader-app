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
  "bindary chip":          [7.0, 8.0],
  "bindary tear":          [7.0, 8.0],
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
  "staple extra (a.m.)":   [4.0, 5.5],
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
