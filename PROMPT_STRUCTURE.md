# Robograder Prompt Architecture

This document defines the canonical structure of the assessment system prompt sent to Claude on every comic grading. It exists because the prompt has, over many sessions, accumulated patches in places where they don't belong — making each new addition harder to write and the overall flow harder for the model to follow.

**Every change to `api/assess.js` system prompt must conform to this structure.** New rules go in the phase that owns them. If a rule doesn't fit cleanly in any phase, that is a signal that the rule may be unnecessary, or that the architecture needs to be revisited deliberately, not that the rule should be wedged in somewhere.

## Why this structure exists

The model produces a grade by working through a logical sequence: figure out what it's looking at, inspect it, score it, verify the score, and emit the result. When prompt content is ordered consistently with this sequence, the model spends less effort on internal reordering and produces results faster and more consistently. When inspection rules appear after scoring rules (as happened in earlier prompt versions), the model has to either (a) re-read inspection rules during scoring or (b) score without applying them — both bad outcomes.

## The five phases

### Phase 0 — Gate Check

**Purpose:** Decide whether and what to assess. Identify the book.

**Owns:**
- Is the submitted item something that can be assessed (comic vs magazine vs non-comic image vs nothing)?
- Are the images adequate (focus, framing, completeness — back cover present, etc.)?
- What is this book? Title, issue, publication date, publisher.
- Is this an original printing, a facsimile, a reprint, or a variant? (Printing detection.)
- Pull the ComicVine clean-cover reference for use later in Phase 1.

**Does NOT own:** any defect-level inspection, any scoring logic, any grade-tier knowledge.

**External integrations:** ComicVine API (cover reference fetch — happens here, used in Phase 1).

**Output artifact:** identification metadata + a pass/fail/flag determination on whether to proceed.

### Phase 1 — Inspection

**Purpose:** Catalogue every defect present on the book. Determine page quality.

**Owns:**
- The full structural damage scan (tape, paper loss, tears around staples and edges) — these dominate the grade and must be caught first.
- Corner-by-corner inspection.
- Edge and surface inspection (creases, soiling, foxing, stress lines, color breaks).
- Spine tick inspection — count, color-breaking determination, location.
- Spine roll inspection — presence, severity description.
- Staple inspection — condition, rust, integrity.
- Page quality determination, anchored against the PQ reference image (`Grade_Reference/pq_psa.jpg`).
- Comparison against the ComicVine clean-cover reference to catch missing pieces and color loss.
- Color-break detection technique.
- Distinction between similar-looking defects (paper loss vs. blunting, foxing vs. soiling, etc.).

**Does NOT own:** scoring weights, severity-to-points conversion, grade-tier comparison. Inspection is pure cataloguing — what's there, where, how severe in descriptive terms. Translating that to numbers belongs to Phase 2.

**External integrations:** PQ reference image (`Grade_Reference/pq_psa.jpg`, fetched on every assessment). ComicVine cover reference (passed in from Phase 0).

**Output artifact:** a defect catalogue (list of defects with location, severity word, color-breaking flag, measurement when meaningful) + a page quality designation.

### Phase 2 — Grading

**Purpose:** Translate the defect catalogue into numerical scores and a predicted grade.

**Owns:**
- The RoboGrade scoring system (Front/Back/Spine/Interior components, point allocation per component).
- Severity word mapping to deductions (light/moderate/heavy → Low/Med/High → point ranges).
- Per-defect-type scoring rules (e.g., spine tick = -1/-2 per tick depending on color-breaking).
- Interior = 1:1 PQ map (no deductions to interior; staple/centerfold defects route to Spine).
- Score sum to RoboGrade.
- RoboGrade to predicted CGC grade mapping (initial determination).
- Severe-defect handling per the canonical CGC tier definitions (NOT a hard cap — gradient handling per the grade definitions).
- Multi-defect interaction (when a book has tape AND missing pieces AND a split, where does it land?).
- Enhancement tagging (which defects are pressing/cleaning candidates).

**Does NOT own:** defect detection or description (Phase 1), grade verification (Phase 3).

**External integrations:** None. Phase 2 is pure logic over the Phase 1 catalogue.

**Output artifact:** sub-scores, RoboGrade, candidate CGC grade, enhancement flags.

### Phase 3 — Confirming

**Purpose:** Verify the candidate grade against canonical CGC definitions and reject or adjust if it doesn't fit.

**Owns:**
- The canonical CGC grade tier definitions (10.0 through NG).
- The grade verification step: read the candidate grade's definition AND one grade above AND one grade below. Confirm the candidate is the best fit. If a neighboring grade describes the book's actual defects better, switch.
- CGC census consultation (`api/census.js` — top ~2,359 most-graded issues, with population, average grade, and distribution percentages at 9.8/9.6/9.4 etc.). Census is consulted ONLY when the book matches the census table; otherwise skipped to save tokens. When present, census data is used as a calibration anchor against the candidate grade — does this book's defect profile justify a grade above, at, or below the population average for this issue? The grade can be adjusted based on census context, but census reasoning never appears in user-visible output (graderNotes, aiAssessment, labelNotes). All grade justifications cite observed defects, never population statistics.
- Logic for when reference image comparison (Grade_Reference/) should fire, if it ever does (currently disabled — Move B may reintroduce).

