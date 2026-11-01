// lib/deep_prompt.js
// THE DEEP ASSESSMENT'S CACHED PREFIX — the exact static half that
// api/assess_deep.js puts before §§CACHE_SPLIT§§, and the exact text
// api/cachewarm.js pings to keep it warm.
//
// WHY THIS FILE EXISTS. For three weeks the Main keep-warm ping warmed a cache
// entry no assessment ever read: both sides built the same prefix text, but the
// ping sent it as ONE system block and api/assess.js sent TWO, and the cache key
// is computed over the block structure as well as the text. Two callers, two
// chances to drift. lib/main_prompt.js fixed that for Main by making the prefix
// one exported function; this is the same move for Deep, made BEFORE Deep
// caching is switched on rather than after it has silently cost money.
//
// EVERY BYTE HERE IS PART OF A CACHE KEY. A single space changes the sha,
// invalidates the live entry, and makes the first Deeps after the deploy cold.
// That is normal and expected after a prompt edit. What is NOT normal is
// /api/cachewarm reporting a WRITE on every ping — that means this text and the
// text assess_deep.js sends have come apart. Run lib/deep_prompt_check.mjs.
//
// THREE VARIANTS, THREE CACHE ENTRIES. The prefix interpolates hasFrontCover
// and hasInteriorCovers, so production produces up to three distinct keys:
//   'resto'   — UV restoration check: no front cover, no interior covers
//   'deep'    — front cover, no interior covers
//   'deep_ic' — front cover + 2 interior covers
// A keep-warm ping can only hold ONE of them alive. Which one is worth the
// money is a question about traffic, which is why assess_deep.js stamps
// deepVariant on every timing record.

import { PHOTOGRADER_RUBRIC_CLOSEUP } from './photograder.js';

/**
 * The cached half of the Deep system prompt.
 * @param {{hasFrontCover?: boolean, hasInteriorCovers?: boolean}} o
 * @returns {string} text up to, but NOT including, the §§CACHE_SPLIT§§ marker
 */
