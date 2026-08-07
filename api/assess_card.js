// api/assess_card.js — PSA trading-card grading (Pokémon MVP).
//
// Standalone card grader that mirrors assess.js patterns but does NOT touch the
// working comics path. Flow:
//   1. Auth (Firebase ID token).
//   2. Identify the card (cheap Haiku pass) -> {name, set, number, year, variant}.
//   3. Fetch a clean reference scan from TCGdex (free, no key) by name (+ number).
//   4. Grade with the model using buildPSACardGradingPrompt() (defined in this file).
//   5. Return the parsed JSON. The CLIENT persists the item (type:'card' + cardData)
//      and spends the credit, exactly like comics (credits are client-managed).
//
// NOT yet wired to the client; testable via API. The full assess.js ->
// thin-orchestrator refactor is a later cleanup — this ships the card path
// without disturbing comics.
//
// ESM note: a static Node built-in import keeps Vercel treating this as ESM
// (matches verify_iap/verify_play); firebase-admin loads dynamically.
import process from 'node:process';
// ── PSA CARD GRADING PROMPT (consolidated from lib/grading_cards.js, S21) ──
// The card prompt + rollup logic live here, in the dedicated assess file —
// prompts live with their endpoint (Matt's call). No lib/grading_cards.js and
// no grading_comics.js split. buildPSACardGradingPrompt()/buildPSACardDeepPrompt()
// are defined below and used by the handler further down.
// ─── PSA GRADE LADDER ───────────────────────────────────────────────────────

const PSA_GRADE_TIERS = `
PSA GRADE STANDARDS — CARDS
============================

PSA 10 (GEM-MT)  Virtually perfect. Four perfectly sharp corners. Sharp focus.
                 Full original gloss. No staining of any kind. A slight printing
                 imperfection is allowed only if it does not impair overall
                 appeal. Centering: 55/45 front, 75/25 back.

PSA 9 (MINT)     Superb condition. Permitted to have ONE of: a very slight wax
                 stain on reverse, a minor printing imperfection, or slightly
                 off-white borders. Centering: 60/40 front, 90/10 back.

PSA 8.5 (NM-MT+) High-end NM-MT. All PSA 8 attributes but with stronger eye
                 appeal — typically a card that meets PSA 9 standards on every
                 axis except centering specifically falls in the 60/40-65/35
                 zone. Reserve for cards that present visually as 9 candidates.

PSA 8 (NM-MT)    Appears Mint 9 at first glance, but on close inspection may
                 show: very slight wax stain on reverse, slightest fraying at
                 one or two corners, a minor printing imperfection, and/or
                 slightly off-white borders. Centering: 65/35 front, 90/10 back.

PSA 7 (NM)       Slight surface wear visible on close inspection. Slight fraying
                 on some corners is acceptable. Picture focus may be slightly
                 out-of-register. Minor printing blemish acceptable. Slight wax
                 staining on back only. Most original gloss retained.
                 Centering: 70/30 front, 90/10 back.

PSA 6 (EX-MT)    Visible surface wear or printing defect that doesn't detract
                 from overall appeal. Very light scratch detectable only on
                 close inspection. Corners may have slightly graduated fraying.
                 Picture focus may be slightly out-of-register. Some loss of
                 original gloss. Minor wax stain on reverse acceptable. Very
                 slight notching on edges. Some off-whiteness on borders.
                 Centering: 80/20 front, 90/10 back.

PSA 5 (EX)       Very minor rounding of corners becoming evident. Surface wear
                 or printing defects more visible. Minor edge chipping possible.
                 Loss of gloss more apparent. Several light scratches visible
                 on close inspection but not detracting from appeal. Some
                 off-whiteness of borders.
                 Centering: 85/15 front, 90/10 back.

PSA 4 (VG-EX)    Corners may be slightly rounded. Surface wear noticeable but
                 modest. Light scuffing or scratches. Some original gloss
                 retained. Borders may be slightly off-white. A single light
                 crease may be visible.
                 Centering: 85/15 front, 90/10 back.

PSA 3 (VG)       Some rounding of corners (not extreme). Surface wear apparent
                 with possible light scuffing/scratches. Focus may be off-
                 register. Edges show noticeable wear. Much (not all) original
                 gloss lost. Borders may be yellowed or discolored. A crease
                 may be visible. Slight stain may show on obverse; wax staining
                 may be more prominent on reverse.
                 Centering: 90/10 both sides.

PSA 2 (GOOD)     Accelerated corner rounding. Surface wear obvious. Scratching,
                 scuffing, light staining, or chipping of enamel on obverse.
                 Several creases possible. Original gloss may be completely
                 absent. Considerable discoloration possible.
                 Centering: 90/10 both sides.

PSA 1.5 (FR)     Extreme corner wear, possibly affecting framing of the picture.
                 Advanced surface wear: scuffing, scratching, pitting, chipping,
                 staining. Picture may be quite out-of-register. Borders may be
                 brown and dirty. One or more heavy creases. CARD MUST BE FULLY
                 INTACT — no missing solid pieces (no major tear, no torn-off
                 corner, no removed back layer).
                 Centering: 90/10 both sides.

PSA 1 (PR)       Same defect spectrum as 1.5 but eye appeal has nearly vanished.
                 May be missing one or two small pieces. Major creasing nearly
                 breaking through all cardboard layers. Extreme discoloration
                 or dirtiness. Noticeable warping or other destructive defect
                 acceptable.

AUTHENTIC (N0)   Genuine but ungraded numerically. Used when alteration is
                 present, when a major defect is otherwise present, or when
                 the submitter requested no numeric grade.

AUTHENTIC ALTERED (AA)  Genuine but with evidence of alteration: trimming,
                 recoloring, restoration, or cleaning. Treated equivalent to
                 Authentic for guarantee purposes.
`;