**Does NOT own:** any inspection or initial scoring. Phase 3 only second-guesses the grade Phase 2 produced.

**External integrations:** Canonical CGC grade tier definitions (in-prompt, sourced from `Grade_Reference/CGC_GRADE_DEFINITIONS.md`, injected via `gradeTierContext()` to send only the candidate ±1 tiers per assessment). CGC census (`api/census.js`, in-memory lookup on title + issue, returns formatted text when matched, empty otherwise). Grade reference images for Hulk 181 (`Grade_Reference/*.jpg`, currently disabled — pending Move B reintroduction).

**Output artifact:** the confirmed grade (possibly adjusted from Phase 2's candidate), plus an optional confirmation note for graderNotes.

### Phase 4 — Output

**Purpose:** Serialize the result into the JSON contract the application consumes.

**Owns:**
- The JSON schema and field-by-field documentation.
- Hard output limits (defect array max, sentence caps, etc.).
- Format rules for graderNotes, aiAssessment, labelNotes, keyInfo.
- Restrictions on what gets surfaced to the user (no census data, no internal reasoning, etc.).

**Does NOT own:** any logic that produces the values. Phase 4 only formats what Phases 0-3 produced.

**External integrations:** None. Phase 4 is pure serialization.

## Progress modal mapping

The progress modal shown to the user during an assessment displays five steps. These steps are user-facing labels for what's happening server-side and should be kept aligned with the actual phases as the architecture evolves. If technically feasible to wire the modal to advance based on actual phase completion (without slowing the assessment), do so; otherwise the modal is timed approximately and should reflect the canonical phase ordering.

| Modal step | Phase | What's happening |
|---|---|---|
| Populating Info | Phase 0 — Gate Check | Identifying title, issue, publisher, printing; fetching ComicVine reference |
| Comparing to Mint | Phase 1 — Inspection | Comparing user's photos to the ComicVine clean-cover reference to surface defects by difference |
| Page Quality Check | Phase 1 — Inspection | Assessing page tone against the PQ reference image |
| Grading | Phase 2 — Grading | Computing sub-scores, RoboGrade, and candidate predicted grade |
| Confirming Grade | Phase 3 — Confirming | Reading the candidate grade's CGC tier definition (and neighbors) to verify or adjust; consulting CGC census for the issue when available |

Phase 4 (Output) does not get its own modal step — it's the serialization that produces the JSON the modal then renders.

## What this means for adding rules

When a new rule is proposed, the first question is: which phase owns this?

- A rule about "the model should look for tape harder" → Phase 1 (Inspection).
- A rule about "tape on the book caps the grade at 2.5" → Phase 2 (Grading) or, more correctly, the CGC tier definitions in Phase 3, since CGC's actual treatment of tape is gradient by grade.
- A rule about "don't include census data in graderNotes" → Phase 4 (Output).
- A rule about "skip the assessment if the back cover is missing" → Phase 0 (Gate).
- A rule about "if the candidate grade is 4.5, check 4.0 and 5.0 too" → Phase 3 (Confirming).

If a proposed rule seems to belong in two phases, the most likely explanation is that the rule is doing two things and should be split.

If a proposed rule doesn't seem to belong in any phase, pause before adding it. The architecture is meant to cover the space — a rule that doesn't fit may be addressing a symptom of a deeper issue better fixed elsewhere.

## Deep Assessment

Deep Assessment (corner-macro second pass) is a different process and should eventually live in its own code path (`api/assess_deep.js` or similar). It does NOT run all 5 phases — it takes the initial assessment's output as input and asks a focused question: "do the corner macros change the Front or Spine scores?" Back and Interior remain frozen. New defects from the macros are tagged as Deep Assessment additions and may adjust the grade. Confidence range narrows because more evidence is in hand.

Deep Assessment has its own minimal phase structure:
- Phase 0 (deep): Validate the corner macros and the prior assessment payload.
- Phase 1 (deep): Inspect ONLY the corner macros for new defects.
- Phase 2 (deep): Apply any new defects to Front and/or Spine scores. Carry Back and Interior forward unchanged.
- Phase 3 (deep): Confirm the revised grade against canonical CGC definitions.
- Phase 4 (deep): Emit the revised JSON.

Deep Assessment as a separate code path is pending the Vercel function-count consolidation (currently at 12/12 Hobby ceiling).

## Changelog
- 2026-05-25: Initial document, Session 15. Author: foundation restoration pass after recognition that S13 inadvertently removed grade tier definitions during refinement-pass removal. Added progress modal mapping. Removed transitional "existing rules conformance" section, which described work in progress at the time of authoring. Added per-phase "External integrations" subsections after a code audit surfaced existing integrations (census, ComicVine, PQ reference) that had been missed when drafting the phase ownership lists from memory alone.
