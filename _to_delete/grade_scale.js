// lib/grade_scale.js
// The legitimate CGC/PSA grade ladder, and the snap that keeps every grade we
// emit on it.
//
// Why this exists: the model writes a grade as free text. Nothing downstream
// forced that text onto a real position, so a value like 9.5 — which neither
// CGC nor PSA issues — could reach the client and be saved on an item
// (observed on RG-ID TKRHZY, Secret Wars #8, Oct 16 2026: PG 9.5). The clamps
// in place only bounded the RANGE (0.5–9.9); they never checked membership.
//
// Tie-break is DOWN by design: 9.5 snaps to 9.4, not 9.6. Handing a user a
// grade higher than the evidence supports is the costlier error — it sets a
// resale expectation the book will not meet at the grading service.
//
// Kept separate from grade_definitions.js so the hot assessment paths can
// import the snap without pulling in the full per-grade definition text.
// grade_definitions.js re-exports CGC_GRADE_SCALE from here — one source.

export const CGC_GRADE_SCALE = ['0.5', '1.0', '1.5', '1.8', '2.0', '2.5', '3.0', '3.5', '4.0', '4.5', '5.0', '5.5', '6.0', '6.5', '7.0', '7.5', '8.0', '8.5', '9.0', '9.2', '9.4', '9.6', '9.8', '9.9', '10.0'];

const SCALE_NUM = CGC_GRADE_SCALE.map(s => parseFloat(s));
// Hundredths, as integers. Comparing in this space removes the float noise
// that made 9.3 snap UP to 9.4 (|9.3-9.4| computes smaller than |9.3-9.2| in
// IEEE754) and defeated the round-down tie-break. Hundredths rather than
// tenths so a two-decimal input lands on its true midpoint: 9.85 is an exact
// tie between 9.8 and 9.9 and must round DOWN, which pre-rounding to tenths
// (Math.round(98.5) = 99) would have silently turned into a round UP.
const SCALE_HUNDREDTHS = SCALE_NUM.map(g => Math.round(g * 100));

// Returns a string like '9.4', or null when the input is not a number.
// The scale is ascending and the comparison is strict `<`, so an exact tie
// keeps the LOWER grade.
export function snapToCgcGrade(value) {
  const n = parseFloat(value);
  if (!Number.isFinite(n)) return null;
  const t = Math.round(n * 100);
  let bestIdx = 0;
  let bestD = Math.abs(t - SCALE_HUNDREDTHS[0]);
  for (let i = 1; i < SCALE_HUNDREDTHS.length; i++) {
    const d = Math.abs(t - SCALE_HUNDREDTHS[i]);
    if (d < bestD) { bestIdx = i; bestD = d; }
  }
  return SCALE_NUM[bestIdx].toFixed(1);
}

// True when `value` is already an exact ladder position.
export function isValidCgcGrade(value) {
  const n = parseFloat(value);
  if (!Number.isFinite(n)) return false;
  return SCALE_NUM.some(g => Math.abs(g - n) < 1e-9);
}