// ─── THE FOUR SUB-GRADE AXES ────────────────────────────────────────────────

const PSA_SUBGRADE_RUBRIC = `
THE FOUR PSA SUB-GRADE AXES
============================

CENTERING — measurable, numeric.
  Measure the visible image area's distance from each border. Express as a
  ratio per axis: left/right and top/bottom. Report whichever is worse.
  - Front 50/50 perfect, 55/45 supports PSA 10
  - Front 55/45 - 60/40: PSA 9 territory
  - Front 60/40 - 65/35: PSA 8 territory
  - Front 65/35 - 70/30: PSA 7 territory
  - Front 70/30 - 80/20: PSA 6 territory
  - Front 80/20 - 85/15: PSA 5 territory
  - Front 85/15 - 90/10: PSA 4 / 3 territory
  - Front worse than 90/10: PSA 2 or below on centering alone

  Back centering tolerances are looser at every grade. 75/25 is the PSA 10
  threshold for back; PSA 9 and below all use 90/10.

  When centering is borderline between two grades, the card grades at the
  HIGHER tier if every other axis supports it, and at the lower tier if
  any other axis is also borderline.

  Photographic centering measurement has ±5% error from camera angle. When
  centering is at a grade boundary, give the benefit of the doubt unless
  the photo angle is clearly poor.

CORNERS — descriptive, four-corner inventory PER SIDE.
  Inspect each corner individually on both front and back. Report sharpest-
  to-softest range.

  Severity ladder per corner:
    PRISTINE     — perfectly sharp, point-like, no rounding visible
    SHARP        — sharp at arm's length, microscopic rounding under loupe only
    SLIGHT FRAY  — visible whitening or fiber lift but corner still sharp
    MINOR BLUNT  — clear rounding visible without loupe
    SOFT         — corner is rounded, point is gone
    HEAVY BLUNT  — substantial rounding, possibly with chip
    CHIPPED      — paper has come away from corner; missing piece
    DESTROYED    — large chunk missing or corner crushed

  Final corners sub-grade tracks the WORST corner across both sides. Two
  soft corners with two sharp corners grade similarly to "soft" overall,
  not "average."

  Back corners are weighted less heavily than front corners — the front/back
  Robograde split (16/4) reflects this. But a chipped back corner still
  caps the predicted PSA grade; back damage is not invisible, just less
  weighted than front damage.

EDGES — descriptive, four-edge inventory.
  Inspect top, bottom, left, right edges across both front and back. Edges
  are physical card boundaries — defects on the edge are the same defects
  whether viewed from front or back.

  Defects to look for:
    - Edge wear (whitening along edge from handling)
    - Notching (small nicks from improper storage)
    - Chipping (paper breakaway along edge)
    - Roughness (fibers visible from rough cutting or wear)
    - Edge tears

  Vintage cards (pre-1980) commonly have rougher edges from manufacturing
  cutting blades — this is NOT a defect. Modern cards (1990+) have much
  cleaner factory edges, so any visible edge wear on a modern card weighs
  more heavily than equivalent wear on a vintage card.

SURFACE — descriptive, full-card inspection on BOTH sides.
  Inspect front and back surfaces under good light AND raking light.
  Report defects per side separately when assigning Robograde sub-scores.

  Defects to look for:
    - Print defects (lines, dots, ink spots — usually run-wide on vintage)
    - Print snow (small white specks from press defects)
    - Scratches (from handling, sleeves, surface contact)
    - Scuffs (gloss disturbed without paper damage)
    - Wax stains (dark spots from candy-wax wrappers — vintage only,
      PSA explicitly accepts on reverse)
    - Whitening (fiber damage from creases, even hairline)
    - Color shift / fading
    - Print bleeding (color migration on chrome / foil cards)
    - Stains (foreign substance on surface)
    - Indentations (from pressure marks)
    - CREASES — CRITICAL. Even a single hairline crease typically caps
      grade at PSA 4. Color-breaking creases cap at PSA 3-4. Heavy
      creases cap at PSA 2-3. Multiple creases typically PSA 1-2.

  Holographic / refractor / chrome cards have unique surface defects:
    - Holo bleeding: color migration along holo pattern boundaries
    - Holo scratching: micro-scratches in holo layer (visible only at
      certain angles, often only in macro photos)
    - Print snow on holo: small white specks especially noticeable on
      darker holo areas

  Surface is the most common sub-grade KILLER on otherwise high-grade
  cards. A card can have perfect centering, sharp corners, and clean
  edges yet grade PSA 4 because of a single visible crease.
`;


// ─── ROLLUP RULES ───────────────────────────────────────────────────────────

