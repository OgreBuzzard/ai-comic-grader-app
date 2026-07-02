// lib/version.js
// Single source of truth for the assessment-system version.
//
// Main (assess.js), Deep (assess_deep.js), and Full (assess_full.js) all import
// ROBOGRADE_VERSION from here, so the three tiers can never drift apart again —
// bump this one value and every tier increments in lockstep.
//
// Versioning schema (see the assess.js header for the full convention):
//   +0.01  minor tweak
//   +0.1   meaningful scoring / gate change
//   +1.0   milestone release
//
// This lives outside /api so it is NOT built as its own Vercel function (the
// 12-function cap is real); it is a pure data module imported by the handlers.
export const ROBOGRADE_VERSION = '4.28';
