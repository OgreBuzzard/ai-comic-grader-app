// lib/version.js
export const ROBOGRADE_VERSION = '5.04';
// v5.04: reference + photograder accuracy. (1) ComicVine volume disambiguation:
// an Annual/Special/King-Size sub-series is no longer chosen over the main series
// on a year hint (fixed FF #27/1963 pulling FF Annual #27/1994, and FF #13 -> FF
// Annual #13); exact-title volumes preferred. (2) Cover-match sanity check: the
// grader now detects when the fetched reference is the WRONG book (wrong volume/
// issue, or an unrecognizable worn copy) and says so instead of falsely reporting
// 'cover matches'. (3) Photograder LIGHTING loosened: a mild warm/glossy sheen that
// doesn't actually hide detail is an A (was dropping to B on readable glossy covers).
// (4) Page quality anchors to the WORST visible interior page (not the average);
// Deep may now RARELY refine page quality (<=1 tier) from the first/last interior-
// wrap pages seen in the interior-cover photos (glossy ad pages ignored), keeping
// PQ and the Interior sub-score 1:1. Also non-grading UI this build: per-slot camera
// zoom defaults, cropper first-image fit + auto-crop for Deep interiors & Full edges,
// list-view PG moved to bottom-right, referral/gift popup copy + green CTA.
// v5.03: Main grading images now resized to 1200px (was 1400). Validated by a
// 1400-vs-1200 A/B across 37 raw books x2 res x3 reps: mean |grade delta| 0.226
// vs within-resolution self-noise 0.188 — no detectable resolution effect; near-
// perfect books (9.2) identical at both. Cuts image tokens ~27%. Deep/Full close-
// up macros ride the same default; not separately A/B'd (revert compressImage
// maxDim to 1400 if any high-grade oddity appears).
// v5.02: Photograder rubric — Focus grades CAPTURE sharpness, not the inherent
// softness of vintage/halftone/painted printing (a well-shot vintage cover earns an
// A); Lighting no longer docks intentional raking/directional light on spine/edge/
// staple shots (only glare/shadow that HIDES detail is a fault). Insert index +5:
// ASM #115/#259/#346, Marvel Team-Up #96, Web of Spider-Man #51.
// v5.01: scoring refinements — Interior rounds up (Off-White+ -> 1); grade is now
// round-each-subscore-then-sum (fixes fronts being shaved down in decompose); a true
// 10 is gated (no listed defects, White pages, v1 >= 49/19/19); list view RG/PG +
// graded-date layout; deep/full animate from the previous grade; misc fixes.
// v5.0: major scoring-scheme release — v3 half-point RG live everywhere (Main 9.0 /
// Deep 9.5 / Full 10 ceilings), Full unlockable by near-perfect grade (not just FMV)
// so any book can reach a perfect 10, Robograder-head styled ceiling pop-ups, and the
// Deep/Full scan sequence fixes. See SESSION_22 handoff.
// v4.72: three assessment-prompt changes.
// (1) MISWRAP vs SPINE ROLL — a miswrap (off-center cover wrap with staples still
//     centered) is a printing defect; it is now LISTED in the Spine category as
//     "Miswrap - printing defect, no deduction" (empty severity, NO grade hit).
//     Genuine spine roll — cover shift WITH staples out of position/stressed —
//     still takes a severity and deduction.
// (2) DEFECT PRIORITIZATION — under the 4-8 defect-list cap, high-impact defects
//     (missing piece/chip-out, tape, tear, foxing, stain, spine roll/split,
//     staple rust, brittleness, restoration, and color-breaking/long creases) are
//     ALWAYS listed individually; only light wear/blunting/soiling/small non-CB
//     creases/bends are expendable (banded) when the cap is tight.
// (3) EARLY DIRECT EDITION — a UPC box with a diagonal slash (late-1970s/early-
//     1980s) is an early Direct Edition marking: not a defect, and not newsstand.
// v4.70: cards show v2 (31-tier) grade in the app + admin list views (comics still
// gated on RG_V2_DISPLAY); card PM base lowered to 1 (Deep + all-A photos -> 0, hidden);
// share text drops the '#' before card numbers; link-preview caption shows the card
// name only (number stays in the message text). Admin RGV2 card config synced to 50/20/20/10.
// v4.69: prompt now distrusts >=5" creases as likely printed art; comic Front/Back
// cropper defaults to a ~9:14 centered, non-rigid box; public card page shows the
// condition assessment; share text drops precision + page-quality and adds the card
// predicted grade; Settings close-X clears the status bar on small phones (safe-area).
// (Admin-side, deployed separately: thinner top bar, card predicted grade shows,
// referral requires recipient to have purchased, daily sales chart ends at PT midnight.)
// v4.68: year-ranged book notes now fire on a first-pass assessment even when the
// client sends no cover date — assess.js falls back to the ComicVine-identified
// cover year (disambiguated by the matched volume). New book notes: Secret Wars
// #8/#1, Crisis on Infinite Earths #5, Trees #1, TMNT #20 (2019); Wolverine #1
// (1988) crease note reworded.
// v4.67: scan coin fade gated on image decode + preloaded (no more card pop); scan
// RG badge + card main score box keep the number centered with +/- absolute on the
// side (no shift); card guide-overlay label shrunk so TOP/BOTTOM FRONT don't clip.
// v4.66: comic score box recolored to near-black to match cards/List/scan across
// Detail/Edit/Public (restoration-aware: purple-black when a book is flagged restored).
// v4.65: card scan animation now shows the v2 (31-tier) RG grade, not the legacy
// 0-100 score; card score box recolored to near-black (#0f1a05) to match List/scan
// (subscores stay the lighter green); Public view brought in line with Detail/Edit —
// Top Front/Bottom Front macros square + side-by-side, Variant/Set/Artist fonts matched;
// Detail/Edit card images gained slot labels (Front/Back/Top Front/Bottom Front).
// v4.64: card speed + cleanup — dropped the redundant Haiku identify pass and the
// TCGdex reference fetch it fed (identity now comes from the Opus grade call);
// added a THINKING & OUTPUT DISCIPLINE block to the card prompt (be decisive, don't
// ramble — the same lever that fixed comic latency); wired prompt-caching to the
// dashboard config/caching lever (static rubric cached in the system prompt). Page
// Quality removed from all card surfaces (no PQ on cards).
// v4.63: card feedback round — Photograder for cards loosened (default focus/lighting
// to A; don't dock ordinary phone-cam softness) and note format fixed (note = fix only,
// no "Axis - Image -" echo, bullet removed). Card panel: centering inset 3px->2px, PM
// tucked to the up/down arrow. Card display: Set + Artist bold; slot labels Front/Back/
// Top Front/Bottom Front; guide overlay "Macro" wording dropped; macro capture now
// PORTRAIT (no forced landscape). Card cropper (Front/Back) locked to 5/7 centered. Card
// scan: PG placeholder + badge RED (was blue), score count-up + glow like comics, PSA
// shows no decimal on whole grades. Card predicted-grade box now carries the independent-
// prediction disclaimer. Camera: editing a card + tapping a slot loads the CARD slot.
// v4.62: card surface scoring re-expressed as BANDS + an accumulation cap (mirrors
// the comic grading philosophy) instead of the rigid per-defect point values from
// 4.61 — one Robograder method across item types. Same outcome for the '6 LOW = ~1
// grade off' case, consistent philosophy. FMV Tier tool: base cell now raisable.
// v4.61: card grading — LOW surface defects now accumulate real deductions
// (~-2/-3 each; 6 LOW ~= one full grade off); Photograder notes forced terse
// (6 words max) and the Angle axis no longer penalizes the intentionally-tilted
// Top/Bottom Macro shots.
// v4.60: pHash cover-index (client dHash stamps coverHash at assess time; a
// previously hand-corrected cover teaches the right issue number to future
// identical covers via cover_index, matched by Hamming distance <=8 after
// identification). set_ident.js upserts cover_index on Fix-Identity. Plus a
// Gold Key / Dell identification caution: leave issue BLANK rather than guess.
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
