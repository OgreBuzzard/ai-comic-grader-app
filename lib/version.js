// lib/version.js
export const ROBOGRADE_VERSION = '4.59';
// v4.59: public link overhaul — card public page renders the full card RoboGrade
// panel (shared buildCardDisplay) + card identity; comic + card public pages gain
// Photograder (lookup now exposes it) and drop the Enhanceable badge; disclaimer
// reworded ("...AI-generated condition assessment. It is not affiliated...").
// v4.58: card scoring reweighted to 50/20/20/10 (Surface/Corners/Edges/Centering,
// mirroring comics); concise severity-tagged card defects; 3-D corner orientation
// rule; centering always records L/R + T/B; Condition Assessment capped ~8 lines.
// v4.57: sharper mid-tier dial-back. v4.56 only moved the bias +0.57→+0.50 because
// the accumulation rules keyed on "widespread soiling"/color-breaks, so all-LOW
// wear (ASM 62: 4 light defects, Front 41 → grade 8.0 vs PSA 6.0) slipped through.
// New rule: light wear on 3+ of the four faces caps Front ≤37 and seats the grade
// in the Fine band (6.0–7.5), never 8.0+. Targeted to the 6–8 range; high-grade
// and Deep grading untouched.
// v4.56: mid-tier over-grade dial-back. v4.53's evidence standard swung too far —
// calibration showed +0.57 mean over-grade driven by 6.0–8.0 books (ASM 62 8.0 vs
// PSA 6.0, etc.). Added a counter-weight: visible accumulated light wear MUST be
// counted and seats a book in the 4.0–7.0 mid-band, without re-opening fabrication.
// HIGH-GRADE / Deep-assessment grading (the 9.4-cap fix) is deliberately untouched.
// v4.55: photograder object moved AHEAD of roboGrade in the output JSON and marked
// REQUIRED — Opus 5 was dropping it (last field), which is why the Photograder box
// stopped appearing. GRADING IS IDENTICAL to 4.54 (no scoring/defect rule change),
// so calibration comparisons across 4.54/4.55 hold.
// v4.54: (1) coverless-enforcement regex tightened — "no back cover damage/wear"
// no longer zeroes a clean cover's sub-score (ASM 55 back=0 bug). (2) Deep
// assessment: disproven/negligible initial defects are DELETED not kept at LOW,
// confirmations are never logged as defects, and a book with zero confirmed
// defects is graded on merit up to 9.8 instead of defaulting to 9.4.
// v4.53 (bundled prompt fixes over Opus-5 v4.51):
//  1. EVIDENCE STANDARD in Phase 1 — defects must be visibly present and
//     localizable; curbs Opus 5's fabrication of phantom edge/corner/spine wear
//     on clean high-grade books (v4.51 under-graded 9.0+ books ~1.8 grades).
//     Banded-wear summaries gated on visible wear; blackjack "count when unsure"
//     clarified to severity-uncertainty only, not presence-uncertainty.
//  2. Defect fields are descriptive only — no "pressing/cleaning candidate" or
//     any remediation advice in the defects array.
//  3. Page quality listed as a defect ONLY when below White, or tanning/foxing
//     or interior damage present; White+clean interiors emit no PQ entry.
