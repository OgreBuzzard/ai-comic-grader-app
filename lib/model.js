// lib/model.js — SINGLE SOURCE OF TRUTH FOR THE GRADING MODEL
// =============================================================================
// WHY THIS FILE EXISTS
//
// The model id used to be a string literal repeated in SIX endpoints — assess,
// assess_deep, assess_full, assess_card, assess_insert, assess_coupon — 13
// occurrences in total. Changing "the model" meant finding all thirteen, and
// missing one left a half-migrated system where Main graded on one model and
// Deep on another. That is invisible in the UI and quietly poisons any
// calibration round, because the rows in the sheet would be a mix of two models.
//
// It is now declared once, here. To switch models, or to revert in a hurry from
// a convention floor, change PRIMARY_MODEL on the line below and redeploy.
// That is the whole operation.
//
// NOTE: the cheap identification pass (Haiku) is deliberately NOT tied to
// PRIMARY_MODEL. It does not grade; it reads a title off a cover. Leave it.
// =============================================================================

// ── THE ONE LINE ─────────────────────────────────────────────────────────────
// v5.24: Claude Opus 5.5, released 2026-09-23. $4/$20 vs Opus 5's $5/$25 — 20%
// cheaper both directions — and cache reads drop from $0.50 to $0.20/MTok,
// i.e. 10% of input to 5%. Deep caching is the heaviest read path, so the
// saving there is larger than the headline 20%.
// PREVIOUS: 'claude-opus-5' ($5/$25, launched 2026-07-24). Reverting is NOT
// just this string any more — see the K1 warning below.
// ── SHIPPING CONFIG: Opus 5.5 + K1 + X1, effort 'low' ───────────────────────
// CUT OVER 2026-10-11, after Session 22's full ablation programme. Opus 5 is
// the fallback, not the default. Read this whole block before reverting.
//
// WHY WE SWITCHED, AND IT IS NOT COST. The $24/month saving is noise and was
// explicitly ruled out of the argument. The reason is TAPE: Opus 5 named tape
// in 0 of 39 production grading passes, 0 of 42 eval passes, and 0 of 6 on a
// book with an obvious tape pull WITH the tape-pull instructions in front of
// it — 0 for 81. Opus 5.5 names it in roughly 13% of passes and hit 11/12 in a
// controlled probe. A grader that cannot see tape is wrong in a way a grader
// that reads half a point high is not.
//
// WHAT IT COSTS US. Opus 5.5 grades mid-range books about +0.70 higher than
// Opus 5 on the PSA books (same-round head-to-head, 14 books, 2026-10-06:
// +0.729). A user who graded a book at 4.5 before the cut-over and re-grades
// after it gets 5.5–6.0. On the PSA set 5.5's mean absolute error is 0.780
// against Opus 5's 0.639. This is a CONSIDERED TRADE made by Matt on
// 2026-10-06, not an oversight, and it is the reason K1 ships with it.
//
// THE COUNTER-EVIDENCE, WHICH IS NOT SMALL. On MFC 65, the only book in the
// calibration set with a known CGC grade (7.0, a $5,000 book):
//     Opus 5    5.00   -2.00
//     Opus 5.5  7.33   +0.33
// And on FF Annual 2, where 5.5 sees the tape pull, 5.5 grades a full point
// LOWER than Opus 5. The +0.70 is real on the PSA books; on books with
// structural damage 5.5 goes the other way. The PSA grades themselves are
// suspect on at least two books. More books with known CGC grades is the right
// next move, not more constant-tuning.
//
// THE SUPERSEDED MATRIX (2026-09-26) is below for the record. It is measured on
// the UNMODIFIED prompt and no longer describes what ships, because K1 moved
// 5.5 and nothing was ever re-measured for Opus 5:
//
//                          mean d    sd   +-0.5  +-1.0  spread  cost
//   Opus 5   effort low     +0.13   0.96   4/10   7/10   0.25   $0.095
//   Opus 5   effort medium  +0.59   1.05   3/10   7/10   0.22   $0.127
//   Opus 5.5 effort low     +0.76   0.62   3/10   7/10   0.52   $0.090
//   Opus 5.5 effort medium  +1.25   0.72   2/10   5/10   0.49   $0.107
//   Sonnet 5 effort low     +1.62   0.96   2/10   2/10   0.56   (cheapest)
//
// TWO PROMPT CHANGES SHIP WITH THIS FLIP AND ARE NOT SEPARABLE FROM IT:
//   K1  LIGHT-ACCUMULATION-ACROSS-FACES Front cap 37 -> 30, band 4.5–6.0.
//       Pulls 5.5's mid-grade books back down (+0.802 -> +0.702). The only one
//       of six arms that ever moved the number. REVERTING THE MODEL WITHOUT
//       REVERTING K1 WILL PUSH OPUS 5 TOO LOW — revert both or neither.
//   X1  referenceComparison must reconcile against the model's own defect list,
//       plus CHECK 1b defining a tape pull. Harmless on Opus 5 (it finds
//       nothing either way) but it is what makes 5.5's tape detection land.
// Both are promoted into api/assess.js and marked in lib/ablation.js.
//
// See shared/_LIBRARY/QUEUE_READ_THIS_FIRST.md and SESSION_22_HANDOFF.md.
// claude/MODEL_MATRIX.md and claude/REASONING_EFFORT_NEGATIVE_RESULT.md still
// assume Opus 5 ships — they are stale on the model, sound on effort.
export const PRIMARY_MODEL = 'claude-opus-5-5';      // $4/$20 — SHIPPING since 2026-10-11
// export const PRIMARY_MODEL = 'claude-opus-5';     // $5/$25 — fallback; revert K1 in api/assess.js too
// export const PRIMARY_MODEL = 'claude-sonnet-5';   // +1.62 grades high, only 2/10 within a full grade