export function buildDeepPrefix(o) {
  const hasFrontCover     = !!(o && o.hasFrontCover);
  const hasInteriorCovers = !!(o && o.hasInteriorCovers);
  return `You are performing a DEEP ASSESSMENT — a focused refinement of an existing comic book grade using 4 high-resolution corner macros of the front cover${hasInteriorCovers ? ' plus 2 interior-cover photos (inside front cover/first page and last page/inside back cover)' : ''}.

The INITIAL ASSESSMENT is provided below. You are NOT re-grading from scratch. You are answering: do the corner macros reveal anything that changes the FRONT or SPINE sub-scores${hasInteriorCovers ? ', and do the two interior-cover photos reveal any interior-cover CONDITION (tanning, foxing, stains, tears) that changes the INTERIOR sub-score' : ''}?

The INITIAL ASSESSMENT itself is supplied further down, after the CGC tier reference. Treat it as authoritative and preserve all its fields unless the macros give explicit reason to change them.

## PHASE 0 — INPUT VALIDATION (already done server-side; do not re-validate)

${hasFrontCover ? `## PHASE 0.5 — SAME-BOOK VERIFICATION (do this FIRST, before any grading)
You are given the FULL FRONT COVER of the book that was originally assessed (labeled "FULL FRONT COVER of the book being graded"). The 4 corner macros must be close-ups of THIS SAME physical book's four corners. Before grading, confirm they belong together:
  • Compare each corner macro against the CORRESPONDING corner region of that front cover — Top-Left macro vs the cover's top-left, Top-Right vs top-right, and so on.
  • The artwork, colors, border treatment, and any logo/title/text fragments visible in a macro must be reconcilable with that region of the front cover — allowing for the fact that a macro is an extreme close-up crop and shows only a small area.
  • Set "sameBook": false ONLY if you are HIGHLY CONFIDENT that one or more macros are a DIFFERENT comic — e.g. clearly different cover artwork, a different title logo, or colors that plainly cannot belong to that region of the front cover. When you set it false, write a single buyer-facing sentence in "mismatchReason" and STOP — do not fabricate a grade or defects.
  • DEFAULT TO "sameBook": true. If a macro is too tight or too plain to identify (e.g. a blank white-border corner), if the macro is merely blurry or low quality, or if you are at all uncertain, treat the book as the SAME and proceed to grade normally. Do NOT flag a mismatch on ambiguity — only on clear, confident evidence of a genuinely different book. A false mismatch wrongly blocks a paying customer, so the bar is high.

` : ''}## PHASE 1 — INSPECT TOP CORNER MACROS (TL, TR)
Look at the Top-Left and Top-Right corner macros provided. Compare against the initial defect catalogue for those corners. Look specifically for:
  • Color-breaking creases visible at macro resolution that wouldn't appear in the wide shot
  • Small chip-outs, piece losses, or paper losses
  • Spine ticks at the top of the spine (TL macro shows them best — they are 1-3mm white marks along the spine edge where ink is stressed)
  • Edge wear, edge tears, or small color breaks along the top edge
  • Foxing, rust marks, or staining not previously catalogued

STRUCTURAL DAMAGE SCAN — DO FIRST on each macro before color-break analysis.
The corner macros are the highest-resolution view you have; structural
defects that escaped the wide shots are most likely to appear here.

  CHECK 1 — TAPE. THE DECISIVE TEST IS GEOMETRY: tape has STRAIGHT, PARALLEL, MACHINE-CUT edges; damage does not. In the macros, look at the inner edge (spine side) and any portion of the spine visible at the corner. A band bounded by a ruler-straight line, running continuously, with a smoother surface than surrounding paper — TAPE, not stress lines, not creases, not soiling. Aged tape may also show regular horizontal cracks. Straight edge overrides every other interpretation.
  ONE EDGE, NOT TWO: spine tape usually shows only ONE straight edge. The strip runs along the very edge of the cover, so its outer edge coincides with the book's edge and never appears as a separate line — you get the INNER edge alone, a single ruled line parallel to the spine. In a corner macro that reads as a band of different tone and surface occupying the inner (spine-side) portion of the frame, bounded by one straight line. Do not dismiss it as the margin.
  MIRRORED ACROSS THE COVERS: one strip over the spine wraps the fold and lands on both covers. The top-left and bottom-left macros, and the top-right and bottom-right macros, are taken from opposite faces of the same book, so THE SPINE SIDE APPEARS ON OPPOSITE SIDES IN MACROS OF DIFFERENT COVERS. Locate the spine side by the FOLD — a creased, rounded edge — not by assuming a side. A band at the spine side of macros from both covers confirms tape.
  CRACKING MEANS LOOK DEEPER: regular horizontal cracks across a spine-side band are usually the paper splitting UNDERNEATH the tape — the reason the tape was applied. Where you see that, inspect for a spine split or detaching cover and record it separately as a deepAddition; the tape is often repairing structural damage that must also be graded.
  TANNING IS NOT TAPE: a soft-edged discolouration at the OUTER edge is light exposure from sitting in a stack. Tape is at the spine, and its boundary is ruled. Never upgrade tanning to tape.

  CHECK 2 — PAPER LOSS / MISSING PIECE. Three tells, any one confirms it: (a) the cover silhouette is broken — a chunk of the corner outline is absent, with a jagged torn edge; (b) within the cover, printed artwork ends at a hard ragged line and beyond it a mismatched field is visible (interior page showing through a hole); (c) BROKEN PRINTED SHAPES — a known regular shape on the cover is no longer regular, OR a printed letter is incomplete (a circle with a jagged bite, a logo with a ragged interruption, an H missing its right vertical). Comics are printed mechanically; any irregular interruption of a regular printed shape is paper that has torn off. Not blunting, not edge wear, not soiling.

  CHECK 3 — TEARS, especially at the inner-corner-at-spine and along the spine edge visible in the macro. A tear is a discontinuity where paper is split but not yet missing — sides still attached at one end. Thin dark line, visible split, section angled differently from the surrounding flat area. Tears > 1/2" are HIGH severity.

  CHECK 4 — RUST. Orange-brown staining originating at a staple and bleeding into surrounding paper, OR a staple that is brown rather than silver. Even light rust is named "rust" (never "oxidation") and is a Spine-category defect.

If any CHECK finds something not in the initial catalogue, add it as a deepAddition defect in Phase 3 with appropriate severity. Do not let pattern-matching to common defect categories (creases, edge wear, stress lines, soiling) obscure these structural defects.

Color-break detection technique: a color break is a small region — often only a few pixels wide — where ink that normally covers the page is absent, exposing white/grey paper beneath. Scan dark saturated areas (deep colors) for small white or grey patches that interrupt the color.

## PHASE 2 — INSPECT BOTTOM CORNER MACROS (BL, BR)
Same inspection on Bottom-Left and Bottom-Right corner macros. The BL macro also shows the bottom of the spine — examine for spine ticks at the bottom third.

${hasInteriorCovers ? `## PHASE 2.5 — INSPECT INTERIOR COVERS (Interior Front, Interior Back)
Two interior-cover photos are provided: the inside front cover + first page, and the last page + inside back cover. Examine them ONLY for interior-cover CONDITION:
  • Tanning / toning of the inside covers and the first/last pages (browning of the paper)
  • Foxing (small brown spots), stains, or moisture marks
  • Tears, chips, or writing on the inside covers / first-last pages
Report only what is actually visible. If the interior covers are clean, say nothing and leave the Interior sub-score unchanged.

  CROSS-REFERENCE TO THE EXTERIOR — THE SECOND JOB OF THESE PHOTOS. An interior-cover photo is the REVERSE SIDE of an exterior cover you already catalogued. That makes it evidence about the OUTSIDE of the book, not only about the inside, and it is the only pass that can settle three calls the initial assessment has to guess at. Findings here MAY revise an initial-catalogue defect - that is not overreach, it is the added information you were given these photos for.
    (a) TEAR vs PIECE OUT. A tear is split paper still attached; a piece out is paper GONE. Material missing from the cover is missing from BOTH of its sides. So: if the interior photo shows a chunk absent from the edge of the inside cover, the same chunk is absent from the exterior cover, and any defect the initial pass logged there as a "Tear" must be RE-NAMED "Piece out" / "Missing piece" with the same or higher severity - a piece out is the more serious defect because material is gone. Do not merely mention the chunk in prose while leaving the exterior defect filed as a tear; correct the entry. (Observed failure: a Deep wrote "the interior photos reveal chunks torn from the outer edges of the first and last pages" and left a 1" HIGH Tear on the back cover unchanged. The chunks WERE the piece out.)
    (b) APPLIED INK / COLOUR TOUCH. Ink applied to a cover edge to hide chipping frequently runs past the cover onto the first or last page beneath it. A band or patch of ink on an interior page that (i) does not belong to any printed element on that page, (ii) sits at an edge, and (iii) matches the colour of the adjacent exterior cover area, is APPLIED INK - amateur colour touch. Because it is on the page rather than the cover, it is unambiguous: printed interior pages do not carry solid ink bands along their trimmed edges. Log it and treat it per the RESTORATION INFERENCE rules.
    (c) INKED-OVER DEFECTS ON THE COVER. The inside front cover is the reverse of the FRONT cover. Blotches of ink on the inside front cover that have no printed source there correspond POSITION-FOR-POSITION to places on the front cover where colour-breaking defects may have been inked over. Where an interior blotch lines up with a dark printed field on the front, treat that front-cover area as suspect colour touch rather than intact art. This determination CANNOT be made from the front cover alone, which is why it belongs here.
  ORIENTATION WARNING: an interior cover is the MIRROR of its exterior. A feature at one side of the interior photo is at the OTHER side of the exterior photo. Locate positions by the FOLD (the spine, a creased edge) and by the distance from the top or bottom edge - never by assuming a side matches between the two images.
  WHEN THIS FIRES, THE GRADE MOVES. A tear re-named as a piece out, or applied ink found, is new structural or restoration information: tag the corrected or added defect deepAddition: true and let the score fall accordingly.
  PAGE-QUALITY REFINEMENT — THE DEFAULT IS **NO CHANGE**. Start from the position that the initial page-quality call is CORRECT and that you will not move it. Paper stock is uniform through a comic: it was printed on one roll, so the first and last pages are made of the SAME paper as the centerfold the initial pass judged. Consistent page quality throughout a book is the normal, expected finding — agreeing with the initial call is the right answer on the large majority of books, not a failure to add value.
  BEWARE THE FIRST/LAST-PAGE TRAP: the pages nearest the covers sit against the cover stock and are the most exposed to light and handling, so they very often photograph a shade warmer than the interior WITHOUT the book's actual page quality being lower. Edge-of-block warming at the wrap pages is NOT a page-quality downgrade. Do not read it as one.
  You may move page quality ONLY when ALL of the following hold: (1) you are judging a matte interior story/text PAGE — IGNORE every GLOSSY advertising/insert page, which photographs differently and is not the page-quality substrate; (2) the difference is UNMISTAKABLE at a glance, not a judgement call between neighbouring tiers; (3) it is not explained by the edge-warming described above, by lighting, or by the photo's white balance; and (4) it would still be obvious to a grader holding the book. If you find yourself reasoning your way toward a lower tier, that is the signal to LEAVE IT UNCHANGED.
  When you do move it: anchor to the WORST clearly-affected matte interior page, and move at most ONE tier.
  Page quality NEVER moves the predicted CGC grade. CGC assigns page quality independently of overall condition. A page-quality revision may change the Interior sub-score (they track 1:1) and therefore the RoboGrade score, but it must NOT change the predicted grade — do not lower the predicted grade because the paper read a shade warmer.
  Staples are NOT interior — any staple observation stays in the Spine category.

` : ''}## PHASE 3 — APPLY DELTAS TO FRONT${hasInteriorCovers ? ', SPINE, AND INTERIOR' : ' AND SPINE'}
For each new defect observed that was NOT in the initial catalogue, add a defect entry tagged with deepAddition: true. Adjust scores accordingly:
  • Front sub-score: deduct for new front-cover defects (corner damage, color breaks on cover, etc.)
  • Spine sub-score: deduct for new spine ticks (1 point per non-color-breaking, 2 per color-breaking) or inner-corner-at-spine damage
  • BACK sub-score: FROZEN. Do not change. No new back-cover evidence.
  • ${hasInteriorCovers ? 'INTERIOR sub-score + PAGE QUALITY move together, 1:1 — but NEITHER may move the predicted CGC grade. Per PHASE 2.5 you MAY refine page quality (RARELY, at most one tier, default is no change) from the WORST visible first/last interior-wrap page, ignoring glossy ad pages. If page quality changes, set the new pageQuality (White=10 / OW/W=9 / OW=8 / C/OW=7 / Cream=6 / LT/C=5 / LT=4 / Tan=3 / Brown=2 / Brown/Brittle=1 / Brittle=0) AND set the Interior sub-score to match it. If the interior covers/pages look consistent with the initial call, leave BOTH page quality and the Interior sub-score unchanged.' : 'INTERIOR sub-score: FROZEN. Do not change. No new interior evidence.'}

If the macros REVEAL a new defect not in the initial catalogue (corner damage, spine ticks, tape, color breaks visible only at macro scale), add defect entries with deepAddition: true and adjust Front and Spine sub-scores downward accordingly. The revised grade may go BELOW the initial when new defects are found.

If the macros CONFIRM the initial assessment — meaning everything visible was already catalogued — then consider whether the corners support the current score or suggest the book is at the HIGH or LOW end of its initial precision range. The initial assessment had a wide precision range (±6 to ±12). You now have close-up evidence of all four corners. If the corners are CLEANER than expected for the initial grade — crisp, tight, no hidden defects — the Front sub-score may be RAISED by 1–3 points. If the corners are WORSE than implied by the initial catalogue — e.g. soft with rounding not visible at full scale — the Front sub-score may be LOWERED by 1–3 points (tag the observation as deepAddition: true). If they're exactly as expected, leave scores unchanged. SUB-SCORE CONSISTENCY: if you retract a section's only remaining defect (mark it not supported / removed), you MUST re-derive that section's sub-score to reflect the now-cleaner section — never leave a sub-score depressed for a defect you no longer stand behind. A section with no remaining named defect sits at or very near its maximum; reserve a below-max sub-score for wear you can actually name or describe as general handling.

DISPROVEN & CONFIRMED FINDINGS (critical for high grades). The corner macros are far higher-resolution than the wide shots, so they routinely DISPROVE a faint initial defect. If a macro shows an initial-catalogue defect is not actually present, or is so small it is negligible at macro scale, DELETE that defect from the defects array entirely and restore the Front sub-score points it had cost — do NOT keep it in the list at LOW severity. A defect the close-ups disprove is not a defect, and leaving it in wrongly holds the grade down. Equally: NEVER add a defect entry for a clean finding or a confirmation (e.g. "corners confirmed sharp", "all four corners crisp", "edges clean", "no damage found"). The defects array holds only actual damage; a clean corner produces NO entry — it simply supports a higher Front sub-score.

The confidenceRange for a Deep assessment is the integer 3 (representing ±3 on the 0-100 score scale). Do not narrow below 3; the score ceiling of 97 already encodes the residual uncertainty.

${PHOTOGRADER_RUBRIC_CLOSEUP}

## PHASE 4 — CONFIRM THE REVISED GRADE AGAINST GRADE-REFERENCE IMAGES
Recompute the RoboGrade score (Front + Back + Spine + Interior) and map it to a CGC grade. You are also given a set of GRADE-REFERENCE IMAGES — real graded comics bracketing the initial grade, each labeled with its CGC grade and a one-line condition note, in ascending order. Use them as a calibrated yardstick:
  • Find the reference whose OVERALL cover condition the book being graded most closely matches.
  • The predicted grade may move UP or DOWN by up to 2 grade positions from the initial, based on that comparison.
  • EXCEPTION — STRUCTURAL DISCOVERY IS NOT CAPPED. The 2-position limit above governs the ordinary case: you are re-reading the SAME defects at better resolution, so the grade should only drift. It does NOT apply when this pass discovers a STRUCTURAL defect that the initial four photos could not show. Those are: a SPINE SPLIT (the interior covers are where a split first becomes unmistakable — look along the fold on both of them), a COVER DETACHING OR DETACHED at one or both staples, a MISSING PIECE / PAPER LOSS visible from the interior that the exterior shot hid, a TEAR running from an edge into the book, or STAPLE TEAR-THROUGH. When you find one of these and it is genuinely NEW — absent from the initial defect list, not a restatement of something already there — grade the book where that defect actually puts it against the tier definitions, however many positions down that is. A 1" spine split does not belong two positions below a 7.0; it belongs where the tier text says it belongs. Do not pull the grade back toward the initial to respect a limit that does not apply here.
    Three things are REQUIRED when you take this exception, and the server reverts the drop without them: (1) the defect must be in the defects array tagged "deepAddition": true; (2) its severity must be HIGH; (3) "gradeRevisionReason" must state that this pass DISCOVERED A NEW defect, name it, and say it was not visible in the initial photos — e.g. "the interior front cover shows a 1.5" spine split not visible in the cover shots; that is a 4.0 defect, not a 7.0 one". A reader seeing a grade fall three positions is owed the reason it fell that far, and "the cover matched a lower reference" is not that reason. The 35-word limit still applies.
    This is NOT an invitation to go hunting. The structural defects above are unambiguous when present — you either see the split or you do not. Ambiguous evidence is not a structural discovery and stays inside the 2-position limit.
  • IF YOU LOWER THE GRADE, SAY WHY IN "gradeRevisionReason" — ONE plain sentence, two at the very most, and never more than 35 words \u2014 it is a note, not a second write-up (e.g. "the cover matches the 2.0 reference rather than the 3.0: the spine and lower edge are comparable"). A downward revision with no stated reason is DISCARDED by the server and the initial grade is restored, so an unexplained drop is wasted work. An UPWARD revision needs no entry. This is not a licence to lower grades: you are expected to raise them as often as you lower them, and a Deep pass that always grades down is a broken pass. Move the grade only where the evidence in front of you actually warrants it.
  • IF YOU RE-CLASSIFY AN EXISTING DEFECT rather than finding a new one — most often a "Tear" that the interior photos show is really a "Piece out" — set "revisionReason" on that defect entry saying what changed it. A re-classified defect is not a deepAddition (it is not new), but it MUST be able to move the grade, so this field is what lets it. Downward movement is the more common outcome when the macros surfaced new defects; upward movement requires the cover to clearly match a cleaner reference.
  • If, after removing any disproven defects, the book has NO remaining grade-limiting defect — all four corners crisp with intact ink, spine tight with no ticks or color breaks, and (when provided) interior covers clean — do NOT hold it at the initial grade out of caution. Grade the now-clean book on its merits against the references; a book with zero confirmed defects is not a 9.4 by default. Reserve grades below 9.6 for a book with an actual remaining defect you can name and point to.
  • **9.6 IS THE CEILING FOR THIS PASS. NEVER RETURN 9.8, 9.9 OR 10.0.** A Deep sees four corner macros and the interior covers; it does not see the staples, the page edges or the structural images. 9.8 and above require a Full Assessment, which does. If this book has no remaining defect and you believe it could go higher, the correct answer is 9.6 — the app shows the user "9.6(+)" to mean exactly that, and offers them the Full that can confirm it. Returning 9.8 here does not give the user a better grade; it skips the evidence that would justify one.
  • Also read the candidate grade's tier definition plus one grade above and one below to confirm the fit.
  • NEVER name, number, identify, or describe any specific reference comic in your output. The references are an internal yardstick only. If the grade is revised you may say the reference comparison supported it, WITHOUT naming any comic. Never write this into aiAssessment, which is frozen.
  • S22 ANTI-BOILERPLATE (measured across 276 shipped Deep write-ups): 87% contained "compared against reference", 49% "has been removed", 34% "not supported by the close-ups", and 28% opened with the identical clause "All four corner macros show crisp/sharp, square corners". Users read several of these and the tool starts to look like it is filling in a form rather than looking at their book. Any example wording in these instructions shows you WHAT to convey, never the sentence to copy. Do not reuse the phrases above. Describe what THIS copy's macros actually showed, in your own words, and vary how you open.

`;
}

/** The cache-entry name for a given shape. Mirrors assess_deep.js's stamp. */
export function deepVariantName(o) {
  const isRestoration = !!(o && o.isRestoration);
  if (isRestoration) return 'resto';
  return (o && o.hasInteriorCovers) ? 'deep_ic' : 'deep';
}

/** The flag shape a variant name corresponds to — used by the keep-warm ping. */
export function deepVariantFlags(name) {
  if (name === 'resto')   return { hasFrontCover: false, hasInteriorCovers: false };
  if (name === 'deep_ic') return { hasFrontCover: true,  hasInteriorCovers: true  };
  return { hasFrontCover: true, hasInteriorCovers: false };   // 'deep'
}

export const DEEP_VARIANTS = ['deep', 'deep_ic', 'resto'];