const PSA_ROLLUP_RULES = `
HOW SUB-GRADES ROLL UP TO FINAL GRADE
======================================

PSA does not publish an explicit formula. The empirical pattern is:

1. WORST-AXIS PRINCIPLE
   The final PSA grade is typically equal to the worst sub-grade, NOT an
   average. A card with Centering 9 / Corners 9 / Edges 9 / Surface 4
   grades PSA 4, not PSA 8. Sub-grade outliers drag the whole card.

2. CENTERING IS A HARD CEILING
   If centering measures worse than 90/10, no half-point grade above PSA 2
   is achievable, regardless of other axes.
   If centering is 60/40, PSA 9 is the maximum even with perfect corners,
   edges, and surface.

3. EYE APPEAL CAN ADD HALF A POINT
   When a card meets the next-grade-up's standards on three of four axes
   and presents well overall, PSA graders will award the half-point step
   (e.g. card with 8-quality centering but 9-quality everything else may
   grade PSA 8.5).

4. CREASES ARE NEAR-FATAL
   A single hairline non-color-breaking crease typically caps grade at
   PSA 4-5. A color-breaking crease caps at PSA 3-4 even when otherwise
   immaculate. Heavier creases cap at PSA 2-3. Multiple creases typically
   PSA 1-2. This rule overrides all other sub-grade considerations.

5. ALTERATION IS DISQUALIFYING
   Trimming, recoloring, or restoration drops the card to Authentic Altered
   (AA), which has no numeric grade. Robograder predicting altered should
   declare it explicitly rather than guessing a number.

6. MISSING PIECES
   Cards missing solid paper pieces cannot grade PSA 1.5 or higher. Even
   a tiny corner chip excludes 1.5 — the card must be fully intact.
   Trace surface chips that don't extend through the paper layer can still
   qualify above PSA 1.

7. VINTAGE BIAS
   Cards 1980 or older are graded with awareness of period manufacturing
   variance: rough cuts, off-register printing, wax staining, slight
   miscuts — all common factory artifacts that don't impact grade as
   harshly as the same defects would on modern cards.
`;


// ─── ROBOGRADE OUTPUT SCHEMA FOR CARDS ──────────────────────────────────────

const ROBOGRADE_CARDS_SCHEMA = `
ROBOGRADE 0-100 DECOMPOSITION FOR CARDS
========================================

The Robograde score is built from four sub-axes that sum to 0-100. All
sub-scores are integers.

Surface:    0-50
  Front     0-40   (creases, scratches, scuffs, print defects, holo issues, stains)
  Back      0-10   (back-side defects of all types above)

Centering:  0-10
  Front     0-8    (L/R + T/B combined)
  Back      0-2

Corners:    0-20
  Front     0-16   (4 corners × 4 points each)
                   Per corner: 4 = pristine, 3 = sharp, 2 = slight fray,
                   1 = minor blunt, 0 = soft/blunt/chipped/destroyed
  Back      0-4    (4 corners × 1 point each: 1 = sharp, 0 = anything notable)

Edges:      0-20   (all four edges, front+back assessed together)
                   20 = pristine, 15 = light wear, 10 = visible wear/notching,
                   5 = significant chipping, 0 = severe damage

Total:      0-100

The Robograde score reflects cumulative damage and is calculated by
distributing point losses based on observed defects. The PREDICTED PSA
GRADE is a separate determination using the worst-axis principle and the
rollup rules above. These are two complementary lenses on the same card.

SURFACE SCORING — BANDS + ACCUMULATION. Score by descriptive bands and
accumulation caps, NOT by subtracting a fixed number of points per defect. (This
deliberately mirrors the COMIC grading philosophy — Robograder is one grading
philosophy across item types; card and comic standards differ, but the METHOD of
turning defects into a score is the same.)
  Front surface (0-40): 40 pristine | 37-39 single trace | 33-36 small/trace
    accumulation | 28-32 minor accumulation | 22-27 moderate accumulation or one
    significant defect | 14-21 substantial wear or a major defect | 6-13 major |
    0-5 severe. Back surface (0-10) follows the same idea at 1/4 scale.
  SEVERITY describes a single defect's weight (LOW = faint/minor, MED = clearly
  visible, HIGH = grade-defining) — it is NOT a fixed point value.
  ACCUMULATION CAP (mirrors the comic LIGHT-ACCUMULATION rule): even when EVERY
  surface defect is individually LOW, a card carrying 4+ visible LOW surface defects
  (or light wear across multiple regions) is NOT a near-pristine surface — front
  surface MUST be <= 30 (about one full grade off), never 33+. Do not let each
  defect being "light" talk the surface up. A near-40 surface is clean or shows
  only one or two trace marks.
  Corners and Edges use their bands above; apply the same accumulate-don't-forgive
  logic — repeated slight fraying / light edge wear across multiple corners or edges
  compounds and moves those axes down rather than averaging out high.
`;