// Effort for the MAIN pass (api/assess.js). Deep is set separately to 'medium'
// in api/assess_deep.js.
//
// DO NOT RAISE THIS. Tested on the frozen calibration set, 2026-09-26, on BOTH
// models. Going low -> medium moved mean bias by +0.46 on Opus 5 and +0.49 on
// Opus 5.5 - nearly the same amount, in the same direction, on every one of the
// 10 books with PSA truth. It is not a model quirk; more deliberation makes the
// grader more forgiving, and it costs latency and money to get there.
// See claude/REASONING_EFFORT_NEGATIVE_RESULT.md.
export const MAIN_EFFORT = 'low';
export const IDENTIFY_MODEL = 'claude-haiku-4-5-20251001';

// Per-token USD rates. Used for the cost figures written into the logs, so a
// missing entry here does not break grading — it just makes the recorded cost
// wrong, which is worse in its own way because it looks authoritative.
export const MODEL_RATES = {
  'claude-opus-5-5':            { in: 4  / 1e6, out: 20 / 1e6 },
  'claude-opus-5':              { in: 5  / 1e6, out: 25 / 1e6 },
  'claude-fable-5-1':           { in: 10 / 1e6, out: 50 / 1e6 },   // diagnostics only — never a grading candidate at this price
  'claude-fable-5':             { in: 10 / 1e6, out: 50 / 1e6 },
  'claude-opus-4-8':            { in: 5  / 1e6, out: 25 / 1e6 },
  'claude-opus-4-6':            { in: 5  / 1e6, out: 25 / 1e6 },
  'claude-sonnet-5':            { in: 2  / 1e6, out: 10 / 1e6 },
  'claude-sonnet-4-6':          { in: 3  / 1e6, out: 15 / 1e6 },
  'claude-haiku-4-5-20251001':  { in: 1  / 1e6, out: 5  / 1e6 },
};

// Falls back to the CURRENT primary's rates, not a stale hardcoded model, so an
// unknown id can never silently bill at an old price.
export function ratesFor(model) {
  return MODEL_RATES[model] || MODEL_RATES[PRIMARY_MODEL];
}
