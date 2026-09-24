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
export const PRIMARY_MODEL = 'claude-opus-5-5';

// Identification only (card/cover title reads). Not a grading model.
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