const PSA_OUTPUT_SCHEMA = `
RESPOND WITH A SINGLE JSON OBJECT MATCHING THIS SCHEMA EXACTLY.
DO NOT include any text outside the JSON.

{
  "version": "0.2",
  "cardIdentification": {
    "name": "<card name as printed>",
    "set": "<set name>",
    "number": "<card number, e.g. '025/094' or 'RC24/RC25'>",
    "year": <year as integer>,
    "illustrator": "<illustrator name if visible>",
    "variant": "<e.g. 'Reverse Holo Uncommon', 'Full-Art Ultra Rare', 'Standard'>",
    "printing": "<1st Edition | Shadowless | Unlimited for vintage WOTC sets (Base/Jungle/Fossil/Base Set 2); else null>"
  },
  "psaGrade": <number 1.0-10.0 in 0.5 increments, OR string "AUTHENTIC", OR string "AA">,
  "confidence": <integer 1-10 representing certainty>,
  "robograde": {
    "total": <integer 0-100>,
    "surface": {
      "total": <integer 0-50>,
      "front": <integer 0-40>,
      "back":  <integer 0-10>
    },
    "centering": {
      "total": <integer 0-10>,
      "front": <integer 0-8>,
      "back":  <integer 0-2>,
      "frontRatio": "<ALWAYS both axes: '<l>/<r> L/R, <t>/<b> T/B' e.g. '55/45 L/R, 60/40 T/B'. Measure from the visible border even if approximate; do NOT omit and do NOT say 'cannot assess'>",
      "backRatio":  "<same format — ALWAYS include BOTH L/R and T/B for the back too>"
    },
    "corners": {
      "total": <integer 0-20>,
      "front": <integer 0-16>,
      "back":  <integer 0-4>,
      "perCorner": {
        "frontTopLeft":     "<PRISTINE | SHARP | SLIGHT FRAY | MINOR BLUNT | SOFT | HEAVY BLUNT | CHIPPED | DESTROYED>",
        "frontTopRight":    "<same scale>",
        "frontBottomLeft":  "<same scale>",
        "frontBottomRight": "<same scale>",
        "backTopLeft":      "<same scale>",
        "backTopRight":     "<same scale>",
        "backBottomLeft":   "<same scale>",
        "backBottomRight":  "<same scale>"
      }
    },
    "edges": {
      "total": <integer 0-20>,
      "top":    "<CLEAN | LIGHT WEAR | NOTCHING | CHIPPING | ROUGH | TEAR>",
      "bottom": "<same scale>",
      "left":   "<same scale>",
      "right":  "<same scale>"
    }
  },
  "defects": {
    "creases":     [ "<what, where SEV>" ],
    "scratches":   [ "<what, where SEV>" ],
    "printDefects":[ "<what, where SEV>" ],
    "stains":      [ "<what, where SEV>" ],
    "edgeIssues":  [ "<what, where SEV>" ],
    "other":       [ "<what, where SEV>" ]
  },
  "alterationFlags": [
    "<TRIMMED | RECOLORED | RESTORED | CLEANED | NONE — list each detected>"
  ],
  "eyeAppeal": "<EXCEPTIONAL | STRONG | AVERAGE | BELOW AVERAGE | POOR>",
  "graderNotes": "<2-3 sentences, ~55 words MAX (must fit ~8 lines on a phone). PSA grader-note style: defect-first, location-specific, no hedging. Summarize the grade-limiting defects; do NOT re-list every defect from the arrays above>",
  "limitingAxis": "<which sub-grade was the lowest and why>",
  "reasoning": "<one paragraph: why this grade vs the adjacent ones>",
  "photograder": {
    "focus":    "<A | B | C>",
    "lighting": "<A | B | C>",
    "cropping": "<A | B | C>",
    "angle":    "<A | B | C>",
    "flags": [ { "category": "<focus | lighting | cropping | angle>", "image": "<which photo: Front, Back, Top Macro, or Bottom Macro>", "note": "<one terse reason this photo scored B or C and how to reshoot it>" } ]
  },
  "_diagnostics": {
    "referenceImageUsed":  <true | false>,
    "macrosProvided":      <true | false>,
    "rakingProvided":      <true | false>,
    "highGradeFlow":       <true | false>
  }
}
`;


// ─── PHOTO FLOW ─────────────────────────────────────────────────────────────

const CARD_PHOTO_FLOW = `
EXPECTED PHOTO INPUTS
======================

The standard 4-photo set for cards (every assessment):
  1. FRONT — square-on, diffuse light. Used for centering measurement,
     surface inspection, card identification.
  2. BACK — square-on, diffuse light. Used for back centering, back
     surface inspection.
  3. FRONT TOP MACRO — close shot capturing both top corners and the
     top edge. Primary detection channel for corner sharpness, top
     edge wear, and upper-region surface defects (especially creases).
  4. FRONT BOTTOM MACRO — close shot capturing both bottom corners
     and the bottom edge. Same purpose for the lower region.

The high-grade refinement set (4 additional photos, when standard score
indicates Robograde 80+ or PSA 7+):
  5. BACK TOP MACRO — back-side corners and top edge from the back.
  6. BACK BOTTOM MACRO — back-side corners and bottom edge from the back.
  7. FRONT RAKING — supplementary surface check, catches occasional
     subtle indentation or holo bleed that macros miss at their angle.
  8. BACK RAKING — same purpose for back surface.

CRITICAL: For cards, MACROS ARE THE PRIMARY surface-defect detection
channel, not raking light. Cards are rigid; raking light produces
weaker shadows than on flexible comic covers. Color-breaking creases
that are clearly visible in a macro photo can be invisible at
standard resolution. When evaluating surface, weight macro evidence
heavily and treat raking as a secondary signal.

When fewer than 4 standard photos are provided, lower the confidence
score accordingly and explicitly note in the reasoning what could not
be assessed.
`;


