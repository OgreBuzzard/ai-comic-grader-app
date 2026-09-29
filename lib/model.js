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
// PREVIOUS: 'claude-opus-5' ($5/$25, launched 2026-07-24). Revert to that
// string if 5.5 grades worse — nothing else needs to change.
// ── SHIPPING CONFIG: Opus 5 at effort 'low' ─────────────────────────────────
//
// Five rounds on the frozen 1200px calibration set (12 books x 3 reps), all at
// true client parity. This is the complete matrix as of 2026-09-26:
//
//                          mean d    sd   +-0.5  +-1.0  spread  cost
//   Opus 5   effort low     +0.13   0.96   4/10   7/10   0.25   $0.095  <- SHIPPING
//   Opus 5   effort medium  +0.59   1.05   3/10   7/10   0.22   $0.127
//   Opus 5.5 effort low     +0.76   0.62   3/10   7/10   0.52   $0.090
//   Opus 5.5 effort medium  +1.25   0.72   2/10   5/10   0.49   $0.107
//   Sonnet 5 effort low     +1.62   0.96   2/10   2/10   0.56   (cheapest)
//
// Opus 5 at low wins on every axis that matters and is not close. Cost is NOT
// the binding constraint on this product - a half-cent of model spend against a
// 3-credit Batch is noise, while a grade and a half of bias is the product being
// wrong. Do not re-litigate on the price sheet.
//
// See claude/REASONING_EFFORT_NEGATIVE_RESULT.md and
// claude/OPUS_55_DEFECT_DIFF_2026-09-25.md before changing either line below.
export const PRIMARY_MODEL = 'claude-opus-5';        // $5/$25
// export const PRIMARY_MODEL = 'claude-opus-5-5';   // +0.63 grades high, sees fewer defects
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
