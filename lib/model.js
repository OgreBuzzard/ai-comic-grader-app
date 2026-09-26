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
// ── ROLLED BACK 2026-09-26 to Opus 5 at effort 'low' ────────────────────────
//
// Three rounds, same frozen 1200px set, 12 books x 3 reps:
//
//                          mean d   +-0.5   defects   outTok    ms    cost
//   Opus 5   effort low     +0.13    4/10     7.47     1164   13953  $0.095
//   Opus 5.5 effort low     +0.76    3/10     5.94     1090   12780  $0.090
//   Opus 5.5 effort medium  +1.25    2/10     4.83     1928   22390  $0.107
//
// The effort hypothesis is FALSIFIED, and backwards. Medium made 5.5 think 60%
// longer and write 77% more output, and it reported FEWER defects and graded
// HIGHER. More deliberation did not recover the missing defects; it removed more
// of them. Run-to-run spread barely moved either (0.49 vs 0.52), so the extra
// thinking bought nothing at all.
//
// Working explanation: the prompt is full of deliberate caution language -
// "default to printed art when in doubt", "when in doubt, round up", "do NOT
// assume a mark is added". Those exist to stop false positives. More reasoning
// means more chances to reach for them, so 5.5 talks itself out of marginal
// defects. That would make this a prompt property, not a model property - and
// it predicts Opus 5 degrades at medium too. Untested.
//
// Opus 5 at effort 'low' remains the best configuration measured on every axis
// that matters: closest to PSA, most defects found, tightest run-to-run spread,
// and the cheapest of the three per assessment.
export const PRIMARY_MODEL = 'claude-opus-5';        // $5/$25
// export const PRIMARY_MODEL = 'claude-opus-5-5';   // $4/$20 - grades high, sees less

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
  'claude-fable-5':             { in: 10 / 1e6, out: 50 / 1e6 },
  'claude-opus-4-8':            { in: 5  / 1e6, out: 25 / 1e6 },
  'claude-opus-4-6':            { in: 5  / 1e6, out: 25 / 1e6 },
  'claude-sonnet-4-6':          { in: 3  / 1e6, out: 15 / 1e6 },
  'claude-haiku-4-5-20251001':  { in: 1  / 1e6, out: 5  / 1e6 },
};

// Falls back to the CURRENT primary's rates, not a stale hardcoded model, so an
// unknown id can never silently bill at an old price.
export function ratesFor(model) {
  return MODEL_RATES[model] || MODEL_RATES[PRIMARY_MODEL];
}