// ─── CALIBRATION NOTES ──────────────────────────────────────────────────────

const CALIBRATION_NOTES = `
CALIBRATION NOTES
==================

These reflect Robograder's calibrated stance and accumulated learnings.

- Modern cards (1990+) are graded with TIGHTER tolerances than vintage.
  Period manufacturing variance is forgiven on pre-1980 cards (rough
  cuts, off-register printing, wax stains on reverse all common). On
  modern cards, the same defects weigh fully.

- Do NOT cap grades artificially out of caution. If a card meets PSA 9
  standards on every visible axis, predict PSA 9 — not PSA 8 to be safe.
  Conservative bias produces consistently-low grades that destroy user
  trust.

- However, when a SINGLE major defect (visible crease, missing piece,
  alteration suspicion) is present, that defect dominates the grade
  regardless of how clean every other axis is. The worst-axis principle
  is non-negotiable.

- Photographic centering measurement has ±5% error from camera angle.
  When centering is at a grade boundary, give the benefit of the doubt
  unless the photo angle is clearly poor. Conversely, when centering
  appears well within tolerance, do not artificially downgrade for
  measurement uncertainty.

- The card may be in a sleeve, top-loader, or PSA holder. Reflections
  from the plastic can mimic surface defects. Distinguish: a defect
  that follows the card surface as the angle changes is a defect; one
  that follows the holder as the angle changes is a reflection.

- If the card is in a PSA holder with a visible grade label, IGNORE
  the printed grade. Grade the card on its visual merits as if it
  were raw. The purpose is to predict what PSA WOULD grade today, which
  is the same task whether or not the card has been graded already.
`;


// ─── COMPLETE GRADING PROMPT ────────────────────────────────────────────────

function buildPSACardGradingPrompt(opts = {}) {
  const {
    referenceImageProvided = false,
    referenceCardName = null,
    photoCountProvided = 4,
    isHighGradeFlow = false,
  } = opts;

  const referenceContextBlock = referenceImageProvided
    ? `

REFERENCE IMAGE PROVIDED
========================

A clean reference image of ${referenceCardName || 'this exact card'} has been
included in the assessment. Use it as the visual baseline for what the card
looks like when undamaged. Any deviation between the user's card and the
reference is potential evidence of a defect — but be careful to distinguish
genuine defects from photographic artifacts (lighting, angle, camera noise,
holder reflections).

The reference image shows ideal printing, centering, color, and gloss for
this card. Compare the user's card region-by-region.
`
    : '';

  const photoContextBlock = `

PHOTOS PROVIDED IN THIS ASSESSMENT: ${photoCountProvided}
${isHighGradeFlow ? 'High-grade refinement flow: macros for both front and back are expected.' : 'Standard flow.'}

${CARD_PHOTO_FLOW}
`;

  return `You are Robograder, an expert trading card grader applying PSA grading
standards combined with the proprietary Robograde 0-100 scoring system.

You are looking at photographs of a single trading card. Your job is to:
  1. Identify the card (name, set, number, year, illustrator, variant)
  2. Assess condition across the four PSA sub-grade axes
  3. Predict the PSA grade the card would most likely receive
  4. Compute the Robograde 0-100 score from the sub-grade observations
  5. Grade the PHOTO QUALITY separately from the card, in "photograder": for each of
     focus, lighting, cropping, angle give A (good), B (minor issue), or C (poor —
     actively limited the assessment). This grades the PHOTOS, not the card.
     ANGLE — IMPORTANT: the Top Macro and Bottom Macro are SUPPOSED to be shot at an
     angle; the capture guide frames them tilted so the corners and edges can be read.
     NEVER dock "angle" for a macro being tilted — judge "angle" ONLY on the Front and
     Back (which should be square-on). A macro's job is corners/edges, so softness away
     from the edge is not a "focus" fault either.
     For EVERY axis graded B or C, add ONE "photograder.flags" entry for the affected
     image. Keep notes EXTREMELY terse — 6 words MAX, plain and actionable, no jargon.
     Format: "<Axis> - <Image> - <short fix>".
       Good: "Lighting - Front - Reduce glare with diffuse light."
       Bad:  long clinical descriptions of the defect and optics.
     If all four axes are A, "flags" is an empty array.

DEFECT LIST STYLE (applies to every entry in "defects"):
  - Terse list items, NOT full sentences. No trailing period.
  - Format: "<what>, <where> <SEV>" where SEV is HIGH, MED, or LOW. The condition
    word (fray, wear, scratching, mottling...) is part of <what>; SEV is the
    separate severity token, always last. Example:
      "Faint scratching, orange text box below Mud Shot LOW"
      "Mottling, lower attack box, typical for SSP reverse holos LOW"
  - List ONLY real defects. NEVER write entries that describe clean, undamaged,
    or factory-normal areas, or the ABSENCE of a defect (e.g. "no roller marks",
    "border shows uniform color"). If an area is fine, say nothing about it.
  - Treat the card as a single 3-D object seen across the front and back photos.
    The front bottom-left corner is the SAME physical corner as the back
    bottom-right. Name left/right consistently to the face you cite, and do not
    report one physical corner/edge as two separate defects.

Operate in two phases.

PHASE 1 — NEUTRAL OBSERVATION
Inspect each photo carefully. Inventory every defect you see across all four
PSA sub-grade axes: Centering, Corners, Edges, Surface. Use the rubric below.
Do NOT decide on a final grade yet. List what you see, region by region.

PHASE 2 — GRADE ASSIGNMENT
Apply the rollup rules. Identify the limiting axis. Assign a final PSA grade
and compute the Robograde score. Half-point grades (1.5, 2.5, 3.5, ..., 8.5)
are available between PSA 2 and 9 when a card exceeds its base tier on every
axis except one.

${PSA_GRADE_TIERS}

${PSA_SUBGRADE_RUBRIC}

${PSA_ROLLUP_RULES}

${ROBOGRADE_CARDS_SCHEMA}

${photoContextBlock}
${referenceContextBlock}

${CALIBRATION_NOTES}

${PSA_OUTPUT_SCHEMA}
`;
}


