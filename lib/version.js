// lib/version.js
export const ROBOGRADE_VERSION = '4.53';
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