// ─── EXPORTS ────────────────────────────────────────────────────────────────

function buildPSACardDeepPrompt(opts = {}) {
  const prior = opts.initialAssessment || {};
  const priorJson = JSON.stringify({
    cardIdentification: prior.cardIdentification,
    psaGrade: prior.psaGrade,
    robograde: prior.robograde,
    defects: prior.defects,
    graderNotes: prior.graderNotes,
    limitingAxis: prior.limitingAxis,
  }, null, 2);
  return `You are Robograder performing a DEEP ASSESSMENT — a focused refinement of an
EXISTING trading-card grade using 4 new high-detail photos, provided in THIS order:
  1. FRONT RAKING      — front surface under angled light (scratches, indentations, print lines, holo/foil issues).
  2. BACK RAKING       — back surface under angled light.
  3. BACK TOP MACRO    — back top-left & top-right corners + the top edge, close up.
  4. BACK BOTTOM MACRO — back bottom-left & bottom-right corners + the bottom edge, close up.

You are NOT re-grading from scratch. The INITIAL ASSESSMENT below is authoritative.
Revise ONLY what these new photos can actually inform:
  - Surface FRONT   -> from the FRONT RAKING photo.
  - Surface BACK    -> from the BACK RAKING photo.
  - Corners BACK    -> from the two BACK MACRO photos.
  - Edges           -> from the two BACK MACRO photos (top/bottom edges especially).
Carry forward UNCHANGED unless a new photo gives explicit, high-confidence reason to change:
  - Centering (front and back), Corners FRONT, and cardIdentification.

Rules:
  - Any NEW defect the deep photos reveal goes into the appropriate defects[] list, with its
    text prefixed "[deep] ".
  - Recompute robograde.total from the revised sub-scores, and re-derive psaGrade using the
    rollup rules below (worst-axis principle).
  - Narrow "confidence" (you have more evidence now).
  - In graderNotes/reasoning, note any change from the initial grade and why.
  - Set _diagnostics.rakingProvided = true and _diagnostics.highGradeFlow = true.

INITIAL ASSESSMENT (authoritative — preserve every field unless the new photos clearly change it):
${priorJson}

${PSA_ROLLUP_RULES}

${PSA_OUTPUT_SCHEMA}`;
}


const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const IDENTIFY_MODEL = 'claude-haiku-4-5-20251001';   // cheap identification pass
const GRADE_MODEL = 'claude-opus-5';                  // matches assess.js PRIMARY_MODEL

const IDENTIFY_PROMPT =
  'You are looking at the FRONT of a single trading card (most likely Pokémon). ' +
  'Identify it. Respond with ONLY a JSON object and nothing else: ' +
  '{"name": string, "set": string|null, "number": string|null, "year": number|null, "variant": string|null, "illustrator": string|null, "printing": string|null}. ' +
  'For "number" use the printed collector number exactly as shown (e.g. "025/094" or "RC24/RC25"). ' +
  'For "illustrator" use the artist credit usually printed in small text near the bottom of the card. ' +
  'For "printing" (ONLY for vintage WOTC Pokémon — Base Set, Jungle, Fossil, Base Set 2; else null): ' +
  'return "1st Edition" if the black circular "Edition 1" stamp is present to the lower-left of the artwork; ' +
  'otherwise "Shadowless" if the artwork frame has NO drop-shadow along its right and bottom edges (Base Set only, and the set/copyright line usually reads 1999); ' +
  'otherwise "Unlimited". ' +
  'If a field is not legible, use null.';

function normalizeMediaType(mt) {
  if (!mt) return 'image/jpeg';
  const clean = mt.toLowerCase().split(';')[0].trim();
  if (['image/jpeg', 'image/png', 'image/gif', 'image/webp'].includes(clean)) return clean;
  if (clean === 'image/jpg') return 'image/jpeg';
  return 'image/jpeg';
}

// A client data-URL ("data:image/jpeg;base64,....") -> Anthropic image block.
function toImageBlock(dataUrl) {
  const [header, data] = String(dataUrl).split(',');
  const m = header && header.match(/data:(.*);base64/);
  return { type: 'image', source: { type: 'base64', media_type: normalizeMediaType(m && m[1]), data } };
}

async function fetchTimeout(url, options = {}, timeoutMs = 8000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try { return await fetch(url, { ...options, signal: controller.signal }); }
  finally { clearTimeout(timer); }
}

// Anthropic messages call returning the first text block; one retry on failure.
async function anthropicText(apiKey, body, timeoutMs) {
  const headers = { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' };
  let lastErr;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const r = await fetchTimeout(ANTHROPIC_URL, { method: 'POST', headers, body: JSON.stringify(body) }, timeoutMs);
      if (!r.ok) { lastErr = new Error('anthropic ' + r.status + ': ' + (await r.text()).slice(0, 300)); continue; }
      const j = await r.json();
      const tb = Array.isArray(j.content) ? j.content.find(b => b.type === 'text') : null;
      return { text: tb ? tb.text : '', usage: j.usage || null, model: j.model || body.model };
    } catch (e) { lastErr = e; }
  }
  throw lastErr || new Error('anthropic call failed');
}

// Pull the first balanced {...} JSON object out of a model response.
function extractJson(text) {
  if (!text) return null;
  const start = text.indexOf('{');
  if (start === -1) return null;
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false; continue; }
    if (c === '"') inStr = true;
    else if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) { try { return JSON.parse(text.slice(start, i + 1)); } catch { return null; } } }
  }
  return null;
}

// Free reference scan from TCGdex (tcgdex.dev) — NO API key. Best-effort;
// returns an Anthropic image block + resolved name, or null. (pokemontcg.io moved
// to the paid Scrydex service in 2026; TCGdex is the free, keyless replacement.)
async function fetchPokemonReference(ident) {
  const name = (ident && ident.name || '').trim();
  if (!name) return null;
  const listResp = await fetchTimeout('https://api.tcgdex.net/v2/en/cards?name=' + encodeURIComponent(name), {}, 6000);
  if (!listResp.ok) return null;
  const list = await listResp.json();
  if (!Array.isArray(list) || !list.length) return null;
  const num = String((ident && ident.number) || '').split('/')[0].replace(/[^0-9A-Za-z]/g, '').replace(/^0+/, '');
  const withImg = list.filter(c => c && c.image);
  const pick = (num && withImg.find(c => String(c.localId || '').replace(/^0+/, '') === num)) || withImg[0] || null;
  if (!pick) return null;
  // TCGdex `image` is a base URL; append quality + extension. PNG for Anthropic compat.
  const imgResp = await fetchTimeout(pick.image + '/high.png', {}, 8000);
  if (!imgResp.ok) return null;
  const buf = Buffer.from(await imgResp.arrayBuffer());
  return { block: { type: 'image', source: { type: 'base64', media_type: 'image/png', data: buf.toString('base64') } }, name: pick.name || name };
}

async function verifyUid(req) {
  try {
    const auth = req.headers.authorization || req.headers.Authorization || '';
    const m = auth.match(/^Bearer\s+(.+)$/);
    if (!m) return null;
    if (!process.env.FIREBASE_SERVICE_ACCOUNT) return null;
    const { initializeApp, getApps, cert } = await import('firebase-admin/app');
    const { getAuth } = await import('firebase-admin/auth');
    if (!getApps().length) initializeApp({ credential: cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)) });
    const decoded = await getAuth().verifyIdToken(m[1]);
    return decoded.uid;
  } catch (e) { console.warn('[assess_card] auth failed:', e && e.message); return null; }
}

const RATES = {
  'claude-opus-5':               { in: 5 / 1e6, out: 25 / 1e6 },
  'claude-opus-4-8':             { in: 5 / 1e6, out: 25 / 1e6 },
  'claude-haiku-4-5-20251001':   { in: 1 / 1e6, out: 5 / 1e6 },
};
const rateFor = m => RATES[m] || { in: 5 / 1e6, out: 25 / 1e6 };

// Fire-and-forget: write a card assessment to assessment_timings so it shows in
// the admin Logs tab with a real dollar cost (cards have no prompt caching).
async function logCardTiming(kind, info) {
  try {
    const { getFirestore } = await import('firebase-admin/firestore');
    const db = getFirestore();
    if (!db) return;
    let cost = 0, inTok = 0, outTok = 0;
    for (const c of (info.calls || [])) {
      const u = c.usage || {}; const r = rateFor(c.model);
      const i = u.input_tokens || 0, o = u.output_tokens || 0;
      inTok += i; outTok += o; cost += i * r.in + o * r.out;
    }
    const key = kind + '_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
    await db.collection('assessment_timings').doc(key).set({
      kind: kind,                    // 'card_main' | 'card_deep'
      itemType: 'card',
      uid: info.uid || null,
      createdAt: new Date().toISOString(),
      totalMs: info.ms || null,
      inputTokens: inTok,
      outputTokens: outTok,
      costUsd: +cost.toFixed(6),
      model: GRADE_MODEL,
      predictedGrade: info.psa != null ? String(info.psa) : null,
      rgScore: info.rg != null ? info.rg : null,
      cardName: info.name || null,
    });
  } catch (e) { console.error('[assess_card] timing write failed (non-fatal):', e); }
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not set' });

  const uid = await verifyUid(req);
  if (!uid) return res.status(401).json({ error: 'Unauthorized' });

  const body = req.body || {};
  const images = Array.isArray(body.images) ? body.images.filter(Boolean) : [];
  if (!images.length) return res.status(400).json({ error: 'At least a front photo is required' });
  const highGrade = !!body.highGrade;

  const t0 = Date.now();
  const userBlocks = images.map(toImageBlock);

  // DEEP mode (revise pattern, like Comic Deep): prior assessment + the 4 new
  // Deep photos only (Front Raking, Back Raking, Back Top Macro, Back Bottom
  // Macro). No identify/reference pass; identity is carried from the prior grade.
  if (body.deep && body.initialAssessment && typeof body.initialAssessment === 'object') {
    const deepPrompt = buildPSACardDeepPrompt({ initialAssessment: body.initialAssessment });
    const deepContent = [...userBlocks, { type: 'text', text: deepPrompt }];
    let deepCard, _deepUsage = null;
    try {
      const out = await anthropicText(apiKey, {
        model: GRADE_MODEL, max_tokens: 16384,
        messages: [{ role: 'user', content: deepContent }],
      }, 120000);
      deepCard = extractJson(out.text);
      _deepUsage = out.usage || null;
      if (!deepCard) return res.status(502).json({ error: 'Could not parse deep grade JSON from model', raw: (out.text || '').slice(0, 500) });
    } catch (e) {
      console.error('[assess_card] deep grade failed:', e && (e.stack || e.message));
      return res.status(502).json({ error: (e && e.message) || 'Deep grade failed' });
    }
    const _pc = body.initialAssessment.cardIdentification || {};
    const _dc = deepCard.cardIdentification = deepCard.cardIdentification || {};
    for (const k of ['name', 'set', 'number', 'year', 'variant', 'illustrator', 'printing']) {
      if ((_dc[k] == null || _dc[k] === '') && _pc[k] != null && _pc[k] !== '') _dc[k] = _pc[k];
    }
    console.log('[assess_card] DEEP uid=' + uid + ' psa=' + deepCard.psaGrade + ' rg=' + (deepCard.robograde && deepCard.robograde.total) + ' ' + (Date.now() - t0) + 'ms');
    await logCardTiming('card_deep', { uid, ms: Date.now() - t0, calls: [{ model: GRADE_MODEL, usage: _deepUsage }], psa: deepCard.psaGrade, rg: deepCard.robograde && deepCard.robograde.total, name: deepCard.cardIdentification && deepCard.cardIdentification.name });
    return res.status(200).json({ card: deepCard, deep: true });
  }

  // 1) Identify (cheap) — best-effort; grading still runs if this fails.
  let identification = {};
  let _idUsage = null, _gradeUsage = null;
  try {
    const idOut = await anthropicText(apiKey, {
      model: IDENTIFY_MODEL, max_tokens: 200,
      messages: [{ role: 'user', content: [userBlocks[0], { type: 'text', text: IDENTIFY_PROMPT }] }],
    }, 15000);
    identification = extractJson(idOut.text) || {};
    _idUsage = idOut.usage || null;
  } catch (e) { console.warn('[assess_card] identify failed:', e && e.message); }

  // 2) TCGdex reference scan — best-effort.
  let referenceBlock = null, referenceUsed = false, referenceName = null;
  try {
    const ref = await fetchPokemonReference(identification);
    if (ref) { referenceBlock = ref.block; referenceUsed = true; referenceName = ref.name; }
  } catch (e) { console.warn('[assess_card] reference fetch failed:', e && e.message); }

  // 3) Grade.
  const prompt = buildPSACardGradingPrompt({
    referenceImageProvided: referenceUsed,
    referenceCardName: referenceName,
    photoCountProvided: images.length,
    isHighGradeFlow: highGrade,
  });
  const content = [...userBlocks];
  if (referenceBlock) content.push(referenceBlock);
  content.push({ type: 'text', text: prompt });

  let card;
  try {
    const gradeOut = await anthropicText(apiKey, {
      model: GRADE_MODEL, max_tokens: 16384,
      messages: [{ role: 'user', content }],
    }, 120000);
    card = extractJson(gradeOut.text);
    _gradeUsage = gradeOut.usage || null;
    if (!card) return res.status(502).json({ error: 'Could not parse grade JSON from model', raw: (gradeOut.text || '').slice(0, 500) });
    // Backfill identity from the cheap identify pass so the card-detail Details
    // block (Set / Number / Year / Artist / Variant) is reliably populated even
    // when the grading model omits a field. Grading values win; identify fills gaps.
    const _idc = identification || {};
    const _cc = card.cardIdentification = card.cardIdentification || {};
    for (const k of ['name', 'set', 'number', 'year', 'variant', 'illustrator', 'printing']) {
      if ((_cc[k] == null || _cc[k] === '') && _idc[k] != null && _idc[k] !== '') _cc[k] = _idc[k];
    }
  } catch (e) {
    console.error('[assess_card] grade failed:', e && (e.stack || e.message));
    return res.status(502).json({ error: (e && e.message) || 'Grade failed' });
  }

  console.log('[assess_card] uid=' + uid + ' card="' + (card.cardIdentification && card.cardIdentification.name) + '" psa=' + card.psaGrade + ' rg=' + (card.robograde && card.robograde.total) + ' ref=' + referenceUsed + ' ' + (Date.now() - t0) + 'ms');
  await logCardTiming('card_main', { uid, ms: Date.now() - t0, calls: [{ model: GRADE_MODEL, usage: _gradeUsage }], psa: card.psaGrade, rg: card.robograde && card.robograde.total, name: card.cardIdentification && card.cardIdentification.name });
  return res.status(200).json({ ok: true, card, identification, referenceUsed, ms: Date.now() - t0 });
}
