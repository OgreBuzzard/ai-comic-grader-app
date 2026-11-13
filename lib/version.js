// lib/version.js
// v6.61: THE CROP TOOL WAS NEVER THE ONE DESTROYING PIXELS.
//
//   Matt: "the cropping tool needs to not permanently cut image data out that
//   the user can't move the handles back to recover." He also said the sides
//   were already gone *in* the tool - which was the clue, because the tool
//   cannot remove what it was never handed.
//
//   1. THE CAMERA WAS THROWING THE FRAME AWAY. #camera-video is
//      object-fit: cover, so the viewfinder is ALREADY a crop of the sensor
//      feed. cameraCapture() faithfully reproduced that crop: it computed the
//      visible source rect and drew only that. Everything outside the stage
//      aspect never reached the file. So a book shot with clear margin on all
//      four sides arrived at the cropper with the sides shaved, and no handle
//      could reach them because they did not exist.
//      Now the FULL video frame is captured. The viewfinder stays cover - it
//      is a viewfinder, and the black bars it avoids were a real complaint.
//      The cost is that a capture holds slightly more than the user framed on
//      whichever axis was clipping. That is the right direction to err: extra
//      background crops away, and the grader only ever sees what was kept.
//
//   2. AND THE CROP IS NOW REVERSIBLE. confirmCrop() replaced the slot image,
//      so the pre-crop frame was gone on Apply. The original is kept per slot
//      and openCropper loads THAT, with the previously applied box restored so
//      nothing looks different until the user drags - at which point the
//      handles move outward into pixels the last crop had removed. Only the
//      FIRST original is kept, so crop-recrop-recrop still gets back to the
//      camera frame rather than to the second-last crop. A reopen does not
//      re-run auto-crop: the user already chose that framing.
//
//      LIMIT, stated rather than discovered later: the originals live in
//      formData. Not in COMIC_DATA_FIELDS, never written to Firestore, and
//      what uploads to Storage is the CROPPED image. So a crop is reversible
//      while the entry is open and not after a save and reload. Recovering
//      across a save means keeping originals in Storage, which is a real
//      decision about cost and is not made here.
//
//   Build only. GRADING_EPOCH stays 6.55.
//
// v6.60: THE APP FROZE ON "ASSESSING..." AND THE BOOK WAS LOST. One-line bug.
//
//   window.matchFMV declared `const g = parseFloat(grade)` BELOW the variant
//   branch, and that branch's own loop reads `g`. So a book whose printing
//   classifies as "other" - a facsimile, a reprint, a later printing, a
//   variant - AND which has a manual FMV curve entered for its variant key
//   threw, from inside the loop:
//       ReferenceError: Cannot access 'g' before initialization
//   The throw escaped matchFMV -> fmvTierOf -> the 4200ms timeout in
//   mountResults that enables the COMPLETE button. The button stayed disabled
//   and said "ASSESSING..." forever. The grade was already computed and on
//   screen; the credit was already charged; there was no way to accept it, and
//   quitting the app lost the assessment. Matt hit it on a Fantastic Four #1
//   facsimile, 2026-11-13.
//
//   It survived because an ordinary printing never enters that branch. Every
//   book without a variant printing takes the other path and is fine.
//
//   THREE CHANGES, because the bug and the blast radius are separate problems:
//
//   1. `g` is parsed at the top of matchFMV, before any branch can read it.
//
//   2. mountResults' button callback is wrapped. Everything that decides what
//      the button SAYS can now throw and the catch still enables a plain
//      COMPLETE. A missing "DEEP UNLOCKED" label is a blemish; a frozen app
//      after taking someone's money is not. A disabled button is the one state
//      with no way out, so it must not depend on every branch behaving.
//
//   3. check-undefined-names.mjs gained no-use-before-define. no-undef CANNOT
//      see this class - `g` IS defined in scope, just later - and a
//      temporal-dead-zone read is a name that resolves to nothing at the moment
//      it runs, which is exactly what that script exists to catch. It is
//      ADVISORY, not fatal: ESLint judges textual position, not execution
//      order, so ~40 of its 41 current hits are a function body referring to a
//      `let` declared further down, which is safe. Failing on those would bury
//      the real one. Read them and ask "does this line run before that
//      declaration does?"
//
//   CROPPER GESTURE SAFE ZONE. Matt: Android reads a swipe that starts at the
//   screen edge as the back gesture and pulls the user out of the app, and the
//   e/w crop handles were sitting in that strip. #cropper-stage now has a
//   34px horizontal gutter (--crop-gutter), which puts the centre of an 18px
//   handle ~43px in from the edge - clear of both Android's back strip and
//   iOS's interactive-pop strip. Top and bottom stay 16px; there is no
//   horizontal-edge gesture to dodge and the image wants the height.
//
//   SESSION TAGS. 118 stray S23/S24/S25/S26 comment tags rewritten to S22
//   across 24 files. There is no Session 23. HOW_WE_WORK section 0 records
//   that 59 were corrected once already; these are the rest, and the count
//   in that doc was stale.
//
//   Build only. GRADING_EPOCH stays 6.55. (check-cache-prefix re-run after the
//   tag rewrite: prefixes unchanged.)
//
// v6.59: AUTO-CROP WAS DESTROYING PHOTOS. The 9:14 fallback is gone.
//
//   WHAT HAPPENED. Matt shot a book on a green mat with clear margin on all
//   four sides, and the cropper came up with both side edges of the book cut
//   off. The assessment then failed at the gate that needs to see whole edges.
//
//   IT WAS NOT THE DETECTOR. Auto-crop REFUSED on that frame, correctly. The
//   box he got was the OLD 9:14 default, which has been there since S22 and
//   which the v6.52 work left in place as a fallback. Measured off his
//   screenshot: the applied box was 0.63-0.66 aspect against 9:14 = 0.643.
//
//   WHY IT WAS ALWAYS WRONG. 9:14 is the aspect of a COMIC, not of a PHOTO OF
//   a comic. Imposing it on the canvas is only correct when the book already
//   fills the frame edge to edge - which is exactly the case where no crop was
//   needed. Every other time it cuts into the book.
//
//   WHY IT MATTERED SO MUCH. confirmCrop() REPLACES the stored image. A
//   default nobody asked for and nobody noticed permanently removed the edges
//   from the user's photo, and the edges are the thing the grader needs most.
//   An automatic action that destroys data has to be right far more often than
//   this was.
//
//   NOW: a box when the detector is confident, and otherwise the WHOLE IMAGE,
//   untouched. No crop is always recoverable; a wrong crop is not.
//
//   SKEW CORRECTION, Matt's ask. autocropAngle() fits a least-squares line to
//   the book's left edge and another to its right edge, from the first and
//   last not-background pixel in each row across the middle 70% of the book.
//   BOTH FITS MUST AGREE within 1.8 degrees - they are parallel on a real
//   book, so agreement is the evidence; disagreement means something other
//   than a book edge was traced and the answer is no rotation. Bounded to
//   0.4-12 degrees. When it fires, the book is re-detected on the DEROTATED
//   render, because the bounding box of a tilted book is larger than the book
//   on every side and the 1cm margin would not be 1cm otherwise.
//
//   HONEST STATUS: on the one real frame available (reconstructed from Matt's
//   screenshot) the detector still REFUSES - that photo has wood table behind
//   a green cutting mat behind the comic, and the ring heuristic finds the mat
//   rather than the book. That now costs nothing, but it means auto-crop will
//   often do nothing until it is tuned against real captures. Needs raw camera
//   files, not screenshots.
//
//   Build only. GRADING_EPOCH stays 6.55.
//
// v6.58: CALIBRATION STUDIO (shared/_WORKING/studio/) + the eBay issue fix.
//
//   EBAY, THE REAL BUG. The first debug dump showed what was actually wrecking
//   FF 1: the band contained Fantastic Four #5, #55, #7, #52 and #13. eBay's
//   keyword search returns ANY issue of a title, SLAB_RE read each one's grade
//   happily, and nothing anywhere checked the issue number. The reprints were
//   real but second-order; this was first-order and hit every book.
//   titleHasIssue() now requires the number as its own token — not preceded or
//   followed by a digit or a dot, and NOT followed by an ordinal suffix. That
//   last rule is the non-obvious one and it caught three of the nine live
//   listings on its own: comic titles are packed with "1st Appearance", and a
//   bare digit check reads every one of those as issue 1.
//   Also excluded: RESTORED and QUALIFIED (purple and green CGC labels — the
//   same number at a materially different price; both appeared live). Signature
//   Series is NOT excluded: same comic, same condition, with an autograph.
//
//   THE STUDIO is not shipped code and does not touch the app. It is a local
//   Node server + a 1:1 browser page that runs the LIVE assessment against
//   books on disk and shows each result beside its CGC truth, for screen
//   capture. See shared/_LIBRARY/CALIBRATION_STUDIO_SPEC.md.
//
//   Build only. GRADING_EPOCH stays 6.55.
//
// v6.57: EBAY MATCHING — year in the query, and a reprint filter.
//
//   The first live call returned a median of $615 for a CGC 4.5 Fantastic
//   Four #1 against a high of $20,900. No real copy sells for $615. Most of
//   that band was a different book.
//
//   MATT NAMED THE TRAP, and it is a good one to have hit first: the GOLDEN
//   RECORD reprints. 1966 reprints of JIM 83, ASM 1, Avengers 4 and FF 1 —
//   genuinely slabbed by CGC, genuinely collectable, low hundreds where the
//   originals are five figures. Filtering for "CGC" does not touch them and
//   no price heuristic can separate them from a cheap original. Only the
//   title says so. JUNK_RE now rejects them by name, along with facsimiles,
//   reprints, replicas, 2nd/3rd printings, lots, posters and canvases.
//
//   DELIBERATELY CONSERVATIVE. A VARIANT is NOT excluded — a variant is a real
//   copy of the real book. Over-filtering costs real comps; under-filtering
//   drags the median toward a different book, which is the failure actually
//   observed. Tests assert both directions.
//
//   YEAR IN THE QUERY (Matt's suggestion): "If I were searching eBay and
//   trying to filter out reprints, I'd include the year of publication in the
//   title search, which we have." Right, and it catches what no exclusion list
//   can. But it is a keyword match, so it also drops legitimate listings that
//   do not mention the year — common on moderns. So it NARROWS FIRST and falls
//   back to the unfiltered query when it leaves too few: same shape as the
//   grade-band widening, same reason. `yearUsed` is reported so the caller
//   knows which answer it got. The year is part of the cache key.
//
//   STILL UNSOLVED, and flagged rather than papered over: modern variant-heavy
//   books. Matt's white whale is Absolute Batman #1 with dozens of variants,
//   all legitimately that book, at wildly different values. The spread alarm
//   will flag it rather than quietly publishing a meaningless median, which is
//   the right behaviour until something better exists.
//
//   Build only. GRADING_EPOCH stays 6.55.
//
// v6.56: EBAY. Compliance endpoint + the asking-price endpoint.
//
//   api/ebay_deletion.js — eBay requires every active application to either
//   subscribe to marketplace account deletion notifications or claim an
//   exemption, and the exemption is only for an app persisting NO eBay data.
//   Robograder stores no eBay USER data, but it will cache item summaries for
//   24h, and an item summary is eBay data. That is a judgement call with
//   account suspension attached, to save forty lines. Built the endpoint.
//   Validated by eBay's own test notification 2026-11-12.
//   The hash is sha256(challengeCode + verificationToken + endpoint) IN THAT
//   ORDER — any other order hashes fine and fails with no useful error.
//
//   api/ebay_asks.js — ACTIVE LISTINGS, NOT COMPS, and the whole file is built
//   around not letting that be forgotten. Sold prices live behind Marketplace
//   Insights, which is partner-only; Browse gives what sellers are ASKING, on
//   a population skewed toward books that did not sell.
//     - median, never mean (one $5,000 fantasy BIN moves a mean, not a median)
//     - n is returned and printed beside it; a bare number reads as a valuation
//     - under 3 in-band listings returns nothing at all
//     - GRADED ONLY. One regex both proves a listing is slabbed and extracts
//       its grade, which is why Matt's graded-only constraint makes this
//       tractable where raw would be guesswork. "CGC graded" with no number is
//       rejected: a company name is not a condition.
//     - bands walk LADDER RUNGS, not 0.5 steps, so one rung from 9.4 is
//       9.2-9.6 and one rung from 4.5 is 4.0-5.0
//     - IT FEEDS NOTHING. Not fmvTierOf, not the Deep/Full gates, not the
//       concierge gate, not the label. A test asserts it.
//
//   Build only. GRADING_EPOCH stays 6.55.
//
// v6.55: ** THE EPOCH MOVES. 6.45 -> 6.55. ** Two deliberate grading changes
//        ship together in one cached-prompt edit, as planned.
//
//   1. MAIN PG CEILING 9.2 -> 9.4. Matt's call, 2026-11-10, and a PRODUCT
//      decision, not an evidence-led one - he said so plainly: "The 15 keys
//      with CGC grades are not related to raising the Main cap." They sat far
//      below the old cap and say nothing either way. His three reasons:
//      a first-timer shooting a clean modern and getting 9.2 on a 9.8 book is
//      the worst possible first impression; 9.4 / 9.6 / 9.8 is one clean step
//      per tier and is memorable where 9.2 / 9.6 / 9.8 is not; and he is
//      confident in the grader to 9.4 off the four Main images.
//      ** THE RG CAPS DO NOT MOVE. ** roboscore_v3 DEPTH_CAP stays
//      { main: 9.0, deep: 9.5, full: 10.0 }. Only the PG ladder changed.
//
//      The ceiling modal follows the cap instead of a literal. Each arm is now
//      "at or within one rung of its OWN Main ceiling": RG >= 9.0 (its cap,
//      unchanged) and PG >= 9.2 (one rung under the new 9.4). Dropping 9.0 was
//      Matt's suggestion and it is right - under a 9.2 cap a 9.0 was one rung
//      off the ceiling, under 9.4 it is two, and a book two rungs clear was
//      never clamped, so telling its owner the grade was limited is untrue.
//      MAIN_PG_CEILING is now named on both sides and watched by
//      check-paired-constants.mjs, so the next cap change cannot half-land.
//
//   2. MAGAZINES PASS THE GATE. Phase 0 of lib/main_prompt.js listed magazines
//      under NOT_COMIC and sent Playboy/Penthouse/Hustler there by name. Both
//      removed: a newsstand or collector magazine now grades exactly as a
//      comic does, same paper, same faces, same ladder. Adult magazines grade
//      like any other - the adult guard added in 6.51 decides what may be
//      PUBLISHED, and that was always a separate question from whether we will
//      grade it. FLAGGED is untouched: real-world gore, child sexual content
//      and extremist symbols are unchanged.
//
//   The foundation for both shipped in 6.51 and 6.54; this is the cache event
//   they were waiting for. Nothing else in this build touches a prompt.
//
// v6.54: THE COST/CREDIT CARD, WHICH HAS BEEN BLANK FOR WEEKS. And per-type
//        cost averages.
//
//   WHY IT WAS BLANK. admin/api/stats.js withholds cost-per-credit unless
//   `coverage` (the share of COST-BEARING timing rows carrying creditsCharged)
//   reaches 0.8. creditsCharged was written on the ERROR row and the slabcheck
//   row - and NOT on the success rows, which are nearly all of the spend. So
//   coverage could never climb and the card could never populate, no matter
//   how many books were assessed. Claude told Matt it would fill in with more
//   data; it would not have, ever.
//
//   THE DESIGN FLAW UNDERNEATH. The numerator was every dollar in the window
//   while the denominator counted only stamped rows' credits, so each unstamped
//   row inflated the ratio - which is the only reason an 80% gate was needed.
//   The numerator is now the cost of the SAME rows that supply the denominator,
//   which is correct at any coverage, so the gate is gone. Warm-ping spend is
//   pro-rated by coverage: it is window overhead and charging all of it against
//   a partial set of credits would overstate the cost.
//
//   SUCCESS ROWS NOW CARRY creditsCharged AND kind. 0, not absent, when nothing
//   was charged - a batch pass really does charge nothing (the 3 credits sit on
//   the batch_credits row) and a real 0 keeps the row inside the coverage count.
//
//   COST / ASSESSMENT, BY KIND. The old flat "per assessment $0.0xx" line was
//   one mean over Main, Deep, Full, every Batch pass and Post-Cleaning, which
//   answers no question anyone has. Removed. In its place: Main, Deep and All,
//   each over 24h / 7d / 30d, with n printed beside every figure. Full, Batch
//   and Post-Cleaning sit inside All and are not broken out - they are rare and
//   a mean over three rows is noise. slabcheck is excluded entirely; it is an
//   identity check, not an assessment.
//   `kind` only exists from here on, so the split falls back to
//   creditPendingLabel, which has been on every CHARGED row for longer - that
//   gives Main and Deep real history instead of starting both at zero today.
//
//   Build only. GRADING_EPOCH stays 6.45.
//
// v6.53: THE WATCHING MODAL, AND CONCIERGE STEP 1.
//
//   WATCHING. Matt: switching a book OWNED -> WATCHING popped "SWITCHED TO
//   PRIVATE". Watching has been public-eligible since 6.51; the modal was not
//   updated because it carried its OWN copy of the rule (`next !== "Owned"`).
//   Worse, it was lying: the book was never actually made private, because the
//   guard beside it read canBePublic({ ...next, ownership: next.ownership })
//   and `next` is a STRING - the spread gave {0:"W",1:"a",...} with ownership
//   undefined, so canBePublic() fell through to its "Owned" default and always
//   returned true. THREE copies of that broken guard existed
//   (setOwnershipDetail, cycleOwnershipFromDetail, and the form's setOwnership
//   which was correct). Consequence of the real bug: switching a public book to
//   SOLD from the detail view did not drop the listing, and neither did the
//   adult guard. Both now test the COMIC, and both modals fire off whether the
//   listing actually changed rather than re-deriving eligibility - so the
//   message cannot drift from the rule again. test-magazines.mjs asserts the
//   old literal never comes back.
//
//   CONCIERGE STEP 1 - INSTRUMENTATION ONLY. No modal, no flow change, no new
//   round trip. api/assess.js's existing `slabcheck` Haiku call (already made
//   on the front cover at camera slot 0) now also returns `title` and `issue`,
//   sanitised hard: title length-capped and must contain a letter, issue digits
//   only - a variant suffix like "15A" changes which FMV row applies and cannot
//   be resolved from a cover shot. The client evaluates conciergeGate() and
//   LOGS it. Nothing is shown to anyone.
//   THE GATE IS THE FMV TIER AT GRADE 0.5 (Matt, 2026-11-10). Gating at 3.0
//   would let through a book worth $50+ only in mid grade, and a 1.0 copy of
//   that book is not worth 2 credits. At 0.5 the book clears $50 in ANY
//   condition, so the offer can never cost more than the book is worth.
//   The point of shipping this alone is `idOk` on the slabcheck timing row:
//   how often Haiku names the book off one cover shot. That number decides
//   whether the modal and the combined run get built at all.
//
//   Build only. GRADING_EPOCH stays 6.45.
//
// v6.52: AUTO-CROP. Deterministic, in-app, no model and no network. The crop
//        box arrives on the book instead of on the whole frame; the handles
//        are unchanged for the cases it gets wrong.
//
//   WHY THE BOX IS LOOSE ON PURPOSE. It is the detected book outline plus
//   ~1cm of background on all four sides. /api/assess terminates at
//   CROP_FAILURE when a cover edge runs off the frame, and the EDGE
//   SILHOUETTE test in main_prompt.js can only see a missing piece against
//   visible background. A crop tight to the book is WORSE than no crop.
//
//   WHY IT REFUSES. Measured against 40 composited real covers plus the ten
//   raw calibration photos. The failure that mattered was a photo already
//   cropped tight: the border ring is then cover ARTWORK, "background" comes
//   back as a colour out of the cover, and the detector reports a logo panel
//   with confidence 0.98. Confidence did not separate those from the right
//   answers - a ring-uniformity test did. Two guards now return no suggestion
//   rather than a wrong one: no uniform background, and a book already at the
//   frame edge (nothing to pad into, and /api/assess gates it regardless).
//
//   THE SNAP IS OUTWARD-ONLY. The gradient refinement may widen an edge, never
//   narrow it. Unrestricted it clipped the book by up to 8% of its width,
//   catching the cover's own border rule just inside the true edge. Outward-
//   only took the worst clip across 40 cases to 2.9% and the median margin to
//   +4% of book width, with 38 of 40 containing the whole book.
//
//   SCOPE: comics and magazines, all four MAIN slots. Not cards (aspect-locked
//   5/7) and not the macro slots - a bounding box round a corner close-up is
//   actively wrong. The 9:14 Front/Back default survives as the fallback for
//   every refusal. A _cropUserMoved latch stops _fitCrop's 450ms re-fit from
//   yanking the box back once the user has touched a handle.
//
//   Build only. GRADING_EPOCH stays 6.45 - the assessment is untouched. Worth
//   saying out loud: better crops change the IMAGES the grader sees, so grades
//   may drift slightly even though no grading code moved. If a calibration
//   round shifts after this ships, that is the reason to look at first.
//
// v6.51: MAGAZINES — THE FOUNDATION. (Build only. GRADING_EPOCH stays 6.45:
//        nothing here changes how anything is graded. The prompt change that
//        WILL move it is deliberately not in this version — see the end.)
//
// -- A SUBTYPE, NOT A THIRD TYPE ----------------------------------------
//   format:"magazine" on type:"comic". There are ~72 `type === "card"`
//   branches in index.html alone, plus more in api/, public.html and the
//   admin, and every one is a BINARY. A third top-level type does not fall
//   into the comic branch by itself; each site has to be read and decided,
//   and the one that gets missed ships a magazine through the card label
//   renderer. As a subtype everything that branches on `type` keeps working
//   and only four places read the flag: identity, FMV, the grading gate, and
//   the adult guard. A test asserts cards are untouched.
//
// -- THE ADULT GUARD, ENFORCED THREE TIMES ------------------------------
//   Matt's rule (2026-11-09): grade them, print labels, never publish them.
//   No QR target, no shareable page. canBePublic() refuses the toggle, the
//   save corrects a record that arrives public, and api/lookup.js refuses to
//   resolve one at all.
//   THE THIRD IS THE ONE THAT MATTERS and it is why there are three. The
//   first two run in a browser, and a browser can be an old build, a restored
//   backup, or a record written before the flag existed. The public page is
//   the half with an audience, so it checks the CURRENT record and returns
//   the same 403 a private listing gets - the response must not confirm that
//   an adult item exists at that ID.
//
// -- IDENTITY: A DATE, NOT AN ISSUE NUMBER ------------------------------
//   Most magazines carry no issue number on the cover, and the ones that do
//   print a volume/number nobody quotes - a collector says "Sports
//   Illustrated, July 1986", never "vol 23 #9". The identity header falls
//   back to the cover date, and suppresses it from the line below so it is
//   not printed twice. formatIssue() still returns null exactly as before, so
//   every existing caller is unchanged.
//
// -- FMV: READY AND EMPTY -----------------------------------------------
//   fmv_magazines.json ships with the SAME SCHEMA as fmv_comics.json - same
//   tier ladder, asserted by a test, because a different ladder would mean
//   "$50-$100" meant two different things on two screens. Keyed
//   "<title>|<issue>" when there is an issue and "<title>|YYYY-MM" when there
//   is not. matchMagazineFMV + a branch in fmvTierOf are wired now, so the $
//   ranges and the Deep/Full value gates work the day the first entry lands.
//   Day one behaviour with an empty index: tier 0, which is the same answer a
//   comic we cannot price already gets - the grade-based routes into Deep and
//   Full still work, and a manual FMV entry restores everything.
//
//   `node test-magazines.mjs` - 18 cases.
//
// -- WHAT IS NOT HERE, AND WHY ------------------------------------------
//   THE GATE STILL REJECTS MAGAZINES. lib/main_prompt.js Phase 0 still reads
//   "NOT_COMIC - magazines" and names Playboy. Reversing it is a cached-prefix
//   edit: a cache event, and the first grading-epoch move since 6.45.
//   HOW_WE_WORK says to batch prompt edits, and there is a second prompt
//   change coming - the CGC key-grade curve Matt raised in the same message.
//   One cache event instead of two is worth the wait, and the curve needs its
//   confound ruled out first (see the reply: the PG ceiling is 9.2 on a Main
//   and 9.6 on a Deep, and high-value keys are exactly the population that
//   hits it).
//   So: everything a magazine needs to EXIST is in. Nothing can create one
//   yet. That is deliberate and it is one line away.
//
// v6.50: THE CREDIT SWEEP COULD ONLY SEE MAIN. (Build only - epoch stays 6.45.)
//
// -- WHAT THE LOG ACTUALLY SAID -----------------------------------------
//   credit_sweep was written up in the 1.14 run sheet as "failing on every
//   10-minute cron run, needs a Firestore composite index". That note was
//   weeks old, and because the catch sliced the error to 200 characters
//   NOBODY HAD EVER READ THE ERROR - including me, when I repeated the
//   diagnosis to Matt and sent him into the Firebase console. The index was
//   already there, Enabled, and the endpoint has been running clean:
//       [credit_sweep] scanned 0 orphan candidate(s): 0 refunded, 0 skipped
//   Three runs, ten minutes apart, level info.
//
// -- AND "SCANNED 0" WAS THE REAL BUG ------------------------------------
//   Only api/assess.js has ever stamped creditSettled / creditPendingUid /
//   creditPendingCost / creditPendingLabel / creditPendingAt. Deep, Full,
//   Post-Cleaning and Batch all charge credits and stamp nothing, so the
//   sweep has never been able to see an orphan from any of them. It was not
//   finding nothing because nothing was wrong; it was looking at one fifth of
//   the surface.
//   The proof is in this session: every Deep broken by the 6.41 ReferenceError
//   was charged server-side and discarded client-side - the textbook orphan -
//   and the sweep logged "scanned 0" through all of it. Matt lost those
//   credits to a safety net that could not see him.
//
//   This is HOW_WE_WORK section 3 corollary 2 again, for the third time this
//   session: two code paths that must agree, written so differently that
//   nobody reads them side by side. The others were the double-charge bug and
//   the Full gate living in two files.
//
// -- THE FIX, AND WHY IT IS NARROW ---------------------------------------
//   Deep and Full now stamp the pending fields on their SUCCESS timing row -
//   the one whose key is returned in _diagnostics.timingKey, which
//   _recordTimingKey() already stashes on the item and _settleCredits()
//   already hands to /api/credit_settle. That settle path is generic and has
//   been carrying Deep and Full keys all along; only the server half was
//   missing.
//   NOT the error rows. Those have already refunded, and a pending stamp on
//   top of a refund pays the user twice.
//   NOT Post-Cleaning and NOT Batch. Neither records a timing key on the item,
//   so nothing would ever settle them and every SUCCESSFUL run would be
//   refunded fifteen minutes later. Wiring _recordTimingKey() through the
//   clean flow comes first; until then it is an explicit exemption.
//
//   check-paired-constants.mjs now asserts the whole invariant: an endpoint
//   that calls reserveCredit() must either stamp pending or be on a named
//   exemption list with the reason. Verified by removing the stamp on
//   purpose - it fails, names the endpoint, and says which row to put it on.
//   The exemption list is a list to SHRINK, not to add to.
//
// v6.49: POST-CLEANING IS FINISHED, AND IT WAS COMPARING THE WRONG GRADE.
//        (Build only - GRADING_EPOCH stays 6.45. Nothing here changes how a
//        book is graded; it changes which FIELD the result is written to.)
//
// -- 1. THE COMPARISON WAS DIFFING MY GRADE AGAINST A PREDICTED GRADE ----
//   _cleanBeforeSnapshot captured `item.grade`. `grade` is MY GRADE - the
//   owner's own opinion, moved down beside the price and the seller in v6.27
//   for exactly that reason. The predicted grade is `predictedGrade`.
//   api/assess_clean.js diffs before.grade against after.grade, and the After
//   side comes from the assess endpoints where `grade` MEANS the predicted
//   grade. So the before/after comparison was holding the owner's own guess
//   up against a model output - and on the common case where My Grade was
//   never filled in, it compared a predicted grade against nothing and
//   reported no movement at all.
//
//   And the result was written back the same way:
//       if (A.grade) formData.grade = A.grade;
//   Three bugs in one line. It overwrote the owner's My Grade with a model
//   output; it never updated predictedGrade, so the screen kept showing the
//   BEFORE grade after a run whose entire purpose is to change it; and it
//   skipped _snapPgToLadder, which every other pass goes through.
//   My Grade is the user's. This pass does not touch it.
//
// -- 2. THE RESULTS WERE STORED AND NEVER DRAWN --------------------------
//   `cleanComparison` has been written since v5.69 and NOTHING HAS EVER
//   RENDERED IT. Two credits bought a defect reconciliation, a page-quality
//   move, a restoration check and a written explanation, and the only visible
//   effect was that a grade changed.
//   renderPostCleaningResults() draws it from the stored record, so Detail and
//   Edit show the same thing from the same function and it survives a reload:
//   RoboGrade and Predicted side by side before and after, the resolved /
//   survived / introduced counts, the page-quality move with its suspicious
//   flag, the write-up, and the resolved and introduced lists.
//   Every number on it was computed in CODE by api/assess_clean.js - the diff
//   is a defect-key reconciliation, not something the model counted - so the
//   panel states them flatly.
//   renderPostCleaningPhotos() pairs the ten before and after shots ROW BY
//   ROW. Two galleries stacked would make the reader hold ten images in their
//   head to do the job the row does for them.
//
// -- 3. THE HONESTY CONSTRAINT, IN CODE AND IN A TEST --------------------
//   When restoration shows on the after photos and not the before ones, the
//   panel leads with it - above the grades, because it is the most
//   consequential thing this pass can turn up - and it says WHAT EACH PASS
//   FOUND. Never that the book was restored, who did it, or when. The before
//   pass may simply have missed it, and the copy says so.
//   The FMV is withheld while that is outstanding. The index prices an
//   UNRESTORED copy at a grade; printing that number beside a book whose
//   latest pass saw restoration states a value nobody has a basis for, on the
//   screen a buyer is most likely to be shown. Blank, not zero, not a guess.
//   A test asserts the wording, because it is the kind of thing a later
//   rewrite loses without noticing.
//
// -- 4. IT IS CALLED POST-CLEANING (Matt, 2026-11-07) --------------------
//   "Cleaning Compare" is gone from every user-facing string. The card header
//   was "BOOK HAS BEEN CLEANED" and the button under it already said
//   "POST-CLEANING ASSESS"; one feature with two names is one too many.
//
//   `node test-post-cleaning.mjs` - 30 cases. Most of them are "what if this
//   field is not there": a render that throws on a partial comparison takes
//   the whole Detail view down with it.
//
// -- 5. credit_sweep SAYS WHERE TO CREATE ITS INDEX ----------------------
//   Firestore's FAILED_PRECONDITION message carries a one-click console URL
//   that builds the exact composite index. The catch sliced the message to
//   200 characters, cutting that URL in half - so the one piece of
//   information the error existed to deliver was the piece thrown away, and
//   the endpoint has been failing on every 10-minute cron run with nothing
//   anywhere saying what to click. Logged in full now and returned as its own
//   `indexUrl` field.
//
// NOTE under 6.47, NOT a version bump. check-native-bundles.mjs now reads the
// iOS Info.plist and asserts UIFileSharingEnabled and
// LSSupportsOpeningDocumentsInPlace are <true/>. That script is a DEV TOOL -
// it is not in the app bundle and no user ever runs it - so bumping
// ROBOGRADE_VERSION for it would have done nothing but invalidate the 6.47
// iOS bundle Matt had already synced, mid-build, and send him back to STEP 2
// for a change that cannot reach a phone. It was bumped to 6.48 and reverted
// within the minute. The same reasoning applies to every check-*.mjs and
// test-*.mjs in this folder.
//
// WHY THE CHECK EXISTS: STEP 4b of the 1.15 run sheet asked Matt to confirm
// those two keys in Xcode and sent him to the wrong pane - the PROJECT's Info
// tab, which shows Configurations and Localizations. The keys live on the
// TARGET's Info tab. He reported "I do not see what you're describing", which
// was the correct answer to the instruction given.
// A verification step that points at the wrong screen is worse than no step:
// "I can't see it" is indistinguishable from "it is gone", and what it guards
// is already invisible - without those keys the label PDF is written to a
// private directory, the write SUCCEEDS, and the user simply never finds the
// file. The script reads the plist instead. No Xcode, no display names.
// Verified by deleting a key on purpose: it fails with the name and the
// consequence, then passes once restored. STEP 4b is gone from the run sheet.
//
// HOW_WE_WORK section 8 already says "don't guess at UI menu paths". This is
// its second half, which was not written down: when a check can read a file
// instead, it should never have been a menu path at all.
//
// v6.47: A THOUSANDS COMMA ON FIVE-FIGURE PRICES. (Build only - the
//        assessment did not change, GRADING_EPOCH stays 6.45.)
//
//   "$12500" reads as a typo at arm's length and "$12,500" does not, which is
//   the entire job of a label you price a book with across a table.
//   FOUR digits stay bare - Matt's call, and the right one: a comma costs a
//   separator's width (0.274em, half a digit) out of a slot that is already
//   the binding constraint, and "$1,250" is unambiguous without it.
//   Grouping applies to the whole-number part only. The lookahead wants three
//   digits with no digit after them, and a decimal point satisfies that, so
//   "12500.50" groups as "12,500.50" and the ".50" is left alone.
//   The EM table already carried a width for ',' from v6.25, so the fit needed
//   no other change. Computed against it, every price from $5 to $1,250,000
//   draws between 150 and 230px in the 230px Square slot - nothing overflows.
//
// v6.46: TWO VERSION NUMBERS, AND A GATE SO NEITHER OF US HAS TO REMEMBER.
//        (The assessment did NOT change in this build. GRADING_EPOCH stays
//        at 6.45, which is the whole point of it.)
//
// -- THE PROBLEM MATT NAMED ----------------------------------------------
//   The protocol was "bump only when the assessment changes". ~100 bumps
//   later, nearly all of them UI. He asked whether it matters. It does, for
//   one reason that is not tidiness: this number is stamped on assessments
//   and timing rows, and calibration_eval.mjs and defect_diff.mjs POOL BY IT.
//   A version that moves for a CSS fix fragments the sample, so no version
//   ever accumulates enough runs to measure anything. TASKLIST already
//   carries the scar: "do NOT pool with earlier versions".
//
// -- THE SHAPE, WHICH IS MATT'S, NOT A THIRD NUMBER ----------------------
//   He restated the fix better than I proposed it: don't invent another thing
//   to track - LOCK the version stamped on assessments to whatever it was at
//   the last assessment change, and leave it there while the build version
//   climbs past it. GRADING_EPOCH is a bookmark into the existing sequence,
//   not a parallel counter.
//
// -- WHAT MOVED ----------------------------------------------------------
//   GRADING_EPOCH in lib/version.js, with the rule written beside it.
//   Timing rows now carry `epoch` ALONGSIDE `version` - additive on purpose:
//   `version` keeps saying which BUILD produced the row, which is provenance
//   worth having, and `epoch` is what the tools pool by.
//   window.RG_EPOCH mirrors it in index.html and public.html, and the LABEL
//   stamps it - "V6.45" on a label is a claim about what graded the book, not
//   about which CSS fix was live that day.
//   sync-version.mjs stamps the epoch mirrors from GRADING_EPOCH and NEVER
//   from the build version, and refuses an epoch ahead of the build.
//
// -- THE PART THAT MATTERS: IT IS ENFORCED -------------------------------
//   Matt asked for this to be locked in somewhere neither of us can forget
//   it, because both of us already did for six weeks.
//   check-cache-prefix.mjs already hashes the cached Main and Deep prompt
//   prefixes, so it already knows the hard-to-remember thing: whether a
//   grading prompt moved. If a prefix moved and the epoch did not, it now
//   FAILS and prints the exact line to change. Verified by breaking it on
//   purpose. The manifest records which epoch its shas belong to.
//   It cannot see a ceiling, a cap or a scoring rule changed in CODE - that
//   half is a person remembering, which is why the rule is also written out
//   in HOW_WE_WORK section 10a with a table, the one-line test, and the list
//   of which epochs so far actually changed a grade.
//
// -- NOT DONE ------------------------------------------------------------
//   roboGrade.version (echoed by the model from inside the Main prompt) and
//   the appVersion reported to the server still carry the BUILD number. The
//   first cannot be changed without editing a cached prompt prefix, which is
//   a cache event, and this is the week 1.15 ships. The tools pool on the
//   timing rows, which now carry the epoch, so nothing is blocked by it.
//
// v6.45: THE FULL'S GRADE RULE IS NOW ARITHMETIC. ** THIS ONE CHANGES THE
//        ASSESSMENT. ** First graded change since 6.20.
//
// -- MATT'S RULE, STATED 2026-11-06 --------------------------------------
//   A Full should leave the grade alone more often than not. It may LOWER
//   only when these six images reveal a defect that was not already noted,
//   and it may RAISE only from at-or-near the Deep ceiling (9.6) when nothing
//   new was found - confirming that a 9.8 PG, and a 10 RG, are justifiable.
//
// -- WHY IT COULD NOT BE ENFORCED BEFORE ---------------------------------
//   The prompt has asked for exactly this since S20, and asking is not the
//   same as getting. There was nothing to check the model against: it
//   returned a grade and some prose, and "was a new defect revealed?" was a
//   question only the prose could answer.
//   v6.44 made the Full return its findings as DATA. That turned the rule
//   into arithmetic, which is where a rule like this belongs.
//
//   applyFullGradeGate(grade, priorPG, newDefectCount) - three clauses:
//     raise + any new defect        -> held at prior
//     raise from a prior below 9.6  -> held at prior
//     drop + no new defect          -> held at prior
//   Both directions CLAMP to the prior grade rather than failing the run. A
//   Full is a confirmation pass: "no change" is the right answer whenever the
//   move is not earned, and it is never a reason to fail something the user
//   has already paid for. Every block is logged as [full-grade-gate] with
//   what the model said and what shipped, so the rate is measurable rather
//   than assumed.
//   `gradeChanged` is now derived from the grade that SHIPPED rather than the
//   model's own claim about it - with the gate in place those can disagree,
//   and the client and the admin both read that field.
//   The prompt says the same three rules and says they are enforced, so the
//   model is not fighting a gate it cannot see.
//
// -- THE 13-DEFECT CAP DOES NOT APPLY TO FULL (confirmed by Matt) ---------
//   "If they are putting a book through that much scrutiny, a longer defect
//   list is warranted." Already the behaviour as of 6.44 and now verified
//   end to end: nothing truncates roboGrade.defects on the client, the cap
//   lives only in the Main and Deep prompts, and carryFullDefects appends
//   after it. A book can carry 13 + 6.
//
//   `node test-full-defects.mjs` - 33 cases now, 12 of them on the gate
//   including both boundaries and the degenerate inputs.
//
// -- A NOTE ON VERSION NUMBERS (Matt, 2026-11-06) ------------------------
//   The protocol was: bump only when the assessment changes. ~100 bumps since
//   have mostly been UI. That is not free, and the cost is not tidiness:
//   RG_GRADING_VERSION is stamped into every assessment, every history entry
//   and every timing row, and calibration_eval / defect_diff POOL BY IT. A
//   version that moves for a CSS fix fragments the sample, which is why
//   TASKLIST already has to say "do NOT pool with earlier versions".
//   The two jobs want opposite things and should be two numbers: a build
//   version that moves freely, and a grading epoch that moves only when a
//   prompt, a ceiling or a scoring rule changes. Proposed, NOT done - it
//   touches stamped data and 1.15 is about to ship.
//   Until then the header of each version says whether the assessment moved.
//   The ones that did: 6.32/6.34 (Full gate to Tier 4), 6.44 (Full returns
//   defects), and this one.
//
// v6.44: THE LOCAL CACHE IS REVERTED (IT WAS BREAKING SAVES), AND A FULL PASS
//        FINALLY RECORDS THE DEFECTS IT FINDS.
//
// -- 1. "Save failed: the client has already been terminated." ------------
//   That is Firestore's error for an operation issued after the SDK has
//   terminated its own client, and the SDK does that when the IndexedDB
//   persistence layer hits something unrecoverable - a lost single-tab lease,
//   an eviction, a quota failure. Nothing in index.html calls terminate();
//   before v6.38 there was no persistence layer that could.
//   I added persistentLocalCache + persistentSingleTabManager in v6.38 and
//   wrote in that header that a second tab would "silently fall back to
//   memory-only rather than erroring". That was an assumption, it was wrong,
//   and the symptom is a SAVE THAT FAILS while changing an asking price.
//   Reverted to the pre-6.38 line exactly. A faster cold start is not worth a
//   failed save, and least of all in the week 1.15 ships into a WebView whose
//   IndexedDB behaviour under memory pressure nobody has tested.
//   IF IT IS TRIED AGAIN: persistentMultipleTabManager is the SDK's answer to
//   this case, single-tab is a known dead end, and the verification is to open
//   the app in two tabs and save from the first. Ship it after a release, on
//   its own. The session restore from v6.38 is UNAFFECTED and stays.
//
// -- 2. A FULL PASS RETURNED NO DEFECTS. NOW IT DOES. ---------------------
//   Matt asked whether a Batch preserves defects a Full added. Checking that
//   turned up something worse than the question: assess_full.js never returned
//   a defect list at all. A staple-rust or trimming finding existed ONLY as a
//   sentence inside the fullAssessment prose - so it never reached the label,
//   the public page, the panel, or the admin defect printout, and the v3
//   engine, which reads roboGrade.defects, could not see it either. The
//   book's most structural findings were the least recorded.
//
//   SERVER: the Full now returns "fullDefects" - the findings from the six
//   structural images only, never a restatement of a cover or corner defect
//   (that would double-count against the grade). Max 6, empty being the normal
//   answer for a sound book. _sanitizeFullDefects trusts the model for CONTENT
//   and not for SHAPE: every field is clamped, an unknown category becomes
//   Interior, an unknown severity becomes Low, and each entry is stamped
//   fullAddition:true.
//
//   CLIENT: that stamp is what every later pass keys off, because Main, Deep
//   and Batch all REPLACE roboGrade.defects wholesale with what their own
//   photographs showed - and not one of them has ever seen the six structural
//   images, so not one of them could re-derive what the Full found. They would
//   delete it, every time. carryFullDefects() re-appends the marked entries,
//   and it sits beside mergeRestorationFlags because it is the same problem
//   with the same answer. A fresh Full result wins outright over a carried
//   one, so re-running a Full replaces its findings instead of stacking them.
//
//   THE 13-DEFECT CAP DOES NOT APPLY TO THEM. TASKLIST's rule is "never
//   discard, and never drop a structural defect to make room" - Full defects
//   ARE the structural ones, and there are at most 6, so they are appended
//   after any cap rather than competing for a slot in it.
//
//   `node test-full-defects.mjs` - 21 cases over the sanitizer, the carry, the
//   Batch swap and the cap, with both halves sliced out of the shipping files.
//
//   NO CACHE IMPACT - CHECKED, NOT ASSUMED. assess_full.js sends no
//   cache_control at all (only the Main and Deep prompts are split at
//   SSCACHE_SPLITSS and cached), so editing this prompt moves none of the four
//   tracked prefixes, and sync-version --check confirms all four unchanged.
//   The only cost is output: a handful of short entries the pass did not
//   previously produce. Worth a glance at the Full timing rows, nothing more.
//
// v6.43: A FULL WAS LOCKING BATCH OUT, VIA THE PHOTOGRADER.
//
// -- 1. WHY BATCH WENT GREY AFTER A FULL ---------------------------------
//   Nothing in isBatchEligible mentions Full. The route was indirect:
//   mergePhotograder keeps the WORST letter seen on any pass, and a Full
//   grades six hard macros - staples, outer edge, page edges. One C, or a
//   second B, from those photographs lands on the running record and stays
//   there. _batchPhotoOK then read that record to decide whether the FOUR
//   MAIN COVER PHOTOS were clean enough to re-grade.
//   They are different photographs. The Full's verdict on a staple macro has
//   no bearing on whether Batch can re-run Main -> Deep on the covers, and
//   because the merge is a high-water mark it locked Batch out permanently.
//
//   THE RULE, from Matt: a Full must not gate a Batch. So the photograder is
//   snapshotted as `photograderPreFull` before a Full overwrites it (FIRST
//   Full wins - a second must not snapshot a value the first poisoned), and
//   _batchPhotoOK reads the snapshot on any book that has run a Full.
//   Books that ran a Full BEFORE this version have no snapshot and the
//   pre-Full record cannot be reconstructed, so they PASS the gate outright.
//   That is deliberate and it is the narrow case: every one of them had
//   already cleared this gate at Deep time, on the same set of photographs
//   Batch actually uses.
//
// -- 2. ON PRESERVING THE FULL'S DEFECTS: THERE ARE NONE TO PRESERVE ------
//   Matt asked that defects added by a Full survive the Batch. Checked, and
//   the premise does not arise: api/assess_full.js returns no defect list at
//   all. A Full returns a revised grade, the roboScore, the Full write-up,
//   interiorComplete, trimmingSuspected and the merged photograder - and
//   every one of those except the score survives a Batch untouched, including
//   fullAssessmentRan, so the book keeps its third star.
//   What a Batch DOES replace is roboGrade.score and the four subscores, with
//   the five-pass average. That is the feature working: the whole point of
//   paying for five passes is that their average becomes the grade.
//
// -- 3. MAP: THE SPINE IS NOT THICKER ANY MORE ---------------------------
//   It was widened twice (3, then 5) to mark Main -> Deep -> Full as the main
//   path. Matt's call on seeing it: it reads as emphasis the map does not
//   need. SPINE 5 -> 2, and the arrowheads come down with it, because a 2px
//   line arriving at a 5px head looks like a mistake.
//
// -- 4. MAP: THE BOTTOM ROW READS 1, 2, 3 --------------------------------
//   Full (1), Post-Cleaning (2), Batch (3). The wires are drawn against
//   COLUMNS rather than nodes, so swapping two cells moves the boxes and
//   nothing else.
//
// -- 5. MAP: EVERY COST LINE SHARES A BASELINE ---------------------------
//   The box centred one stack, so the cost sat wherever the rest of that box
//   left it. FULL carries three stars; POST-CLEANING wraps to two lines;
//   BATCH has neither, so its COST 3 floated about 6px above the COST 1 and
//   COST 2 beside it. Stars and label now centre in the space ABOVE a
//   bottom-anchored cost, which fixes the row Matt was looking at and the six
//   boxes above it at the same time.
//
// -- 6. MAP: "SIGNATURE" IS SET 2px SMALLER, ON ITS OWN -------------------
//   It is exactly 9 characters and the size step was "> 9", so it rendered at
//   the full 10px and ran wider than a third of the row. Dropping the whole
//   label would have shrunk "CHECK" for no reason, so the oversized WORD
//   alone comes down 2px. Done by LETTER RUN, not by space-separated word, so
//   "POST-CLEANING" measures as POST + CLEANING - neither long - and is left
//   at full size, exactly as the line box already breaks it.
//
// v6.42: I BROKE DEEP IN 6.41. ONE LINE. HERE IS THE LINE AND THE GATE THAT
//        WOULD HAVE CAUGHT IT.
//
// -- 1. EVERY DEEP ASSESSMENT FAILED -------------------------------------
//   v6.41 added one logging line to the refund block:
//
//       dbg(`deep refund test: ...`)
//
//   `dbg` is a LOCAL const declared inside mountResults. That line is inside
//   assessHighGrade, a different function, where the name does not exist. So
//   the moment a Deep came back it threw ReferenceError, the enclosing catch
//   turned it into the generic "Assessment failed. Please try again. (No
//   credit was used.)", and the result was thrown away.
//
//   THE CREDIT WAS USED. The server had already finished the work - Matt's log
//   shows totalMs 14835, stopReason end_turn, valid JSON, $0.113 spent - and
//   the message said the opposite. Any Deep lost this way is still recoverable
//   from its assessment_timings row: rawText holds the complete result.
//
//   Fixed by using console.log. The real fix is the next item.
//
// -- 2. check-undefined-names.mjs ----------------------------------------
//   Every gate passed on 6.41. `node --check` PARSES; a parser cannot see that
//   a name has nowhere to resolve to. That is twice now that a Deep-breaking
//   change has gone out clean, so this is a scope check, not another syntax
//   check: ESLint with the single rule no-undef, over all of index.html's
//   inline blocks CONCATENATED into one virtual file.
//   Concatenated because those blocks share one global scope at runtime, and
//   linting them separately would report thousands of false positives for
//   names defined one block over - a check that cries wolf gets turned off.
//   Module blocks are wrapped in a block statement (they have their own scope)
//   and their imports rewritten into equivalent const declarations, so the
//   names they bind still resolve without making the whole file a module.
//   Needs eslint: npm i -D eslint@9.15.0. node_modules is already gitignored.
//
//   IT FOUND TWO MORE ON ITS FIRST RUN, both older than this session:
//
//   a. `_interiorZoomSlot` and `_isZoomedRestorationSlot` in the Android
//      no-label zoom fallback. NEITHER HAS EVER EXISTED anywhere in the file.
//      `||` evaluates left to right, so on every kind that is not corner /
//      signature / carddeep that line threw, the enclosing catch logged
//      "Android zoom fallback failed", and NO zoom constraint was applied at
//      all. The S19 forced-wide fix - the one that stops an ultra-wide lens
//      handing back a too-wide, soft frame - has been dead on this path since
//      it was written. Both names removed; whatever they meant was never
//      written down, and the three remaining kinds are the ones the comment
//      above the line says intentionally want zoom.
//   b. `_iosFetchPrices` / `_applyIosPrices` - NOT a bug. They are injected
//      into the iOS bundle by make-ios-index.mjs and their only caller is
//      guarded by isNativePlatform(). Verified in that file before being
//      added to the allow-list, which is the rule for that list.
//
// -- 3. THE SHUTTER WAS SITTING ON THE BOOK -------------------------------
//   Interior Front and Interior Back are the two landscape captures: the book
//   is open and fills the frame edge to edge, and a shutter at bottom-centre
//   sits on top of the thing being framed. In portrait that same button would
//   be at the side, so on these two slots it goes centre-right - where a thumb
//   already is when the phone is turned.
//   position:fixed rather than relocating it inside #camera-controls, because
//   that bar also holds Photo Library and the lens selector and those belong
//   at the bottom. The guide reserves room on the RIGHT instead of losing it
//   at the bottom, so the spread is now TALLER than it was.
//   Scoped to interiorCover alone via an additional body class. The Full
//   interior slots and the restoration spreads are landscape too; if they
//   should move as well it is one more kind on one line.
//
// v6.41: THE MAP'S JUMPS LAND; CGC COMES OFF THE SCAN SCREEN; THE NEEDLE GETS
//        TO FINISH; THE DEEP REFUND LOOKS AT BOTH GRADES.
//
// -- 1. TAPPING A MAP NODE DID NOT LAND ON ITS SLOTS ----------------------
//   showEditToSection measured the anchor after two animation frames and
//   scrolled once. Two frames is enough for LAYOUT and not for CONTENT: every
//   photo slot above the target is an <img> with height:auto, so each one that
//   decodes after the scroll makes the page taller ABOVE the anchor and pushes
//   it down. The scroll was right when it was taken and wrong a quarter of a
//   second later.
//   _settleScrollTo re-measures at 0/120/300/600/1000ms and scrolls again only
//   when the anchor has moved, stopping as soon as the position is stable
//   twice - and stopping instantly on touch, wheel or key, because a page that
//   scrolls out from under a finger is worse than one that lands short.
//   Every node already had an anchor (deep-corner-section, full-staple-section,
//   uv-section, signature-section, insert-section, coupon-section,
//   batch-section, clean-section, assess-btn); none of them was the problem.
//
// -- 2. THE BLUE BOX SAID CGC ---------------------------------------------
//   It holds OUR predicted grade. Labelling it with a grading company's name
//   says, on our own screen, that what we are selling is their grade - the
//   exact claim the rest of the app was scrubbed of. It says PG now, in the
//   scan placeholder, in mountResults and in the Batch results panel. The
//   CARD box is relabelled too: the same reasoning applies to PSA and there
//   was no reason to leave one of them standing.
//   NOT touched: the places that report a real slab's grade from its label
//   (the Official Grade block). That is factual reporting of someone else's
//   grade on a book they graded, which is the opposite of the problem.
//
// -- 3. THE PANEL SLID AWAY WHILE THE NEEDLE WAS STILL SWINGING -----------
//   S22's reveal fired 1000ms into mountResults; the needle's own sweep did
//   not START until 2000ms and takes 2000ms to land. So the gauge went off
//   screen mid-swing, having never arrived at the grade - which is the one
//   thing a gauge is for.
//   The order now: RG counts, PG counts, the needle sweeps and the grid
//   lights stop, ALL AT ONCE at t=0, every one of them a 2000ms animation, so
//   they land together. The panel slides at 2150ms - after they finish.
//   Nothing downstream got slower. PG actually arrives a second EARLIER than
//   before, because its 1000ms head start is gone; the PQ pill and the
//   COMPLETE button keep their own timings.
//   BATCH IS UNTOUCHED, as asked: mountBatchResults has its own pacing and
//   revealScannedPhoto already returns early for batch, so the panel stays up
//   and the five results stay on screen.
//
// -- 4. A DEEP THAT RAISED THE PG WAS STILL REFUNDED ----------------------
//   The test was RG only, so a Deep that moved the PREDICTED grade 5.0 -> 5.5
//   while the RoboGrade stayed flat came back as "didn't improve" and gave the
//   credit back. The user is shown TWO numbers and told the credit returns "if
//   the score doesn't go up"; one of the two went up.
//   A Deep now counts as improved if EITHER number rose. The RG branch keeps
//   its treat-unknown-as-improved safety (never refund on missing data); the
//   PG branch defaults to NOT improved, because two safe-defaults OR'd
//   together would refund nothing at all. The pre-Deep PG is captured beside
//   the pre-Deep RG, before the run, because formData is rewritten later in
//   that flow. The promise shown to the user now says "if neither grade goes
//   up", which is what the code does.
//   STILL CLIENT-SIDE. This decision has always been made in the browser and
//   still is; api/assess_deep.js only refunds on errors. Worth moving, not
//   today.
//
// -- 5. DETAIL GOES BACK, EDIT STAYS (Matt, 2026-11-06) -------------------
//   v6.38 gave the panel its own container everywhere. Edit needed it - there
//   is no sheet there, so the panel was a stack of dark boxes on white. Detail
//   did not: it already has the ASSESSMENT sheet, and a bordered card inside a
//   bordered sheet is the box-inside-a-box v6.33 removed.
//   buildDisplay takes opts.framed now. Edit frames; Detail and the public
//   page do not, and the ASSESSMENT sheet goes back to #152e10 so it IS the
//   box, as before v6.38. One flag rather than two renderers - the moment this
//   file has two of anything, the two drift.
//
// v6.40: THE SQUARE LABEL, MEASURED INSTEAD OF REASONED ABOUT.
//
// A label harness now lives at shared/_WORKING/label-measure/. It renders the
// real label with the real fonts and reports where the INK lands, not where
// the CSS boxes are. Both of the label bugs below were found in one run of
// it, and one of them was mine from two versions ago.
//
// -- 1. SQUARE'S DATE LINE HAD 17px OF LEADING NOBODY ASKED FOR -----------
//   Wide and Case both declared line-height:1.0 on .iss. Square did not, so
//   its date line fell back to 'normal' - about 1.35 - and its line BOX was
//   65px tall for a 48px face. That is the "too tall" spacing between
//   Title/Issue and Pub Date/Publisher, and between that line and
//   Printing/Variant: not a margin, the line box itself.
//   Shared now (.rg-any .iss), for the same reason the wrap rule is: this is
//   how the line is SET, not where it sits. Wide and Case keep their exact
//   previous rendering. Square's own margins came down with it, 4 -> 2 and
//   6 -> 4.
//   MEASURED: the date line box 65 -> 48; the printing line starts at y=201
//   instead of y=222. Square's ink gaps are now -10 / -3 against Wide's
//   -13 / -1 and Case's -12 / -2 - the three labels are finally set alike.
//
// -- 2. THE PRICE WAS OVERLAPPING THE PRINTING LINE. I DID THAT IN 6.38 ---
//   Matt reported the price "clipping over" the Printing/Variant text and
//   said it was well below it and did not overlap. It overlapped.
//   v6.38 capped the price at 0.95 of its slot, reasoning that line-height:1
//   makes the line box the type size. It does, AND THE GLYPHS OVERFLOW IT.
//   Measured: Noto Sans Display 900 paints 1.36x its font-size, so "$5" at
//   171px drew ink from y=292.5 to y=525.5 - over the printing line (ink ends
//   302.6) and down across the meta rule at y=513. The CSS box was innocent
//   and the ink was not, which is precisely the class of thing this file has
//   now got wrong twice and the harness exists to stop.
//   The cap is the INK now (1.37, measured 1.356-1.363 plus margin), and the
//   slot grew to every pixel available between the info column and the rule:
//   y 318..502. Result, measured: "$5" sits at 319..501 with 37px of clear
//   air under the printing line; nothing overlaps on any price tested.
//   Against the PRE-6.38 sizes: $45 +51%, $12.50 +56%, $12,500 +66%. A
//   single-digit price is the exception at +7% - it is not width-limited at
//   all, so the slot's height is its only wall, and the slot is as tall as
//   the label allows.
//
// -- 3. THE PREVIEW STOPPED FITTING, AND v6.38 DID THAT TOO ---------------
//   fitPreviewToFrame budgeted height as a flat 38% of the viewport - stable,
//   but not the room that actually exists. Shortening the card to 100vh-88px
//   (to leave a band of backdrop to tap) took 64px out of a budget nothing
//   was tracking. The preview area is flex:1 with overflow:auto, so it
//   absorbed the loss by SCROLLING, and on Square - the one label as tall as
//   it is wide - you could no longer see the whole label at once.
//   It measures the room now: the card's max-height minus the heights of its
//   other children (header, toggle rows, actions, buy link). None of those
//   depend on the label's scale, so the ratchet-to-micro bug the 38% was
//   guarding against still cannot start.
//
// -- 4. ADMIN: "NO SIGNATURE" AND "NO CLOSE-UP" LOOKED THE SAME -----------
//   The admin renders signature close-ups only when signatureImages is
//   non-empty, so an absent section read identically as "this book has no
//   signature" and "a signature was detected and the user never photographed
//   it" - completely different facts. The close-ups are optional and most
//   users do not take them. The Signatures block now states which case it is.
//   NOTHING WAS BROKEN in the pipeline: admin/api/item.js reads
//   signatureImages from `flat` (correct since 5.81), the upload path writes
//   them to signature_01 / signature_02, and the item view renders them when
//   present. The ambiguity was the whole problem.
//
// v6.39: A TRANSFER COPIED FOUR PHOTOS, THEN NONE AT ALL.
//
// Matt asked for the verified-book transfer bug. It is fixed, and it was the
// smaller half of what is in here.
//
// -- WHAT WAS REPORTED --------------------------------------------------
//   transfer_resolve wrote the recipient's item with `images: newImages`, a
//   list of bare STRINGS. splitImageArray maps a string entry to
//   DEFAULT_IMG_META, which is source:"upload" - so a book the sender had
//   photographed entirely in-app arrived permanently stamped "Unverified:
//   photos taken outside of app", with no way to correct it short of
//   re-shooting someone else's book.
//
// -- WHAT WAS UNDERNEATH IT ---------------------------------------------
//   1. THE COPY ONLY EVER COVERED THE FOUR MAIN COVERS. It copied
//      `imageManifest`, which transfer_recv builds from `item.images` alone.
//      Corner macros, interior covers, Full's six structure slots,
//      signature, restoration, insert, coupon, the user's own defect photos,
//      the Cleaning Compare before and after sets and the thumbnails were
//      never copied. The recipient's entry pointed at files sitting in the
//      SENDER's Storage folder. Nothing looked broken, because these are
//      download-token URLs and tokens bypass the Storage rules - but the
//      recipient's book was one ordinary "delete" by the sender away from
//      losing most of its photographs. Step (4) of an accept sets the
//      sender's retained copy to Watching, which is exactly the state in
//      which someone tidies it up.
//   2. SINCE SCHEMA v3 IT COPIED NOTHING. v3 stores images as
//      { url, source, capturedAt, hash } objects, so imageManifest became an
//      array of OBJECTS, and objectPathFromUrl returns null for anything
//      that is not a string. Every entry fell through a branch written for
//      an unparseable legacy URL, which quietly became the only path taken.
//      Not one file was copied for any transfer of a v3 item.
//      This also MASKED the reported bug: on the v3 path the images were
//      left as objects, metas intact, so the verification stamp was right by
//      accident while the files were wrong.
//
// -- THE FIX --------------------------------------------------------------
//   Stop using the manifest. WALK the snapshot and copy every file the entry
//   refers to, wherever in the document it is written, rewriting each URL in
//   place. A walk cannot miss a field - including a field added after the
//   code was written, which is precisely how (1) happened.
//   The image OBJECTS are left intact and only their `url` changes, so
//   source / capturedAt / hash cross with the photograph and a verified book
//   stays verified. ComicVine reference scans and anything outside our
//   bucket are left alone; a file already in the recipient's folder is not
//   re-copied, so a resumed retry is a no-op.
//   Destinations come from the SORTED list of source paths, so a retry
//   overwrites rather than littering, and the index prefix stops two arrays
//   that both contain "0.jpg" from overwriting each other - which would turn
//   a corner macro into a front cover inside the copy, silently.
//   A source the sender deleted between send and accept is skipped and
//   recorded rather than failing the transfer: retrying will never find it,
//   and failing would strand the recipient on a book they can never accept.
//   Any other copy failure still throws, pre-commit, leaving the transfer
//   pending and safely retryable. The accept now records imagesCopied /
//   imageUrlsRewritten / imagesMissing on the transfer doc, because the last
//   version of this copied zero files and nothing anywhere said so.
//
//   `node test-transfer-images.mjs` - 25 cases, no Firebase needed (the
//   functions are sliced out of the shipping file, not copied into the
//   test). It covers both shapes, idempotence, the deleted source, the
//   non-404 abort, and that a verified book stays verified.
//
// -- STILL OPEN: BOOKS ALREADY TRANSFERRED --------------------------------
//   This fixes transfers from here on. Any entry accepted since schema v3
//   landed still points at the sender's Storage folder, and no read-time
//   projection can repair that - the URLs are real files in the wrong
//   account. A repair would have to re-copy them, and it can only run while
//   the sender's files still exist. Scope it from the transfers collection:
//   accepted docs with no imagesCopied field are the affected ones.
//
// v6.38: THE WALL LABEL GETS A WALL-SIZED PRICE; THE APP REMEMBERS WHERE IT
//        WAS; THE PANEL IS AN OBJECT AGAIN.
//
// -- 1. SQUARE'S PRICE IS NO LONGER THE WATERMARK'S WIDTH ----------------
//   The price and the figure are alternates in one slot, so the price was
//   budgeted at the width the FIGURE draws (150px) rather than the width of
//   the box it sits in (230px). That is right for the handled labels. Square
//   is the one you read across a convention hall, and 80px of its slot was
//   dead air the price was not allowed to use. Square only: 150 x 1.5 = 225.
//   Measured across six price strings: +49% to +52%, drawn width 191-225
//   against a 230 box. A single-digit price is the exception - it is not
//   width-limited at all, so the slot's HEIGHT caps it (+37%); without that
//   cap it would have drawn over the QR beneath it.
//
// -- 2. THE DATE / PUBLISHER LINE COULD NOT WRAP -------------------------
//   white-space:nowrap on a line whose width is 160% (undoing scaleX 0.625),
//   so a long one drew straight past the info column and over the score box.
//   Reported on Square, where the column is narrowest, but Wide and Case had
//   the identical rule and only their geometry hid it. The sixth instance of
//   this session's recurring fault, and the first one found BEFORE it was
//   reported on all three. Whether a line may break is a behaviour, not a
//   size or a position, so it is one rule in .rg-any now and the three
//   per-variant declarations are gone.
//
// -- 3. SAVE PDF FROZE ON 'GENERATING 1/1...' AND CAME BACK ON A RETRY ---
//   A hang that clears on a retry is a RACE. qrcodejs builds a <canvas>
//   synchronously, then on its own setTimeout(0) may replace it with an
//   <img> and hide the canvas. renderQRsImmediately re-asserts canvas-only
//   across six ticks over ~400ms - but the capture does not wait for those
//   ticks, it waits for the FONTS, and when the fonts resolve first an <img>
//   can survive into html2canvas's cloned document, where on iOS its load
//   neither completes nor errors. An unsettled promise is not a throw, so
//   nothing is catchable and the button just sits there.
//   settleLabelImagesSync() runs the sweep once more SYNCHRONOUSLY, in the
//   same tick as the capture call, after which nothing can be inserted
//   before html2canvas reads the DOM. It also drops any other image that is
//   not complete - the watermark figure - for the same reason.
//   STATED AS A GUESS: this fits every symptom but has not been reproduced
//   on a device; headless Chromium captures the exact DOM qrcodejs produces
//   without complaint. If it still hangs, look at the art slot, not the QR.
//   The timeout is 45s -> 20s. Nobody waits 45 seconds at a table - they tap
//   away and retry, which is what happened, so the message that was meant to
//   turn a hang into a bug report was never being read.
//
// -- 4. THE PRINT LABEL SHEET WAS A TRAP ON SQUARE -----------------------
//   Tap-outside was the only way out, and the card was max-height 100vh-24px
//   - a 12px strip of backdrop. On Square (a 1:1 label, so the preview is as
//   tall as it is wide) there was nowhere left to tap. Now 100vh-88px, which
//   guarantees a ~44px band top and bottom, AND an explicit x in the header
//   on every label type. It closes, it does not cancel: the queue survives
//   it, exactly as tapping outside always has.
//
// -- 5. THE APP NOW COMES BACK WHERE YOU LEFT IT -------------------------
//   Backgrounding the app and returning to a fresh document is the OS
//   discarding the WebView's content process under memory pressure. That is
//   not ours and cannot be prevented. Two things that WERE ours:
//     a. NOTHING WAS REMEMBERED. The only visibilitychange listener polled
//        for transfers. The open book, its tab and the list position are
//        recorded now and reopened after the first items snapshot.
//        Detail and the list position only - Edit and Add are deliberately
//        NOT restored, because the form lives in page memory and may hold
//        data: URLs that were never uploaded. Reopening an edit screen with
//        half its content silently missing is worse than landing on the list.
//        localStorage with a 30-minute window, not sessionStorage: the
//        lifetime is right either way, and it does not depend on a guess
//        about what WKWebView keeps across a discarded content process.
//     b. THERE WAS NO LOCAL CACHE. initializeFirestore set only
//        experimentalAutoDetectLongPolling, so every cold start refetched
//        the whole items collection over the network before anything could
//        be drawn - the long blank the reload actually feels like.
//        persistentLocalCache, single-tab manager, wrapped in a try that
//        degrades to the old memory-only behaviour. It is a cache, not a
//        backup: nothing is written there that is not also written to
//        Firestore, and no write path changed.
//
// -- 6. THE ROBOGRADE PANEL IS AN OBJECT AGAIN (option 3) ----------------
//   v6.33 made the panel's outer container transparent so the ASSESSMENT
//   tab's sheet could BE the box. That fixed the sub-score clipping, and it
//   cost the panel its identity everywhere the sheet is not: in Edit view it
//   was a stack of dark boxes floating on white, and the same markup read as
//   two different objects depending which screen you were on.
//   It has its own container again, and Detail's sheet is a step lighter
//   (#1d3317) behind it, so the panel is a card lying on the sheet. The
//   clipping does NOT come back: what fixed that was the sub-grade grid
//   itself (2fr 2fr 1fr, min-width:0 on every cell, locked to 104px), not
//   the removal of this box.
//
// -- 7. TABS: THE CLOSED FOLDER KEEPS ITS COLOUR -------------------------
//   v6.35 did this for PHOTOS; ASSESSMENT was still going grey at 0.72
//   opacity when closed. Both are gone. OPEN is carried by position (the
//   closed tab sits 3px lower) and weight, which is how a real tab tells you.
//   And the sheet's top corners are SQUARE now. It used to round the corner
//   away from the open tab, leaving a 10px arc under the closed one with the
//   page background showing through it - the white wedge in Matt's close-up.
//   A folder's sheet has no visible top corners; the tabs are the top edge.
//
// -- 8. SUB-SCORE BOXES: THE AIR WAS UNDER THE NUMBER --------------------
//   League Spartan at line-height:1 leaves about 0.28em of internal leading
//   split above and below the digits. Below, it sat between the number and
//   its category label and read as a gap; above, it was the room the 104px
//   lock had just taken away. line-height 0.72 is the face's cap height, so
//   the box hugs the digits and the flex centring redistributes what is
//   freed - the space moves from between the two to the top, which is
//   exactly the complaint, in both directions.
//
// -- 9. THE WIDE-SCOPED CSS BACKLOG: 8 RULES -> 3 ------------------------
//   check-print-label.mjs has been reporting eight rules scoped to one label
//   for an object that exists on all of them. Resolved, not re-asked:
//     DELETED (4) - every .rg-label.has-price rule. Wide NEVER carries that
//       class: showPrice is opts.priceTag AND size is not 'small', and Wide
//       IS 'small'. They described the retired white price-pad layout - a
//       label that cannot be produced any more. Same removal and the same
//       reasoning as the Case rules in v6.25. The .price-pad rules went with
//       them on stronger ground: the class is emitted nowhere, on any variant.
//     PROMOTED (1) - .ttl-iss's weight and colour moved to .rg-any. They are
//       PROPERTIES, which is why the issue number inside the title read
//       lighter on Case and Square than on Wide. Its SIZE stays per-variant.
//     KEPT, and now documented so the check stops asking (3):
//       .score-box.has-plus .rg-num  - a size. Case and Square handle (+)
//         through _NUMFIT's plusBudget instead, which is the same decision
//         expressed in the place that variant makes it.
//       .info.squeeze .ttl > .ttl-iss - part of WIDE's squeeze, which does
//         the opposite of Square's. Not shared behaviour; two behaviours.
//       .qr-col .qrc - the white quiet-zone pad. Wide prints its QR on the
//         orange gradient and needs it; Case and Square print theirs on the
//         olive field with colorLight matched to it. Deliberately different.
//
// v6.37: THE PUBLIC PAGE DREW ONE STAR ON A TWO-STAR BOOK.
//
// ── THE SAME PANEL, TWO DIFFERENT ANSWERS ───────────────────────────────
//   Weird Science 21 (ID CXWDMG) has a Deep assessment. The label printed
//   two stars. The QR on that label points at the public page, and the
//   public page - same ID, same panel code - drew one.
//
//   robograde-panel.js counts a Deep if ANY of three flags is set:
//       comic.deepAssessmentRan || comic.highGradeTier
//       || comic.roboGrade.deepAssessmentRan
//   api/lookup.js, which builds the object the public page is handed, read
//   the flag from ONE place only - inside roboGrade - and never projected
//   highGradeTier at all. completeAssessment writes deepAssessmentRan at
//   the TOP LEVEL of the comic, so for those books lookup handed the panel
//   a false and the panel believed it. The app read the document directly
//   and saw the truth; only the public page went through lookup.
//
//   lookup.js now mirrors the panel's three-flag test and projects
//   highGradeTier. This is a READ-TIME PROJECTION: nothing is stored wrong
//   in Firestore, so every existing public listing corrects itself the
//   moment this deploys. No backfill, no re-save, no re-print. Check
//   CXWDMG's public link after the push - it should show two stars.
//
// v6.36: SAVING A LABEL STOPS GOING THROUGH THE SHARE SHEET; CASE AND SQUARE
//        GET WIDE'S NUMERAL, WIDE'S RULE, AND A WHOLE LINE OF TEXT.
//
// ── 1. SAVE AND SHARE WERE THE SAME BUTTON ──────────────────────────────
//   "Save as PDF" opened the iOS share sheet, where Save to Files sits behind
//   "View More". So keeping a label - the common case, because the printing
//   happens in the printer's own app - cost: Save as PDF, View More, Save to
//   Files, pick a folder, Save. Five taps for a file the user had already
//   asked for, and the thing they wanted was the one option not on screen.
//   Two buttons now. SAVE AS PDF writes straight to the app's Documents
//   directory, which is Files -> On My iPhone -> Robograder, and says so.
//   SHARE… is the old behaviour, for AirDrop / Mail / Print.
//   On the web, Save is a plain download - which on iOS Safari lands in
//   Files -> Downloads without a sheet - and only Share… shares.
//
//   THIS NEEDS TWO Info.plist KEYS OR THE FILE IS INVISIBLE:
//       UIFileSharingEnabled              = YES
//       LSSupportsOpeningDocumentsInPlace = YES
//   Without them the write still succeeds but into a private directory the
//   user cannot reach. The code falls back to the share sheet if the write
//   fails, because a label you cannot get at is worse than an extra tap.
//
// ── 2. SHEET FACTS ON A SINGLE LABEL ────────────────────────────────────
//   "Queue: 1 / 14" counted toward a capacity that is not in use, and
//   "Labels print 14 to a sheet" described a sheet that is not being printed.
//   Both are hidden in single-label mode. Matt's instinct that single belongs
//   in an entry and sheets belong in List is already how this works - Detail's
//   Print Label passes {single:true}, List's queue does not - so nothing had
//   to be restructured, only stop saying the sheet's lines in the other mode.
//
// ── 3. THE NUMERAL WAS A LIGHTER WEIGHT, NOT A SMALLER ONE ──────────────
//   Case and Square compressed to scaleX(0.625) where Wide uses 0.78. A 25%
//   harder squeeze thins every stroke, so the number read as a different
//   weight. All three are 0.78 now.
//   The SIZE CAPS DID NOT CHANGE. Dropping them to preserve the drawn width
//   would have cut the numeral's height by the same 25% - fixing the weight by
//   shrinking the number, which is not what was asked and left 21px of dead
//   air under the stars. "9.5" at 150px/0.78 draws 163px against a 246px
//   interior and still fits. Measured: 8-10px over the stars on every grade,
//   same as Wide.
//
// ── 4. THE RULE RAN UNDER THE QR ────────────────────────────────────────
//   On Case and Square the rule crossed beneath the code, separating it from
//   the ID text - and those two are the same thing pointing at the same place.
//   Wide stops its rule short of the QR and rests the QR's bottom edge on it,
//   which says they belong together without drawing anything that says so.
//
//   FIRST ATTEMPT WAS WRONG AND IS WORTH RECORDING: shortening the band got
//   the rule right and wrapped the ID onto a second line, because the band and
//   the rule were the same element - the band carries GRADED at its left and
//   the ID pair at its right and must stay full width. They are two objects.
//   The band keeps its width; the rule is drawn as a background strip of a
//   fixed length (644px Case, 360px Square), with its own mono override since
//   Wide still uses a border and these two no longer do.
//   Verified: Case rule ends x=935 against a QR at 965; Square 378 against
//   397; both QRs' bottom edges land exactly on the rule.
//
// ── 5. THE PRINTING LINE WAS CUT THROUGH THE GLYPHS ─────────────────────
//   On Square the line read "1st Printing, First full" with its lower half
//   sliced off, rather than ending in an ellipsis the way Case does.
//   .prt is `flex: 0 1 auto`, so a title taking most of the column shrank it
//   to 23px against a 41.6px line box, and overflow:hidden cut through the
//   letters. fitLabelText computed a one-line clamp correctly; the element it
//   was clamping was already shorter than one line.
//   Two parts:
//     - fitLabelText now floors .prt at one whole line (min-height) before it
//       considers anything else. A clamp that leaves half a letter row reads
//       as a rendering fault, which is the same reason the ellipsis exists.
//     - Square had NO .squeeze rule, so when the fit pass decided the line
//       could not fit and added the class, nothing happened. Its title clamps
//       to two lines now. (Case does the OPPOSITE on purpose: Matt asked that
//       its title never truncate, so its squeeze RELEASES the title clamp.)
//   Another variant-scoped rule for a thing every label has - the fifth.
//
//   Build-guide note: STEP 4b now carries the two Info.plist keys the 6.36
//   save-to-Files change needs, click by click, and the R8 section records
//   the five-point pass as PASSED (3 devices, 5 Nov).
//
//   To make labels show the real version: run `node sync-version.mjs 6.36`
//
// v6.35: MAP LABELS, SUB-SCORE HEIGHT, THE TWO-TAP DELETE, AND SEVEN OTHERS.
//
// ── 1. THE MAP WAS PUSHING ITSELF OFF THE SCREEN ────────────────────────
//   white-space:nowrap on a grid item whose default min-width is min-content:
//   "SIGNATURE CHECK" set its column's minimum to the width of the whole
//   string, the track grew, and the map ran off the right edge.
//   Labels wrap between WORDS now and never inside one, the size is derived
//   from the longest unbreakable run rather than the whole string
//   ("POST-CLEANING" breaks at its hyphen, so its longest run is "CLEANING"),
//   and every box carries min-width:0 so a long label can never widen a track
//   again.
//   Row gap 24 -> 32 so the arrowheads have room, and the MAIN -> DEEP -> FULL
//   spine goes 3px -> 5px against the branches' 2px.
//
// ── 2. THE SUB-SCORE GRID WAS TALLER THAN THE SCORE BOX ─────────────────
//   It was auto-height beside a fixed 104px box, so it overshot and left a
//   band of empty green under the score. Locked to 104px as two equal rows:
//   Front takes the top half, Back / Spine / Int share the bottom. The 2:2:1
//   columns still encode the weights.
//
// ── 3. DELETE TOOK TWO TAPS ─────────────────────────────────────────────
//   Slide, tap, tap again, confirm. The first tap was being eaten somewhere
//   between the row's gesture handling and the click the browser synthesises
//   after a touch. The button fires on POINTER DOWN now. Chasing exactly where
//   the click went is not worth it on a control that has one job and no other
//   gesture to disambiguate against - there is no drag and no long-press on
//   it, so acting on the press removes the question. A _busy flag swallows the
//   synthetic click that follows.
//
// ── 4. THE CAPTURE TIMESTAMP SAID NOTHING ───────────────────────────────
//   It printed a bare date in the VIEWER's bottom-left corner, with no
//   relationship to the photo and no statement of what the date was of.
//   It sits under the IMAGE's bottom-left corner now - measured from the
//   panzoom wrapper, which shrink-wraps the image, so it follows the letterbox
//   whatever the aspect ratio - and it reads "Taken" for an in-app capture and
//   "Added" for an upload. Those are different claims: an uploaded file's
//   timestamp is when it reached Robograder, and calling that "taken" would be
//   a guess dressed as a fact. Hidden while zoomed, since it is anchored to
//   the un-zoomed image.
//
// ── 5. SMALLER ──────────────────────────────────────────────────────────
//   - PHOTOS keeps its beige when it is the closed tab. A folder does not
//     change colour when you close it; the grey fill made the pair read as one
//     live tab and one dead control.
//   - BOOK HAS BEEN CLEANED moved below the whole Full section in Detail. It
//     was between the FULL card and the Full photos, cutting the run of
//     assessment photo blocks in half.
//   - After a capture, the jump lands on the ASSESS BUTTON, not the slot grid:
//     the photos are already on screen behind the camera, and what the user
//     needs next is the control that spends them.
//   - The Outer Edge strip rotates CCW in the Full scan sweep - 180 degrees
//     from the other edges, which it is shot from the opposite side of.
//   - The dropdowns' text is weight 500, the same as any other field.
//
// ── 6. STILL OPEN: THE CONTAINER MODEL ──────────────────────────────────
//   Detail has PHOTOS / ASSESSMENT sheets; Edit has neither, so the Robograde
//   panel - which gave up its own container in 6.33 so the sub-scores would
//   stop clipping - now floats on white in Edit. Matt is right that this needs
//   deciding rather than patching, and it is NOT fixed here. See the handoff.
//
//   To make labels show the real version: run `node sync-version.mjs 6.35`
//
// v6.34: I BROKE FULL ASSESSMENTS IN 6.32. THE GATE LIVES IN TWO PLACES.
//
// ── 1. THE BUG ──────────────────────────────────────────────────────────
//   v6.32 lowered the Full FMV gate from tier 6 ($500+) to tier 4 ($100+) -
//   in index.html's isFullAssessmentEligible() ONLY. api/assess_full.js has
//   its own server-side backstop, added precisely so the client could not be
//   trusted, and it was still at 6.
//   So every $100-$499 book now SHOWED the Full button and the server refused
//   it with INELIGIBLE_BOOK. Tier 6+ books and the near-perfect path still
//   passed both gates, which is why Matt's runs failed while other users'
//   succeeded on the same deploy - it looked like an outage rather than a
//   gate.
//   The threshold is FULL_MIN_FMV_TIER in assess_full.js now, with a note in
//   both files that it is a pair. The user-facing message quotes it rather
//   than hard-coding "$500+ (tier 6)", which had also become a lie.
//
// ── 2. WHY IT TOOK A DAY TO SEE ─────────────────────────────────────────
//   describeAssessmentError() had no branch for the server's own refusals, so
//   a message written for the user - naming the exact requirement the book
//   failed - was thrown away and replaced with "Assessment failed. Please try
//   again. If this keeps happening, please contact support." Advice that
//   cannot work, on a book that would never pass, to the person who IS
//   support. It surfaces the server's message now.
//
// ── 3. A FULL CAPTURE IS ONE SESSION OF SIX ─────────────────────────────
//   The walkthrough queue was "the empty slots AFTER the one you tapped", so
//   starting at the first staple shot three and stopped, and the three edge
//   shots above it needed a second trip through the camera. The queue wraps
//   round for `interior` now - it still starts where you tapped and then
//   covers the earlier slots in the same session.
//   Only `interior` wraps: elsewhere "I only want this one" is a real
//   intention, and the main four are a sequence, not a set.
//   (Also removed an empty `if (kind === "interior") {}` left over from
//   debugging that run.)
//
// ── 4. AN UNSET DROPDOWN IS A PROMPT, NOT A VALUE ───────────────────────
//   "Select grade" was bold near-black, which read as a filled-in field and
//   sat louder than the labelled fields around it. Muted and regular while
//   empty, normal as soon as something is chosen - toggled on the element
//   rather than through a re-render, so changing a grade does not move the
//   page under the user.
//
// ── 5. check-paired-constants.mjs (new) ────────────────────────────────
//   A value duplicated across a client and a server is not a mistake: the
//   server cannot trust the client, and the client cannot wait for the server
//   to decide what to draw. The mistake is having no way to notice when the
//   two stop agreeing, because nothing about editing one of them looks like
//   editing the other.
//   Five pairs watched: the Full FMV tier, the Batch credit cost, the free UV
//   limit, the derived "Signature detected" note, and the tabs kill switch.
//   Run from sync-version.mjs --check, so it is checked by the command that
//   already runs before every deploy rather than by remembering - the same
//   reasoning as the cache-prefix gate.
//   A pattern that stops matching is a BLOCKER, not a pass: a pair the script
//   cannot see is a pair that will drift unwatched. Verified by reintroducing
//   the 6.32 bug and confirming it fails.
//   WHEN YOU DUPLICATE A VALUE ACROSS FILES, ADD IT THERE IN THE SAME EDIT.
//
//   To make labels show the real version: run `node sync-version.mjs 6.34`
//
// v6.33: THE QR RACE, AND MATT'S SECOND REVIEW PASS.
//
// ── 1. THE MISSING QR WAS A RACE BETWEEN TWO ZERO-DELAY TIMERS ──────────
//   "The label is often missing a QR. All I have to do is toggle either the
//   price or thermal tabs and it appears."
//   qrcodejs builds the canvas synchronously, then on its OWN setTimeout(0)
//   may build an <img> from the canvas's data URL and set the canvas to
//   display:none. Our canvas-only cleanup also ran on setTimeout(0). Two
//   zero-delay timers, order decided by whichever was registered first on a
//   main thread that is busy on the first open of a session. When ours won,
//   qrcodejs hid the canvas immediately afterwards and the code vanished.
//   Toggling re-rendered the preview with nothing left to race, which is why
//   a toggle always "fixed" it.
//   The cleanup re-asserts across several frames now, so the outcome does not
//   depend on that ordering, and it leaves an img alone if a platform produced
//   one with no canvas rather than deleting the only thing on screen.
//   Also: openLabelViewer() starts the QR library downloading when the viewer
//   opens instead of when the first render asks for it.
//
// ── 2. THE ASSESSMENT PANEL WAS A BOX INSIDE A BOX ──────────────────────
//   Once the ASSESSMENT tab wrapped it in a sheet, the Robograde panel's own
//   container was a second set of borders and padding around the same content,
//   and the sub-scores clipped - "0.5 INT" lost its last character.
//   The panel's outer container is transparent now and the SHEET carries its
//   colour (#152e10, taken from the panel rather than matched by eye). The
//   score box and sub-grade grid sit directly on it with the full width. The
//   ID / GRADED line, the defect printout and the Photograder panel are one
//   bordered box, joined top / middle / bottom.
//
// ── 3. PREDICTED GRADE WAS max-width:66% ────────────────────────────────
//   A fixed fraction of the column, so "Cream to Off-White" had nowhere to go
//   and the disclaimer wrapped to four lines inside a box with empty space
//   either side. Full width, same as the defect list it is read against.
//
// ── 4. THE MAP, SECOND PASS ─────────────────────────────────────────────
//   Pale panel (#eef3e6 - the assessment-history summary's own colour) so it
//   is distinct from the sheet it sits on AND from all four box states. The
//   title tab is flush with the panel's left edge, so the two left borders are
//   one unbroken line; indenting it was the hard corner.
//   SIGNATURE / INSERT / COUPON gained CHECK, and the label size is derived
//   from the string's length, so nothing wraps and a tenth type needs no
//   override. An AVAILABLE box is now a tap target, routing through
//   showEditToSection() to the control that runs it - which learned anchors
//   for uv / signature / insert / coupon to make that possible.
//
// ── 5. AFTER A CAPTURE, LAND ON THE PHOTOS ──────────────────────────────
//   The camera closed back into a 10,000px form at whatever offset it was
//   opened from. cameraFinish() now scrolls to the section matching the last
//   batch's kind - Deep lands on the corner macros it just shot.
//
// ── 6. SMALLER ──────────────────────────────────────────────────────────
//   - The unselected tab no longer shows a sliver of page between it and the
//     sheet: both tabs drop their bottom border and overlap the sheet's edge,
//     so the inactive one reads as lying underneath.
//   - PHOTOS is beige (#e6e2d4), the paper tone the label and export images
//     use, so the photo half reads as a contact sheet.
//   - FULL ASSESSMENT AVAILABLE comes before POST-CLEANING ASSESS: Full is the
//     next rung up the ladder, Post-Cleaning is something you do and re-measure.
//   - An alert's single button centres (#app-confirm-actions.single).
//   - The Summary Image label centres on itself in the space the thumbnail
//     leaves, instead of being left-aligned against it.
//   - The Post-Cleaning typo: "for an objective BEFORE/AFTER".
//
//   To make labels show the real version: run `node sync-version.mjs 6.33`
//
// v6.32: MATT'S REVIEW PASS — THE MAP, THE TABS, AND TEN SMALLER THINGS.
//
// ── 1. FOLDER PANELS, EVERYWHERE THEY WERE ASKED FOR ────────────────────
//   rgFolderPanel() draws a bordered panel whose title sits in a tab on its
//   own top edge: the tab carries the panel's fill and covers the panel's top
//   border under itself, so the two read as one object rather than a heading
//   above a box. Two elements, not a pseudo-element, so html2canvas can see it.
//   The ASSESSMENT MAP uses it. The PHOTOS / ASSESSMENT tabs now use the same
//   construction: the active tab IS the top edge of the sheet below it, so the
//   Robograde score box is joined to the ASSESSMENT tab and every photo block
//   sits inside the PHOTOS sheet, which runs to the last photo. PHOTOS is the
//   lighter of the two sheets, so the halves are distinguishable before you
//   read the tab.
//   IMAGES is PHOTOS now, in the app and on the public listing.
//
// ── 2. THE MAP, AFTER MATT'S NOTES ──────────────────────────────────────
//   Boxes 84 -> 62px. The six unstarred types no longer reserve a star row, so
//   their two lines centre on the box's real middle instead of hanging under a
//   blank strip.
//   The MAIN -> DEEP -> FULL spine is 3px against the branches' 2px: that is
//   the assessment path and the other six are ancillary, which the drawing
//   should say without a legend.
//   AVAILABLE now takes #152e10 / #4a7028 / #b8d820 - lifted from the BATCH
//   ASSESSMENT AVAILABLE card rather than eyeballed, so the two cannot drift.
//   LOCKED is grey (#6e6e66) with near-white text, not a dark box.
//   YOUR CREDITS is gone: the balance is in the header on every screen.
//
// ── 3. FULL UNLOCKS AT TIER 4 ───────────────────────────────────────────
//   $100+, down from tier 6 ($500+), which was itself down from tier 7
//   ($1000+). Still a completeness pass and still never refunded.
//
// ── 4. THE TWO DROPDOWNS ────────────────────────────────────────────────
//   Added Label Notes and My Grade were full-width platform selects on a form
//   of mostly-empty optional fields, which made them the loudest thing on it.
//   select.rg-select: width:auto so it is as wide as its longest option,
//   appearance:none with the caret drawn as a background SVG so iOS and
//   Android match, and a min-width of 230px on My Grade because
//   "9.8 - Near Mint/Mint" is the longest string either of them holds and it
//   was being clipped.
//   The placeholders are "None" and "Select grade". The em-dashes around them
//   were decoration pretending to be structure.
//
// ── 5. SMALLER ──────────────────────────────────────────────────────────
//   - The camera emoji is off the Verified pill.
//   - Cost Breakdown had colour:#6a8a6a hard-coded in both views while every
//     other section label inherits #8a7a6a from .section-label. It inherits now.
//   - "- public, prints on the label" is off the Added Label Notes field.
//   - The Post-Cleaning blurb is Matt's wording, in both places it appears.
//
//   To make labels show the real version: run `node sync-version.mjs 6.32`
//
// v6.31: THE ASSESSMENT MAP; THE 4x2 CHIP ROW IS 0.5in; EDIT'S HEADER GOES TO
//        THE TOP.
//
// ── 1. THE ASSESSMENT MAP ───────────────────────────────────────────────
//   (v6.31b, after Matt's review: rebuilt as HIS 3x3 with the arrows drawn.
//   The first attempt stacked the rows vertically with no connectors, which
//   was taller, emptier and made the unlock paths harder to read, not easier.
//   Colour carries the state now - the label score box's light green for run,
//   the dark green for available, grey for locked, light red for unaffordable
//   - and the RUN / AVAILABLE captions are gone: if a box needs a word to say
//   which it is, the colour has failed. Cost is "COST" beside a coin with the
//   number in it; a free check says FREE in words, because a 0 in a coin reads
//   as a quantity rather than as nothing to pay. An unaffordable box keeps
//   BOTH its cost and NEED CREDITS - you cannot act on "you are short"
//   without knowing short of what.
//   AND: Coupon and UV hang off MAIN in the drawing too. Matt's sketch had
//   them beside Deep to use the space, with the arrows showing the real
//   source; I misread the placement as the claim. The arrows are the claim.)
//   Nine types, three prices, three confidence tiers and a dependency graph,
//   all of it previously inferable only from which buttons happened to appear
//   down a very long page. One picture now answers: what has run, what is
//   available, what is locked, what each costs, and which ones raise the
//   stars. Bottom of the ASSESSMENT panel in Detail; above the acquisition
//   block in Edit.
//
//   THE GRAPH IS READ FROM THE REAL GATE FUNCTIONS. Every node names the
//   predicate that actually decides it - showDeepTier, isBatchEligible,
//   _cleanUnlocked, showRestorationTier, matchInsert, matchCoupon,
//   hasIdentifiedSignatures - so the map cannot drift into describing an app
//   that no longer exists. A hand-drawn diagram would have.
//
//   IT DIFFERS FROM MATT'S SKETCH IN ONE PLACE, deliberately. Coupon and UV
//   hang off MAIN, not DEEP: showRestorationTier() and matchCoupon() never ask
//   whether a Deep has run, they only need the book identified. Drawing them
//   under Deep would have told users to spend a credit they do not need.
//
//   "Unlocked but unaffordable" is its own state (NEED CREDITS, amber), not
//   LOCKED. Calling it locked sends someone hunting for a prerequisite that is
//   already met. Costs are INSIDE the coins and the balance is the same coin
//   at the foot, so "costs 3" and "you have 2" are one glance apart.
//
//   Verified by direct call across three records: fresh offers only MAIN;
//   after Main, UV and DEEP open; after Deep with a balance of 2,
//   POST-CLEANING is AVAILABLE and BATCH reads NEED CREDITS.
//
// ── 2. 4x2 CASE: THE CHIP ROW IS HALF AN INCH ───────────────────────────
//   144px at 288dpi, measured top-of-upper-bar to top-of-lower-bar. The LOWER
//   bar does not move - it is the fold the user makes first and every label
//   already printed is creased there - so the upper bar rises from 192 to 129
//   and the blank fold-over panel shrinks to suit. The text centres in the
//   137px between the bars, not in the row including its own border.
//   Measured: 144px exactly, lower bar still at 274, chip centred at 206.0
//   against a true midpoint of 205.5.
//
// ── 3. EDIT'S IDENTITY HEADER IS AT THE TOP ─────────────────────────────
//   It was sitting where the four locked fields used to be - below every photo
//   block, a few thousand pixels down. "What book am I looking at" belongs
//   above the photos of it whether or not this view ever gets tabs. Same
//   function Detail renders, with Added Label Notes under it, then the
//   ownership bar. Edit stays one long scroll by Matt's decision; only the
//   order changed.
//
//   To make labels show the real version: run `node sync-version.mjs 6.31`
//
// v6.30: TABS ON THE PUBLIC LISTING, A KILL SWITCH FOR ALL OF IT, AND THE
//        INTEGRITY PILL MOVES INTO IMAGES.
//
// ── 1. THE KILL SWITCH ──────────────────────────────────────────────────
//   TABS_ENABLED in index.html, PUB_TABS_ENABLED in public.html. Set either
//   to false and that page renders exactly as it did before tabs existed - no
//   tab bar, both panels open - with nothing else to revert. Splitting the
//   record is a judgement call that can only really be tested by living with
//   it, so the cost of changing your mind should be one word, not a rollback.
//   Turn one off, turn the other off too.
//
// ── 2. PUBLIC LISTING ───────────────────────────────────────────────────
//   Same split, same default as Detail. A public listing always has an
//   assessment - that is the only reason it exists - so there is no
//   "nothing to show yet" case to default around; it always opens on
//   ASSESSMENT.
//   CARDS ARE NOT TABBED: the card layout is five short blocks and does not
//   have the length problem this solves.
//
// ── 3. THE INTEGRITY PILL BELONGS WITH THE PHOTOS ───────────────────────
//   It reports whether the IMAGES are unaltered, so it says nothing useful
//   beside the write-ups. Inside the IMAGES panel in both views. (It already
//   was in Detail, structurally - my 6.29 note claiming otherwise was wrong.)
//
// ── 4. EDIT VIEW IS NOT DONE, AND WHY ───────────────────────────────────
//   Detail and the public page both assemble their bodies from named pieces,
//   which is what made both safe. Edit builds one enormous interleaved
//   template literal, and its current ORDER is wrong for the spec before tabs
//   even enter it: the image capture sections come FIRST, then the identity
//   header, then the write-ups, then the ownership pill near the bottom. The
//   spec wants header -> Added Label Notes -> ownership bar -> tabs ->
//   panels. So Edit needs a reorder first, and the reorder is the risky half,
//   not the tabs.
//   Doing that blind, while Matt is testing live, is how a working app stops
//   working. Detail and Public first, on a device.
//
// ── 5. ADMIN ITEM IMAGES: NOTHING TO FIX ────────────────────────────────
//   Checked end to end. admin/api/item.js returns signature, coupon, insert,
//   user-defect, interior-cover, restoration and both cleaning sets (the
//   read-from-`flat`-not-`raw` fix in v5.81), and admin/index.html renders
//   every one of them when present.
//   "Whitman/direct diamond price variant" is a PRINTING classification read
//   off the cover's price box by the Main assessment. It is not an Insert
//   finding. The Insert check looks for a Mark Jewelers / Diamond Sales
//   advertising leaf bound into the centerfold - a different "diamond"
//   entirely, and the reason the two read as connected.
//
//   To make labels show the real version: run `node sync-version.mjs 6.30`
//
// v6.29: DETAIL SPLITS INTO IMAGES / ASSESSMENT.
//
//   A fully-worked book runs past 10,000px. The two things people open a
//   record FOR - the photos and the grade - are each now one screen instead of
//   one expedition.
//
//   THE DEFAULT IS THE WHOLE DESIGN. The worry with tabs is that people miss
//   them and never find the second half. So the assessment is what you LAND on
//   whenever one exists, and IMAGES is the half you opt into - which people go
//   looking for anyway, because they arrive wanting to add or check a photo. A
//   book with no assessment opens on IMAGES, because that is all it has. The
//   failure mode only exists in the arrangement where the assessment is the
//   hidden half; this is the other arrangement.
//
//   WHAT IS WHERE
//     IMAGES      every photo block, the integrity pill (it reports whether
//                 the PHOTOS are unaltered, so it belongs with them), and
//                 Post-Cleaning - a capture flow (ten Before, ten After)
//     ASSESSMENT  Robograde score, Photograder, Predicted Grade, the
//                 write-ups, Assessment History, then Batch at the bottom -
//                 Batch is about assessing, not about this book's photos
//     NEITHER     below the panels: Date Acquired, Seller,
//                 My Grade, Cost Breakdown, the public toggle, the action
//                 buttons and Delete - all visible on both tabs
//
//   Panels are HIDDEN, not omitted. The lightbox reel, the camera chain and
//   every getElementById in there expect their nodes to exist whichever tab is
//   showing; rendering one half conditionally would break them in ways that
//   only appear on the tab you are not looking at.
//
//   The choice is sticky per BOOK, not globally: opening a different record
//   re-applies the default rather than inheriting wherever you happened to be.
//
//   NOT DONE YET, deliberately: Edit view and the public listing page. Edit
//   builds its body as one enormous template literal rather than the
//   statement-by-statement assembly Detail uses, so splitting it is a
//   different and riskier job, and Matt is testing live. Detail first, on a
//   device, then the other two.
//
//   Also corrected here: a comment in 6.28 claimed Watching may not be public.
//   It may, and has since 2026-10-17. Only Sold is excluded. The CODE was
//   always right; only my note was wrong.
//
//   To make labels show the real version: run `node sync-version.mjs 6.29`
//
// v6.28: "MAKE NEW ASSESSMENTS PUBLIC" NEVER DID ANYTHING.
//
// ── 1. THE SETTING WORKED; NOTHING ASKED IT ─────────────────────────────
//   The save path reads
//       publicListing: formData.publicListing != null
//                        ? !!formData.publicListing
//                        : !!window._publicByDefault
//   and EMPTY (the blank-form template) sets publicListing: false. `false` is
//   not null, so the fallback was unreachable and every new assessment saved
//   private no matter what the toggle said. The toggle stored its value
//   correctly the whole time.
//   The default is applied in blankForm() now, not at save: the Public switch
//   in Edit shows the right state BEFORE saving instead of flipping on
//   afterwards. Ownership still forces it off for SOLD - and only Sold;
//   Watching has been publishable since 2026-10-17 and stays that way - and an
//   explicit toggle still wins; this only sets the start value. blankForm() reads localStorage directly when
//   window._publicByDefault is not populated yet, because that is set inside
//   the async boot sequence and the first blankForm() runs before it.
//
// ── 2. THE COMPLAINT MESSAGE WAS A BROWSER alert() ──────────────────────
//   The one dialog in the app that was not the app's own. It now goes through
//   appAlert(), and that dialog's acknowledge button reads OKAY rather than
//   OK - applied once, in appAlert, so every acknowledgement in the app reads
//   the same way.
//
// ── 3. ADDED LABEL NOTES IS A DROPDOWN ──────────────────────────────────
//   Seven toggle chips were accurate about the data (a set) and wrong about
//   the use: the field is rarely filled in, and it spent a seven-button block
//   near the top of Edit to say nothing most of the time. One <select>, one
//   line.
//   THE STORED SHAPE IS STILL AN ARRAY. The label, public.html and
//   api/lookup.js all read a list; a book saved while this was multi-select
//   may legitimately hold two; and a future multi-select needs no migration.
//   The picker writes 0 or 1 entry and preserves anything already beyond the
//   first, with a line in Edit saying so. A stored value that is no longer in
//   the vocabulary still appears and stays selectable.
//
//   To make labels show the real version: run `node sync-version.mjs 6.28`
//
// v6.27: ONE IDENTITY HEADER, RENDERED BY BOTH DETAIL AND EDIT.
//
// ── 1. THE HEADER ───────────────────────────────────────────────────────
//   Edit used to re-declare the book's identity as four LOCKED rof() fields in
//   a form grid, plus a fifth locked row for Printing - the same information
//   as Detail's heading, in a different shape, reading as "four things you are
//   not allowed to type in" rather than as a heading. Two copies of one thing
//   is also two things to keep in step, which is the fault behind most of the
//   label bugs this session.
//
//   renderIdentityHeader(item) is now the only copy, and Detail and Edit both
//   call it:
//       Title #Issue
//       Pub Date, Publisher
//       Printing, Added Label Notes, Key Info
//   The third line is the LABEL's own line (print-label.js prtLine) in the
//   same order with the same contents, so the screen and the printed label
//   read the same way. Added Label Notes sits directly under it in Edit.
//
//   Printing is still unforgeable - more so. The anti-fraud concern was that a
//   user could blank a reprint's printing; it is not an input at all now.
//   The unassessed add-flow keeps its editable Title / Issue / Pub Date /
//   Publisher grid untouched: nothing is locked until an assessment exists.
//
//   rof() is deleted. Those four fields were its only callers.
//
// ── 2. MY GRADE MOVED ───────────────────────────────────────────────────
//   Below Seller, above Cost Breakdown. It is the owner's OWN opinion of the
//   grade - personal record-keeping, like the price and the seller. Sitting
//   beside the Robograde score it read as a Robograder output.
//   It never reaches the public listing: api/lookup.js does not project it,
//   and now it is not rendered anywhere public either.
//
//   To make labels show the real version: run `node sync-version.mjs 6.27`
//
// v6.26: ADDED LABEL NOTES - A PUBLIC LINE WITHOUT A UGC OBLIGATION. AND THE
//        PRIVATE FIELD WAS BEING PRINTED ON THE LABEL.
//
// ── 1. WHAT WAS ACTUALLY ON THE LABEL ───────────────────────────────────
//   The printing/notes/key-info line read comic.notes - "My Notes", the
//   owner's PRIVATE free-text field - and printed it on the label. Labels get
//   photographed and listed. That is free text on a public surface, which is
//   the exact exposure the picker below exists to avoid, and it was live.
//   My Notes is private again, labelled as such in Edit, and nothing public
//   reads it. It was never in the public API projection, so the listing page
//   itself never leaked it; the label did.
//
// ── 2. addedLabelNotes: A CLOSED VOCABULARY ─────────────────────────────
//   Seven options (married pages, spine/centerfold/staple detached, staple /
//   coupon / pin-up missing), multi-select, public, printed on the label.
//   A fixed list is not user-generated content, so none of App Store 1.2 or
//   Play's UGC policy attaches - no filtering, reporting, blocking or
//   moderation duty for a one-person company. That was the whole point of
//   choosing a picker over a text box.
//
//   "Signature detected" is DERIVED, never stored: the Main assessment flags a
//   possible signature and the owner filling a Signature slot confirms it is
//   not a false positive. It says nothing about where the signature is or
//   whether it was witnessed - it may have been; we do not know. Derived, so
//   removing the photo removes the note and it cannot go stale.
//
//   A note that is no longer in the vocabulary still prints. Dropping an
//   option must not silently rewrite books that already carry it.
//
//   Reaches: the label (print-label.js), the public listing page (public.html,
//   now one combined Printing / Added Label Notes / Key Info line in the same
//   order as the label), and the public API projection (api/lookup.js, which
//   also now carries keyInfo). comic.notes is deliberately absent from all of
//   them.
//
// ── 3. RENAMES ──────────────────────────────────────────────────────────
//   The existing read-only CGC/PSA slab text is "Grader Label Notes" now, in
//   Edit and Detail, so "Added Label Notes" is unambiguous.
//   Post-Cleaning: the button is POST-CLEANING / 2 CREDITS (the no-refund
//   warning is still stated in the confirm dialog, where a decision is
//   actually being made), and the user-facing "Cleaning Compare" strings read
//   "Post-Cleaning". "BOOK HAS BEEN CLEANED" stays, per Matt.
//
//   To make labels show the real version: run `node sync-version.mjs 6.26`
//
// v6.25: THE 6-CHARACTER CODE CHANGED EVERY TIME YOU SAVED, AND THE CASE LABEL
//        CHANGED SHAPE WHEN THE PRICE WAS TOGGLED.
//
// ── 1. THE CODE WAS NOT STABLE ──────────────────────────────────────────
//   submitForm() claims roboGradeId in a "robograde_ids" document so two books
//   cannot share a code. The claim check asked "does this document exist?" and
//   treated YES as a collision - but on every save after the first, the
//   document it found was the book's OWN claim from last time. So every edit
//   minted a fresh code. Matt: "when I try to print a label for an existing
//   entry, I'm finding the code is different than it was the last time it was
//   printed."
//   The claim document has recorded comicId since it was written. Nothing read
//   it. It does now: a claim whose comicId is this book is ours, and the code
//   stands.
//   NOT CHANGED, because it needs a decision: completeAssessment() also mints a
//   new code whenever Main or Deep produces a roboGrade. If the code identifies
//   the BOOK it should not; if it identifies the ASSESSMENT it should. Old
//   claims are never deleted, so previously printed labels still resolve.
//
// ── 2. CASE: THE PRICE AND THE FIGURE WERE DIFFERENT SIZES ──────────────
//   The price was sized from the art slot's BOX (230px). The figure is a
//   500x600 asset fitted into a 230x184 box, so it is height-constrained and
//   draws at 153px with 77px of empty air beside it. Two alternates in one
//   slot, 77px apart. The price is now sized from the figure's DRAWN width,
//   derived from the asset's aspect rather than hard-coded, for all three
//   labels.
//   The em table is measured now, not guessed: Noto Sans Display 900 draws
//   every digit AND the dollar sign at 0.558em, period and comma at 0.274em.
//   It had 0.60 for the dollar and 0.556 for digits.
//
// ── 3. CASE: ONE RULE MOVED THREE THINGS ────────────────────────────────
//   .rg-label-l.has-price .info { right: 400px } widened the text column by
//   90px whenever the price was on - a leftover from the retired white price
//   pad, which sat somewhere else on the label. Because .info-lower is
//   positioned against .info, that 90px also slid ROBOGRADER.APP/ID sideways.
//   So the text wrapped later and ran into the price, AND the ID moved when
//   the toggle changed. Deleted; the column is now identical in both states.
//
//   The bottom band went from right:-285px to -454px. -285 was measured off
//   the QR column's LEFT edge (x=947) and read as arbitrary. The band and its
//   border-top now stop at x=1116, the QR's right edge: the printed code and
//   the code the QR encodes are the same thing, so they share an edge.
//
//   Verified: .info is 291..661 with and without the price; the band, the ID
//   text and the QR all end at 1115; figure 153px, price 151px.
//
//   Also: "May 1988 , 1st Printing" had a space before the comma - the wrap
//   strip's 14px flex gap sat between the date and the comma pseudo-element.
//
// ── 4. check-print-label.mjs (new) ──────────────────────────────────────
//   A stray backtick in a CSS COMMENT closes the stylesheet's template literal
//   and corrupts the file. It has now happened FIVE times, including twice
//   this session. node --check cannot see it. The script checks for backticks
//   inside the literal, imports the module for real, and warns about rules
//   scoped to one label for an object that exists on all of them - the fault
//   behind four shipped bugs. Run it after every print-label.js edit.
//
//   To make labels show the real version: run `node sync-version.mjs 6.25`
//
// v6.24: ANDROID BACK EXISTS NOW; THE FREE UV CHECK STOPS HIDING BEHIND A
//        BUTTON THAT DESCRIBED IT WRONG.
//
// ── 1. THERE WAS NO BACK HANDLING AT ALL ────────────────────────────────
//   Not a partial implementation - none. No backButton listener, no
//   pushState, no popstate anywhere in index.html. Views are swapped in JS
//   without ever touching history, so Android's Back found a one-entry WebView
//   history and Capacitor did the only thing left to it: exit the app.
//   A tester: "If I hit Start Grading and then hit back, it kicks me out."
//   The screens that seemed to work were the ones that happened to open
//   something with its own back behaviour.
//
//   handleAppBack() tests the overlays first (topmost wins), then the view:
//     cropper -> camera -> lightbox -> confirm -> give -> settings ->
//     label viewer -> buy credits -> public preview
//     then add/edit -> cancelForm(), detail -> showList(), list -> exitApp()
//   "Open" is measured by whether the element is actually laid out, which is
//   the one test that survives display / class / inline-style showing.
//
//   Back does NOT dismiss the in-progress assessment modal. Backing out of a
//   paid call already in flight reads as a cancellation we cannot honour.
//
//   This also fixes the tester's second report - returning from an external
//   link landing on the main screen rather than the screen he left - because
//   hideBuyCredits() already knows to return to Settings when Buy came from
//   there, and now something actually calls it.
//
//   On the web there is no hardware back, so the listener never attaches.
//
// ── 2. THE UV CHECK WAS BEHIND A BUTTON THAT LIED ABOUT IT ──────────────
//   CHECK RESTORATION promised "8 photos (UV front + back, staples, edge,
//   interior)... 6 of 8 images are shared with Full Assessment". The check has
//   needed TWO photos for some time. A free check hidden behind a tap that
//   overstates the work by 4x is worse than no tap at all.
//   The reveal gate is gone: a qualifying book shows the UV Check section
//   directly, with Matt's copy.
//
//   revealRestorationSlots() and _restorationRevealed went with it. The
//   function's surviving effect was a re-render - its "auto-populate shared
//   slots from Full Assessment" loop walked RESTORATION_TO_FULL, which has
//   been [null, null] since the check dropped to 2 photos, so it could never
//   populate anything. Dead code that read as live, and a comment in the
//   capture handler still pointed at it as though it ran.
//
// ── 3. check-index-syntax.mjs (new) ─────────────────────────────────────
//   `node --check index.html` is meaningless - node parses the HTML as JS and
//   dies on the first tag - so the biggest file in the project had NO syntax
//   gate. This extracts all ten inline <script> blocks and checks each one,
//   as a module where the tag says so. Run it after every index.html edit.
//   It is the index.html counterpart to the import test that catches a stray
//   backtick in print-label.js.
//
//   To make labels show the real version: run `node sync-version.mjs 6.24`
//
// v6.23: FIVE FIRE-AND-FORGET FIRESTORE WRITES THAT MOSTLY NEVER RAN, AND THE
//        "(+)" SITTING ON TOP OF THE GRADE.
//
// ── 1. UNAWAITED WRITES ON A PLATFORM THAT FREEZES THE INSTANCE ──────────
//   The Nov 4 logs carried 12 of these in 12 hours:
//       DEADLINE_EXCEEDED: Deadline exceeded after 254.448s
//       name resolution: 234.605s
//   Nobody waited 254 seconds. Vercel freezes the function instance the moment
//   the handler's response is sent; a promise still in flight gets no CPU, its
//   gRPC connection to Firestore stops mid-DNS, and it is still sitting there
//   when the instance thaws for the NEXT request - at which point it rejects
//   and logs against an unrelated requestId. That misattribution is why this
//   looked like a Firestore problem for weeks.
//
//   Every one of these was written as "fire-and-forget, a failed write must
//   never fail the request". The intent was right; the mechanism was not.
//   Unawaited is not best-effort here, it is a row you do not get.
//
//   Now awaited (each still swallows its own errors, so the request is as safe
//   as it was):
//     lib/credits.js  logCreditEvent at BOTH call sites
//     api/assess.js            slabcheck timing  (response was the NEXT line)
//     api/assess_batch_start.js  batch timing    (same shape)
//     api/assess_clean.js        clean timing    (same shape)
//     api/probe.js               probe cost row  (same shape)
//
//   reserveCredit needed more than an await: its ledger call sat INSIDE the
//   transaction callback, which can run more than once under contention. It
//   now records the intent and writes once, after the transaction commits -
//   still outside the transaction, as the original comment required.
//
//   WHAT THIS COST: credit_sweep has been refunding orphaned credits correctly
//   and losing the ledger row for each one, so the audit trail disagrees with
//   the balances by exactly the refunds. The balances were never wrong.
//
// ── 2. THE "(+)" OVERLAPPED THE GRADE ───────────────────────────────────
//   In the app's score box the numeral is drawn dead-centre at a size derived
//   only from the BOX, and the "(+)" is pinned to the right edge. Nothing
//   stopped them sharing pixels. A 2-glyph grade happened to fit; "9.5(+)"
//   did not, and that is what an Android tester photographed.
//   The numeral is now capped by the measured em-width of the actual string
//   against the space the "(+)" leaves - the same method print-label.js uses
//   (_NUMFIT) rather than a character count. The "(+)" also drops from
//   numSize/3 to numSize/3.6: it is a hint, not a result, and at a third of
//   the numeral it was the second-loudest thing in the box.
//   Verified headless across 9.5 / 9 / 10 / 8.5 with and without the mark, at
//   three box sizes, in the real League Spartan.
//
//   To make labels show the real version: run `node sync-version.mjs 6.23`
//
// v6.22: ONE PLACE FOR THE THINGS THAT ARE TRUE OF EVERY LABEL.
//
//   Every comic label root now also carries the class `rg-any`, and the
//   stylesheet opens with a SHARED block written against it. A rule that is
//   true of Wide AND Case AND Square goes there once; a variant that genuinely
//   differs overrides it at equal specificity, which works because the shared
//   block is first in source order. No !important anywhere.
//
//   WHY: four separate times a rule written while working on Wide was scoped
//   to `.rg-label` - which is Wide and nothing else - for an object that lives
//   on every label. The chip colour (twice), the `(+)` mark, the price face.
//   Each shipped subtly wrong on the other two and was caught by eye, on
//   paper, weeks later. That is a mechanism problem, not four mistakes.
//
//   WHAT MOVED: the price face/weight/colour (incl. the mono override) and the
//   grade numeral's typeface. Deliberately NOT moved: sizes and positions. The
//   labels are 4x1, 4x2 and 2x2 inches - a shared font-size or offset is almost
//   always wrong, and the numeral's size is computed per label from the
//   measured string width (_NUMFIT), not from CSS at all.
//
//   NOT INCLUDED: the trading-card label (`rg-label-card`). It has its own
//   `rgc-*` element vocabulary and shares no selectors with these three, so a
//   shared hook would buy nothing.
//
//   STILL WIDE-SCOPED, audited but not moved - see LABEL_SHARED_STYLES.md:
//     .rg-label .ttl-iss                        (title/issue, exists on all 3)
//     .rg-label .info.squeeze .ttl > .ttl-iss
//     .rg-label .qr-col .qrc                    (QR sizing, exists on all 3)
//     .rg-label .score-box.has-plus .rg-num     (probably dead - _NUMFIT's
//                                                inline size overrides it)
//     .rg-label .has-price .*                   (the retired white price pad)
//   Each needs a decision rather than a blind move; they are listed so the
//   next person does not have to rediscover them.
//
//   AND AGAIN: backticks in a comment inside the CSS template literal closed
//   the string. Fourth occurrence. The import test caught it; reading did not.
//
//   To make labels show the real version: run `node sync-version.mjs 6.22`
//
// v6.21: THE PRICE WAS ONLY STYLED ON WIDE.
//
//   `.rg-price` carried its face and weight from a rule scoped to `.rg-label`
//   - which is the Wide label ONLY. Case is `.rg-label-l` and Square is
//   `.rg-label-square`, so on both of them the price inherited the container's
//   Barlow Condensed instead of Noto Sans Display 900. The inline font-SIZE is
//   computed per label from the string's measured width, so the price was the
//   right size and the wrong typeface, which is why it read as "slightly off"
//   rather than obviously broken.
//   One selector covers all three now, mono colour override included.
//   Verified by computed style, not by eye: $50 renders as
//   'Noto Sans Display' 900 on small / small-l / square.
//
//   THE PATTERN, AGAIN: a rule written for Wide and scoped to Wide, for an
//   object that exists on every label. Same shape as the chip-vs-face colour
//   drift in 6.15/6.19 and the missing `.rg-plus` rule on Case and Square.
//   When a thing is shared, its rule has to be too.
//
//   To make labels show the real version: run `node sync-version.mjs 6.21`
//
// v6.20: THE WIDE NUMERAL COLLIDED WITH THE STARS, AND MY HARNESS COULD NOT
//        HAVE SEEN IT.
//
// ── 1. THE MEASUREMENT WAS TAKEN IN THE WRONG TYPEFACE ──────────────────
//   Every ink measurement of the grade numeral since the Wide rebuild ran in
//   a sandbox with no network access to fonts.googleapis.com. 'League Spartan'
//   never loaded; the browser silently fell back to a substitute face whose
//   digits are shorter and narrower. So the harness reported 12px of air over
//   the stars at 212px while the real font was 4-7px INTO them - which is
//   exactly what printed on Matt's Batman #151.
//   The harness now serves League Spartan, Barlow Condensed, Noto Sans
//   Display, Noto Sans Mono and Saira from local @fontsource copies. No ink
//   number taken before this is worth anything.
//
// ── 2. WIDE: 212 -> 204px, translateY 14 -> 24px ────────────────────────
//   Re-measured with the real face across 4 / 9 / 10 / 8.5 / 9.5, with and
//   without the (+). Lowering alone was not enough at 212 (the 8.5's ink then
//   ran into the version stamp), so it is both: a little smaller and a little
//   lower. Result across every case: 8-10px over the stars, 21-24px under the
//   numeral to V6.xx.
//
// ── 3. SQUARE: translateY 14 -> 17px ────────────────────────────────────
//   Same re-measurement: 5px of clearance, not overlapping but tighter than
//   anything else on the label. 8px now, and it has 37px underneath to spend.
//   Case (small-l) re-measured clean at 8-10px; left alone.
//
//   To make labels show the real version: run `node sync-version.mjs 6.20`
//
// v6.19: THE THERMAL CASE LABEL WAS PRINTING COLOUR, AND I HID A FOLD LINE.
//
// ── 1. A GREEN PANEL ON A ONE-INK PRINTER ────────────────────────────────
//   The chip row's score box moved from the dark fill to the light green in
//   v6.15, along with the face's box - and the .mono override followed only
//   the face's. So the thermal Case printed a green chip. Same rule as the
//   face's box now: white fill, black outline, at the 2px the chip uses.
//   This is the second time this exact pairing has drifted (v6.16 fixed the
//   chip's COLOUR against the face's and missed that mono existed), which is
//   the argument for the chip and the face reading from one place rather than
//   two. Not done here; noted.
//
// ── 2. THE FOLD-OVER BACK CARRIED THE GRADIENT ──────────────────────────
//   0.67in of orange gradient on a printer that burns black: it dithers the
//   whole panel into cross-hatch and carries no information while doing it -
//   and it is the side that faces out on a shelf. White in mono.
//   The upper fold rule needed its own override too: it is the chip row's
//   border-top, which the .fold-guide rule does not reach, so it was still
//   printing olive. A fold mark that dithers to a grey hatch is the one thing
//   a fold mark must not be.
//
// ── 3. I HID A FOLD LINE RATHER THAN MOVING IT ──────────────────────────
//   The 4x2 stock folds TWICE: back over the top of the case along the upper
//   rule, and forward along the lower one so the chip row sits on top. When I
//   built the tall variant I set the original fold-guide to display:none -
//   treating it as a leftover of the 1.33in design rather than as the second
//   fold - so the label lost the mark for the fold the user actually makes
//   first.
//   It moves with the chip row now (top 81 -> 273) and it is on EVERY version
//   of the Case label, sheet and roll alike. Also 10px soft olive -> 7px solid,
//   matching the upper rule: at 10px and 0.8 opacity it read as decoration
//   rather than as a mark to line a thumb up against.
//   Verified across all four states (sheet/roll x colour/thermal): the guide is
//   present in each, black in mono, and the chip and back panel follow.
//
//   To make labels show the real version: run `node sync-version.mjs 6.19`
//
// v6.18: CASE PRINTS ON 4in x 2in ROLL STOCK; THE NUMERAL IS SIZED BY WIDTH,
//        NOT BY CHARACTER COUNT.
//
// ── 1. "IS THE SIZE EXPANDING TO FIT THE SPACE?" — NO, AND THAT WAS THE BUG
//   Matt saw an 8.5 sized correctly and a 4 too big, overlapping the star.
//   Nothing was auto-fitting: the size came from a .num-3 class meaning
//   "three or more CHARACTERS, use the small value", with a hand-picked px per
//   size. Two faults in that.
//   CHARACTER COUNT IS NOT WIDTH. "10" is two characters but two FULL digits -
//   wider than the three characters of "9.5", since a period is about a third
//   of a digit. So "10" took the big size and ran into the (+): measured, the
//   overlap was 5px on Square and 57px on Case.
//   And each size's value was picked once and never re-measured after the
//   layouts moved under them.
//   The size is computed from the string's own em width against the box's real
//   interior now - the same method the price fit uses, with a digit at 0.556em
//   and a period at 0.28em, measured off rendered glyphs.
//   The (+) budget is a RENDERED WIDTH, not "interior minus the (+)": the
//   numeral is CENTRED and the (+) is pinned right, so what binds is how far
//   the ink may reach from the centre. Measured per size.
//
// ── 2. CASE HAD NO (+) RULE AT ALL ───────────────────────────────────────
//   The base .rg-plus is scoped to .rg-label, which does NOT match
//   .rg-label-l, so on Case the (+) was a static block inside the centring
//   flex column - it rendered UNDER the number. Square had the same gap and
//   was fixed last version; Case is fixed the same way.
//
// ── 3. CASE SINGLE-LABEL IS 4in x 2in ────────────────────────────────────
//   Nobody makes a 4 x 1.333 thermal roll, so a single Case label prints on
//   4 x 2 while the Avery 5162 SHEET keeps 1.333. Carried as a `single` block
//   on the existing 'small-l' format rather than a new size: the size chips
//   render from that list, and a second Case chip would ask the user to choose
//   between two things that are the same label. _fmtFor() picks the geometry.
//   All 192px of the extra height goes ABOVE the design - it folds over the
//   top of the case and covers the back - so the face and the chip row keep
//   their layout exactly and move down together. Nothing inside them had to be
//   re-measured.
//   The back is blank by design, with the gradient INVERTED so the two run the
//   same way as the eye travels down the front and up the back. A 7px rule
//   across the top of the chip row marks the fold: the only mark on the label
//   that is an instruction rather than information, so it is heavier than the
//   hairlines.
//
// ── 4. THE SAME scaleX FAULT, A THIRD TIME ───────────────────────────────
//   Case's title and date line had transform:scaleX(0.625) with no width:160%,
//   so they wrapped against the full box and then drew at 0.625 of it - 37% of
//   the column thrown away. "The Amazing Spider-Man" took three lines where it
//   takes two, and the date line wrapped into the meta band. Wide had this,
//   Square had this, Case had this. All three now carry the 160%.
//
// ── 5. CONTENT, PER MATT ─────────────────────────────────────────────────
//   Comma between publication date and printing, not a bullet (the issue
//   number keeps its bullet - it separates identity from description).
//   GRADE ID -> ID on the chip row. The title is never truncated on Case; the
//   printing/variant line gives instead. QR bottom edge 14px clear of the meta
//   rule. Price with no box, sized like Wide's; watermark when no price is set,
//   standing on the rule.
//
//   To make labels show the real version: run `node sync-version.mjs 6.18`
//
// v6.17: SQUARE REBUILT; ONE ART/PRICE SLOT FOR EVERY SIZE; THE PM MECHANISM
//        RENAMED TO WHAT IT ACTUALLY DOES.
//
// ── 1. computePhotograderPM -> computeScoreCeilingPenalty ────────────────
//   The number was never a precision estimate. It is how many points come off
//   the top of the 0-100 score because the photographs do not support a higher
//   one, and that is all it has ever done. lib/photograder.js says so now, and
//   the old export name is kept as an alias so nothing breaks on the rename
//   alone. Verified identical output across five letter/tier/prior cases.
//   THE STORED KEY: roboGrade.scoreCeilingPenalty is written as the honest
//   name, and confidenceRange is still written beside it, because every
//   existing record carries it and because assess_deep/assess_full read the
//   PRIOR tier's value for the monotonic clamp. Readers prefer the new key and
//   fall back to the old, so the legacy name can retire once no live record
//   depends on it. Hard-renaming the stored key today would orphan every
//   record and silently disable the cross-tier clamp.
//
// ── 2. ONE SLOT, NOT THREE THINGS FIGHTING OVER THE SAME CORNER ──────────
//   .rg-art is now the single art/price column on every comic size, replacing
//   BOTH the white price-pad and the per-size robot-badge. Slot width per size
//   (Wide 160, Square and Case 230) feeds the price fit, so a wider slot gets
//   a bigger price rather than the same one floating in space.
//   The white box around the price is gone everywhere, per Matt.
//
// ── 3. SQUARE, REBUILT FROM THE BOTTOM UP ────────────────────────────────
//     meta band   y 514..562   GRADED left, ROBOGRADER.APP/ ID / right
//     rule        y 514        14px of air under the QR, not flush to it
//     QR          y 340..500   bottom-RIGHT, directly above the grade ID
//     art/price   y 320..500   bottom-LEFT, bottom-aligned with the QR
//     score box   y 14..270    unchanged
//     info        y 14..306    top-left
//   Type sizes now match Wide: title 46 -> 62, date line 32 -> 48, the
//   printing/My Notes/Key Info line 25 -> 32.
//   THE TITLE WAS WRAPPING THREE WORDS EARLY and it was the same fault Wide
//   had: scaleX(0.625) compresses the rendered glyphs but leaves the layout box
//   alone, so the text wrapped against the full box and then drew at 0.625 of
//   it - 37% of the column thrown away on every label. width:160% (= 1/0.625)
//   makes the line box the column's real width. Square never got Wide's fix.
//   The (+) was rendering UNDER the number because Square had no rule for it
//   and inherited a flow position. It is on the number's midline to its right
//   now, at 54px.
//
//   ONE THING MATT ASKED FOR THAT I COULD NOT ALSO GIVE HIM: "let the
//   printing/notes/Key Info line wrap until it reaches the horizontal line"
//   and "put the price/watermark in that space" are the same 180px of
//   bottom-left label. On a 576 square you can have a full-height text column,
//   an art/price slot and a bottom-right QR - any two of the three. The text
//   currently stops above the art slot. Needs Matt's call on which gives.
//
//   To make labels show the real version: run `node sync-version.mjs 6.17`
//
// v6.16: CASE AND SQUARE GET WIDE'S BOTTOM ROW; PM OUT OF THE PROMPTS.
//
// ── 1. ONE META ROW ON CASE AND SQUARE, WITH A RULE ──────────────────────
//   GRADED + date left, ROBOGRADER.APP/ ID / XXXXXX right, matching fonts, a
//   rule above, pinned to the floor so both sit at the same y on every label
//   however the title wrapped - which is what makes the stock pre-printable.
//   The separate .url line under the QR is GONE on both. It said the same
//   thing twice in a second typeface, and on Case it was the element that did
//   not fit its own column.
//   Case also had `.meta-id-lbl, .meta-id-val { display:none }` from when the
//   URL carried the ID - removed, or the new row would have shown GRADED and
//   nothing else.
//   Case's .info had no bottom inset, so an absolutely-positioned band at
//   bottom:0 landed at the bottom of an AUTO-HEIGHT column - in the middle of
//   the text. Fixed, and .info-upper's ceiling cut 250 -> 198 so the text
//   cannot run into the band.
//
// ── 2. THE FOLD-STRIP CHIP WAS THE OLD DARK SCORE BOX ────────────────────
//   Case's wrap-strip drew #1a2208 with a chartreuse numeral while the face's
//   box below it had moved to light green with black numerals: same label,
//   same book, two different score boxes. It is the thermal argument again - a
//   pale numeral knocked out of a dark panel is physically unprintable on a
//   one-ink printer.
//
// ── 3. I BROKE THE CSS LITERAL WITH BACKTICKS. AGAIN. ────────────────────
//   A comment I wrote inside the CSS template literal used backticks around a
//   property name, which closed the string. HOW_WE_WORK §10 names this exact
//   trap and I walked into it anyway. Caught by the import test, not by
//   reading. The CSS block is now audited for stray backticks as part of the
//   check (100,695 chars, none).
//
// ── 4. PM IS OUT OF THE PROMPTS ──────────────────────────────────────────
//   Removed from api/assess.js (rule 8 "CONFIDENCE" entirely, the "Confidence
//   base +/-N" line, and the confidenceRange field in the output schema),
//   api/assess_full.js (the PRECISION MODIFIER line and its schema field) and
//   api/assess_deep.js (its schema field). The SCORE CEILING instruction
//   STAYS - it shapes the model's grade, and it is phrased as a ceiling now
//   rather than as a function of a +/-.
//   The model's confidenceRange was being overwritten by the server anyway, so
//   every token spent asking for it was wasted.
//   **The prefix gate says the cached prompt prefixes are UNCHANGED** - all of
//   this text lives after the cache split, in the per-request portion. That is
//   the gate earning its keep on its first real use: the answer was checked,
//   not assumed.
//   lib/deep_prompt.js's PM paragraphs are deliberately NOT touched: they ARE
//   in the cached Deep prefix, so that edit belongs in a pass that re-verifies
//   the keep-warm ping in the same breath.
//
//   STILL TO DO: rename computePhotograderPM / confidenceRange to something
//   that says "photo-quality score ceiling" rather than "precision estimate".
//   The FIELD has to stay - assess_deep and assess_full read the prior tier's
//   value for the monotonic clamp, and old records carry it.
//
//   To make labels show the real version: run `node sync-version.mjs 6.16`
//
// v6.15: PM GONE FROM EVERY DISPLAY SURFACE; CASE AND SQUARE CARRY-OVER;
//        A PRODUCTION CRON THAT HAS NEVER RUN.
//
// ── 1. /api/credit_sweep HAS BEEN FAILING ON EVERY RUN ────────────────────
//   Found in a log Matt sent for an unrelated reason: 117 failures in 19
//   hours - every run of the 10-minute cron - all
//   `9 FAILED_PRECONDITION: The query requires an index`.
//   credit_sweep is the half of the credit fix that protects the USER: it
//   refunds assessments charged but never landed, which is the Punisher 1 case
//   from 2026-10-21 that prompted it. It has been dead for as long as it has
//   been deployed, so nobody has had a credit swept back.
//   Needs one composite index on assessment_timings: creditSettled +
//   creditPendingAt. Firebase's create-link is in the error and in TASKLIST.
//   The lesson is not the index. It is that a cron can fail every run for
//   weeks and nothing says so, because a log only gets opened when something
//   else is already wrong.
//
// ── 2. PM IS GONE FROM EVERY DISPLAY SURFACE ─────────────────────────────
//   lib/roboscore_v3.js (computePM/formatPM and the scoreBox's pmHtml), the
//   three hand-edited copies of it in index.html / public.html /
//   admin/index.html, robograde-panel.js (which computed a +/- THREE ways -
//   v3 pmLabel, a v2 "severity notches" variant, and a legacy four-tier rule
//   off confidenceRange), the card panel's own version, the summary image's
//   PM drawing, the admin item payload, the admin catalogue score box, the
//   dead rgV3PMStr() helper, and the rgV3PM fields that were stored and never
//   rendered.
//   photoSeverity() STAYS: it also steps the grade CAP, which is a different
//   mechanism that has nothing to do with the +/-.
//   index-ios.html and index-android.html are generated from index.html, so
//   they pick this up at the next build - do not hand-edit them.
//   Removed code is in shared/_ARCHIVE/PM_REMOVED_S22.md.
//   STILL TO DO: the server side. confidenceRange is not display-only -
//   scoreCeiling = 100 - PM in Main, Deep and Full - so the mechanism has to
//   survive under an honest name. Matt's ceilings to preserve exactly:
//   Main 9.0 (v3) / 90 (v1), Deep 9.5, Full 10.
//
// ── 3. CASE AND SQUARE: THE INTERIOR, NOT THE PLACEMENT ──────────────────
//   Matt's distinction, and it is the right one. Carried over: the .num-3
//   three-glyph guard (both variants could still wrap "100" or "9.5" down over
//   the version string - the class was being emitted for every size and only
//   Wide had rules for it), the wrapping printing / My Notes / Key Info line
//   with the whole-line clamp and the "...", the fit pass (its selector was
//   '.rg-label .info' - Wide alone - so Case and Square had the line with none
//   of the clamping), and the version-string size. NOT carried: Wide's numeral
//   size or compression, and no placement. Matt reviews and lists refinements.
//
// ── 4. ROLL LINKS FOLLOW SINGLE-LABEL, NOT THERMAL ───────────────────────
//   Matt's correction: a roll printer that prints in colour is still a roll
//   printer, and sending that user to an Avery sheet because they did not tick
//   "thermal" would be wrong. Thermal implies a roll; it is not the only thing
//   that does.
//
//   To make labels show the real version: run `node sync-version.mjs 6.15`
//
// v6.14: WIDE LABEL - BIGGER GRADE, MY NOTES, A MARKED TRUNCATION, ROLL LINKS
//        ON THERMAL.
//
// ── 1. THE GRADE IS BIGGER, BUT NOT FOR THE REASON WE ASSUMED ────────────
//   I said removing the PM would let the numeral grow. It did, but not
//   directly: the PM sat in the box's TOP-RIGHT corner, so removing it freed
//   the right side, and the numeral's binding constraint was the VERSION
//   STRING below it - at 188 there were 3px between them.
//   The room actually came from two moves the PM removal made possible:
//   .rg-num-wrap translateY 22 -> 14 (into the 28px of slack that opened under
//   the stars once the layout settled) and .rg-v bottom 14 -> 10.
//   188 -> 212, and 212 is measured: swept 196/204/208/212/216 across
//   6 / 9.5 / 100 / 4.5 / 8, rasterising the box and diffing black pixels. At
//   212 the worst case clears the stars by 12 and the version by 7. At 216 the
//   version drops to 5 and the last 4px are not worth it.
//   has-plus did NOT scale with it. 167 (148 x 212/188) put the numeral 1px
//   INTO the (+). The (+) is a horizontal constraint on the number's midline
//   and the PM was never in its way, so a (+) book gains almost nothing - the
//   (+) is the thing taking that space. 152, leaving 5px.
//   num-3 stays at 172: three glyphs are width-bound against the 256px
//   interior, which also did not change.
//
// ── 2. MY NOTES ON THE LABEL ─────────────────────────────────────────────
//   comic.notes rides between the printing and the Key Info. A fact about THIS
//   copy ("Detached spine", "coupon cut from page 14") outranks a fact about
//   the issue, which is true of every copy of it - so it goes above.
//
// ── 3. A TRUNCATION THAT LOOKS LIKE ONE ──────────────────────────────────
//   The printing / notes / Key Info block clamps to whatever lines the title
//   left, and it used to just stop. text-overflow cannot mark a multi-line
//   clip - it only marks a single clipped line - so fitLabelText shortens the
//   text until it fits WITH the ellipsis.
//   Word at a time from the end, not character at a time: a cut mid-word
//   ("...Spider-M...") looks like damage where a cut between words looks
//   deliberate. Trailing punctuation goes with the word, so it never reads
//   ", ...". The original string is kept in data-full so a re-run measures the
//   full text and can put it back if the clip no longer applies.
//
// ── 4. ROLL LINKS FOLLOW THERMAL ─────────────────────────────────────────
//   The Buy button points at roll stock when mono (thermal) is on OR when
//   printing a single label, and at Avery sheets otherwise. Thermal IS a roll
//   printer; nobody feeds a 20-up sheet through one.
//   4x1 B0H2668WYX, 2x2 B0FDFWJ4K6, 4x2 B0FGXX2NJC, tag appended at build time.
//
//   To make labels show the real version: run `node sync-version.mjs 6.14`
//
// v6.13: DEEP WAS PAYING A CACHE-WRITE SURCHARGE ON EVERY SINGLE-BOOK PASS;
//        THE PUBLISHED PG LADDER IS NOT CGC'S SCALE; A DEPLOY GATE FOR
//        PROMPT-PREFIX DRIFT.
//
// ── 1. THE DEEP CACHE: READING, BUT ALSO WRITING SOMETHING NOBODY READS ───
//   From Matt's log (deep_1793747569602_li61uo, FF #121):
//     cacheReadInputTokens      8302     <- the system prefix. Working.
//     cacheCreationInputTokens  8817     <- the SECOND breakpoint.
//   The second breakpoint sits on the last invariant IMAGE - corners, interior
//   covers, cover - and its comment is right that those are byte-identical "on
//   every pass of a BATCH". That is also the catch: on an ordinary single Deep
//   there is no second pass, and those images are this one book's. The entry is
//   written and never read.
//   A cache write bills at 1.25x base, so an unread write is a 25% surcharge on
//   everything it covers: ~8,800 tokens, about $0.03 on a $0.134 call.
//   The breakpoint is now set only when _isBatchPass, where four later passes
//   read it back. Single Deeps let those images bill at base rate.
//   So the answer to "is Deep caching?" is yes, the prefix is - the 8302 read
//   proves it - and the 12-13c Matt is seeing against the old 15-17c is that
//   cache working. This change should take a little more off.
//
// ── 2. WE DO NOT ISSUE 1.8, 9.9 OR 10.0 ──────────────────────────────────
//   Matt's correction, and he is right: enforceCgcGrade was snapping to CGC's
//   full 25-rung scale, which includes three grades Robograder does not
//   predict. 9.9 and 10.0 were already unreachable via the tier ceilings
//   (Main 9.2, Deep 9.6, Full 9.8), so naming them legal in the output schema
//   only ever invited a number we would then clamp; 1.8 had nothing stopping
//   it at all.
//   Two lists now, and the split is the point:
//     CGC_GRADE_SCALE   - CGC's scale (25). Reference images, windows, defs.
//     PG_OUTPUT_LADDER  - what we publish (22). enforceCgcGrade snaps to this.
//   The Deep's grade-reference window keeps using the full scale, because the
//   reference IMAGES are per real CGC grade.
//
// ── 3. HOW WE STOP LOSING THE KEEP-WARM PING ─────────────────────────────
//   Matt's question, and the honest answer is that a person cannot be relied
//   on to connect "I edited a sentence in the prompt" to "every cached entry
//   just died" - a note in a document has already failed at it once.
//   So: check-cache-prefix.mjs hashes the Main prefix and all three Deep
//   variant prefixes and compares them against cache_prefix_manifest.json.
//   It runs from `node sync-version.mjs --check`, which is already the command
//   that runs before every deploy, so it is checked by machinery rather than
//   by memory. On a change it exits non-zero and prints the three steps:
//   deploy, verify /api/cachewarm?mode=status, then --update to record.
//   It watches the BUILT STRING, not the source file - verified both ways: a
//   comment added inside buildDeepPrefix() does not trip it, and a single
//   extra space inside the Main prompt's tier text does.
//   Recorded at creation: main 2cf0adb252514a0d, deep f88b764982ee6c7b,
//   deep_ic 6d3ed9024eef3cff, resto f9e342633ad86dbc. The deep_ic sha matches
//   the one in Matt's live log, which independently confirms the running Deep
//   is on the prefix this repo builds.
//
//   To make labels show the real version: run `node sync-version.mjs 6.13`
//
// v6.12: PM SCRUB BEGUN (LABEL DONE); CATALOGUE SORTS BY RG AND PG;
//        admin/api/rescore.js HAD ITS OWN, WRONG, CGC LADDER.
//
// ── 1. THE 9.5: WHAT I CHECKED AND WHAT IS LEFT ───────────────────────────
//   Matt's hypothesis was that the prompt does not reference the valid-grade
//   list. It does, three ways: lib/main_prompt.js ships CGC_GRADE_TIERS (the
//   full per-grade definitions, whose only rungs are 10.0/9.9/9.8/9.6/9.4/
//   9.2/9.0/8.5/... - no 9.5 anywhere in it); the output schema in all three
//   endpoints names the legal set explicitly; and Deep builds its reference
//   window by indexing CGC_GRADE_SCALE itself. api/assess_clean*.js, which I
//   suspected, turns out to orchestrate Main and Deep internally and take
//   their already-snapped grades.
//   So the foundational fix he was pointing at is already in place, and the
//   remaining path is still unidentified. What WILL find it: enforceCgcGrade
//   logs [grade-offladder] whenever it snaps, so the Vercel log for 2 Nov is
//   the evidence - if it fired, the model produced 9.5 and the guard caught
//   it (meaning the display is at fault); if it did not fire, the 9.5 never
//   went through the guard and the path is outside those three endpoints.
//
// ── 2. admin/api/rescore.js CARRIED ITS OWN LADDER, AND IT WAS WRONG ──────
//   snapToGradeStep() had a hardcoded steps[] missing 1.8, 9.9 and 10.0: a
//   1.8 book rescored to 1.5 or 2.0, and no rescore could ever reach 9.9 or
//   10.0. Its ties also went UP where the server's go DOWN - it snapped 9.5
//   to 9.6. A second definition of "the CGC ladder" is how the first drifts;
//   it defers to lib/grade_definitions.js now. The 9.8 ceiling stays on
//   purpose: a rescore works from stored subscores, so 9.9/10.0 are claims
//   that should come from a Full pass rather than from arithmetic.
//
// ── 3. CATALOGUE: SORT BY RG, SORT BY PG ──────────────────────────────────
//   Grade primary, title then issue secondary, so a tier reads alphabetically
//   inside itself. First tap is highest-first; a second tap on the SAME button
//   reverses it and the button shows an arrow. Only RG and PG reverse - there
//   is no question that "Title, descending" answers.
//   A book with no grade sorts LAST in both directions. Ungraded is not zero,
//   and sending nulls to the top of the ascending pass would bury the thing
//   the ordering was opened to find.
//
// ── 4. PM REMOVAL - LABEL DONE, REST PENDING ──────────────────────────────
//   The label's ± is gone: its own four-tier computation, the render site, and
//   every .rg-prec / .rgc-prec rule across all four label variants.
//   widenPrecisionForAge is gone WITH it, and it is worth saying plainly that
//   it never existed: the call looked the function up on window.RobograderPanel,
//   which exports only buildDisplay, buildCardDisplay and pgCell, so it always
//   fell through to the identity function beside it. The detailed comment above
//   it described paper-aging behaviour that has never run once.
//   Removed code is kept in shared/_ARCHIVE/PM_REMOVED_S22.md, out of the build.
//
//   STILL TO DO, and listed there too: robograde-panel.js, lib/roboscore_v3.js
//   (computePM/formatPM), the inlined RoboScoreV3 copies in index.html,
//   public.html and admin/index.html, the summary-image PM drawing,
//   rescore.js's own confidenceRange formula, and the prompt text in
//   api/assess*.js + lib/main_prompt.js + lib/deep_prompt.js.
//
//   THE TRAP IN THE REST OF IT: confidenceRange is NOT display-only.
//   scoreCeiling = 100 - PM in Main, Deep and Full, and assess_full.js caps the
//   stored RoboScore with it. Removing the field without replacing the ceiling
//   lets a 4-photo Main score 100. The mechanism has to survive the ±.
//   Also: touching lib/main_prompt.js or lib/deep_prompt.js changes the CACHED
//   PREFIX and its sha, so the keep-warm ping has to be re-pointed in the same
//   pass or every Main and Deep goes back to paying full input price.
//
//   Side effect worth revisiting: the Wide numeral's size was pinned by the
//   measured gap from its ink to the PM's. That constraint is gone, so the
//   grade can grow. Not done - not asked for.
//
//   To make labels show the real version: run `node sync-version.mjs 6.12`
//
// v6.11: PG LADDER GUARD MOVED TO THE WRITE SITES; THE PRE-ARCHIVE CHECK WAS
//        PASSING ON STALE BUNDLES; ROLL ASINS.
//
// ── 1. I NAMED THE WRONG CAUSE FOR THE 9.5 ─────────────────────────────────
//   v6.10 found a real bug - Batch rounded the PG to the half point and
//   published 9.5 from a 9.4 average, and 10.0 from a 9.8 - and that fix
//   stands. But Matt is seeing 9.5 on books that have only had a Main and a
//   Deep, which Batch cannot explain. So Batch was A cause, not THE cause, and
//   I should not have presented it as the answer.
//
//   The server paths all check out on re-reading: assess.js, assess_deep.js
//   and assess_full.js each run enforceCgcGrade() on the way out, including on
//   the floor and ceiling clamps. I have not found the remaining path.
//
//   So the guard moves to where it cannot be routed around: the WRITE SITES in
//   index.html, where every path ends regardless of which one it took.
//   _snapPgToLadder() now wraps the assess-result write (Main and Deep both
//   land there), the Full write, and the Batch average. It passes "", null and
//   "NG" through untouched, and treats 0 as no-grade rather than snapping it
//   up to a real 0.5.
//   Each call carries a site name and logs [pg-offladder] when it fires. The
//   next sighting therefore names its own source, which is what I should have
//   built the first time instead of reasoning from the code alone.
//   PSA grades are NOT snapped: the PSA scale really does include 9.5.
//
// ── 2. THE PRE-ARCHIVE CHECK HAD THE BUG IT EXISTS TO CATCH ────────────────
//   check-native-bundles.mjs tested the version with
//     html.includes(ROBOGRADE_VERSION)
//   - a bare substring match against a 2MB document. "6.10" occurs in any
//   number of innocent places (a CSS length, a timestamp, a numeric literal),
//   so the test answered "do these four characters appear anywhere" rather
//   than "is this bundle stamped with this version". Run tonight against the
//   current iOS bundle it said OK; the bundle is stamped 5.62.
//   That is the same false pass that let build 23 ship four-week-old code,
//   living inside the script written to prevent it.
//   It reads the real window.RG_GRADING_VERSION stamp now and compares it, and
//   a bundle with no stamp at all fails rather than falling through. The 5.x
//   fallback regex went with it - it could not have matched a 6.x stamp.
//   _snapPgToLadder added to FEATURES so the guard cannot be silently lost.
//
// ── 3. ROLL STOCK ──────────────────────────────────────────────────────────
//   ASINs in: 4x1 B0H2668WYX, 2x2 B0FDFWJ4K6, 4x2 B0FGXX2NJC, tag appended at
//   build time. Single-label mode points at rolls; sheet mode keeps Avery.
//
//   To make labels show the real version: run `node sync-version.mjs 6.11`
//
// v6.10: THE 9.5 PREDICTED GRADE - FOUND, AND IT WAS WORSE THAN 9.5.
//        PLUS: Key Info 28 -> 32, lightbox timestamp overlap, pan trails,
//        roll-stock buy links.
//
// ── 1. WHERE THE 9.5 WAS COMING FROM ───────────────────────────────────────
//   Not from the model. api/assess.js, assess_deep.js and assess_full.js all
//   run enforceCgcGrade() on the way out, so every grade LEAVING the server is
//   on the ladder. I checked that first and it is working.
//
//   It is Batch, client-side, in index.html:
//       avgPG = (Math.round(avg * 2) / 2).toFixed(1)
//   with a comment saying "PG is averaged and rounded to the half point, same
//   as RG". PG is NOT the same as RG. RG v3 is a half-point scale from 0 to
//   10, on which 9.5 is legal. PG is a CGC grade, and above 9.0 that ladder
//   steps 9.0, 9.2, 9.4, 9.6, 9.8.
//
//   So rounding to halves did not merely ALLOW an off-ladder value, it
//   MANUFACTURED one from clean inputs:
//       five passes averaging 9.4  ->  published 9.5
//       five passes averaging 9.6  ->  published 9.5
//       five passes averaging 9.3  ->  published 9.5
//       five passes averaging 9.2  ->  published 9.0
//       five passes averaging 9.8  ->  published 10.0
//       five passes averaging 9.9  ->  published 10.0
//   Every Batch on a high-grade book published a grade that either does not
//   exist or is wrong by two ladder positions, and the 9.8 -> 10.0 case is an
//   over-grade on the most valuable books there are.
//
//   This is the same scale confusion the prompts warn the model about, made in
//   our own code. The earlier round of work on this hardened the PROMPTS and
//   added the server guard; neither one can see a client-side average.
//
//   Fixed with _snapPgToLadder() in index.html - the same 25 positions and the
//   same ties-go-down rule as enforceCgcGrade(). Restated rather than imported
//   because lib/grade_definitions.js also carries the full definition text,
//   which the page should not ship. Verified against 18 averages.
//
//   NOT DONE: records already saved with an off-ladder PG still read 9.5 (or
//   10.0). A backfill is a separate decision and needs Matt's call.
//
// ── 2. LABEL ───────────────────────────────────────────────────────────────
//   Printing / Key Info 28 -> 32px, and line-height 1.4 -> 1.3 WITH it. At
//   1.4, two lines at 32px need 90px against the column's 89, so the fit pass
//   would have quietly dropped the Key Info back to one line and left 46px of
//   the column empty - the font bump would have COST a line. 1.3 gives 83 and
//   still contains the glyphs. Column ceiling 208 -> 210.
//   Buy button: roll stock when printing a single label, sheet stock for a
//   sheet - you do not feed an Avery sheet through a thermal printer for one
//   book. The three roll ASINs are NOT filled in: Amazon refuses automated
//   fetches, so the a.co short links cannot be resolved from here. Until an
//   ASIN is set, that size falls back to its sheet link rather than rendering
//   a dead button.
//
// ── 3. IMAGE VIEWER ────────────────────────────────────────────────────────
//   The capture timestamp was position:absolute at bottom:safe-area, which is
//   the same place #lightbox-footer occupies - and the footer, later in the
//   DOM at the same z-index, painted the defects box over it. It is in the
//   footer's flow now, after the defects box, so the overlap is impossible and
//   the defects box lifts by exactly the timestamp's height.
//   The pan trails: the stage clips with overflow:hidden while Panzoom
//   translates a child inside it, and on iOS Safari that clip is repainted on
//   the CPU, leaving rows of the previous frame along the boundary - which is
//   why they are horizontal and why they appear only after the image has
//   crossed an edge. translateZ(0) + contain:paint on the stage and
//   will-change/backface-visibility on the moving child put both on their own
//   compositor layers. NOT VERIFIED ON DEVICE: this is the standard fix for
//   the standard symptom and the symptom matches, but only an iPhone confirms
//   an iOS compositor bug.
//
//   To make labels show the real version: run `node sync-version.mjs 6.10`
//
// v6.09: PDFs NAMED AFTER THE BOOK; KEY INFO WRAPS; THE SHEET PRICE IS A
//        BLANK SPACE, NOT A FIELD.
//
// ── 1. FILENAME ────────────────────────────────────────────────────────────
//   ONE label -> Amazing-Fantasy-15-2026-10-26.pdf. The date is the GRADE
//   date, not today, so re-printing a label next year gives the same filename.
//   A SHEET keeps Robograder-Labels-8161-<today>.pdf: twenty books on one page
//   have no single title, and naming it after whichever came first would be a
//   lie about the other nineteen. A record with no title falls back to the old
//   shape rather than emitting "--2026-11-03.pdf".
//
// ── 2. THE PRINTING / KEY INFO LINE: 22 -> 28, LOWER, AND IT WRAPS ─────────
//   6px of margin-top, because the line sat under .iss's baseline and the g in
//   "Aug" came down into it.
//   One line was throwing away most of a Key Info that is routinely a
//   sentence. It wraps now - but how many lines it gets is NOT fixed, because
//   a fixed count either wastes the room a one-line title leaves or overflows
//   the rule when the title takes two. .info-upper is a flex column with a
//   208px ceiling and .prt is the only item allowed to shrink, so it takes
//   what the title left.
//
//   WHY THAT NEEDED JAVASCRIPT TOO. Flex shrinks to an arbitrary pixel height
//   and overflow:hidden then cuts the last line THROUGH the glyphs - a
//   half-height row of letter-tops sitting on the rule, which reads as a
//   printing fault, and is exactly what the first render of this did. CSS
//   cannot round a height down to a line box. fitLabelText() does, in both the
//   preview and the PDF's off-screen container, and it runs AFTER the font
//   wait because the fallback face has different metrics and would snap to the
//   wrong count.
//   Two parts. If there is not room for even ONE line, the TITLE gives way
//   (.squeeze, one line, ellipsis, issue number kept) - the printing and the
//   key fact are not optional, the second line of a long title is. Then .prt
//   is clamped to a whole number of lines.
//   A first attempt used padding-bottom to save the last line's descenders.
//   That fought itself: overflow:hidden clips at the PADDING box, so the
//   padding let the next line's tops through - the same sliced row it was
//   meant to prevent. The line box has to contain its own glyphs instead, so
//   line-height is 1.4 and there is no padding. Then a cut on a line boundary
//   touches no glyph.
//
//   .squeeze also replaces .has-prt as the trigger for the one-line title.
//   .has-prt meant "this book HAS a printing line", so every such book got an
//   ellipsised one-line title whether or not it needed one.
//
// ── 3. THE SHEET PRICE IS SPACE, NOT A NUMBER ──────────────────────────────
//   A typed price is a single-label thing. A sheet is twenty different books
//   printed in one pass from one queue, and there is one price field - so a
//   typed value could only ever be right for one of them and would be wrong,
//   and confident-looking, on the other nineteen. On a sheet the same toggle
//   leaves the slot EMPTY to be written in by hand (no box, no placeholder -
//   160 x 184 of clear label), and off it is the figure as before. The field
//   is only offered in single-label mode, where it can be honoured; offering
//   it on a sheet would be the old Wide price toggle's mistake in reverse.
//
// ── 4. VERSION STRING ──────────────────────────────────────────────────────
//   .rg-v 22 -> 24.
//
//   Verified: filenames across 5 shapes including a titleless record and a
//   multi-book sheet; the column budget across 4 title/key-info combinations
//   (every one clears the rule, none cuts a glyph); html2canvas 1.4.1 captures
//   all five test labels at 1152x288.
//   To make labels show the real version: run `node sync-version.mjs 6.09`
//
// v6.08: COLOUR FIGURE ON COLOUR LABELS; THE WIDE PRICE TAG IS BACK, TYPED;
//        VERSION STRING 20 -> 22.
//
// ── 1. TWO FIGURES, ONE PLACEMENT ──────────────────────────────────────────
//   assets/Robograder_Line_Colored.png on a colour label,
//   assets/Robograder_Line.png on a thermal one. Which file is chosen by the
//   RENDER, not by the printer in general: mono is a one-ink render on white
//   stock and the painted figure would dither into hatching on it. Both files
//   are 500x600, so the slot, the fit and the position are identical.
//
// ── 2. THE WIDE PRICE TAG, WITHOUT THE PAD ─────────────────────────────────
//   v5.x removed the price toggle from Wide because the 220px white pad took
//   the slot the QR now occupies and squeezed the info column until a two-line
//   title stopped fitting. That is still true of the PAD. It is not true of a
//   PRICE: the figure's 160px column is already there, and a number needs no
//   box around it. So the toggle is back for Wide and the price goes where the
//   figure goes.
//   It is TYPED, not read off the record. The old secondary toggle pulled
//   comic.askingPrice; at a show the price is decided at the table, so the
//   toggle opens a field instead. The field starts from askingPrice when the
//   book has one, which is a starting point rather than a default.
//
//   THE FIT. Every price has to end up the same width - "$10" large, "$12500"
//   small, both 160px - and CSS cannot do it, because CSS has no way to ask
//   how wide a string is. Nor does character COUNT work: it makes "$1,250" the
//   same size as "$12345", which is visibly wrong. The size is computed per
//   label from the string's own em width (digit 0.556, '$' 0.60, '.' 0.28,
//   ',' 0.26 - Noto Sans Display, the same digit constant the three-glyph
//   score size uses) and set inline. Measured across $10 / $95 / $450 / $1000
//   / $12500 / $1250.50: rendered ink 154-157px in the 160px slot, every time.
//   132px is a ceiling rather than a target, so a short price cannot come out
//   taller than the grade beside it.
//
//   WHERE IT LIVES, AND WHY THAT MATTERS. generatePDF reads options, never the
//   modal, so the typed value has to be in options or it would preview and
//   then print blank. Options are global, so it carries widePriceFor - the
//   roboGradeId it was typed for - and both render paths ignore it unless they
//   match. Without that scope a price typed for one book prints on the next
//   book opened, which in a print-and-stick workflow is a mispriced book on a
//   wall. A queue of ten shows the price on the one it belongs to and the
//   figure on the other nine.
//
//   The field repaints the PREVIEW only, not the modal. renderModal rebuilds
//   the whole card, which would drop focus on every keystroke and close the
//   keyboard on a phone.
//
// ── 3. VERSION STRING ──────────────────────────────────────────────────────
//   .rg-v 20 -> 22.
//
//   Verified: html2canvas 1.4.1 captures all five test labels at 1152x288
//   with the price showing and with the figure showing.
//   To make labels show the real version: run `node sync-version.mjs 6.08`
//
// v6.07: THE VANITY USER ID TOOL DID NOT WORK, AND FAILED IN THE WORST WAY.
//
// ── WHAT HAPPENED ───────────────────────────────────────────────────────────
//   The admin page's api() helper stringifies opts.body itself and sets the
//   Content-Type. _wireVanityCode passed JSON.stringify(...) to it, so the
//   body was encoded TWICE and the server received a JSON string rather than
//   an object. body.action read undefined, so the handler did not take the
//   'assign' branch.
//
//   On its own that is a no-op. What made it a defect is where it landed: the
//   original one-shot vanity-trio write (MATT / RICK / PAVL) sat at the bottom
//   of the handler as the DEFAULT path. So the call did not fail - it fell
//   through and re-ran that write, and reported ok:true with none of the
//   fields the UI reads, which is the "DONE / undefined / undefined" Matt saw.
//   No damage: that write is idempotent and re-asserted the same three codes
//   on the same three uids. But a data-mutating default on an endpoint that
//   now takes several actions is the wrong shape, and it is what turned a
//   client-side encoding mistake into three unintended writes.
//
// ── THE FIX, BOTH ENDS ──────────────────────────────────────────────────────
//   Client: pass the OBJECT to api(), not a JSON string.
//   Server: req.body is parsed whether it arrives as an object or a string, so
//   the old double-encoded shape would now work too; and every branch is named
//   explicitly - 'assign', 'backfill_missing', 'legacy_vanity_trio'. Anything
//   else is a 400 that says so. Nothing mutates by default any more.
//   Verified against four body shapes: object, JSON string, empty, and
//   garbage. The first two dispatch to assign; the last two are refused.
//
// ── LABEL: THE FIGURE WAS TOUCHING THE RULE ────────────────────────────────
//   top 42 -> 32, same 184 of height, bottom 216 against the rule at 226.
//   Standing it exactly ON the rule read as an overlap in print, because the
//   tracks' outline IS the figure's bottom edge and there is no visual gap
//   between a 1px rule and a 1px outline that touches it. 10px of air now.
//
//   To make labels show the real version: run `node sync-version.mjs 6.07`
//
// v6.06: WIDE LABEL REBUILT AROUND A LOWER RULE; VANITY USER ID TOOL;
//        THE DEEP REMEDIATION IS RETIRED.
//
// ── 1. ONE META ROW, AND THE RULE DROPS TO THE CODE'S BOTTOM EDGE ───────────
//   GRADED and the ID row were stacked, which cost ~40px of height that both
//   the title and the Key Info line wanted, and the rule sat where it cut
//   across the figure. They are one row now - GRADED and its date left, the
//   ID right - and the rule is at y=226, which is also where the QR and the
//   figure now end.
//   The band stays PINNED (absolute, 48px, bottom:0) rather than flowed. That
//   is what keeps GRADED and the ID at the same y on every label however the
//   title wrapped, which is the whole reason this stock can be pre-printed.
//   The rule keeps the text column's width (665); only the meta TEXT runs
//   191px past it, out to 856 - the right edge of the QR column - because with
//   the code ending above the rule there is nothing down there to clear.
//   One row out of four spans without touching markup that Case, Square and
//   Large all share: the grid becomes a flex row and margin-left:auto on the
//   ID label splits it into two groups.
//
// ── 2. WHAT THE EXTRA 36px BOUGHT ──────────────────────────────────────────
//   The one-line title clamp is GONE. It existed because a 2-line title plus a
//   printing line did not fit above the rule. Measured worst case now: title
//   118 + date line 48 + printing/Key Info 26 = 192, inside the 214 the column
//   has. The flex rule that keeps the issue number when a title is too long
//   even for two lines stays.
//   .ttl max-height 126 -> 118. 2 x 62 x 0.95 = 117.8, so 126 was 8px MORE
//   than two lines and let the tops of a third through underneath - the same
//   sliced-glyph sliver the one-line clamp had. 118 is the two line boxes
//   exactly; the 8px of padding-bottom below carries the descenders.
//   The figure moves down with the rule rather than growing into the gap:
//   10..190 becomes 42..226, the same 184 of height, standing on the rule.
//
// ── 3. THE GRADE WAS THE WORST-READING THING ON THE LABEL ──────────────────
//   scaleX(0.625) is a heavy condense - it is what let the numeral reach 200px
//   without touching the PM - but at that ratio the strokes are thin enough
//   that the one element meant to be read from across a room read worst of
//   anything on it. 0.625 -> 0.78, a quarter wider, with the size down 200 ->
//   188 so the footprint is close to unchanged. Re-measured by rasterising the
//   box and diffing black pixels: the horizontal gap to the PM is still
//   positive on every two-glyph case, 7..25px.
//   The three-glyph size went UP, 134 -> 172, because 134 was guessed and 172
//   is measured: a digit in Noto Sans Display is 0.556em, so "100" is 287px of
//   unscaled text, 245 once scaleX(0.78) has it, inside the 256px interior
//   with 5px a side - and that is with the restoration check mark, which rides
//   inside .rg-num-wrap and costs ~27px more.
//   has-plus 168 -> 148: the (+) was landing 4px off the numeral.
//
// ── 4. KEY INFO SEPARATOR ───────────────────────────────────────────────────
//   "<printing>, <key info>". A comma, not a bullet.
//
// ── 5. VANITY USER ID, AS A TOOL RATHER THAN A DEPLOY ──────────────────────
//   admin/api/set_transfer_codes.js takes action:'assign' with a uid and a
//   4-char code. Its ASSIGNMENTS array was a frozen one-shot, and vanity
//   requests keep arriving (M123, MATC) - editing a hardcoded array and
//   redeploying for each one needs a code change, a deploy and a Matt who does
//   not use a terminal. Same validation, same conflict check, same orphan
//   cleanup as the array: a code already held by a DIFFERENT uid is refused,
//   not taken, and the user's previous code is released back into the pool.
//   The control is a row at the top of the admin Users tab.
//
// ── 6. THE DEEP DOUBLE-CHARGE REMEDIATION IS DONE AND GONE ─────────────────
//   43 accounts credited, addresses captured. admin/api/credit_remediation.js
//   and its two buttons are removed; the endpoint file is in _to_delete. The
//   'deep_doublecharge_fix' rows stay in credit_events as the record.
//   admin/api/credit_audit.js stays - it answers the recurring "what happened
//   to this user's credits" question and is not a one-off.
//
//   Verified: html2canvas 1.4.1 captures all five test labels at 1152x288
//   (the Save PDF path), and every new rule uses a flex-* spelling.
//   To make labels show the real version: run `node sync-version.mjs 6.06`
//
// v6.05: THE FIGURE RETURNS BESIDE THE QR; KEY INFO ON THE LABEL; SCORE BOX
//        CENTRED AND RE-BALANCED; THE CREDITED-ACCOUNT EMAIL LIST.
//
// ── 1. THE WORDMARK WAS OFF-CENTRE BECAUSE I BOXED IT OFF-CENTRE ────────────
//   6.04 held ROBOGRADE off the PM by giving it left:6 / right:76 - a box that
//   ends 70px short of the right edge - and then centring the word IN THAT
//   BOX. Centred in a box that is itself off-centre reads as off-centre,
//   which is exactly what printed. It is left:0 / right:0 now, centred on the
//   score box, and the PM is held off VERTICALLY instead.
//   That separation is measured, not assumed: at the 6.04 positions the word's
//   ink ran y 17..33 and the PM's y 31..72 - already a 2px overlap, which the
//   horizontal box had been hiding. The word goes up 4 (top 10 -> 6) and the
//   PM down 4 (top 20 -> 24): 6px of clear air on every case tested.
//
// ── 2. STARS UP, NUMERAL DOWN ───────────────────────────────────────────────
//   .rg-stars top 44 -> 34. At 44 the stars floated midway between the
//   wordmark and the numeral and read as part of the number; they belong to
//   the ROBOGRADE line. Now 8px under the wordmark's ink.
//   .rg-num-wrap translateY 20 -> 22. 26 was tried first and the numeral's ink
//   landed 1px INTO the version string - the 0 of "60" sitting on V5.92. 22 is
//   the measured landing: 4px under the numeral, 24-35 above it to the stars.
//
// ── 3. THREE-GLYPH SCORES HAVE BEEN BREAKING THE BOX ────────────────────────
//   Found while measuring the above, and it is not new. .rg-num-wrap is a flex
//   item in a 256px column, so its width is capped at the box interior, and
//   scaleX(0.625) shrinks what is DRAWN without touching the line box the text
//   wraps against. "100" at 200px is ~360px of unscaled text, so it wrapped to
//   two lines inside the wrap and the second line ran down over the version
//   string: measured ink y 86..260 against 86..227 for a two-glyph score.
//   Fixed with white-space:nowrap plus a .num-3 size (168, or 150 with a (+)).
//   This matters more under the v3 display than the 0-100 one - "9.5" is three
//   glyphs and ordinary, where a 100 is rare.
//
// ── 4. THE FIGURE IS BACK, LEFT OF THE QR AND ABOVE THE RULE ────────────────
//   assets/Robograder_Line.png - the filled-chest line art. It replaces the
//   empty-chest Robograder_Line_QR.png, which existed only to frame a code
//   inside the chest, an idea the module arithmetic ruled out; that file is in
//   _to_delete.
//   x 505..665: right:487 is the info column's own right edge, so the figure
//   ends exactly where GRADED and the ID row end and the rule runs under its
//   tracks, with an 11px gutter to the QR at 676.
//   It does NOT take its column by moving .info - that would drag the rule and
//   the meta rows left with it. Only .info-upper yields, through
//   padding-right:172, so the title, the date line and the printing line wrap
//   short of the figure while everything below stays full width.
//
// ── 5. KEY INFO RIDES THE PRINTING LINE ─────────────────────────────────────
//   "<printing> · <key info>", clamped to one line and clipped with an
//   ellipsis at the figure's left edge. Key Info is routinely a paragraph, so
//   nothing is truncated in JS - CSS clips it, because only CSS knows how much
//   room there actually is. has-prt (which clamps the title to one line) now
//   keys on this line existing at all, so a book with Key Info and no printing
//   still spends the row.
//   Two consequences of the narrower text column, both fixed here:
//   (a) the one-line title clamp was 60px, which let 1px of the second line
//       through - a full first line with a sliver of sliced glyph tops under
//       it. 59 is the line box exactly.
//   (b) truncating the line as one string ate the ISSUE NUMBER. The clamped
//       line is a flex row now: the title shrinks (min-width:0) and takes the
//       ellipsis, the issue number is flex:0 0 auto and never goes. A label
//       that cannot say which issue it is has failed at its job.
//
// ── 6. THE 43 CREDITED ADDRESSES ────────────────────────────────────────────
//   admin/api/credit_remediation.js takes ?emails=1 and returns the addresses
//   of the accounts that actually received a deep_doublecharge_fix credit -
//   read from the grant rows, not re-derived from the Deep debits, so it is
//   exactly who was credited. A second button in the Users-tab block shows
//   them in a copyable box. Accounts with no email on file are reported by uid
//   rather than dropped, so the count always reconciles against the 43.
//
//   Verified: html2canvas 1.4.1 captures all five test labels at 1152x288
//   (the Save PDF path), and every new rule uses a flex-* spelling.
//   To make labels show the real version: run `node sync-version.mjs 6.05`
//
// v6.04: ADMIN REMEDIATION AUTH FIXED; FOUR LABEL CORRECTIONS.
//
// ── 1. THE "auth failed" ON THE REMEDIATION BUTTON WAS NOT AN AUTH FAILURE ──
//   credit_remediation.js and credit_audit.js did
//     JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)
//   at the top of the handler. FIREBASE_SERVICE_ACCOUNT is not reliably plain
//   JSON on Vercel: it arrives escaped-quoted, or base64, depending on how it
//   was pasted. So the parse threw BEFORE the token was ever checked, the
//   handler returned its generic error, and the button reported "auth failed"
//   for a problem that had nothing to do with the token.
//   Both files now use parseServiceAccount(), copied verbatim from
//   admin/api/history_repair.js, which already handles all three encodings:
//   plain JSON, escaped-quote JSON, and base64. Tested against all three.
//
// ── 2. HANGING y IN "Fantasy" ───────────────────────────────────────────────
//   6.03 removed overflow:hidden from .info-upper, which fixed the g in "Aug".
//   The y in "Fantasy" is a SECOND clip, from .ttl's OWN overflow:hidden
//   against its own max-height. A descender on the last line falls below the
//   line box, so the box has to be taller than the text. .ttl now carries
//   padding-bottom:8px with max-height raised to 126px: same two-line clamp,
//   8px of room under the final baseline.
//
// ── 3. GRADE NUMBER: 215 -> 200, LOWERED ────────────────────────────────────
//   Per instruction. .rg-num font-size 200, .rg-num-wrap translateY(20px).
//   Re-measured by rasterising the box and diffing black pixels across
//   6 / 9.5 / 10 / 4.5 with PMs: stars gap 17-20px, version gap 8px, no
//   overlap with the PM at any value.
//
// ── 4. PM PLACEMENT IS NOW STRUCTURAL, NOT A CLEARANCE ──────────────────────
//   The CSS on disk was already top:20 right:6 when the collision was
//   reported; an intermediate deploy is the likeliest explanation. Either way
//   the old fix leaned on 12px of vertical clearance between the wordmark and
//   the PM, and the wordmark OVERFLOWED its own box - 192px of ink with no
//   overflow:hidden - so the clearance was never the thing holding them apart.
//   .rg-word is now boxed (left:6 right:76, i.e. it stops 76px short of the
//   right edge where the PM lives), shrunk to 22px with 2px tracking, and
//   clamped with overflow:hidden; white-space:nowrap. The wordmark cannot
//   reach the PM's column now regardless of string length.
//   Measured ink: wordmark x 15-173, PM x 184-253 (or 215-252 on 10 / 4.5).
//
//   To make labels show the real version: run `node sync-version.mjs 6.04`
//
// v6.03: LABEL GEOMETRY MATCHED TO MATT'S PRINTED MOCK-UP; ADMIN CHIPS FIXED.
//
// ── 1. SCORE BOX, MEASURED OFF THE MOCK ─────────────────────────────────────
//   Not estimated: the mock PNG was read pixel-wise and the rounded rect's
//   borders located. It gives 262 x 262 with a 10px right and 12px top inset,
//   against the 276/6/6 that was printing close enough to the die-cut edge for
//   half a millimetre of feed drift to clip it.
//   Numeral 188 -> 215. The mock keeps the numeral's TOP where it was and takes
//   the BOTTOM down toward the version string: 170px of ink against ~133.
//   215 IS THE MEASURED CEILING, not a preference. Rasterising the box and
//   diffing black pixels across 6 / 9.5 / 10 / 4.5 with PMs: at 215 the numeral
//   clears the stars by 9px, the version by 6px, and its top (73) sits 4px
//   below the PM's bottom (69) so they do not overlap at all. At 225 they do.
//   PM moved to top:20 right:6 to match the mock, which put it through the
//   ROBOGRADE wordmark - so the wordmark lifted 14 -> 8. Ink is now 8..28 for
//   the wordmark and 32..100 for the PM: no vertical overlap, so their
//   horizontal positions stop mattering.
//
// ── 2. DESCENDERS WERE BEING SHAVED ─────────────────────────────────────────
//   The tail of the y in "Fantasy" and the g in "Aug" were cut off on every
//   printed label. .info-upper carried overflow:hidden, which added nothing -
//   .ttl already clamps itself with its own max-height and overflow - except
//   eating anything below the baseline. Now visible.
//
// ── 3. META LABELS SIT AGAINST THEIR VALUES ─────────────────────────────────
//   column-gap 18 -> 8, so "ROBOGRADER.APP/ ID / QK34X4" reads as one URL
//   rather than two columns with a gap in the middle.
//
// ── 4. ADMIN CACHE CHIPS: MAIN + DEEP, ONE LINE ─────────────────────────────
//   "Comic" beside "Deep" read as two different KINDS of thing when they are
//   two DEPTHS of the same comic assessment. Renamed to Main/Deep. Card is
//   dropped from the picker - nobody is grading cards and its caching was never
//   wired - exactly as Large was dropped from the label sizes; _CACHE_LIVE.card
//   and the types.card field stay so a stored value survives and the chip can
//   return in one line. flex-wrap:nowrap + max-width 112 keeps the column
//   beside FMV/Growth/Catalogue instead of wrapping to its own row and leaving
//   the space to its right empty.
//
// ── 5. WHY THE LABEL PRINTED "V5.79" ────────────────────────────────────────
//   The label prints window.RG_GRADING_VERSION, which lives in index.html and
//   only moves when `node sync-version.mjs <v>` runs. lib/version.js is the
//   source of truth; index.html is a MIRROR, and it has been parked at 5.79
//   since that is the last time the mirrors were synced for a native build.
//   That lag is deliberate for the native bundle (HOW_WE_WORK 11) but it also
//   means the WEB app, and therefore every printed label, reports 5.79.
//   To make labels show the real version: run `node sync-version.mjs 6.03`
//   before pushing. That also stamps the native mirror, so it is Matt's call.
//
// v6.02: THE QR IS CANVAS-ONLY, and the remediation control moved to the top.
//
// ── 1. SAVE PDF HUNG ON THE QR, ON iOS ONLY ─────────────────────────────────
//   qrcodejs builds BOTH a <canvas> and an <img>, then on its own iOS/Android
//   branch hides the canvas and shows the img carrying a base64 data URL.
//   html2canvas must LOAD that image inside its cloned document before it can
//   draw, and on iOS that load never completed: the capture promise never
//   SETTLED, which is not a throw and therefore not catchable. The button said
//   "Generating 1/1..." forever until v6.00 added the 45s race, which is how
//   this finally produced a message instead of silence.
//
//   I could not reproduce it: the exact DOM qrcodejs produces (CANVAS block +
//   IMG display:none, then IMG block with a data: URL) captures fine in
//   headless Chromium with the real library. So rather than keep guessing at a
//   platform difference, the dependency is removed. After the code is built,
//   any <img> qrcodejs made is deleted and the canvas is shown. html2canvas
//   draws a <canvas> from its own pixels - nothing to load, nothing to wait
//   for, on any platform - and the QR is the ONLY image on a Wide label.
//   Runs twice because qrcodejs swaps canvas for img on a 0ms timeout.
//   Verified: with the cleanup in place the element holds a canvas and ZERO
//   images, and html2canvas still captures 1152x288.
//
// ── 2. THE REMEDIATION CONTROL WAS UNREACHABLE ──────────────────────────────
//   It sat at the BOTTOM of the Users tab. That tab is a paginated list, so
//   reaching it meant tapping Load More dozens of times, and a mis-tap on the
//   way opened a user and lost the place. Moved to the TOP of the tab, above
//   the search box.
//   It also now answers the question actually being asked - "did this already
//   run?" - in words before any numbers: ALREADY DONE, or NOT YET DONE with
//   the counts. When there is nothing left to credit no apply button is
//   offered at all, so it cannot be run twice by accident. Both states driven
//   against a stubbed api() before shipping.
//
// v6.01: THE REMEDIATION MOVED INTO THE ADMIN, because a terminal tool can
//        never reach an admin endpoint.
//
//   admin/middleware.js is a SECOND gate in front of admin.robograder.app: an
//   ADMIN_GATE_SECRET cookie checked at the edge, before any page or /api/*
//   function runs. curl has no such cookie, so every terminal tool pointed at
//   an admin endpoint dies on {"error":"gate: locked"} before it reaches the
//   Firebase/ADMIN_EMAILS check underneath. Both credit .command files were
//   therefore broken by design, not by a bug, and they have been retired.
//   REMEMBER THIS: anything that must call an admin endpoint belongs IN the
//   admin page, where the gate cookie and the Firebase token are both already
//   in hand. A .command can only talk to the MAIN app (robograder.app), which
//   is why Test cache ping.command works.
//
//   The Deep double-charge refund is now a control at the BOTTOM OF THE USERS
//   TAB - not the header, which is kept clear. Two taps: "Check who was
//   affected" runs the dry run and prints the counts; a second button then
//   appears naming the exact number of accounts and credits, behind a confirm.
//   It is a ONE-OFF and is meant to be deleted once it has been run.
//   Driven end to end against a stubbed api() before shipping: the check call
//   goes out as GET, the apply call as POST with apply=1, and both render.
//
//   EVAL FOLDER CLEARED OUT. Retired to shared/_ARCHIVE/eval_retired/:
//     Measure cache TTL.command  - the TTL question is answered (1h, verified)
//                                  and /api/cachewarm?mode=status supersedes it
//     binding_probe.py           - answered; see BINDING_STAPLES_VS_GLUE.md
//   Moved to _to_delete/ (broken by the gate, superseded by the admin control):
//     Check a user's credits.command + _credit_report.py
//     Fix the double-charged credits.command + _remediation_report.py
//   Still live: Run Main and Deep round, Run grade parity round,
//     Run grade reference A-B, Test cache ping.
//
// v6.00: LABEL PRINTER UNBLOCKED, WIDE PRICE TOGGLE REMOVED, CASE + SQUARE
//        MATCH THE LIGHT SCORE BOX.
//
// ── 1. "Failed to load label printer: Unexpected token '{'" ─────────────────
//   Comments I wrote into print-label.js quoted class names with BACKTICKS -
//   inside CSS comments that live inside the one template literal holding the
//   entire stylesheet. Each backtick closed the string early. Fixed twice,
//   because the fix comment itself contained a backtick.
//   `node --check` PASSED THROUGHOUT: it parses .js as CommonJS, and the file
//   only fails when loaded as an ES module, which is how the app loads it.
//   The check that matters, now used on every module touched:
//     node --input-type=module -e "import('./print-label.js')"
//
// ── 2. Save PDF stuck on "Generating 1/1..." ────────────────────────────────
//   handleSavePDF has always had a catch that alerts, so a THROW was never the
//   problem - html2canvas never SETTLED, and an unsettled promise cannot be
//   caught. I first blamed calc() inside a transform and WAS WRONG: tested
//   against real html2canvas 1.4.1 in a headless browser, the calc version
//   captures fine. Two things are fixed on evidence rather than suspicion:
//     • `justify-content: end` -> `flex-end`. html2canvas only knows the
//       flex-* spellings.
//     • each capture is now raced against a 45s timeout, so a hang becomes a
//       named error naming the label instead of a dead button.
//   Verified by running html2canvas against the real label CSS: both the
//   plus and no-plus cases capture at 1152x288.
//
// ── 3. WIDE DROPS THE PRICE PAD ─────────────────────────────────────────────
//   At 4x1 the pad takes the slot the QR now occupies and squeezes the info
//   column until a two-line title stops fitting. Both price toggles are hidden
//   on Wide and a stored priceTag is IGNORED for that size rather than
//   cleared, so switching to Case or Square keeps the setting. The
//   toggle-price listener is now guarded - the element no longer exists on
//   Wide and an unguarded querySelector would have thrown on every open.
//
// ── 4. CASE AND SQUARE JOIN WIDE ON THE LIGHT SCORE BOX ─────────────────────
//   #cfe8a8 with a 3px #0f1a05 border and black numerals, matching Wide.
//   Wordmark #6a8030 -> #2a4010, version string -> #3a5010, stars opacity
//   0.5 -> 0.85. The restored-book palette inverts with them: the inline
//   override now keys on `_lightBox = !isLarge` rather than isWide, so a
//   restored Case gets #ead8f5/#3a1252 instead of a lavender numeral that
//   would be invisible on a light panel.
//
// ── 5. REMEDIATION IS NOW DOUBLE-CLICKABLE ──────────────────────────────────
//   shared/_WORKING/eval/Fix the double-charged credits.command - shows the
//   numbers, asks YES, then grants. Nothing to type but a token.
//
// v5.99: THE DEEP DOUBLE-CHARGE, plus the label printer I broke.
//
// ── 1. DEEP CHARGED TWICE ON NON-STREAMING CLIENTS ──────────────────────────
//   SYMPTOM: a new account with 3 free credits runs one Main and one Deep and
//   lands on 0 instead of 1. Seen across many accounts.
//
//   CAUSE, one line: api/assess_deep.js stamped creditsRemaining on the result
//   INSIDE its `if (wantsSSE)` branch, so the plain-JSON return shipped without
//   it. The client applyServerCredits() keys on exactly that field - no field
//   means "the server did not take the credit" - so onAssessmentSuccess() fell
//   through to decrementCredit() and took a SECOND credit after the endpoint
//   had already debited.
//
//   api/assess.js has always stamped it ABOVE its own wantsSSE branch. The
//   ASYMMETRY between two files that must agree IS the bug, which is why Main
//   charged once and Deep charged twice. Keep them shaped the same.
//
//   WHY IT SURVIVED SINCE v5.19: streaming clients were never affected. The
//   desktop PWA streams, so it could not be reproduced there. A WebView that
//   cannot read the stream falls back to plain JSON - and the native builds are
//   what users hold. NATIVE REBUILD IS THE URGENT PART OF THIS FIX.
//
//   SIMULATED against the real applyServerCredits/onAssessmentSuccess, sliced
//   out of index.html and executed:
//     non-streaming BEFORE: firestore=0  serverDebits=2  clientDebits=1
//     non-streaming AFTER : firestore=1  serverDebits=2  clientDebits=0
//     streaming     BEFORE: firestore=1  (unaffected, as predicted)
//   The before-state shows firestore=0 while the UI shows 1 - stored balance
//   and display diverge, which is how a user watches a refund appear and still
//   reads zero.
//
//   SAME SHAPE, ALSO FIXED: the Cleaning Compare path in index.html synced the
//   balance from res.creditsRemaining and then called
//   onAssessmentSuccess(formData) - formData has no such field, so it
//   decremented again. It now passes `res`.
//
//   REMEDIATION: admin/api/credit_remediation.js. Dry-run by default,
//   idempotent (every grant writes a credit_events row labelled
//   deep_doublecharge_fix and anyone carrying one is skipped), window defaults
//   to 2026-09-18 = v5.19. It credits every account with a server-side Deep
//   debit in the window, which is deliberately GENEROUS: the client's extra
//   decrement wrote NO ledger row and nothing records whether a request
//   streamed, so the victims cannot be named exactly. Desktop-only users will
//   get a credit they did not lose. That is the right way to be wrong here.
//
// ── 2. THE LABEL PRINTER WOULD NOT LOAD ─────────────────────────────────────
//   "Failed to load label printer: Unexpected token '{'". Two comments I wrote
//   into print-label.js quoted code with BACKTICKS - inside a CSS comment that
//   lives inside the JS template literal holding the whole stylesheet. Each
//   backtick closed the template early and the rest parsed as code.
//
//   `node --check print-label.js` PASSED THE WHOLE TIME. It parses a .js file
//   as CommonJS; the file only fails when loaded as an ES module, which is how
//   the app loads it. Reproduced the user-visible error exactly with
//   `import('./print-label.js')`, which is now the check that matters. Every
//   module touched this session has been import-tested, not --check-tested.
//   HOW_WE_WORK 10 already said --check is not verification. It was right.
//
// v5.98: PHOTO CAPTURE DATES IN THE IMAGE VIEWER.
//
//   Every image array already had a parallel *Meta array carrying
//   { source, capturedAt } — imagesMeta, cornerMeta, interiorCoverMeta,
//   interiorMeta, signatureMeta, restorationMeta, couponMeta, insertMeta,
//   cardDeepMeta — and the viewer never surfaced any of it. The data was
//   there the whole time.
//
//   WHAT IT CLOSES. A listing's grade is tied to the photos that produced it,
//   but nothing stopped someone grading a clean copy, swapping in photos of a
//   worse one, and keeping the screenshot or the Summary image. A visible
//   capture date makes a mismatched set obvious to whoever is looking at the
//   book — which is the person who needs to know. Verified in the harness:
//   a front cover from March beside a spine shot from October now reads as
//   exactly that.
//
//   EVIDENCE, NOT ENFORCEMENT, DELIBERATELY. Blocking the swap outright would
//   punish everyone who legitimately re-shoots a bad photo, which is most of
//   the people who replace an image. Making the fact visible costs the honest
//   user nothing.
//
//   _comicLbEntries() now carries `t` on every entry and _lbRenderCapturedAt()
//   draws it bottom-left of the lightbox: 11px, white at 78%, above the
//   safe-area inset, no pill or chip — it is a fact about the photo, not a
//   control, and should not invite a tap. HIDDEN ENTIRELY when a photo has no
//   recorded date; books that predate the meta arrays would otherwise show a
//   row of "unknown" that reads as a fault.
//
//   Verified by EXECUTION, not inspection: both functions were sliced out and
//   run against eight entries including a photo with null meta, a group with
//   no meta array at all, a malformed date string and a legacy bare-string
//   entry. All four degrade to hidden rather than throwing.
//
// v5.97: REVERTS AND CORRECTIONS. No new behaviour.
//
//   1. VANITY TRANSFER CODES — REVERTED IN FULL. api/transfer_recv.js is back
//      to what it was and admin/api/set_vanity_code.js is gone. The diagnosis
//      stands and is worth keeping: ID_ALPHABET is
//      '23456789ABCDEFGHIJKLMNPQRSTVWXYZ' — no 0, 1, O, I or U, deliberately,
//      so a code read aloud or typed off a label is never ambiguous. A code
//      set by hand that uses an excluded character passes the CLIENT's check
//      (length 4 and nothing else) but fails isValidCode() on the server, so
//      register_code allocates a fresh random code over the top at the user's
//      next sign-in, silently. The code also lives in TWO places —
//      users/{uid}.transferCode and the transfer_codes/{CODE} reverse index —
//      so editing one by hand never holds anyway.
//      The fix is to pick a code from the alphabet. Matt is doing that. No
//      code change was warranted and the one made here was removed.
//
//   2. SESSION TAGS CORRECTED. Comments written across the last several
//      versions were tagged S22, S22, S22 and S22. Those sessions do not
//      exist — SESSION_22_HANDOFF.md says plainly that Session 22 is not
//      closed and that Matt runs one session until the assistant degrades.
//      All 59 of those tags are now S22. Invented session numbers are worse
//      than no tag: the tag's whole job is to let a future reader find the
//      handoff block that explains the change, and a number with no handoff
//      behind it sends them looking for a document that was never written.
//
//   3. THE CREDIT CHECKER RUNS. shared/_WORKING/eval/Check a user's
//      credits.command shipped with a Python block embedded in a shell
//      heredoc, containing an f-string with a backslash in its expression —
//      a syntax error, so it died at the point of printing results. The
//      report moved to its own file, _credit_report.py, beside the .command,
//      and was EXECUTED against a canned payload before shipping rather than
//      eyeballed.
//
// v5.96: THE FIGURE COMES OFF THE LABEL; THE CODE IS SIZED FROM THE PHYSICS.
//
//   Three versions went into fitting a scannable QR inside the line-art Robo's
//   chest. It cannot be done at this label size, and the arithmetic says why in
//   one line: a phone wants each module about 0.4mm, the payload makes a 29x29
//   grid, the spec adds 4 modules of quiet zone each side, and 37 x 0.4mm is
//   0.58" — more than half the height of a figure that is itself only 0.96"
//   tall. No redraw fixes that. A chest big enough IS the figure.
//
//   So the code stands on its own again at 160 CSS px — 0.556" at 288 px/inch,
//   0.38mm a module, essentially the target — in a 180px column, with the info
//   column taking back the width the figure held (right 530 -> 486).
//
//   WORTH RECORDING, because it is the whole lesson: the 118px the bare code
//   carried before any of this was ALREADY in the right range (0.41",
//   0.28mm/module). The chest was the problem; the code never was. Several
//   versions were spent discovering that the original was close to correct.
//
//   Two improvements survive from the chest work and are kept: the code is
//   rasterised at 2x its display size and scaled down (a canvas drawn at
//   display size then printed at 288 DPI loses module edges, and a QR is
//   nothing but module edges), and Wide draws pure black on pure white rather
//   than #1a2208 on #d4d9be, which was tuned for the olive score box.
//
//   assets/Robograder_Line_QR.png is left in the repo, unreferenced.
//
// v5.95: CREDIT AUDIT ENDPOINT, and the info column stops overlapping the figure.
//
//   admin/api/credit_audit.js — the credit ledger for ONE user, in plain words.
//   READ ONLY; it writes nothing. Takes ?transferCode=AYRP (the 4-char code
//   people actually quote) or ?uid=, resolves one to the other, and returns the
//   stored balance plus every credit_events row with a RUNNING TOTAL, so a
//   double-debit is visible by eye. It also names the pattern: any two debits
//   landing within 20 seconds of each other cannot be two real assessments, so
//   it reports those as `closeDebits` and says so in `readThis`.
//   WHY IT EXISTS: answering "my balance is wrong" required the Firestore
//   console's filter UI, which is a bad thing to need for a recurring support
//   question on a database holding user data. Paired with
//   shared/_WORKING/eval/Check a user's credits.command — double-click, type a
//   4-character code, read the answer.
//   Same auth bar as every other admin endpoint: signed-in Firebase user whose
//   email is in ADMIN_EMAILS, which exists only on the admin deployment.
//   No composite index is needed: it filters on uid alone and sorts in memory,
//   because one user's ledger is small and an index is not worth a deploy.
//
//   LAYOUT: .rg-label:not(.has-price) .info right 526 -> 530. The figure
//   occupies x 622..862 and the info box ended at 626 — a 4px overlap that
//   stayed invisible only because the meta rows are right-justified and the
//   title is clamped. A long title would have run under Robo's shoulder.
//
// v5.94: THE CHEST PANEL IS SQUARED TO THE CODE, AND DEEP CACHING HAS A CHIP.
//
//   QR / CHEST FIT. The chest interior measures 166 x 157 in the 427x512 art —
//   close to square, not square — and v5.93 stretched the code to fill it. A
//   stretched QR is sloppy at best and undecodable at worst; a reader expects
//   square modules. Fixed geometrically rather than by redrawing: the LARGEST
//   SQUARE that fits the panel is inscribed and centred (157x157, 4.5px of the
//   art's own interior either side), which lands at 84.6 x 84.6 against the
//   230x276 figure — square to a tenth of a pixel.
//     left 31.733%  top 29.102%  width 36.768%  height 30.664%
//   The code is inset to 86% of that so the remaining white is its quiet zone.
//   A QR butted against the art's black chest stroke with no quiet zone is the
//   classic reason a code "looks fine and will not scan".
//   Two rendering fixes went with it: the chest code is rasterised at 240px and
//   scaled down (a canvas drawn at display size and printed at 288 DPI loses
//   module edges, and a QR is nothing but module edges), and it is drawn pure
//   black on pure white instead of #1a2208 on #d4d9be — that pairing was tuned
//   for the olive score box and on a white chest it reads as a dirty square
//   while costing contrast this size cannot spare.
//   STILL TO TEST ON A PHONE: the panel is ~0.29" at 288 DPI against the 0.41"
//   the bare code had. If it will not scan reliably, the lever is the PAYLOAD,
//   not the art — "https://robograder.app/id/XXXXXX" is 32 bytes and forces
//   byte mode; an uppercase host-and-path would encode in QR alphanumeric mode
//   at 5.5 bits a character instead of 8 and drop a whole version.
//
//   DEEP CACHING CHIP. api/assess_deep.js has read types.deep off config/caching
//   since v5.92 and the admin already carried the whole per-type structure with
//   `deep` present but held in _CACHE_LIVE as a no-op. It is now live, as a
//   THIRD CHIP IN THE EXISTING ROW rather than the dropdown that was asked for:
//   the row is flex-wrap at max-width 200px and Comic+Card+Deep measure about
//   140px, so this costs ZERO additional height, where a second select would
//   have added a control and its gap. Same toggle, same confirm, same place.
//
// v5.93: THE LINE-ART ROBOT CARRIES THE QR, AND THE (+) GOES BACK ON THE MIDLINE.
//
//   WIDE LABEL. The bare QR and the URL line under it are replaced by Matt's
//   line-art Robograder with the code composited into its chest panel - one
//   branding element instead of two utility ones, on every Wide label.
//   The chest rectangle is MEASURED, not eyeballed: a flood fill from inside
//   the chest of assets/Robograder_Line_QR.png gives left 30.68%, top 29.10%,
//   width 38.88%, height 30.66% of the 427x512 art. Those four numbers are the
//   only thing tying the code to the drawing - IF THE ART IS REDRAWN,
//   RE-MEASURE THEM, or the QR lands on Robo's ribs.
//   The art ships with the white knocked out to transparency so the gradient
//   shows through; the QR keeps a white backing because a code needs a light
//   quiet zone.
//   SCANNABILITY IS THE TRADE: the chest panel is ~89px at 288 DPI (0.31")
//   against the 118px (0.41") it replaced. Test it with a phone before the
//   print run. The Grade ID is on the label as the fallback.
//
//   The URL line is gone from Wide - it duplicated the ID. The meta block is
//   right-justified and the ID row reads "ROBOGRADER.APP/ ID / A7K2M9", so one
//   line serves as both a URL and an ID.
//
//   THE (+) IS BACK ON THE NUMBER'S MIDLINE, where the app's own score box has
//   always drawn it. v5.92 put it bottom-right, reasoning that a three-glyph
//   "9.5" reaches x=223 of 276 so a midline (+) collides at every numeral size.
//   True, and beside the point: the numeral size is not fixed. It now shrinks
//   188 -> 168 WHEN A (+) IS PRESENT AND ONLY THEN, so the two share the
//   midline and the large majority of books - no (+) - keep the full 188.
//   168 is measured: numeral and (+) rendered separately and their BLACK PIXELS
//   diffed puts the worst case at 8px clearance at 168 and 0px at 190. Two
//   passes - at the (+)'s first size (56px) the ceiling was 136, WORSE than the
//   150 these labels carried before v5.92, which would have made a (+) book
//   look downgraded. Dropping the (+) to 44px bought 32px of numeral. The grade
//   is what is read across a room; the (+) yields to it.
//
// v5.92: DEEP CACHING + DEEP KEEP-WARM, and the Wide score box sized for a wall.
//
//   DEEP WAS NEVER CACHING AT ALL. `DEEP_CACHE_ENABLED` was
//   `cacheProfile === 'batch'` and nothing else, and only assess_batch_run.js
//   sends that. Every app-initiated Deep sent its system prompt as a PLAIN
//   STRING with no cache_control: no entry to warm, nothing that would read
//   one. That - not frequency - is why Deep warming could not be built.
//
//   ONE SOURCE FOR THE TEXT. The Deep prefix moved out of api/assess_deep.js
//   into lib/deep_prompt.js, which api/cachewarm.js imports too. Proven
//   BYTE-IDENTICAL to the old inline template across all four
//   hasFrontCover x hasInteriorCovers combinations before the swap, by
//   rendering the original literal and diffing. Two copies of a cached prefix
//   is how Main's ping spent three weeks warming an entry nothing read.
//
//   THE SHAPE IS COPIED, NOT APPROXIMATED. assess_deep.js sends ONE system
//   block, so the Deep ping sends ONE - the OPPOSITE of the Main ping, which
//   sends two because assess.js sends two. output_config and thinking are sent
//   identically. Copying the Main ping here would have repeated the exact bug
//   v5.90 fixed.
//
//   THREE VARIANTS, THREE ENTRIES: 'deep' (16,700 chars, sha f88b764982ee6c7b),
//   'deep_ic' (23,017, 6d3ed9024eef3cff), 'resto' (15,156, f9e342633ad86dbc).
//   A ping holds ONE alive; ?variant= picks it, default 'deep_ic'.
//   assess_deep.js now stamps deepVariant / deepPrefixSha / deepCacheEnabled /
//   deepCacheSource on every timing record, so the default can be set from
//   traffic instead of guessed.
//
//   OFF BY DEFAULT. `types.deep` on config/caching gates it and defaults FALSE,
//   so this deploy changes nothing until Matt sets it. A cache WRITE bills at
//   2x input, so the first day is the test: Deeps reading = it pays for itself,
//   every Deep still writing = the prefix varies per book and the chip goes
//   back off.
//
//   A BUG CAUGHT IN THE WRITING: the Deep cron carries ?mode=warmdeep, and
//   `_isCron` only accepted 'warm'. The cron would have fallen through to the
//   Firebase branch and 401'd silently, on a schedule, forever - the same shape
//   as the defect that comment block warns about. Fixed before it shipped.
//
//   WIDE SCORE BOX SIZED FOR A WALL. These labels go on display walls read from
//   10+ feet. Box 252 -> 276 (6px inset top and right - all a die-cut can give
//   up), numeral 150 -> 188, PM 50 -> 58, wordmark 24 -> 26. 188 is the
//   measured ceiling, not an estimate: the box was rasterised and the numeral's
//   BLACK PIXELS compared against the stars, version, PM and (+) across five
//   grade/star/PM combinations. Worst case "9.5" with PM and three stars clears
//   by 11px at 188; at 192 the PM clearance falls to 3px. Line-box arithmetic
//   claimed room at 210.
//
//   AND THE (+) NOW EXISTS ON THE LABEL. It never rendered here - the app's
//   score box draws it on the right midline, the label's never did. Room on the
//   midline is the one thing this box cannot give: a three-glyph "9.5" already
//   reaches x=223 of 276, so a midline (+) overlaps it at EVERY numeral size,
//   140 included. It goes bottom-right instead, beside the version string,
//   where it costs the grade nothing.
//
// v5.91: THERMAL LABEL MODE. A "Thermal printer (black only)" toggle in the
//   label modal, stored beside size/priceTag/includePrice as `mono`, puts a
//   `mono` class on the label wrapper and a single override layer on top of
//   whichever format is selected.
//
//   WHY A SEPARATE RENDER AND NOT JUST A PRINT SETTING. A direct-thermal roll
//   printer (Rollo, Zebra, the Jadens) burns black or leaves the stock white.
//   There is no orange, no green and no grey; a mid-tone comes out as a dither
//   pattern. Rendered untouched at 1-bit, the Wide label's full-bleed gradient
//   covers the whole 4x1 in cross-hatch and swallows the smaller type - the
//   printing line and the URL both disappear outright. Measured, not guessed.
//
//   THE THREE RULES THE LAYER FOLLOWS, all consequences of a 1-bit head:
//     1. Nothing mid-tone. Every colour is #000 or #fff.
//     2. No fill behind text. The score box inverts from a filled panel to a
//        4px outline. Knocking white type out of a black panel means burning
//        the whole panel and leaving the number as the one unburned shape -
//        the first thing to close up as the head wears or the stock shifts.
//     3. Weight and position carry what colour used to, so nothing is lost in
//        the conversion.
//
//   SCOPE. It is a layer, not a fourth set of geometry: every position, size
//   and clamp stays exactly as tuned per format. Applies to Case, Wide, Square
//   AND Card - all are inside a 4" roll printer's width. !important throughout,
//   because renderLabelMarkup sets several colours inline for restored books
//   (purple box, purple numeral, purple check) and the tier stars take their
//   fill from an inline SVG attribute.
//   The mascot PNG is hidden in thermal: it is photographic with soft shading
//   and dithers into a grey smudge that reads as a printer fault.
//
//   VERIFIED by computed style, not by eye: every element under .mono audited
//   in a headless browser for color / background-color / border-color /
//   background-image / SVG fill. Zero non-monochrome values survive, inline
//   restoration colours included. Then rasterised at 300 dpi and reduced to
//   1-bit to confirm it reads.
//
//   The colour design is untouched. List view still prints Avery sheets on a
//   colour laser or inkjet exactly as before; the PDF filename gains a
//   "-Thermal" tag when the toggle is on.
//
// v5.90: THE KEEP-WARM PING HAS NEVER WARMED AN ASSESSMENT.
//   /api/cachewarm?mode=status, read 2026-10-27, settled a question that had
//   been open for weeks. The ping and real Mains are on SEPARATE cache entries:
//     every ping      reads/writes 31,402 tokens
//     every ordinary Main reads/writes 31,403 tokens
//   216 pings, 30 Mains, never once crossing. The decisive row: a Main at
//   03:05:25 WROTE a new entry five minutes after a ping at 03:00:19 READ one.
//   That is only possible if the keys differ. $16.64 of pings bought nothing,
//   and every assessment more than an hour after the last one paid full cold
//   price (~$0.31 against ~$0.065).
//
//   The prefix TEXT comes from the same buildMainPrefix(null) on both sides, so
//   the suspected difference is the SHAPE of the system array:
//     assess.js    [{text: prefix, cache_control}, {text: <variable tail>}]
//     cachewarm.js [{text: prefix, cache_control}]
//   The cached segment is serialised with the block structure around it, so one
//   block and two blocks are not the same key. The ping now sends two blocks,
//   the second a single "." (its content is after the breakpoint and outside the
//   key, but the API rejects an empty text block).
//
//   AND THE INSTRUMENT, because this is a hypothesis and not yet a proof:
//   api/assess.js now stamps mainPrefixSha / mainPrefixChars / mainSystemBlocks
//   on every timing record. The next real Main after this deploy decides it:
//     sha == cachewarm's prefixSha (2cf0adb252514a0d) -> the text matched, the
//       shape was the bug, and this fix is the fix.
//     sha != that -> buildMainPrefix() is returning different bytes to the two
//       callers and the shape change was beside the point. Chase the bytes.
//   Expect the first Mains after the deploy to be cold either way; a push
//   invalidates the cache.
//
//   mode=status IS NOW OPEN (no auth). It was behind a Firebase ID token, which
//   meant the one instrument built to make a silent failure visible was itself
//   hard to reach - which is why this ran unnoticed for weeks. It discloses ping
//   timestamps, token counts, costs and the app version: no user data, no comic
//   data, no credits, no spend, no writes. To close it again delete
//   `|| _isOpenStatus` in api/cachewarm.js; nothing else depends on it.
//
// v5.89b: WIDE LABEL - the horizontal rule takes the same #2a3a18 as GRADED and
//   ID (the old #b0b89a all but vanished on the orange gradient, and the rule
//   and those two words are one pre-printed unit). The QR box and its URL moved
//   down 29px - 10% of the 288px label height - to pad 95..229, URL 233..249.
//   Pre-print artwork regenerated to match.
//
// v5.89: WIDE LABEL - FIXED-POSITION META BLOCK, TITLE CARRIES THE ISSUE.
//   Supersedes the v5.88 note below, which was handed over but never
//   deployed; where the two disagree this one is what the code does.
//   Wide only. Case, Square and the retired Large keep their own geometry,
//   but the two MARKUP changes (issue rides with the title, "ID" not
//   "GRADE ID") are in shared markup and reach every variant by design.
//
//   1. THE META BLOCK IS PINNED TO THE FLOOR. .info now spans top to bottom
//      with justify-content:space-between, so .info-lower sits on the floor
//      and GRADED / ID print at the SAME y on every label no matter how many
//      lines the title took. The divider moved with them (border-bottom on
//      .info-upper -> border-top on .info-lower). This is what makes those
//      two words pre-printable: a flowed position could not be.
//      Measured, identical across a 1-line title, a 1-line title with a
//      printing line, a 2-line clamped title and a short title:
//        divider y=193, GRADED 204..235, ID 242..273, both right-aligned at
//        x=148.7, QR box 692..826 x 67..201, URL 205..221.
//      has-price keeps the old flowed layout unchanged.
//
//   2. THE ISSUE NUMBER RIDES WITH THE TITLE. "<Title> #<Issue>" is one
//      element with no break between them; if the line must break it breaks
//      BEFORE the issue number. The line below is now
//      "<pub date>, <publisher>" as one string (the old flex row with a 24px
//      gap is gone - a comma does the separating). The comma only appears
//      when both halves exist.
//
//   3. QR BACK TO 118px, CENTRED. v5.88 grew it to 196; reverted. It sits in
//      the former mascot slot in a 134x134 white pad (118 + 8px quiet zone
//      each side, which a scanner needs and the orange gradient would eat),
//      and the pad + URL are centred on the label as a group: pad 66..200,
//      URL 204..221, group centre 143.5 against the label's 144.
//      SCAN TO VERIFY is gone - the code and the URL under it say it.
//      GRADE ID is now just ID.
//
//   4. TYPE, retuned around the pinned block: title 66 -> 62 (clamp 118 =
//      2 lines at 0.95), issue line 52 -> 48, meta labels 28 -> 26, meta
//      values 32 -> 30. Still well above the v5.87 baseline of 58/46/26/28.
//      The width:160% correction from v5.88 stands and is the reason the
//      title fits: scaleX(0.625) compresses the rendered glyphs but not the
//      layout box, so the title used to wrap against the column and then
//      render at 62.5% of it, throwing away a third of the line.
//
//   5. PRE-PRINT ARTWORK regenerated: assets/Robograder_Wide_4x1_preprint.png,
//      1276 x 376 @ 300 dpi (4" x 1" trim + 1/8" bleed). It is now SCREENSHOT
//      FROM THE LIVE CSS with every variable element hidden, not redrawn by
//      hand, so it cannot drift from what the app prints. Static layer:
//      gradient (extended through the bleed), score box + ROBOGRADE wordmark,
//      the empty white QR box, the divider, and GRADED / ID in dark green.
//
// v5.88: WIDE LABEL REDESIGN - QR INTO THE MASCOT SLOT, LIGHT SCORE BOX.
//   Two changes to the Wide (4" x 1", Avery 8161 / thermal roll) label only.
//   Case, Square and the retired Large are untouched.
//
//   1. QR RELOCATION. The QR moved out of the bottom-left corner and into the
//      slot the Robograder mascot used to hold (top:14, right:282, 220 wide,
//      immediately left of the score box), and grew from 118px to 200px -
//      0.41" to 0.69" at 288 DPI. The URL it encodes follows it and now
//      prints centred beneath it. The mascot badge is retired for Wide; Matt
//      is producing a figure that INTEGRATES the code (QR as Robo's chest,
//      head/arms/wheels extending past it) for the pre-printed stock, so the
//      app-rendered label draws the bare code.
//      The corner the QR vacated is what paid for bigger type: .info now
//      starts at the label's own 32px left margin instead of clearing a QR
//      that is no longer there (+138px of column), and title 58 -> 66, issue
//      46 -> 52, meta labels 26 -> 28, meta values 28 -> 32, printing 20 -> 22.
//      Title clamp retuned to 128px at line-height 0.95 so a 2-line title
//      still lands inside the 288px label (measured worst case ends at 268).
//      has-price is the one exception: the price pad takes the mascot slot, so
//      the QR reverts to bottom-left at 118px and .info keeps left:170. That
//      state is visually unchanged from v5.87.
//
//   2. LIGHT SCORE BOX. The Wide score box flipped from #1a2208 with a
//      #b8d820 numeral to #cfe8a8 (an app-palette light green) with a BLACK
//      numeral and a 3px border in the app's RoboGrade-Score dark green
//      (#0f1a05). Thermal label printers are 1-bit black-only: they can only
//      burn dark, so a pale numeral knocked out of a dark panel is physically
//      unprintable - the panel prints solid and the number disappears. Light
//      interior + black ink is the only arrangement that survives thermal,
//      laser and pre-printed stock alike. ROBOGRADE wordmark, stars, version
//      string, precision and the restoration palette all re-tuned for the
//      light panel (restored Wide gets #ead8f5 / #3a1252 rather than the dark
//      variants' #1a0a2a / #c8a8e8).
//
// v5.87: LARGE LABEL RETIRED. The 'Large' chip is gone from the label picker
//   in BOTH views (Detail and List). It was an early attempt at matching CGC's
//   own 7.5" x 1.5" slab label (OL5450) and nobody uses it; it is also the only
//   format that cannot fit a 4"-wide thermal printer, so showing it would
//   promise something the printing path can never deliver. 'large' is dropped
//   from VALID_SIZES too, so a stored preference of it falls back to the
//   default rather than selecting a chip that is no longer drawn. The format
//   definition and its renderer stay in the file, unreferenced.
//
// v5.86: SINGLE-LABEL PDF FROM DETAIL.
//   printLabel() now calls openLabelViewer(comic, [comic], {single:true}).
//   In that mode generatePDF makes the jsPDF page BE the label - format
//   [labelW, labelH] - and draws it at the origin with no sheet margins and no
//   grid. The label's own dimensions are unchanged: 4" x 1.33" exports as a
//   4" x 1.33" page, so a printer driver can map it to physical stock. One
//   label per page. List view's printQueueSheet() calls openLabelViewer
//   WITHOUT the flag, so the Avery sheet path is byte-for-byte unchanged.
//   KNOWN GAP: Small-L\'s full-width gradient band (bandImgData, laid 8.5"
//   wide across each sheet row) is sheet-only and is skipped in single mode.
//   That band is exactly the artwork the pre-printed stock is meant to carry,
//   so it needs a decision rather than a quick fix - see the label notes.
//
// v5.85: THE EXPORT HUNG ON "Rendering…" FOREVER, plus button finish.
//   MEASURED in the live 5.83 app, not reasoned about: render 224ms, PNG
//   encode 413ms, 924KB blob - all fine. The hang is in _saveImageBlob.
//   navigator.canShare({files}) returns TRUE on desktop Chrome, so the share
//   branch is taken, the OS sheet opens, and dismissing it does not always
//   reject: the promise simply never settles and every awaiting caller is
//   stuck. Two changes, either of which alone would fix the symptom:
//     - _exRun restores the button BEFORE saving. Rendering is over by then, so
//       "Rendering…" was already a lie.
//     - the share is RACED against 60s and falls through to the download path,
//       which is the right desktop behaviour anyway.
//   Also: .rg-btn-action takes .btn-topbar.btn-grade's finish - the 135deg
//   surface gradient and soft drop shadow - keeping the same green. The
//   thumbnail button takes its padding too (6px 14px 6px 7px, height 56px), so
//   the thumbnail sits near the left edge instead of floating in a tall box.
//
// v5.84: FIVE EXPORT BUGS, all found by a verification pass over 5.82/5.83.
//   (1+2) THE MEASURE SIDE WAS TIGHTENED AND THE DRAW SIDE WAS NOT. v5.82 cut
//       _exPaperMeasure's section header P(26)->P(20), its empty row
//       P(28)->P(20) and _exRowH's line pitch P(16)->P(14), and left
//       _exDrawPaper drawing the old numbers. _exRenderSummary clips the list
//       to the MEASURED height, so every section drew 18px taller than it was
//       allotted and the excess was silently cut. On a clean book - three empty
//       sections - that is 126px: the whole SPINE section vanished and a band
//       of bare black card showed between the paper and the bookend. A wrapped
//       defect's second line sat on the band boundary below its own row.
//       These heights must now be changed in pairs; the comment says so.
//   (3) THE GRADE STACK DID NOT FIT ITS SLOT. badge P(86) + P(16)/P(11) gaps
//       made blockH 525 against EX_COVERH 480. Math.max(0,...) clamps the
//       centring, so it ran 45px past the cover and the score panel painted
//       over the bottom of the Page Quality pill - on EVERY book with a page
//       quality. Now P(74) and P(10)/P(10): 468 into 480.
//   (4) A MISSING COVER WAS INVISIBLE. The placeholder is #1a1a1a, chosen when
//       the container was cream; on the black card it is 1.12:1. A book whose
//       cover failed to load showed nothing at all. Now #23232a with a border.
//   (5) EXP.red1 WAS 3.29:1 ON BLACK - below AA, and dimmer than the red2 line
//       beside it, so the more important imprint line was the harder to read.
//
// v5.83: 5.82 SHIPPED BROKEN - plus the export buttons and PNG.
//   (1) THE 5.82 CRASH. "Couldn't build the image" on every export. Deleting
//       the dead _exRenderDefects took `const EX_RULE = P(3)` with it, because
//       it was declared on the line immediately above the function. The
//       combined renderer reads EX_RULE three lines into its own layout maths,
//       so it threw before drawing anything. Restored, and every identifier the
//       renderer touches is now checked against a declaration.
//   (2) SUMMARY BUTTON SHOWS WHAT IT MAKES. A thumbnail of the export sits in
//       the button, the same idea as the Start Grading button's cover. SAME
//       44px height; width 23px = 44 * 8/15, the export's own ratio. Label is
//       "Summary Image". assets/Summary_Image_Placeholder.png is a blank stand-in
//       at the right ratio - replace the file, keep the name.
//   (3) PRINT LABEL takes the slot the Defect List button had. printLabel()
//       already existed and was simply unreferenced from Detail since batch
//       printing moved to List view; it opens the same openLabelViewer() the
//       List view uses, seeded on this one book, so the style picker and the
//       Avery-positioned jsPDF output are the existing ones, unchanged.
//   (4) EXPORT IS PNG, not JPEG at 0.92. The image is flat colour, hard edges
//       and small monospace text on black - what JPEG rings around. The cover
//       photo is the only part JPEG compresses well and it is a fraction of
//       the frame.
//   (5) _exRun wrote its status with btn.textContent, which would have DELETED
//       the new thumbnail <img> on the first export. It targets the button's
//       <span> now.
//
// v5.82: ONE EXPORT IMAGE, ON BLACK - and the empty blue grade badge fixed.
//   (1) SUMMARY AND DEFECT LIST ARE MERGED. Same 15:8 / 1080x2025 lock. The
//       Defect List button is gone and so are _exRenderDefects and
//       exportDefectListImage; the paper helpers they used are called from the
//       combined renderer instead. What bought the room: the back-cover
//       thumbnail is dropped and Predicted Grade + Page Quality move into the
//       space it leaves, stacked beside the front cover; the ID and graded date
//       share one line under the imprint; the conclusion card at the foot is
//       gone entirely, since PG and PQ were all it carried.
//   (2) THE SCORE PANEL, THE LIST AND THE BOOKEND ARE ONE COLUMN. Panel rounded
//       on top and square at the bottom, list between its two green rules, and a
//       new bookend in the panel's own colour closing it with a rounded bottom.
//   (3) BLACK, FULL BLEED. EX_INSET 14 -> 0 and EX_BOXH -> EX_H, so the
//       container runs to the image edge; only the corner slivers outside the
//       rounding stay white. Title and issue inverted to white//#d8d2c6, and the
//       footer moved off #5a7028, which vanished against the new background.
//   (4) TIGHTER LIST. Row P(12)+lines*P(16) -> P(6)+lines*P(14), section header
//       P(26) -> P(20), slack padding P(10) -> P(3). About 9 rows of space.
//
//   (5) THE EMPTY BLUE BADGE - a real bug, found while rebuilding the layout.
//       _exFacts read `item.grade != null`, and item.grade is the MANUAL grade
//       field, stored as an EMPTY STRING on every book without one. "" is not
//       null, so that branch won, `predicted` became "", and the badge drew an
//       empty string - a solid blue square with no number, on nearly every
//       book. Now tested for non-blank, not non-null.
//   (6) EXP.bg DID NOT EXIST. The score panel filled with it, so the fill
//       silently inherited whatever colour was set last (the cover placeholder
//       #1a1a1a) and happened to look right. Named EXP.panel and defined.
//
// v5.81: FULL CAPTURE BUGFIX + the admin write-ups that were never displayed.
//   (Items 11 and 12 below were written against 5.80 but land here - 5.80 was
//   already deployed when they were made.)
//
// v5.80: GRADING ACCURACY - color break, missing pieces, Deep bracket.
//   The theme is that Robograder has been grading HIGH, and two prompt failures
//   account for most of it. Both were measured on real books, not reasoned about.
//
//   1. COLOR BREAK — THE DEFAULT IS NOW TRUE. Werewolf by Night 32 came back with
//      "Spine stress lines - along spine fold, few small, non-color-breaking",
//      LOW. The spine carried four runs of bright WHITE lines against a dark
//      purple cover. White-on-dark IS the color break. The old prompt had ONE
//      line on this (a detection note framed as "distinguishes 9.6 from 9.4")
//      against several paragraphs warning against inventing defects, so false
//      was the safe-feeling answer and the model took it almost every time.
//      Replaced with COLOR-BREAK ADJUDICATION: a fold that does NOT break color
//      is a tonal ripple that usually does not survive a 1200px phone photo, so
//      VISIBILITY IS ITSELF EVIDENCE OF A BREAK. colorBreaking is now TRUE unless
//      unbroken ink can be SEEN crossing the fold, false is stated as a positive
//      claim rather than a hedge, and a spine tick is color-breaking BY
//      DEFINITION. Expect this to pull grades DOWN across the board.
//
//   2. MISSING PIECES ON BLANK PAPER. ASM 57 (PSA 7.0, label reads "TINY PIECE
//      MISSING LEFT EDGE ... BACK COVER") came back 8.5. The piece WAS found and
//      was recorded as "Surface mark ... about 1/4 inch ... Low" — seen, then
//      named wrong, which costs nothing. CHECK 2's three tests were all
//      art-dependent (silhouette, art cut off, broken printed shape) and the bite
//      was in the blank cream margin of an all-text back-cover ad: no art to
//      interrupt, and shot on a white board so no tonal contrast either. Added
//      test (d), an EDGE SILHOUETTE test that runs on all four edges of both
//      covers independently of the art, keyed on EDGE TEXTURE (machine-trimmed
//      cut vs fibrous torn edge) rather than contrast, plus a naming guard:
//      surface mark / soiling / stain / tanning / edge wear all leave the
//      silhouette straight.
//
//   3. MISSING-PIECE GRADIENT IS A CEILING, NOT A LANDING. "1/4\" missing -> 9.0"
//      was being read as a mapping. Rewritten so every figure is explicitly the
//      best an OTHERWISE-CLEAN book can do, with the instruction to apply the
//      ceiling and then grade DOWN for everything else. Paper loss is structural
//      and is never LOW severity.
//
//   4. DEEP: STRUCTURAL DISCOVERY IS NOT CAPPED. PHASE 4 limited the Deep to +/-2
//      ladder positions, which near mid-scale is one grade point. A spine split
//      first visible on an interior cover can be worth far more than that. The
//      limit now exempts a genuinely NEW structural defect (spine split, cover
//      detachment, hidden paper loss, edge tear, staple tear-through), requiring
//      deepAddition:true, HIGH severity, and a gradeRevisionReason that says this
//      pass DISCOVERED it and that it was not visible in the initial photos.
//
//   5. DEEP GRADE-REFERENCE BRACKET 5 -> 3 IMAGES. ~1,475 input tokens each,
//      after the cache breakpoint by design, so ~7,375 tokens billed in full on
//      every pass — the largest never-reused cost in a Deep. Now a GRADE_REF_SPAN
//      constant, overridable per request as gradeRefSpan (2=5 images, 1=3, 0=1).
//      eval/grade_ref_ab.mjs measures all three on the same Main.
//
//   6. COMICVINE REFERENCE COVERS: super_url first, original_url last, plus a
//      3.5MB hard drop on both the ComicVine and local reference_covers paths.
//      Venom: Lethal Protector 1 was killing the whole assessment with a 500 —
//      "image exceeds 10 MB maximum: 11002612 bytes" — because original_url was
//      an 8MB raw scan. A reference cover is a nice-to-have and must never fail
//      the call.
//
//   7. SOFT STRIKE THRESHOLD 10 -> 8, and the soft lockout duration split into
//      its own constant so a bad-photo cool-off can be made gentler than the
//      abuse one. (Briefly 3; reverted same day as too strict for real users.)
//
//  13. ADMIN WAS READING IMAGE ARRAYS FROM THE WRONG HALF OF THE DOCUMENT.
//      nestForFirestore() splits a saved item: COMIC_DATA_FIELDS go inside
//      comicData, everything else stays top-level. images/cornerImages are
//      explicitly excluded from the split; interiorImages, interiorCoverImages,
//      restorationImages and signatureImages are not in the list at all - so all
//      six sit at the top and read fine from `raw`, which is why they always
//      rendered. couponImages, insertImages and userDefectImages ARE in
//      COMIC_DATA_FIELDS, so raw.couponImages is undefined and normImages()
//      returned [] every time. S22 added the Coupon and Insert rendering and it
//      has never drawn anything. All arrays now read from `flat`
//      ({...raw, ...comicData}), and cleanBeforeImages / cleanAfterImages are
//      returned and rendered for the first time.
//
//  12. FULL CAPTURE: PHOTOS WERE LANDING IN DROPPED SLOTS. On a binding that
//      does not use all six Full slots, handleInteriorImages() computed
//      (_tappedInteriorSlot + n) % _slotN - a STORAGE index (0-5, FULL_SLOTS
//      order) reduced modulo the REQUIRED COUNT (3 on a glue-bound book). On a
//      3-slot book, tapping Outer Edge (storage 4) wrote to 4 % 3 = 1, which is
//      exterior_bottom_staple - a slot that binding had dropped, so the photo
//      was never rendered and the required slot stayed empty. Bottom Pages
//      (3 % 3 = 0) hit the other dropped staple slot. Only Top Pages was right,
//      by coincidence. submitFullAssessment then read the required indices,
//      found them empty, and the user's real photos were discarded - which is
//      how a Full ran on three staple close-ups sitting in the page/edge slots
//      (Werewolf by Night 32, grade ID I7KEWM). Now walks REQUIRED positions
//      and translates to storage at the end, the way _assignCommitInterior
//      always has.
//
//  11. ADMIN: THREE WRITE-UPS THE APP STORED AND THE ADMIN NEVER SHOWED.
//      fullAssessmentNotes (the Full pass's internal summary - shown only when
//      the user-facing fullAssessment is empty, since otherwise the two say the
//      same thing); gradeRevisionReason (why a Deep or Full moved the number -
//      the app showed it, the admin, where movement is audited, did not); and
//      cleanComparison, the whole Cleaning Compare result including its write-up
//      and defect movement, which users pay for and which was invisible
//      server-side. Batch has no per-item prose to show - it writes a
//      statistical consensus and depth:'batch' history entries, not a write-up.
//
//  10. THE GRADE IS WRITTEN BEFORE THE PHOTOS (the real Punisher 1 fix).
//      submitForm() uploaded every image to Cloud Storage and only then wrote
//      the item to Firestore, so for the whole length of the upload — the
//      slowest part of the flow on a phone — the entire assessment existed
//      nowhere but that browser tab. _saveProvisional() now writes the text
//      record (grade, PQ, defects, write-ups) as its own document before any
//      byte of image is uploaded, with data: URLs stripped (megabytes each
//      against a 1MB document limit) and provisionalSave:true as the marker.
//      The real save at the end clears the flag. A record still carrying it is
//      an interrupted save. It also settles the credit immediately, since the
//      assessment is durable from that line onward.
//
//   9. CREDITS: CHARGED-BUT-NEVER-SAVED IS NOW REFUNDED AUTOMATICALLY.
//      /api/assess takes the credit before the Anthropic call and already
//      refunded every failure it could see — gates, thrown errors, 402s. It
//      could not see the client dying AFTER a good result. Punisher 1
//      (2026-10-21): clean 9.0 in 12.9s, stopReason end_turn, app froze during
//      the save, book never reached the library, credit kept, user emailed.
//      A charged assessment is now written creditSettled:false; the client calls
//      the new /api/credit_settle when saveItem() succeeds; the new
//      /api/credit_sweep cron (every 10 min, 15 min grace) refunds whatever is
//      still pending. Worst case a user waits ~25 minutes for the credit back.
//      The bias is deliberate: a failed settle call refunds a credit the user
//      arguably owes, which beats silently keeping money for work never
//      delivered. [credit_sweep] logs the rate every run.
//      NOT DONE, and the better fix: save the graded item BEFORE uploading its
//      photos. A grade with no pictures is recoverable; a grade with nowhere to
//      live is not. Punisher 1's photos never left his phone.
//
//   8. ADMIN: PG now renders with one decimal in the Item views and item search,
//      matching the app. RG still drops a trailing .0 — that is correct, it is a
//      0-10 score, not a ladder position.
//
// v5.79: EXPORT IMAGES - the overflow line's COUNT is bold.
//     Canvas has no inline markup, so the line is drawn as three runs with the
//     x position carried between them: "...and " plain, the number at 700, then
//     " more defect(s), not shown" plain again.
//
// v5.78: EXPORT IMAGES - PAPER TONE AND THE OVERFLOW LINE. Final pass before
//     this is judged in the app rather than in headless renders.
//
//     The paper is #fbfaf5 rather than #ffffff. Pure white read as a hole
//     punched in the card; this is warm enough to be paper and still a clear
//     step up from the off-white around it - the blue channel does most of that
//     work (f5 against dc).
//
//     The overflow line gained a leading ellipsis: "...and 12 more defects, not
//     shown". The list is cut off mid-flow and the mark says so.
//
//     PLURAL AGREEMENT KEPT, DELIBERATELY. Matt's wording was "...and X more
//     defect, not shown"; "and 12 more defect" would read as a typo on a
//     seller's image, and `hidden` is 1 often enough for the distinction to
//     matter. One ternary to change if the literal singular was meant.
//
// v5.77: EXPORT IMAGES - PAPER/CARD TONES FLIPPED, AND THE OVERFLOW LINE IS
//     PLAIN.
//
//     The continuous-form paper is now PURE WHITE and the card around it is the
//     off-white, which is the reverse of 5.76. The green bands are unchanged,
//     so the paper reads brighter and the card recedes behind it. The Summary
//     has no paper, so it is simply off-white throughout.
//
//     "and N more defects, not shown" lost its bold - it is the same plain
//     black monospace as the defect detail beside it.
//
//     NOT A CODE CHANGE, BUT WORTH RECORDING: the "FR" under a 1.5 in the
//     mock-ups was the test harness, which carried an invented GRADE_LABELS
//     stub. The app's own table has 1.5 -> "Fa/G" and 9.8 -> "NM/M", and always
//     did; the harness now carries the real one. Two mock-ups were lying about
//     grade labels for several rounds, which is the second time a harness stub
//     has been mistaken for an app bug (PQ_COLORS was the first). Stubs in that
//     harness are now a known hazard: prefer copying the app's real table.
//
// v5.76: EXPORT IMAGES - "PREDICTED GRADE" NO LONGER CLAIMS PAGE QUALITY.
//
//     Matt spotted the real error: page quality is not a kind of grade, and
//     sitting it under a "PREDICTED GRADE" heading said it was. The heading is
//     now two lines centred over the blue badge alone, on the LEFT half of the
//     card; page quality (and FMV on the Summary) occupies the RIGHT half on
//     its own. The two halves are the card's quarter-points, so they are evenly
//     spaced whatever the card's width.
//
//     The card grows to its contents and stays centred - wider for "Off-White
//     to White", narrower for "White" - CLAMPED to the container. The first
//     build of that had no ceiling and the card bled off both sides of the
//     white box; the page-quality name now also steps its own type down rather
//     than forcing the card wider than its half allows.
//
//     ON THE DEFECT LIST THE CARD IS FULL WIDTH INSTEAD, because it has to
//     connect to the bottom of the list: square top corners, rounded bottom,
//     flush against the paper. A card that adapted its width could not join.
//     Say so if the narrowing was wanted there too - it would mean narrowing
//     the whole interior object, list included.
//
//     ── THE DEFECT LIST IS ONE OBJECT NOW ────────────────────────────────
//     ID/graded bar (rounded top) -> paper between two green rules that carry
//     that bar's own colour down both outer edges -> conclusion card (rounded
//     bottom). No gaps anywhere in the stack, which is where the extra list
//     height came from.
//
//     Everything outside that object is PURE WHITE on both images. The
//     off-white belongs to the paper and its sprocket margins alone, so the
//     header band and its dividing rule are gone.
//
//     Page-quality pills were drawing in the fallback grey for everything but
//     two designations - that was the test harness carrying a stub table, not
//     the app, which has always used the full PQ_COLORS. The harness now
//     carries the real one so "Cream to Off-White" renders in its own tint.
//
//     Judged in the app from here: the sandbox has no Google Fonts, so every
//     numeral width in a headless render is wrong.
//
// v5.75: EXPORT IMAGES - LAYOUT PASS. Still 1080 x 2025 (15:8) for Whatnot.
//
//     The container now runs to the bottom inset, mirroring the top, with
//     "robograder.app" inside it. That alone returned ~30 CSS px, and with the
//     inter-section gaps cut to 8 the covers went from 133 to ~184 CSS tall -
//     which matters, because a Whatnot listing crops to the CENTRAL 1:1 square
//     and on the Summary that square is the RoboGrade panel plus the lower
//     covers.
//
//     The title block sits on a PURE WHITE band with a hairline under it, and
//     is tighter: pub date and publisher share one line, comma-separated, with
//     the printing below.
//
//     PM now splits across two faces exactly as scoreBox does on screen - the
//     symbol in Saira, the number in Saira Extra Condensed at scaleX(0.72) -
//     rather than being set in one face and left wide.
//
//     ── THE DEFECT LIST IS NOW ONE CARD ───────────────────────────────────
//     The provenance bar is the list's HEADER: rounded on top, square on the
//     bottom, the same width as the paper, which removes the gap that used to
//     sit between them. The paper's own bottom corners are rounded.
//
//     "and N more defects, not shown" is the bottom line, in the same black
//     monospace as the defects, with nothing beneath it.
//
//     THE PAPER NO LONGER STRETCHES TO FILL. Rows share out a SMALL amount of
//     leftover space (<=10 CSS px each) so quantised heights do not leave a
//     hairline gap, and a residue worth less than half a row is absorbed so the
//     paper meets the card cleanly. Anything larger is left as box background:
//     the previous build stretched a three-row clean book across the whole
//     band, producing a vast empty tract of cream with sprockets down the
//     sides. A clean book has a short list, and the paper may end where its
//     content does.
//
//     _exPaperPlan() works all of that out BEFORE anything is drawn, so the
//     caller can clip to the real height and the bottom corners round on the
//     actual last band rather than on an empty clip boundary.
//
//     NEXT: this is as far as headless renders are worth taking. The sandbox
//     has no Google Fonts, so League Spartan, Noto Sans Display and Saira all
//     fall back and every numeral width in those test images is wrong. From
//     here it needs to be judged in the app.
//
// v5.74: BOTH EXPORT IMAGES LOCKED TO 1080 x 2025 (15:8), FOR WHATNOT.
//
//     The fixed canvas is the change everything else follows from. It is a real
//     constraint, not a preference: a Whatnot listing crops to the CENTRAL 1:1
//     square, so the layout is tuned around what lands there - the RoboGrade
//     panel with the lower covers above it on the Summary, mid-list on the
//     Defect List.
//
//     ── THE DEFECT LIST CAN NO LONGER GROW, SO IT TRUNCATES BY SEVERITY ───
//     Defects are ranked HIGH > MED > LOW and the least severe are dropped
//     first, with "and N more defects, not shown" on the last band. The subtle
//     part: a category whose rows were ALL dropped is omitted entirely rather
//     than rendered as "No defects noted." The first build did the latter and
//     showed BACK as clean on a book with a tanned back cover - on a seller's
//     image that is the worst failure this feature could have, so the builder
//     now takes the untruncated list and uses it to tell "clean" apart from
//     "did not fit".
//
//     The paper also RUNS ON to meet the conclusion card. Quantised row heights
//     never land exactly on the available space, and stopping short left a slab
//     of dead cream mid-image; a trailing blank band is what the real
//     continuous-form stationery does anyway.
//
//     FMV is gone from the Defect List. Matt: "Sellers do not want to show the
//     FMV on books they're selling."
//
//     ── THE TWO GRADE NUMERALS NOW MEET IN THE MIDDLE ────────────────────
//     The RoboGrade numeral was size*0.66 and the predicted-grade numeral 40px,
//     so the first was far bigger and left no margin for the PM label or the
//     ceiling mark - which is why the (+) overlapped it. RG is now size*0.52
//     and PG is 48px. AND EITHER SHRINKS FURTHER WHEN THE (+) IS ACTUALLY
//     PRESENT (0.45 / 42px), so an ordinary book keeps the big number and only
//     a ceiling-hit book pays for the mark. The mark sits on the numeral's
//     midline in both boxes, condensed horizontally into whatever room is left.
//
//     ── SMALLER PIECES ───────────────────────────────────────────────────
//     Imprint lines (date, publisher, printing) are a muted brick red. Column
//     labels are centred over the thing they label. On the Summary the right
//     column is bottom-aligned so the FMV figure sits on the badge's own bottom
//     edge; on the Defect List the page-quality group is centred against the
//     badge instead. Subscore cell padding pulled in, RoboGrade box down to
//     92px, and the covers absorb whatever the title block does not use - which
//     is what holds the 15:8 lock whether the title runs to one line or two.
//
//     STILL NOT VERIFIED ON HARDWARE: the headless pass has no Google Fonts, so
//     League Spartan and Noto Sans Display fall back to wider system faces and
//     the numerals in the test renders are not the real widths.
//
// v5.73: TITLE AND ISSUE ON ONE LINE EVERYWHERE, AND THE EXPORT IMAGES REWORKED.
//
//     ── TITLE + ISSUE, ALL SURFACES ───────────────────────────────────────
//     Matt: "I don't know why we have a line break between Title and Issue.
//     They should appear together unless a line-break happens to be required."
//     The issue is now an inline span inside the title element on the List row,
//     Detail header and the public listing, so it inherits the title's family,
//     62.5% width axis and SIZE - only weight (600 vs 900) and colour still
//     separate them, and it wraps naturally instead of on a forced break. The
//     cover date drops to its own line with the publisher and printing.
//     ADMIN ALREADY DID THIS ("Title #Issue" inline) and was left alone. EDIT
//     IS DELIBERATELY UNCHANGED: there Title and Issue are two labelled fields
//     in a symmetric 2-column grid, and merging them would leave a labelled box
//     whose label is wrong.
//
//     ── EXPORT IMAGES, THIRD PASS ─────────────────────────────────────────
//     Defect List: disclaimer removed (extraneous on a summary); ID + GRADED
//     date now in a provenance bar between the imprint lines and the first
//     defect, drawn as robograde-panel.js draws it; robograder.app centred;
//     category headers no longer carry their subscore (they sum to the
//     RoboGrade and this image shows the PREDICTED grade, so they answered a
//     question the image does not ask); INTERIOR only appears when there is a
//     real interior defect, since page quality is already stated in the
//     conclusion and an Interior section carrying only a page-quality row was
//     pure duplication.
//
//     Summary: the RoboGrade panel is now the real thing - RoboScoreV3.scoreBox
//     ported to canvas with depth stars, the PM label upper-right, the grading
//     version at the foot and the ceiling mark, with the subscore grid beside
//     it at Detail view's own 2:2:1 proportions (the box sizes encode the
//     50/20/20/10 weights), and the provenance bar beneath.
//
//     THE "(+)" NOW BEHAVES DIFFERENTLY IN THE TWO BOXES, on purpose. On the
//     88px PG badge it sits on the NUMBER'S MIDLINE, against the numeral's
//     right edge, horizontally condensed to whatever room is left - the number
//     stays dead centre either way. On the 104px RG box it keeps the app's own
//     absolute right-middle placement at full size, because Matt confirmed that
//     one already reads correctly and it should not drift from Detail view.
//
//     NOT VERIFIED: the headless pass has no Google Fonts, so League Spartan
//     and Noto Sans Display fall back to much wider system faces. Numeral
//     widths inside the score boxes are therefore wrong in the test renders and
//     the real app will be tighter. Check both boxes on a device.
//
// v5.72: CLEANING COMPARE WAS UNREACHABLE, AND THE EXPORT IMAGES NOW LOOK LIKE
//     THE APP.
//
//     ── CLEANING COMPARE: RENDERING ALL ALONG, FINDABLE BY NOBODY ──────────
//     Matt ran a Deep on ASM 129 and reported the feature missing from both
//     Detail and Edit. It was not missing. #clean-section was in the Edit DOM
//     and correct - measured live: top at 9,225px of a 10,811px page, 3,313px
//     tall, because the ten Before/After pairs render unconditionally. There
//     was also no Detail-view entry point at all, and Detail is where Batch and
//     Full are offered, so that is where he looked first.
//
//     Two fixes, and the second is the one that matters:
//       - a Detail card in the same shape as BATCH / FULL ASSESSMENT AVAILABLE,
//         routing through showEditToSection(id,'clean')
//       - the Edit section is COLLAPSED by default to a compact offer and opens
//         on a tap. Already having After photos counts as open, so a run in
//         progress is never hidden.
//     The lesson is not about this feature: a section that renders correctly
//     9,000px down a page has not shipped.
//
//     ── THE (+) WAS SHOVING THE PG NUMBER OFF CENTRE ──────────────────────
//     On .ubadge it was INLINE inside .ubadge-num, a centred flex child, so
//     adding it widened the content and moved the numeral. Now absolutely
//     positioned in the badge's upper right, and 2pt larger (13.2px -> 15px)
//     because a third of the numeral was not readable. The big RG score box
//     already did it this way and is untouched - Matt confirmed that one reads
//     correctly.
//
//     ── EXPORT IMAGES, SECOND ATTEMPT ─────────────────────────────────────
//     Matt on the first: "your sample images have none of the established
//     Robograder formatting." Correct - they were an invented dark poster. They
//     now draw the app's own surfaces, with the constants lifted from where
//     they already live rather than re-picked by eye: showDetail()'s title
//     block, robograde-panel.js's tractor-feed paper (mint/cream bands banding
//     CONTINUOUSLY across section breaks, sprocket margins, olive ink, IBM Plex
//     Mono, category headers carrying their subscore), and
//     buildPredictedGradeBox()'s black card.
//
//     HEIGHT IS NOW VARIABLE, a deliberate break from the spec's fixed
//     1080x1920. Matt wanted room for a long defect list "without creating an
//     image that's too vertically long to be readable on a phone", and one
//     fixed canvas cannot do both. The paper grows to its content and the
//     conclusion is two columns - grade left, page quality and FMV right -
//     which is what buys the vertical room. A clean book's image is now about
//     half the height of a thirteen-defect one.
//
//     Unlike the in-app panel, ALL FOUR category sections always render, empty
//     ones included. On a shareable image the four subscores are part of the
//     claim; a missing SPINE row reads as withheld rather than as clean.
//
//     Verified headless on four defect counts again. Two spacing faults caught
//     that way: the conclusion row was sized to the 88px badge when the right
//     column is taller, so FMV ran into the disclaimer; and the paper's last
//     band is often cream, the same colour as the box, so it bled into the card
//     below until a hairline was added.
//
// v5.71: THE TWO EXPORT IMAGES, PLUS TWO BUGS FOUND BY LOOKING RATHER THAN
//     THEORISING.
//
//     EXPORT IMAGES - Summary and Defect List (SUMMARY_IMAGE_SPEC v2). Two
//     buttons at the bottom of a comic entry, each rendering a 1080x1920 JPEG
//     on an OFFSCREEN CANVAS and handing it to the existing save path. Both
//     were built rather than one chosen: Matt wanted to see which sellers
//     actually use.
//
//     The save path is the reason saveLightboxImage() was split. _saveImageBlob()
//     is now shared, so the export images inherit the Capacitor Filesystem ->
//     Share route that fixed Android's silent save failure in 1.13 instead of
//     growing a second implementation that would drift from it.
//
//     Verified headless on four cases before shipping: 13 defects (the app's cap
//     - fills the band exactly and reports "+ n more"), 7, 2, and none at all.
//     Three layout faults were caught that way and would not have been caught by
//     reading the code: the (+) ceiling mark drew on top of the score box's own
//     label; the Defect List's facts band drew its values at y=1866, below the
//     footer rule at 1858 and straight through "robograder.app"; and per-row
//     type sizing gave a list where one defect was 20px and its neighbour 34px.
//     The list now picks ONE size that fits its longest row.
//
//     Short lists are TOP-ALIGNED. Centring them was tried and is worse - two
//     defects floating mid-page with void above and below reads as a rendering
//     fault, where a gap below a short list just reads as the list having ended.
//
//     Cards hide both buttons entirely (Cards is shelved), as do sample books:
//     these images carry an RG-ID and read as a real assessment.
//
//     NOT YET RUN ON A PHONE. The headless pass proves the layout and that
//     nothing throws; it does not prove the native share sheet or that Firebase
//     Storage's CORS lets the covers onto the canvas in the real app.
//
//     ── AND TWO BUGS ──────────────────────────────────────────────────────
//
//     1. THE ADMIN WAS REPORTING AD SPEND THAT DOES NOT EXIST.
//     The summary read "Ads $34.73 24h" with BOTH ad accounts fully paused —
//     Google's own UI says "None of your ads are running" and both report $0.00
//     for today. admin/lib/ad_spend.js defined the 24h figure as "the value of
//     the latest daily row present". A paused account stops emitting daily rows
//     altogether, so that figure froze on the last day that actually spent money
//     and would have sat there indefinitely. It now reads TODAY's row, falling
//     back to yesterday's only while today has not been reported, and treats an
//     absent day as $0 — which is what an absent day means. The 7d and 30d
//     figures were never wrong: they are real rolling windows still carrying the
//     pre-pause spend, and they decay on their own.
//
//     2. CLEANING COMPARE COULD HAVE DESTROYED THE BEFORE SET ON DESKTOP.
//     The storage redirect added in 5.70 lives in runCropperSequence(), which is
//     the CAMERA path. With window._cameraSupported false — a desktop PWA, which
//     is exactly how a test from a prepared After image set gets run — tapSlot()
//     routes to the hidden file inputs instead and handleImages /
//     handleCornerImages / handleInteriorCoverImages wrote into the book's OWN
//     images, cornerImages and interiorCoverImages. That is the one thing this
//     feature must never do. All three now call _cleanHandleLibraryFiles() first
//     and return if it took the files. It disarms the flag on the way out, which
//     is the camera path's opposite and deliberate: there is no chain on the
//     library path, so a flag left set would redirect the next ordinary slot tap
//     too. retakeCleanSlot() re-arms it per tap.
//
// v5.70: CLEANING COMPARE IS FEATURE-COMPLETE AND UNTESTED ON HARDWARE.
//     The capture screen was the last missing piece. Ten Before photos down the
//     left, ten After slots down the right, paired and labelled; the assess
//     button stays greyed with an "n of 10" count until all ten exist, and the
//     2-credit no-refund charge is stated before the tap, not after.
//
//     THE DESIGN DECISION WORTH KEEPING: there is NO tenth camera `kind`.
//     The After photos must be shot exactly the way the Before ten were or the
//     comparison measures the photography rather than the cleaning — so the
//     capture reuses `main`, `corner` and `interiorCover` unchanged (same
//     guides, same macro focus, same orientation gates) and only REDIRECTS
//     WHERE THE RESULT IS STORED. One flag, three hooks: the chain, the storage
//     redirect in runCropperSequence(), and the opener.
//
//     That redirect is the dangerous part and it is why the flag is cleared
//     only AFTER every parked batch has been replayed: runCropperSequence reads
//     it, so resetting earlier would send the last batch into the book's own
//     image lists and overwrite the Before set — the one thing this feature must
//     never do.
//
//     _cameraChainNext() now covers main -> corner -> interiorCover in clean
//     mode, judging emptiness against cleanAfterImages rather than the book's
//     own photos (which are all already present). 20 cases pass, including that
//     normal-mode chaining is untouched.
//
//     NOTHING HERE HAS RUN ON A PHONE. The ASM 129 sets are the test:
//     calibration_books/ASM_129/ is Before, ASM_129/cleaned/*_Reimaged.jpg is
//     After. Run it end to end before it goes near a user.
//
// v5.69: CLEANING COMPARE — the client half. Still no entry point; the capture
//     screen is the last piece and nothing can start a run until it lands.
//
//     submitCleanAssessment() does four things: decides whether to offer the
//     feature (_cleanUnlocked, which REUSES _batchDeepRan rather than restating
//     the "a Deep RESULT exists" test, so the two cannot drift), freezes the
//     Before on the first run only, uploads the ten After photos under their own
//     clean_* storage slots so an After set can never overwrite the book's
//     originals, and hands URLs to api/assess_clean_run.js.
//
//     THE LIGHTS TELL THE TRUTH. The runner writes its stage to
//     users/{uid}/meta/clean_run after each step; the client subscribes with
//     onSnapshot and lights RUNNING MAIN and RUNNING DEEP on the real
//     transitions. That path is ALREADY owner-readable under the existing
//     Firestore rules, so this needed no endpoint and no rules change. Timed
//     lights remain as a fallback for when onSnapshot is unavailable — Matt said
//     those would be acceptable, so they are the fallback, not the plan.
//
//     AFTER BECOMES THE ITEM'S GRADE (decision 3) — written into the normal
//     grade / roboGrade / pageQuality fields so Catalogue, FMV and history pick
//     it up with no special cases, with Before preserved beside it.
//
//     TIER_OVERLAY_BG gains `cleaned`. Those URLs resolve against
//     raw.githubusercontent.com, so Progress_Overlay_Cleaned.webp must be in a
//     PUSHED commit before the overlay will load — on disk is not enough.
//
// v5.68: CLEANING COMPARE IS SERVER-ORCHESTRATED, and a Logs row now says whose
//     assessment it was.
//
//     (1) api/assess_clean_run.js (new). A run is Main -> Deep -> compare, and
//     those three calls now happen SERVER-side, modelled on
//     api/assess_batch_run.js, which already calls /api/assess and
//     /api/assess_deep over HTTP with the user's own auth header. The first
//     draft had the CLIENT make them in sequence, which is the wrong place: a
//     phone that locks or loses signal between call two and call three leaves
//     the user charged two credits with an After grade, no comparison, and
//     nothing to resume from.
//     Progress is written to users/{uid}/meta/clean_run after each step — a
//     path the existing Firestore rules already make owner-readable — so the
//     modal can light RUNNING MAIN and RUNNING DEEP on the real transitions
//     with no new endpoint and no rules change.
//
//     THE TRAP AVOIDED, because the obvious choice was the wrong one:
//     knownIdentity is NOT sent on the After Main. The book's identity really
//     is settled, so it looks made for this — but it selects the `main_ki`
//     cached prefix, a different entry that the keep-warm ping never warms.
//     Skipping identification saves about two cents; a cold prefix costs about
//     twenty-two. Sending it would have made every Cleaning Compare Main a
//     guaranteed cold write to save $0.02.
//
//     (2) `uid` is now stamped on the Main success timing row. The row carried
//     the book's title and its grades but nothing identifying the account, so a
//     logged assessment with no matching item — which happens whenever the
//     client never saved, or the user deleted the book afterwards — could not be
//     traced to anyone. Matt hit exactly that: two assessments in Logs with no
//     row in Items and no way to ask whose they were.
//
// v5.67: THE KEEP-WARM PING HAD NO TIMEOUT CONFIGURED.
//
//     api/cachewarm.js is the ONE endpoint the cron hits, and it was the only
//     model-calling endpoint missing from vercel.json's `functions` block —
//     assess 60s, assess_deep 60s, assess_full 60s, assess_clean 60s, probe
//     120s, batch_run 180s, and cachewarm on Vercel's DEFAULT (10-15s).
//
//     Why that is self-reinforcing rather than merely occasional: when the
//     entry is already warm the ping READS and returns fast, well inside the
//     default. When the entry has died the ping must WRITE 29,134 tokens, which
//     is the slow path — so the ping is most likely to be killed exactly when it
//     is most needed, records nothing, and leaves the entry dead for the next
//     fire to find. 60s now, matching every sibling.
//
//     The data that pointed here (status, 2026-10-19): prefixSha correct,
//     warmedPrefix present and correct on every row, gate working — and a
//     255-MINUTE GAP between paid pings with ZERO Main traffic inside it. The
//     maximum possible gap on a healthy */15 cron with quietMinutes 40 is 45.
//
//     ALSO: a failed ping used to return 500 and write NOTHING, so a run of
//     failures and a cron that never fired left an identical trace. The warm doc
//     now records lastErrorAt / lastError / lastErrorMs / totalFailures, and
//     mode=status returns them.
//
//     AND A CORRECTION TO HOW THIS HAS BEEN DESCRIBED: prompt caching is
//     WORKING. 31 reads to 4 writes is 88.6% warm. The problem is that 88.6% is
//     roughly the 87.4% baseline measured BEFORE any ping existed — so the ping
//     has been buying almost nothing while costing $3.69. "Cache warming isn't
//     working" is true of the PING, not of the cache.
//
// v5.66: BATCH'S 3 CREDITS ARE NOW COUNTED, and the rules know about the ledger.
//
//     (1) THE BATCH HOLE IN COST PER CREDIT (Matt caught it). Batch debits its
//     3 credits in its OWN transaction in api/assess_batch_start.js, bypassing
//     lib/credits.js, and its ten passes each write a timing row stamped
//     creditsCharged: 0 — correctly, because the passes cost nothing extra, the
//     batch paid up front. Net effect on 5.65's new figure: ten assessments'
//     worth of Anthropic spend in the numerator with ZERO credits under it,
//     inflating the cost of every other credit.
//     Matt's framing is the fix: "look at the cost of all 10 of those
//     assessments, some of which are very small, then divide that total by 3."
//     batch_start now writes a `batch_credits` row carrying the 3 credits and
//     costUsd: 0 — the money is already on the pass rows and double-counting it
//     would be the opposite error — plus a credit_events entry.
//     admin/api/stats.js now tallies credits from ANY row carrying them rather
//     than only cost-bearing rows, which is what had excluded that row.
//
//     (2) firestore.rules: credit_events added as Admin-SDK-only (deny all
//     client access), matching purchases / credit_adjustments / promo_redemptions.
//     THE RULES ARE NOT AUTO-DEPLOYED — paste into the Firebase console.
//
// v5.65: CROSS-TIER PRICING PARITY, and a cost-per-credit figure that is
//     actually cost per credit.
//
//     (1) NO TIER IS EVER A WORSE DEAL PER CREDIT THAN A CHEAPER TIER.
//     A customer on their fourth Comic Stack gets +60% — 8 credits for $10,
//     $1.25 each — while an unbonused Comic Wall sits at $1.50. Moving UP a
//     tier cost them MORE per credit, so the ladder meant to pull people
//     upward was pushing them down. A tier's level is now the greater of its
//     EARNED level (priors at that tier or higher, unchanged) and its PARITY
//     level: the lowest level at which its price per credit is no worse than
//     the best price available at any tier below it.
//     Reproduces Matt's three cases exactly — Stack +60% unlocks Wall 24 for
//     $30; Wall +80% unlocks Short Box 120 for $100; Wall +100% unlocks Short
//     Box 140 for $100, which is the customer he watched buy a sixth Wall.
//     A price rule, not a purchase count: the counts behind those three cases
//     are 3, 4 and 5, with no constant N that fits, because what really drives
//     each is where two price curves cross.
//     Resolved in ASCENDING TIER ORDER, which is the correctness condition and
//     not an optimisation — a monotonicity test caught the Short Box being
//     compared against the Wall's EARNED price and landing dearer than the Wall
//     it is supposed to be an upgrade from. 784 invariant checks in
//     test-repeat-bonus.mjs; nothing anyone has already earned can go down.
//
//     (2) "COST / CREDIT USED" WAS COST PER ASSESSMENT. Matt asked whether
//     refunded Deeps should raise the per-credit cost. They should, and the
//     dashboard could not answer it because nothing recorded how many credits
//     were actually consumed. Four leaks sat between the two numbers: refunded
//     Deeps, Batch (3 credits for 10 assessments), uncharged slab-checks and
//     probes, and the keep-warm ping. All four push the real figure UP.
//     New: `creditsCharged` on every grading timing row, a `credit_events`
//     ledger for server refunds, `deepRefundAt` on the item for the client-side
//     Deep no-raise refund, and `costPerCredit` = (all Anthropic spend in the
//     window + the ping's spend) / (credits charged − refunded). The ping is in
//     the numerator deliberately: it is supposed to pay for itself, and that is
//     only checkable if its cost sits in the same fraction as its saving.
//     Reports `coverage` and publishes nothing below 0.8 — the data starts now,
//     so early windows get a dash rather than a confidently wrong number.
//
//     (3) Admin card relabelled Cost / Credit, with per-assessment kept on a
//     sub-line. No new card, no tooltip.
//
// v5.64: CLEANING COMPARE — SERVER SIDE. api/assess_clean.js (new) plus the
//     clean* fields on an item. The client capture flow and results panel are
//     NOT in this version; nothing user-facing changes yet.
//
//     SHAPE: a run is TWO calls, not one. The client sends the 10 After photos
//     to /api/assess_deep exactly as an ordinary Deep (1 credit) and stores the
//     result under cleanAfterResult instead of the item's normal fields; then
//     it sends BOTH results, as data, to /api/assess_clean (1 credit) for the
//     comparison. Two credits total, one grader, called twice. Re-grading
//     inside assess_clean would have meant a second copy of the Deep pipeline
//     to drift from the first.
//
//     THE COUNTS ARE COMPUTED IN CODE, not by the model: resolved / survived /
//     introduced, whether restoration appeared, whether page quality moved more
//     than one tier. Those numbers go on screen beside the grades, so they must
//     be reproducible. The model writes prose only and is handed the computed
//     diff so it cannot contradict the screen.
//
//     DEFECT MATCHING, and the bug a test caught: defects are matched on
//     category + a normalised type, and the normalised key is TOKEN-SORTED.
//     Without the sort, "Back cover tanning" and "Tanning, back cover" produced
//     different keys and read as one defect resolved AND one appeared — the
//     feature lying in the most flattering direction available, on exactly the
//     ASM 129 back-cover tanning that is the reason the comparison exists.
//
//     ARCHITECTURE CORRECTED BEFORE SHIPPING (Matt). The first draft sent all
//     10 After photos to /api/assess_deep. assess_deep does not grade a book
//     from scratch and does not read 10 images — it takes the 4 macros, the 2
//     interior covers, ONE front cover and the reference/bracket images, and it
//     REFINES an existing grade via initialAssessment. The After set has no
//     prior Main, so seven of its ten photos would have gone unread. A run is
//     now THREE calls: /api/assess (4 main images, 1 credit), /api/assess_deep
//     (6 deep images + the Main result, 1 credit), /api/assess_clean (results
//     only, FREE). Two credits, as specified. assess_clean's CREDIT_COST is 0.
//
//     BATCH KEEPS ITS PANEL. Every scan sequence ended by sliding the progress
//     overlay away to reveal the front cover. For Batch that took FIVE grade
//     results off screen a beat after they arrived, to show a photo the user
//     had already seen. revealScannedPhoto() now returns early for kind
//     'batch', gated on the kind recorded at run time rather than on the caller
//     (both callers pass slotName 'front').
//
// v5.63: THE PING NOW OBEYS THE DASHBOARD, and three grading/UI fixes.
//
//     (1) CACHE WARMING — TWO WAYS IT COULD BURN MONEY WHILE DOING NOTHING.
//     api/assess.js has always read config/caching (the chips and the TTL
//     select in the admin header) to decide whether to send cache_control at
//     all and with which TTL. api/cachewarm.js read neither: it always sent a
//     1h ephemeral block. So:
//       - Main caching OFF  -> assessments send NO cache_control, there is no
//         entry in the world to keep warm, and the ping kept paying anyway.
//         The first ping after each expiry pays the WRITE price, $0.2331.
//       - TTL set to 5m     -> assessments write 5-minute entries, the ping
//         writes 60-minute ones over the top, and the */15 cron cannot reach a
//         5-minute entry at all. Every ping a write, every Main cold.
//     The ping now reads the same doc: it REFUSES TO SPEND while Main caching
//     is off, and it matches production's TTL (and only sends the extended-TTL
//     beta header on the 1h branch, as assess.js does).
//     lib/main_prompt_check.mjs used to ASSERT the bug — "both use a 1h
//     ephemeral cache_control" — so it passed happily throughout. It now
//     asserts that both resolve the TTL from the same config.
//
//     (2) mode=status IS NOW A DIAGNOSIS, not a log. It returns the live
//     caching config, the prefix sha, and a read/write/uncached tally over the
//     last 60 Main rows, plus a one-line verdict. "Is cache warming working"
//     is answerable from one free GET instead of from the Firestore console.
//
//     (3) TIER GRADE CEILING IS NOW ENFORCED ON THE SERVER. gradeCeiling
//     existed since S16 and was applied to the prompt text and to a clamped
//     COPY in the diagnostics — never to parsed.grade, the number the app
//     shows. A 4-photo Main could return and display 9.4 against a stated 9.2
//     ceiling. Same failure as the Deep returning 9.8, fixed the same way.
//
//     (4) DEEP CAPTURE IS ONE SESSION. The corner walkthrough used to end and
//     close the camera, leaving the user to find the Interior Front slot
//     themselves. It now chains into Interior Front/Back with a continuous
//     1-of-6 counter. Captures are parked per kind and replayed at finish,
//     because runCropperSequence() picks its image list from the kind.
//
//     (5) REFERENCE COVERS CAN BE ENLARGED. Tapping a ComicVine or hosted
//     reference scan opens it alone, pinch-zoomable, with no next/prev — it is
//     deliberately NOT in the reel of the user's own photos.
//
//     (6) api/probe.js WRITES A TIMING ROW (kind:'probe'). It spent real money
//     and logged nothing, which is the leading explanation for the ~$134 gap
//     between the invoices and the logged total over Sep 13 - Oct 11.
//
//     (7) Admin summary hover tooltips removed — they are invisible on a phone,
//     which is where the admin is read. The keep-warm write alarm now shows
//     inline as "warming 3w/10" when writes are high.
//
// v5.62: VARIANTS GET THEIR OWN FMV KEY. Plus share-text v3, Grading Date
//     removed, and the Android image-save fix.
//
//     (1) FMV, FINISHED. 5.61 stopped a variant taking the original printing's
//     value; this gives it somewhere to put its own.
//     KEY: _fmvKeyOf(title, issue, printing) now appends |<printing slug> for
//     an 'other'-class printing. base and channel (newsstand, direct edition)
//     keep the plain title|issue key and the static index value, per Matt:
//     "Base and Channel keep the FMV."
//     SLUG folds the spellings people type — "3rd Printing", "Third Printing"
//     and "3rd print" are one book and one key — but KEEPS parentheticals,
//     because "Facsimile Reprint (2019)" and "(1992)" are different books.
//     APP: an 'other' printing looks its variant key up in the manual overrides
//     and NOTHING ELSE. No curve yet means no FMV — blank, no message. Matt:
//     "An empty FMV is fine and much better than an incorrect one or a
//     long-winded excuse."
//     ADMIN: _catGroup splits each 'other' printing into its OWN catalogue
//     entry (labelled with a gold printing pill), so it appears in the two
//     "books with no FMV" worklists (fmvaz / fmvrank) as a book needing a
//     value. Previously the issue had a curve, so the issue looked done and the
//     variant was invisible. saveFmv/clearFmv write the variant key.
//     VERIFIED: the app's key builder and the admin's key builder were run side
//     by side over all 4,517 comics in the live export — 0 mismatches. They
//     MUST agree; a disagreement means an FMV entered in the dashboard never
//     reaches the app. 2,384 base keys, 135 variant keys now awaiting values.
//
//     (2) SHARE TEXT WAS STILL v1. buildListingSummary emitted
//     `Robograde: ${Math.round(rg.score)}` — so a shared assessment read
//     "Robograde: 95" while every surface in the app had shown 9.5 since v3.
//     Now uses RoboScoreV3.formatGrade, falling back to the v1 score only if
//     the engine is missing. Covers both share paths (public listing, and the
//     give-a-book notify text).
//
//     (3) GRADING DATE REMOVED from the edit form and the detail readout. It
//     meant the date CGC slabbed the book; nobody filled it in, and the
//     Robograde date already covers anything this app graded. The stored
//     slabbingDate field stays in COMIC_DATA_FIELDS so existing values are not
//     destroyed — it is simply no longer shown or editable.
//
//     (4) ANDROID COULD NOT SAVE IMAGES, and the reason is that both save paths
//     are no-ops there:
//       - navigator.share({files}) is Web Share Level 2. WKWebView implements
//         it, so iOS worked. A plain Android WebView does not — canShare({files})
//         returns false and the branch is skipped.
//       - the <a download> + blob fallback is ignored by Android WebView unless
//         the host app installs a DownloadListener. MainActivity does not. The
//         click does nothing, throws nothing, logs nothing. Silent, Android-only.
//     FIX: a Capacitor path between the two — Filesystem.writeFile to Cache,
//     getUri, Share.share. @capacitor/filesystem and @capacitor/share are both
//     already in capacitor.settings.gradle and file_paths.xml already exposes
//     cache-path, so no new plugin, permission or native code. The system sheet
//     is where "Save to Photos" lives.
//     NOT VERIFIED ON HARDWARE — there is no device in this session. Check it on
//     the Android build before telling the user it is fixed.
// v5.61: THE QUEUE — FMV printings/variants, Batch start-state, field reorder,
//     catalogue thumbnails, Watching sharing.
//
//     (1) FMV NO LONGER GIVES A VARIANT THE ORIGINAL PRINTING'S MONEY.
//     Reported on TMNT #1: a third printing was showing first-printing value.
//     The index is keyed title|issue and its curves are for the ORIGINAL
//     printing with the standard cover, but the only gate on `printing` was a
//     substring test for the literal words "facsimile" and "reprint". So
//     "3rd print", "Virgin variant", "Gold edition" and "UK pence variant" all
//     sailed through and took the first printing's curve.
//     NEW: window.fmvPrintingClass(printing) -> 'base' | 'channel' | 'other'.
//       base    empty, or an explicit first printing. Index value applies.
//       channel newsstand / direct edition. A DISTRIBUTION CHANNEL, not a
//               different book — and this distinction is load-bearing:
//               "Newsstand variant" is by far the commonest populated value
//               (566 of 4,527 items). Reading it as a variant would have
//               stripped the FMV off an eighth of every collection.
//       other   later printing, variant cover, facsimile, price variant,
//               special edition. No base value.
//     matchFMV returns { suppressed: true, printing } rather than null for
//     'other', because null already means "not in the index" and the two want
//     different words on screen. The Predicted Grade box now says the figure
//     for this issue is the original printing's and does not apply.
//     Swept against every distinct printing string in the live export: 3,819
//     base, 566 channel, 142 suppressed. 32 classifier cases asserted.
//     fmvTierOf returns 0 on a suppressed match, so the FMV routes into Deep
//     ($50+) and Full ($500+) close for a variant we cannot price. The
//     near-perfect route into Full is unaffected; a manual FMV entry restores
//     both. STILL OPEN: per-variant FMV *data* needs the index keyed by
//     printing as well as title|issue — schema plus admin, scoped separately.
//
//     (2) BATCH OPENED ON THE MAIN GRADE. Batch was the only pass that never
//     called _capturePrevAssessResult(), so it inherited whatever snapshot a
//     previous action left behind — and the Deep takes ITS snapshot BEFORE it
//     runs, which is the Main grade. Main, then Deep, then Batch, and Batch
//     showed the Main. It now snapshots at its own start.
//
//     (3) Date Acquired + Seller moved below the write-ups and the Assessment
//     History, above Cost Breakdown. Grading Date was not named in that
//     request and stays in the original transaction block.
//
//     (4) Admin catalogue lines view carries a front-cover thumbnail per entry
//     (26x39, 2:3, lazy). The stored `thumbnails` are inline blobs and
//     /api/export omits blobs, so the row uses images[0].url — the same field
//     admin/api/items.js already calls thumbUrl.
//
//     (5) WATCHING ENTRIES CAN BE SHARED. Was Owned only. Sold stays excluded:
//     the listing outlives the book and the link would misrepresent what you
//     have. One predicate, _publicEligibleOwnership(), now backs the per-book
//     toggle, both ownership-change paths, the bulk make-public action and the
//     bulk-state read, so they cannot drift apart. No server-side ownership
//     gate existed, so this is the whole change.
//
//     PROCESS NOTE, worth not relearning: index-ios.html and index-android.html
//     are GENERATED from index.html by make-ios-index.mjs / make-android-index.mjs.
//     Edit index.html and regenerate. Editing them directly is wasted work that
//     the next generate overwrites.
// v5.60: "(+)" ON THE RG SCORE BOX TOO, AND MOVED TO THE MIDLINE.
//     PG mark: vertical-align 0.9em -> 0.65em, so the parentheses sit on the
//     numerals' midline instead of against their cap height. Size unchanged at
//     0.33em of the grade digits. Still suppressed on the small list badge.
//     RG mark: scoreBox() gains an `o.plus` option, fed from the v3 engine's
//     existing ceilingHit && upsell. No new computation -- the engine has
//     reported both since v3 shipped, and the admin has been printing them as
//     "capped @ Deep (full can raise)" in words all along.
//     WHY RG NEEDS NO DEFECT TEST, unlike PG: ceilingHit means the subscores
//     SUMMED above this depth's cap. That is already direct arithmetic evidence
//     the book scored higher than this tier may award. The PG mark needs the
//     clean-defect-list condition because the PG ceiling is a flat tier cap
//     that a 4-image Main hits on any decent book.
//     PLACEMENT: absolutely positioned on the right-middle of the box, offset
//     by _nudge to sit on the NUMBER's midline rather than the box's. It does
//     NOT join the number. That layout exists specifically so the number stays
//     dead-centre whatever else is drawn -- PM owns the upper-right, the footer
//     the bottom, and the midline was free.
//     Wired on the 104px box in robograde-panel.js (Detail + Edit). NOT on the
//     56px list badges: at a third of a 36px numeral the mark is ~5px.
// v5.59: THE "(+)", THE COIN DROP, AND THE CACHE-WARMING ANSWER.
//
//     (1) "(+)" ON A GRADE THAT COULD GO HIGHER. Two conditions, BOTH required:
//     the pass landed exactly on its tier ceiling (Main 9.2 at 4 images / 8.5
//     below that; Deep 9.6), AND nothing worse than a LOW-severity defect was
//     found. The second condition is the whole point. The Main ceiling is a
//     hard tier cap, not a judgement -- a 4-image Main cannot exceed 9.2 however
//     clean the book is -- so at-ceiling ALONE would mark every decent-looking
//     book, including ones the Deep drops to 8.5, and "(+)" would come to mean
//     "you ran a Main". Requiring a clean defect list makes it mean what it
//     says. Server decides (`gradeAtCeiling` on the Main and Deep results);
//     the client only draws it. Full clears the flag -- it is the last pass and
//     has no deeper tier to promise.
//     RENDERING: a span at font-size 0.33em of .ubadge-num, so the parentheses
//     stand about a third the height of the grade digits, raised to sit against
//     the top of the numerals. Suppressed on the small list badge, where a third
//     of an already small numeral is not readable.
//     Persisted via COMIC_DATA_FIELDS. All three bundles.
//
//     (2) THE THREE BATCH COINS NO LONGER FADE. The single coin never touches
//     opacity: it disappears because .rg-coin-clip is overflow:hidden with its
//     bottom edge on the coin-slot Y-line. The 3-coin stack faded instead, and
//     it HAD to -- the coins sit at different heights (top: 88.8 - i*8.4%) and
//     the fixed 260%-of-own-height drop is only enough travel from the lowest
//     position. Measured against the production layout (577x1835, clip 73.13%,
//     coin 16.6%): coin 0 cleared, coins 1 and 2 did NOT -- they parked inside
//     the clip still visible, and the fade was the only way to hide them. That
//     is what read as "fading away before reaching the slot".
//     FIX: measure, do not guess. One pass at drop time reads each coin's real
//     distance from its own top edge to the clip's bottom edge, plus half its
//     height for the corners the rotation throws out. No opacity change at all
//     on the drop. The shortest drop takes COIN_DROP_MS and the others are
//     scaled to match, so all three fall at ONE speed (0.414 px/ms) instead of
//     the top coin being yanked down twice as fast over twice the distance.
//     Verified: 207px/500ms, 319px/771ms, 432px/1043ms, all clearing the slot,
//     last coin gone at 3113ms against a 3320ms first-photo wait.
//
//     (3) WHY MAIN CACHE WARMING WAS FAILING -- ANSWERED, from the mode=status
//     log that 5.58 made readable. Gaps between paid pings, newest first:
//     45, 44, 90, 165, 45, 60, 45, 45, 60 minutes. With a */15 cron and
//     quietMinutes 40 the maximum possible gap on a quiet stretch is 45. The
//     90 and the 165 are pings that never fired, and BOTH pings that followed
//     them were cache WRITES -- the entry had died. Those windows line up with
//     Batch/Card/Deep traffic, which is precisely the gate defect fixed in
//     5.57: rows that warmed a different prefix counted as Main touches and
//     turned the ping away.
//     THE ECONOMICS, now visible: 10 pings, 8 reads, 2 writes, $0.5133 total.
//     A read is $0.0059. A write is $0.2331. A MISSED PING COSTS 40x A TAKEN
//     ONE. That is the whole argument for the gate being conservative.
//     Also settled: the ping reads 29,134 tokens, which is the Main prefix --
//     so it has always been warming the right entry. Prefix mismatch is ruled
//     out for good.
//     NOT YET PROVEN: the two most recent pings are clean 45-minute reads,
//     which is the designed cadence, but that is two cycles on a quiet morning,
//     not proof. Re-read mode=status after a busy day before calling it fixed.
// v5.58: THE DEEP CEILING IS REAL NOW, and a (+) to say the grade can go up.
//     api/assess.js has advertised a 9.6 predicted-grade ceiling for the Deep
//     tier since S21. api/assess_deep.js had NO server ceiling and its PHASE 4
//     text told the model to grade a clean book "up to 9.8". The two files
//     disagreed and the prompt won -- which is how RG-ID 77H9H6, a Secret Wars
//     #8, took a 9.8 off a Deep with no Full ever run.
//     FIX: the Deep prompt now states 9.6 is the ceiling and says WHY (a Deep
//     sees corner macros and interior covers; it does not see staples, page
//     edges or structure -- 9.8 is evidence a Full gathers and a Deep cannot).
//     A server cap backs it up. The cap is the HIGHER of 9.6 and the incoming
//     grade, so a Deep re-run on a book whose Full already awarded 9.8 cannot
//     claw it back.
//     NEW FIELD: `gradeAtCeiling` on both the Main and the Deep result. True
//     means this pass went as high as it is allowed to go and the next tier can
//     go higher. It is what the app renders as the "(+)" in 9.6(+).
//     NOT CHANGED, because it was already right: Full is ALREADY unlocked on a
//     near-perfect book regardless of FMV. isFullEligible() in assess_full.js
//     returns 'near-perfect' for RG >= 9.5 or PG >= 9.6, and
//     isFullAssessmentEligible() in index.html does the same client-side. The
//     $500 / tier-6 gate is the OTHER route in, not a precondition.
//     BUGFIX: 5.57 shipped mode=status unreachable. The GET whoami guard
//     returned early for any mode that was not 'warm', so GET
//     /api/cachewarm?mode=status answered with the whoami payload and the
//     status block never ran. 'status' is now allowed through.
//     CLOSED: the cache hypothesis from 5.57 is WRONG. Tested directly against
//     the API on 2026-10-17 with a throwaway prefix: a request WITH
//     thinking:{type:'adaptive'} reads a cache entry written by a request
//     WITHOUT it (write 48,422 -> read 48,422 -> read 48,422). Extended
//     thinking does not participate in the cache key, so the ping and
//     /api/assess do share an entry and that is not why Mains were cold.
//     Still unexplained; read mode=status for the ping cadence once deployed.
// v5.57: THE 9.5 THAT WASN'T A GRADE, and two cache-warming defects.
//
//     (1) PG 9.5. Reported on RG-ID TKRHZY, Marvel Super Heroes Secret Wars #8:
//     RG 9.5 AND PG 9.5. RG 9.5 is fine -- v3 is a half-point 0-10 scale. PG
//     9.5 is not a grade any service issues; above 9.0 the CGC ladder steps
//     9.0, 9.2, 9.4, 9.6, 9.8.
//     MECHANISM: the output schema never named the legal set. api/assess.js
//     said `"grade": "CGC grade estimate e.g. 7.0"` and assess_deep.js said
//     `"grade": "revised CGC grade"` -- free text, no ladder. The ladder
//     appeared only in the descriptive tier definitions far upstream. So the
//     model had a v3 value of 9.5 in hand on a scale where 9.5 is legal, and
//     a PG field with no stated constraint, and wrote the same number twice.
//     FIX, at the source: all three passes now spell out the 25 legal
//     positions in the "grade" field spec, state that 9.1/9.3/9.5/9.7 are not
//     grades, and say explicitly DO NOT COPY THE v3 RoboGrade VALUE INTO THIS
//     FIELD, with the reason.
//     NET UNDER IT: enforceCgcGrade() in lib/grade_definitions.js, beside the
//     CGC_GRADE_SCALE that was already there. It is a last resort, not the
//     fix, and every firing logs [grade-offladder] naming the pass -- if that
//     line ever appears, the prompt has drifted and the prompt is what to fix.
//     Also fixed in passing: in assess_full.js an unparseable grade with no
//     predictedGrade fallback hit Math.min(null, 9.9) === 0 and would have
//     published a 0.0 grade with a roboScore of 0.
//
//     (2) THE BATCH MAIN WAS SUPPRESSING THE KEEP-WARM PING. There are two
//     Main cached prefixes: the ordinary one (_ki === null, what every
//     app-initiated Main sends and what the ping warms) and the _ki variant
//     that assess_batch_run.js sends with a settled identity. DIFFERENT cache
//     entries. v5.55 stamped both `warmedPrefix: 'main'`, so a Batch Main
//     counted as proof the ordinary entry was warm and turned the ping away --
//     the Card-assessment defect from v5.55, one layer down. assess.js now
//     stamps 'main_ki' for the Batch variant, the gate counts 'main' only, and
//     the pre-2026-10-16 token-count fallback applies only to rows with no
//     warmedPrefix at all (it would otherwise re-admit 'main_ki', whose cache
//     tokens are also > 20,000).
//
//     (3) THE CRON NO LONGER DEPENDS ON A QUERY STRING. vercel.json pointed at
//     "/api/cachewarm?mode=warm", so the feature rested on that query string
//     surviving into the function; if it did not, the request fell through to
//     Firebase auth, 401'd, and nothing said the ping had stopped. Path is now
//     bare and a credentialed cron hit with no mode is the ping.
//
//     (4) NEW: GET /api/cachewarm?mode=status. Any signed-in user, spends
//     nothing, calls no model. Returns cache_warm/main: lastWarmAt,
//     minutesSinceLastPing, all-time totals, the 30-day per-ping log, and the
//     gaps in minutes between consecutive paid pings.
//     STILL OPEN: ordinary Mains were cold at 18:35 and 20:25 local on
//     2026-10-16 with the ping reporting healthy, and neither (2) nor (3)
//     explains those -- the Batch ran AFTER the 20:25 Main. Leading untested
//     hypothesis: the ping sends no extended-thinking config and /api/assess
//     does, so they may not share a cache entry at all. Test before believing.
//
//     OPEN QUESTION FOR MATT, not changed here: api/assess.js sets a predicted
//     grade ceiling of 9.6 for the Deep tier, but api/assess_deep.js has no
//     server ceiling and its PHASE 4 text tells the model to grade a clean
//     book "up to 9.8". That is why RG-ID 77H9H6 took a 9.8 off a Deep with no
//     Full. The two files disagree; one of them is wrong.
// v5.56: KEEP-WARM PING SPEND IS NOW VISIBLE. Admin + cachewarm only.
//     The ping spends real money and writes NO assessment_timings row, so it
//     was invisible to every cost figure on the dashboard -- a cent at a time,
//     forever. Matt asked for it as its own line under API, which is the right
//     shape: the saving is only worth claiming if the cost of claiming it sits
//     beside it.
//     api/cachewarm.js now keeps running totals (totalCostUsd, totalPings,
//     totalReads, totalWrites) plus a 30-day rolling log at cache_warm/main,
//     trimmed on write so the doc cannot grow without bound.
//     admin/api/stats.js reads it; the Spending box shows an indented
//     "warming" line under API with 24h / 7d / 30d.
//     THE HOVER CARRIES THE ALARM: a healthy ping READS an existing entry. If
//     writes are more than ~25% of pings, the prefix the ping sends no longer
//     matches what /api/assess sends and it is paying 2x input to warm an entry
//     nobody uses. That is the failure mode to watch, and it is now watchable.
// v5.55: **WHY MAIN CACHE WARMING WASN'T WORKING.** Found 2026-10-16 from
//     Matt's report of two cold Mains: Captain Marvel 4 at 03:03 local
//     ($0.301) and Uncanny X-Men 234 at 06:17 ($0.285).
//     The ping was running fine -- minutesSinceLastPing came back at 30. The
//     TRAFFIC GATE was the problem. It took the single most recent row from
//     assessment_timings as proof the Main cache was warm. But Deeps, CARD
//     assessments, slab-checks and Batch passes all write rows there and NONE
//     of them warms the Main prefix. Three Card assessments at 08:37 (visible
//     in the logs as cacheRead 16,565 rather than Main's 29,135) made the gate
//     skip ping after ping; the Main entry expired on schedule and the next two
//     Mains paid full cold price.
//     FIX, two halves:
//       (1) api/assess.js stamps `warmedPrefix: 'main'` on the timing row
//           whenever it actually sent Main cache_control.
//       (2) api/cachewarm.js scans the last 40 rows and gates on the most
//           recent MAIN-warming row, not on any row. Scanned client-side so no
//           composite index is needed; falls back to the cache-token counts for
//           rows written before today, since only a cached Main carries >20k.
//     This was a design error in 5.49, not a deploy problem. The gate was
//     written as "has anything happened recently" when the question is "has the
//     MAIN PREFIX been touched recently".
// v5.54: **THE KEEP-WARM PING WAS RACING THE CACHE EXPIRY AND LOSING.**
//     The ping worked in isolation (the two-call test passed) and still failed
//     in production. Why: the cron fires every 15 minutes, so the only
//     achievable ping intervals are multiples of 15. With the quiet gate at 50
//     minutes the T+45 fire was turned away (45 < 50) and the first one that
//     passed was T+60 -- exactly the cache TTL. Every ping was arriving at the
//     moment of expiry and about half of them lost the race.
//     MEASURED 2026-10-12: /api/cachewarm reported minutesSinceLastPing = 56,
//     and a real assessment 1h25m after the previous one paid the full cold
//     $0.296. Both consistent with a 60-minute ping cadence, not 50.
//     FIX: quietMinutes default 50 -> 40, so the T+45 fire passes and the ping
//     cadence is 45 minutes with 15 minutes of headroom inside the hour.
//     If the cron interval ever changes, re-derive it: the gate must sit
//     strictly between one cron tick and (TTL minus one tick).
// v5.53: FAILURE DIAGNOSTICS. Admin + logging only; no grading or prompt change.
//     (1) Removed the warning marker added to the Spending box in 5.51. It was
//         a hover tooltip, which does not exist on a phone, on a screen Matt
//         has said twice is already too crowded. The spend-window truncation
//         FIX from 5.51 stays; only the UI nag is gone.
//     (2) NEW: admin/api/failure_audit.js — a ONE-TIME diagnostic, deliberately
//         not wired into the dashboard. GET /api/failure_audit[?days=30] pages
//         the whole assessment_timings collection and returns, per kind
//         (main/deep/slabcheck): success and failure counts, failure rate,
//         mean COLD and WARM cost measured from the data, and an estimated
//         cost of the failures. Plus why they failed, by version, and by image
//         count. Failure cost cannot be measured — error rows carry no usage
//         object — so each failure is priced at the mean cost of a cold
//         successful run of the same kind, from this account's own numbers.
//     (3) Failure records now say HOW the call got there: lib/anthropic_retry.js
//         fills a `stats` object with { attempts, lastStatus, retried,
//         waitedMs } and api/assess.js logs attempts / upstreamStatus /
//         retryWaitedMs on BOTH the success and the error path. A 50-second
//         failure used to look identical whether it was one slow call or three
//         429s plus backoff.
//     CORRECTION to the 5.51 note: "retries bill twice and only the final usage
//     is captured" was wrong. anthropicWithRetry only retries 429 and 529, which
//     are rejections Anthropic does not bill, and it already refuses to retry
//     when the wait would not fit the deadline. Retries are not part of the gap.
// v5.52: CRON_SECRET IS NO LONGER REQUIRED, timed-out runs stop logging as free,
//     and the Catalogue gets a one-line-per-assessment view.
//     (1) **CRON_SECRET optional.** Vercel rejects an env var with leading or
//         trailing whitespace at BUILD time, and an invisible newline from a
//         paste failed three deploys in a row -- guarding an endpoint that
//         spends one cent and writes nothing. Both sides are now trimmed, and
//         if no secret is set the cron authenticates on Vercel's own cron
//         user-agent. Spoofable, and it does not matter: the worst anyone can
//         do is keep our prompt cache warm at our expense, gated to about once
//         an hour. DELETE the CRON_SECRET variable in Vercel and the deploy
//         will go through.
//     (2) **Errored/timed-out assessments no longer record costUsd: 0.** The
//         old comment claimed "the API never returned (no tokens billed)".
//         False for a timeout: Anthropic has already received the prompt and
//         all four images, processed them, written or read the cache and begun
//         streaming by the time we abort at 55s. A timed-out Main costs about
//         what a cold successful one costs. It now records an ESTIMATE flagged
//         costEstimated, deliberately a floor (prefix priced as a cache read,
//         output ignored).
//     (3) **Catalogue issue screen: compact line view, now the default.** One
//         row per assessment -- RG, PG, level, Grade ID, date, user name,
//         4-char user code -- sorted RG descending with PG descending as the
//         tie-break. ASM 129 has 31 copies and the card view made finding one
//         a scroll. 'cards' is still there in the View dropdown.
// v5.51: **THE DASHBOARD'S 30-DAY API SPEND WAS TRUNCATED.** Admin only; no
//     grading change, no prompt change.
//     Matt's Anthropic invoices for Sep 13 - Oct 11 (28 days) total $526.15.
//     The dashboard read $254.48 for 30 days. Cause found in
//     admin/api/stats.js: the day/week/month spend sums came from a single
//     `.limit(2500)` read of assessment_timings. EVERY call writes a row -
//     assessments, slab-checks, errored runs, all five passes of a Batch, and
//     all 84 passes of a calibration round - so once more than 2500 rows land
//     inside 30 days the month window stops partway through the month and
//     reports a smaller number with nothing to show it is short. (The ALL-TIME
//     figure was already exact; it uses a paginated rollup. Only the windows
//     were capped.)
//     FIX: the window now pages back until it genuinely crosses the 30-day
//     cutoff, ceiling 30,000 rows, and sets `truncated` if it ever hits the
//     ceiling. The Spending box shows a warning marker on the API line and
//     explains it on hover.
//     ALSO SURFACED: `zeroCost` counts rows logged at $0.00. Those are NOT free
//     calls - an errored or timed-out run still billed Anthropic for every
//     input token it had already sent, and it is recorded as free. This is
//     expected to be a second, separate chunk of the gap.
//     NOT YET EXPLAINED: whether truncation + zero-cost rows account for the
//     whole 2x. Retries inside anthropicWithRetry bill twice and only the final
//     usage object is captured, and a hard Vercel timeout kills the function
//     before the log row is written at all - spend with no row whatsoever.
//     See QUEUE_READ_THIS_FIRST.md section 6.
// v5.50: **THE LOGGED COST WAS WRONG ON OPUS 5.5.** No grading change.
//     Anthropic's cache-READ price is not the same fraction of input on every
//     model: Opus 5 reads at $0.50/M against $5 input = 0.10x; Opus 5.5 reads
//     at $0.20/M against $4 input = **0.05x** (verified against Anthropic's
//     published pricing 2026-10-11, not from memory).
//     api/assess.js hardcoded 0.10 and api/assess_deep.js / assess_full.js
//     hardcoded 0.05, so exactly ONE of them was right at any given moment and
//     the Opus 5.5 cut-over flipped which one. Since 5.47, every WARM Main has
//     been logged about $0.004 too expensive (~4% on a $0.10 assessment).
//     Cold assessments were unaffected -- the 2x write multiplier is right on
//     both models -- so the $0.296-$0.315 figures from the cut-over night are
//     accurate.
//     FIX: lib/model.js now carries cacheRead / cacheWrite5m / cacheWrite1h
//     PER MODEL, plus one `costOf(usage, model, ttl)` helper. assess.js,
//     assess_deep.js, assess_full.js and cachewarm.js all call it. The
//     arithmetic now exists in exactly one place.
//     STILL NOT VERIFIED: nobody has ever reconciled the admin's API spend
//     against the real Anthropic invoice. The dashboard's "API" line is the sum
//     of these estimates, not billing data. See QUEUE_READ_THIS_FIRST.md.
// v5.49: KEEP-WARM GATE FIX. 5.48's ping gated on real assessments only, and a
//     ping does not write to assessment_timings — so on a quiet night EVERY
//     cron fire would have seen "no traffic in 50 minutes" and paid. At a
//     15-minute cron that is four paid pings an hour instead of one. The ping
//     now records its own timestamp at config/cache_warm/main and the gate
//     takes the LATER of (last assessment, last ping). Caught before it ever
//     ran -- 5.48 shipped without CRON_SECRET set, so every cron fire 401'd and
//     spent nothing. Frequency is now harmless by design: fire every 15
//     minutes, pay about once an hour, and a failed fire retries in 15 minutes
//     instead of leaving the cache to die for an hour.
// v5.48: KEEP-WARM PING. No grading-rule change -- the prompt TEXT is identical
//     to 5.47, it just lives somewhere else now. Ships on top of the 5.5
//     cut-over; the two are independent and 5.47 should be confirmed first.
//     (1) The whole cached prefix of the Main prompt moved out of the handler
//         in api/assess.js into **lib/main_prompt.js**, along with
//         CGC_GRADE_TIERS, CGC_MULTI_DEFECT_RULE and gradeTierContext().
//         VERIFIED BYTE-IDENTICAL: all 269 prefix lines were diffed against
//         shared/_WORKING/PROMPT_ASSEMBLED_5.42_partial.txt -- 218 exact, 47
//         blank, 4 new since 5.42 (X1's two additions, CHECK 1b, and the
//         K1-modified rule), and **zero indentation-only differences**, which
//         is the signature the move could have left and did not. The 16,253-
//         character tier ladder appears verbatim in the rendered prefix.
//         Rendered prefix: 77,571 chars, sha256 388d3b2bdebc06f2...
//     (2) api/cachewarm.js gained **mode:'warm'** -- the production ping. It
//         sends the REAL prefix (buildMainPrefix(null), the variant every
//         ordinary Main produces; only assess_batch_run.js sends knownIdentity).
//         Traffic-gated: returns free, with no model call, if a Main ran in the
//         last 50 minutes. Fails OPEN -- if the gate read throws it warms
//         anyway, because a missed ping costs more than a wasted cent.
//         Authenticates by Firebase token OR by CRON_SECRET, the latter only
//         for mode:'warm'.
//     (3) **lib/main_prompt_check.mjs** -- costs nothing, calls no model, and
//         asserts assess.js and cachewarm.js still send the same bytes.
//         RUN IT AFTER ANY PROMPT EDIT.
//     NOT DONE HERE: the Vercel cron entry. Ping by hand once, confirm it says
//     READ, then add the schedule. See QUEUE_READ_THIS_FIRST.md.
//     WHY: 12.6% of Mains run cold on an ordinary day (91% on a deploy day), a
//     cold Main costs $0.3148 against $0.0925 warm, and reads DO refresh the
//     TTL (verified 2026-10-05). Worth ~$27/month, and worth MOST overnight --
//     03:00-05:00 ET run 47-52% cold against 9-11% at the 19:00 peak. Do not
//     make the ping sleep at night.
// v5.47: **OPUS 5.5 CUT-OVER.** The grading model changes. Expect mid-range
//     grades to come in about 0.7 higher than 5.46; that is the known, accepted
//     cost of the switch and not a regression. Four changes, one deploy:
//     (1) PRIMARY_MODEL -> 'claude-opus-5-5'. The reason is TAPE: Opus 5 named
//         tape in 0 of 81 passes across production and eval, including 0 of 6
//         on a book with an obvious tape pull and the tape-pull instructions in
//         front of it. 5.5 names it. Cost is NOT the reason ($24/mo, noise).
//     (2) K1 promoted into the prompt: LIGHT-ACCUMULATION-ACROSS-FACES Front
//         cap 37 -> 30, stated band 6.0-7.5 -> 4.5-6.0. This pulls 5.5's
//         mid-grade books back down (+0.802 -> +0.702 vs Opus 5). It is the
//         only one of six tested arms that ever moved the number.
//         **REVERTING THE MODEL WITHOUT REVERTING K1 WILL PUSH OPUS 5 TOO LOW.**
//     (3) X1 promoted into the prompt: referenceComparison must now RECONCILE
//         against the model's own defects array (it contradicted itself in 170
//         of 201 assessments -- 85% -- listing tape/tear/paper loss and still
//         saying "cover matches the reference"), plus a new CHECK 1b defining a
//         tape pull, which had no definition anywhere in the prompt. Targeted
//         round 2026-10-10 on FF Annual 2: Opus 5.5 named the tape pull 6/6 at
//         High severity and the comparison named it 6/6; Opus 5 found it 0/6
//         and said "cover matches" 6/6. Zero false positives on ASM 55 / ASM 64
//         across 24 passes. Both edits sit in the CACHED PREFIX -- caching and
//         the cache-variant count are unchanged.
//     (4) Admin caching toggle now confirms before changing state, in BOTH
//         directions. It was switched off by a mis-tap once and every Main cost
//         ~$0.21 instead of ~$0.09 until the cost drift was noticed. No visual
//         change to the admin header -- the dialog is the whole fix.
//     WATCH AFTER DEPLOY: tape should appear in roughly 13% of assessments
//     where it was 0%; mid-grade grades visibly rise. MFC 65 (CGC 7.0) is the
//     standing regression check -- 5.46/Opus 5 graded it 5.00, 5.5 grades 7.33.
// v5.30: HOTFIX — 5.29 SHIPPED BROKEN. Deploy this immediately over it.
//     A backtick inside a COMMENT in scan-animation.js's CSS block terminated the
//     template literal that block lives in. Everything after it became executable
//     expressions, so the module threw at LOAD time, window.RobograderScan was
//     never assigned, and every assessment died at
//     `mountStepTracker: scan-animation module not loaded`. No crash, no error
//     dialog — assessGrade() opens with a silent `if (assessing) return`, so the
//     app just stopped responding to Assess.
//     **`node --check` PASSED IT.** The file was still syntactically valid; it
//     only failed when run. This is the third time a parse check has given a
//     false pass on this codebase (print-label.js parsed as CommonJS; a const
//     reassignment in robograde-panel.js). PARSE CHECKS ARE NOT VERIFICATION.
//     Added `scan_load_test.js` — it EXECUTES scan-animation.js in a stubbed DOM
//     and asserts all 15 exports are present. Run it after any edit to that file.
//     Rule now written into the CSS block itself: never put a backtick in there,
//     not even to quote a class name in a comment.
// v5.29: FOUR FIXES FROM MATT'S FIRST TEST PASS. No grading-rule change except
//     (2), which RAISES a cap rather than altering judgement — 5.26-5.29 still
//     pool, but expect slightly longer defect lists on heavily-defected books.
// (1) END-OF-SCAN REVEAL: the cover SLID into place as the progress modal slid
//     away. It should already be there, with no movement of its own. The reveal
//     was reusing `.in-view`, the ANIMATED mid-scan arrival from translateX(-100%).
//     New `.reveal-now` seats it with transition:none, the element is built in
//     place rather than off-screen left, and it is seated BEFORE the modal starts
//     moving — doing it after left one frame with the modal travelling and the
//     cover not yet arrived.
// (2) DEEP'S DEFECT CAP WAS TIGHTER THAN MAIN'S — 10 against Main's 13. On a
//     heavily-defected book Deep therefore had to silently DROP three findings
//     the Main pass had already made, which is one way a real defect disappears
//     between passes. Matched to 13, with Main's consolidate-don't-discard rule
//     and an explicit instruction never to drop a STRUCTURAL defect (tape,
//     missing piece, tear, spine split, water damage, rust migration) to make
//     room — consolidate cosmetic wear instead.
// (3) GRADE REVISION IS A NOTE, NOT A WRITE-UP (Matt: 7 lines; 4 is plenty). The
//     prompt now caps it at 2 sentences / 35 words and forbids re-listing defects
//     or showing grade arithmetic. The client trims an over-long one at a
//     SENTENCE boundary rather than mid-word — a truncated explanation in a box
//     whose only job is to explain reads worse than no box.
// (4) A PAGE-QUALITY ROW SHOWED SEVERITY "LOW" IN THE APP and nothing in admin.
//     Page quality is an observation, not a defect, and carries empty severity by
//     design — but when the model omitted the key entirely the panel's null
//     fallback invented LOW. Suppressed for page-quality rows outright.
// v5.28: BINDING DECIDES WHICH FULL-ASSESSMENT PHOTOS WE ASK FOR.
//     Grading rules unchanged — this changes which SLOTS are requested, so
//     5.27 and 5.28 grade data pool freely. But Full image COUNTS now vary
//     (3 / 5 / 6), so any analysis keying off "6 interior images" must change.
// (1) THE PROBLEM. Full's interior staple shot requires opening the book to the
//     centerfold. Full is offered mainly to confirm a perfect 10 — so we were
//     asking the owner to crack the spine on the one book least able to take it.
//     And on books with no staples we were asking for three photos of nothing.
// (2) THREE BINDINGS, NOT TWO (Matt). The 1960s–early-80s square-bound giants
//     DO have staples: driven UP through the last interior page and folded down
//     on the first, with glue holding the cover wrap. They cannot be photographed
//     without forcing the covers wide open. They also produce a characteristic
//     defect — a bump or exposed metal where the staple presses through a cover.
//     Evidence and catalogue figures: shared/_LIBRARY/BINDING_STAPLES_VS_GLUE.md.
//       saddle  stapled through the fold  -> 6 slots (unchanged)
//       square  hidden internal staples   -> 5 slots; interior macro dropped, the
//               two exterior slots re-aimed at cover penetration
//       none    glued or sewn             -> 3 slots
//     "none" puts a whole book at 4 Main + 6 Deep + 3 Full = 13 images, with the
//     single centerfold interior shot the only one requiring it to be opened.
// (3) THE MAIN PASS DECIDES, from the 4 Main images and chiefly the SPINE photo
//     (api/assess.js BINDING rule). Format and date are TIEBREAKERS ONLY, and
//     only once the spine photo has established the spine is flat: flat-spined
//     thick book before 1982 -> square; 1986 on -> none; 1982-85 -> prefer square.
//     A folded spine is saddle whatever the date — modern standard issues are
//     still stapled. Emits binding / bindingBasis / bindingConfidence; a LOW
//     confidence answer is discarded and the saddle default stands.
// (4) STORAGE DID NOT CHANGE. interiorImages stays a fixed 6-long array indexed
//     by FULL_SLOTS order, with nulls in dropped positions, so every existing
//     item stays readable and every index stable. Only which slots are shown,
//     required, captured, placed and submitted varies. The placement overlay is
//     compact (3/5/6) and scatters back through the index map — writing it
//     positionally would land Outer Edge in a staple slot on a 3-slot book.
// (5) SERVER validates against the slotKeys actually sent (known, no duplicates,
//     the three structural slots always present) instead of a hard count of 6,
//     and tells the model WHICH slots are absent and why. On a square-bound or
//     glue-bound book it is explicitly forbidden to report a staple as missing,
//     popped or absent, and must state in the write-up why staple close-ups were
//     not required — otherwise a user who has seen those slots on other books
//     will think something is broken.
// (6) OPEN: the two exterior slots still show the SADDLE-BOUND ghost images on a
//     square-bound book, which is wrong guidance. Matt is generating two
//     square-bound ghosts; tracked in TASKLIST.
// v5.27: RESTORATION INFERRED BY THE GRADING PASS NOW REACHES THE SCREEN.
//     No grading-rule change — display and persistence only, so 5.26 and 5.27
//     grade data POOL FREELY.
// (1) roboGrade.restorationFlags has been produced by assess.js's RESTORATION
//     INFERENCE rule and stored on every graded item all along (roboGrade is
//     persisted whole) and was rendered NOWHERE. The Restoration Assessment
//     section was gated on the UV Check alone, so a book the grader believed was
//     restored looked identical to one nothing had ever been said about. Detail
//     view now opens that section when EITHER source has something, and labels
//     which is which: "Noted during grading" (ordinary light, a suspicion) above
//     "UV Check" (a blacklight finding). They are never merged, and a grading
//     flag deliberately does NOT set restorationFlag or
//     restorationHighConfidence — those drive the RESTORED badge and the public
//     listing and must keep meaning "the UV pass found something." When only the
//     grading pass flagged it, the box says so and points at the UV Check.
// (2) Same list surfaces in Edit as a read-only "Restoration Noted During
//     Grading" box, beside the existing UV Check box.
// (3) BUG: formData.restorationFlag was assigned UNCONDITIONALLY from the
//     assessment response. A Main or Deep response carries no restorationFlag at
//     all, so running one after a failed UV check silently reset the book to
//     false while the UV report text beside it (guarded by an `if`) survived —
//     the badge and the report disagreed. Now only written when the response
//     actually carries the key.
// (4) RESTORATION IS NOW COLLECTED FROM EVERY PASS, AND NEVER RETRACTED. Each
//     depth sees a different class of it — Main: glue, structural-support tape,
//     obvious amateur colour touch. Deep: leaf casting and added/replaced pieces,
//     seen from the interior covers. Full: replaced or reset staples, trimming,
//     married pages. UV: colour touch, and only colour touch. assess_deep.js and
//     assess_full.js now emit restorationFlags with guidance aimed at what THAT
//     pass can actually see, and both are told to flag only when confident and
//     NEVER to state or imply a book is unrestored — an empty array means
//     "nothing seen here", never "nothing there". A UV Check that comes back
//     clean likewise proves nothing; only a positive UV result is conclusive.
// (5) BUG, and the reason (4) was not optional: Deep returns a whole roboGrade
//     and the client adopted it WHOLESALE, so a Deep pass silently ERASED
//     whatever restoration the Main pass had recorded. mergeRestorationFlags()
//     unions prior + incoming (case-insensitively, prior first) on every
//     adoption. The list only ever grows; a later pass not re-stating an earlier
//     finding is not a retraction, because no pass can establish absence.
// (6) Full returns no roboGrade — it patches the existing one — so its
//     restorationFlags arrive top-level and are merged in by the Full handler.
//     Full is the only pass that can see replaced staples or trimming, so
//     dropping them would have lost the finding entirely.
// (7) sync-version.mjs (NEW, root). lib/version.js is the single source of truth
//     for the SERVER, but the browser cannot import it — index.html and
//     public.html are static, with no build step — so each carried a hand-typed
//     mirror, and hand-typed mirrors drift: index.html sat at 5.16 against 5.21,
//     public.html at 5.25 against 5.26, and index.html's appVersion — the number
//     STAMPED ON EVERY TIMINGS RECORD from the PWA — was still 4.57. The S22 fix
//     added injection to the native generators, which is why the store builds
//     never drifted; it did not cover the web. Now: `node sync-version.mjs 5.28`
//     bumps version.js and stamps all four mirrors, and `--check` fails loudly
//     if any is adrift. A mirror pattern that stops matching FAILS the run
//     rather than being skipped.
// (8) IMAGE VIEWER IS ONE REEL. The lightbox held Main + reference covers + Deep
//     macros + Full, and every other group had its own opener building a private
//     little list — so tapping a signature let you cycle the signatures and
//     nothing else, an interior cover cycled the two interior covers and stopped,
//     and the interior covers were missing from the main cycle entirely. Six dead
//     ends where the user expects one reel. Now one list in shooting order:
//     MAIN 4 -> DEEP 6 (4 corner macros + 2 interior covers) -> FULL 6 ->
//     Signature -> UV -> Coupon -> Insert -> Missing. Every opener lands on its
//     own frame inside that list. REFERENCE COVERS ARE NOT IN IT (Matt): nobody
//     wants to examine a reference scan up close. Same in the admin viewer,
//     where the two reference cells no longer open the lightbox at all — the
//     assessed covers beside them still do, landing on the right frame.
// (9) PAGE QUALITY ROW. 5.21 stripped the location and left a bare "Page
//     Quality", which says less than what it replaced. The useful token was never
//     in d.location — it is rg.pageQuality. The row now reads "Page Quality -
//     Off-White to White", falling back to the entry's own fields for records
//     written before the canonical call was stored.
// (10) REFERENCE-COVER LAYOUT IN DETAIL, GATED ON DEEP. Three cases, matching
//     the admin viewer: no reference -> unchanged; ComicVine front only ->
//     Front | ComicVine, then Back | Interior (interior at half width, stretched
//     to the back cover's height), then Spine; local front+back -> Front | Ref
//     Front, Back | Ref Back, then Interior, then Spine. The local pair wins when
//     both exist. GATED because the reference images are fetched during Main but
//     the comparison only happens in DEEP — Main cannot use them (the pipeline
//     does not allow it, and making it would slow the one pass that must feel
//     fast). Showing a reference after a Main-only run would claim a check that
//     did not happen. Not applied to the public link (buyers do not care what a
//     reference cover looks like) or to Edit (Edit is for making changes).
// (11) BATCH ANNOUNCEMENT in Detail — the same card as the DEEP announcement,
//     taking the slot the Deep card vacates. The Deep badge shows only while the
//     book has no corner macros, and isBatchEligible() requires a completed Deep,
//     so the two can never both appear; the Batch card then disappears for good
//     once a Batch has run (hasBatchRun() reads the _batch entry in
//     assessmentHistory, so there is no separate flag to drift). Whole card is
//     the click target and routes to #batch-section in Edit, where the control
//     lives; the button is inert. Two stars, matching how a Batch reads in
//     Assessment History. The 5 / 10 / 3 come from BATCH_N and
//     BATCH_CREDIT_COST, so changing a constant cannot leave the copy lying.
// (13) GOLD IS RESERVED FOR PERFECT-10 SCORE BOXES (Matt). Batch was drafted in
//     gold and is now on the DEEP palette — in Detail and on both buttons in the
//     Edit section. The only gold left outside the score box is the FULL
//     ASSESSMENT card and its button, which is consistent rather than an
//     exception: Full exists to confirm a perfect 10. Do not introduce gold
//     anywhere else.
// (12) ROLLED BACK an earlier 5.27 change that gave the lightbox defect box
//     `touch-action: pan-y`. It was a fix for a problem that did not exist: the
//     report was that scrolling failed on INTERIOR specifically, and the cause
//     was (9) — the Interior box had nothing after the word "Page Quality" to
//     scroll to. Scrolling worked everywhere else, which the touch-action theory
//     could not have explained.
// v5.26: GRADING RULES CHANGED — TREAT THIS AS A CALIBRATION BOUNDARY.
//     Everything below alters what the grader outputs, so data from 5.25 and
//     5.26 must not be pooled. Anything analysed after this point should filter
//     on version >= 5.26.
// (1) HIGH-SEVERITY FLOORS ENFORCED IN CODE (api/assess.js). BOTTOM-OF-SCALE
//     already stated them; the model did not apply them. HG7PMR (ASM 11) came
//     back Front 15/50 on 3 High + 1 Med where the rubric allows <= 6, and Back
//     5/20 on 3 High where it allows <= 3. The floors are countable, so they are
//     now counted: >=2 High on a face caps Front 6 / Back 3 / Spine 3; >=1 High
//     STRUCTURAL (tape, missing piece, split, water damage, rust migration) caps
//     Front 12 / Back 6 / Spine 6. Only ever LOWERS a face, never raises one.
//     Logs `[floor]` and sets roboGrade._highSeverityFloor when it fires, so the
//     rate is measurable — if it fires on most damaged books the prompt floors
//     were never working; if it rarely fires, they mostly were.
// (2) TAPE DETECTION (assess.js + assess_deep.js CHECK 1). The geometry test was
//     sound but looked for STRAIGHT, PARALLEL edges — and edge-laid tape has only
//     ONE visible edge, because its outer edge coincides with the book's own. The
//     single inner edge then sits in the margin strip the model discounts as
//     background. Now stated explicitly, with: length and position are NOT part
//     of the test (tape is only as long as the damage, and follows tears, which
//     occur anywhere); check the BACK cover first (light ad stock shows the same
//     strip far more clearly than saturated front art); spine tape wraps the fold
//     so it appears on BOTH covers, at the spine margin of each — and the spine
//     side appears on OPPOSITE SIDES of the two photos, so locate it by the FOLD,
//     never by assuming a side; horizontal cracking across a spine band is the
//     paper splitting UNDERNEATH, i.e. why the tape is there — look for a spine
//     split and grade it separately. Tanning guard kept intact: soft boundary at
//     the OUTER edge is tanning, never upgraded to tape.
// (3) INTERIOR-TO-EXTERIOR CROSS-REFERENCE (assess_deep.js PHASE 2.5). The phase
//     said to examine interior covers "ONLY for interior-cover CONDITION", which
//     is why a Deep wrote "the interior photos reveal chunks torn from the outer
//     edges" and left a 1" HIGH Tear on the back cover unchanged. An interior
//     cover is the REVERSE of an exterior cover, so it is evidence about the
//     outside. Three inferences added: material missing on the inside is missing
//     outside too (Tear -> Piece out); ink on an interior page with no printed
//     source, at an edge, matching the adjacent cover colour, is applied ink;
//     interior blotches align position-for-position with inked-over cover
//     defects. All carry the mirror warning — locate by the fold and by distance
//     from top/bottom, never by assuming a side matches.
// (4) ERA CONTEXT (assess.js). Three skepticism adjustments keyed on issue year;
//     visible evidence still wins. Amateur defacement (marker over chips, whited
//     highlights) is a pre-1975 habit — attitudes shifted from ~1975 and were
//     settled by ~1982 with the direct market, so applied ink on a 1982+ book
//     needs strong unambiguous evidence. Layout conventions loosened from the
//     Bronze Age, above all on INTERIOR pages (no borders, splatter, bled spot
//     blacks as deliberate style), so unusual ink distribution is printed ART
//     until shown otherwise. Modern glossy stock defaults to WHITE page quality —
//     Off-White or lower only on a tideline, edge-concentrated browning or
//     foxing. Glue-bound books have no staples and take no staple observations,
//     but BINDING IS JUDGED FROM THE SPINE PHOTO, never from the date, and when
//     the photo does not settle it the book is assumed STAPLED.
// (5) DEEP FLOOR RULE WIDENED (assess_deep.js). It blocked every downward
//     revision not backed by a NEW defect — which deleted the reference-comparison
//     move PHASE 4 explicitly invites, and had already needed a page-quality
//     exemption bolted on. Now an EXPLAINED drop stands and an UNEXPLAINED drop is
//     reverted, where an explanation is: a new defect, a page-quality refinement,
//     a CORRECTED defect (new `revisionReason` on the entry — re-naming a Tear as
//     a Piece out is not new, but must be able to move the grade), or a stated
//     grade-reference comparison (new top-level `gradeRevisionReason`). Both new
//     fields require real prose; "confirmed" or an empty string does not count.
//     The rule is KEPT, for a behavioural reason: a second look always finds
//     something, so with no floor Deep would ratchet downward on every book, and
//     a revision pass users learn to distrust is worse than none. Deep must be as
//     likely to raise as to lower — the prompt now says so outright. Logs
//     `[deep-floor]` in both directions so the up/down ratio is measurable.
// (6) Signatures persist (see below), batch/scan reveal, cross-book history
//     bleed and the COMPLETE double-tap — app-side, no grading effect.
// v5.25: REFERRAL SMALL-TIER PAYOUT + /yt SHORT LINK.
// (1) REFERRER_BONUS.comic_stack 5 -> 3 (Matt). A 5-credit bonus on a 5-credit
//     pack paid the referrer as much as the buyer bought, which made the
//     smallest tier the cheapest credit-farming route. Wall (10) and Short Box
//     (50) unchanged; the issuer's flat +3 unchanged. This is also the number
//     stated in the public release video, so code and marketing now agree.
// (2) vercel.json: /yt -> /get?utm_source=youtube&utm_medium=video&
//     utm_campaign=release (302). The video description needs a link that does
//     not LOOK like tracking — a bare UTM string in a public description reads
//     as surveillance and costs clicks. The redirect keeps attribution without
//     showing it. /get's referrer sniffing already tags youtube when the
//     referrer survives; this covers the cases where it does not.
// v5.24: OPUS 5.5 + THE MODEL ID HAS ONE HOME NOW.
//     Grading moves to 'claude-opus-5-5' (released 2026-09-23): $4/$20 against
//     Opus 5's $5/$25 — 20% off both directions — and cache reads fall from
//     $0.50 to $0.20/MTok (10% of input -> 5%), so the Deep path, which is the
//     heaviest cache-read consumer, saves more than the headline 20%.
//     The id was previously a literal repeated 13 times across SIX endpoints
//     (assess, deep, full, card, insert, coupon). Missing one would have left
//     Main on 5.5 and Deep on 5 — invisible in the UI, and it would have
//     silently mixed two models inside a single calibration round. It now lives
//     in lib/model.js and every endpoint imports it. Reverting is that one line.
//     MODEL_RATES moved there too, with the 5.5 entry, so logged costs are
//     right; ratesFor() falls back to the CURRENT primary rather than a stale
//     hardcoded model. All six endpoints verified by real import(), not a parse
//     check — the failure mode here is an unresolved import, which parsing misses.
//     Promo code removed from Settings (Buy screen only) — wrong home for it.
// v5.23: PWA WELCOME CREDIT IS NOW A FIRST-SIGN-IN GRANT.
//     api/pwa_welcome.js granted on the SECOND visit, >=15 min after the first
//     (RETURN_GAP_MS); call #1 only recorded pwaFirstSeenMs. Matt is announcing
//     "sign in through the PWA and get a free credit" in a video, so the code
//     now matches the claim: not granted yet -> grant now. The one-time flag
//     (pwaWelcomeGranted, plus the legacy nested pwaWelcome.granted) is the only
//     guard, set inside the same transaction as the increment so concurrent tabs
//     cannot double-grant. pwaFirstSeenMs is no longer read or written; stale
//     values on existing docs are ignored. 10/10 tests against a fake Firestore.
//     TESTING NOTE: clearing the Firestore flag alone will not re-trigger it —
//     localStorage 'rg_pwa_welcome_done' short-circuits the call per browser.
// v5.22: BCC26 PROMO + PUBLIC LISTING + ADMIN IMAGE SETS.
// (1) PROMO 'BCC26' — 3 credits, Baltimore Comic-Con. Active 2026-09-23 00:00
//     Pacific through 2026-10-01 00:00 Pacific (i.e. the last redeemable
//     instant is 23:59:59 on Sep 30). The promo MACHINERY already existed
//     (api/redeem_promo.js, FENCON26); this adds the registry entry, its
//     client date mirror, and a SECOND surface for it — the field now appears
//     in Settings under Credits as well as in the Buy modal. Both share one
//     implementation keyed by an id suffix (PROMO_SCOPES), so there is no
//     duplicated redeem logic. The field only renders while a promo is live.
// (2) PUBLIC LISTING (public.html): the Robograder logo + "COMIC GRADING APP"
//     header is gone; the whole assessment now sits in one container matching
//     Detail's .card (#fff / 1px #ddd8d0 / 8px radius / 16px 14px); and the
//     "Open Robograder" CTA renders AGAIN. It had not disappeared — it was
//     gated to window.self === window.top, so it never showed on the common
//     path (the in-app iframe). The gate existed to avoid a reload loop from
//     href="/" inside the frame; that is now solved with target="_blank" when
//     framed, so the button shows everywhere, still above the disclaimer.
// (3) ADMIN: Coupon and Insert image sets now render in the item detail view,
//     and — the real bug — admin/api/item.js never RETURNED couponImages,
//     insertImages or userDefectImages at all. The 'User Defect Photos'
//     section had been reading a field the endpoint did not send, so the
//     "missed defect" photos have never displayed in admin. All three are now
//     fetched and returned, with couponFinding / insertFinding / couponQualified
//     / userDefectResult alongside. Download-all picks them up too.
// (4) Assessment History summary: 'AVE.' -> 'AVG.' (it is the average, and AVE
//     is not an abbreviation for it); SUMMARY 11px -> 14px; the ROBOGRADE and
//     PREDICTED range-bar labels 10px -> 13px.
// v5.20: UV CHECK ALLOWANCE + ADS TAG CLEANUP.
// (1) The free UV Check is now metered: THREE runs per book, and the meter
//     resets to zero whenever a PAID assessment lands on that book (Main, Deep,
//     Full or Batch). Tracked as item.uvCheckRuns - runs SINCE the last paid
//     pass, not lifetime. Enforced in the UI (the button and the whole offer
//     disappear at zero; a finished report stays readable) AND server-side in
//     assess_deep.js, which counts from the STORED item rather than the number
//     the client sends. The server check fails OPEN when the item cannot be
//     read, so the first UV Check on a not-yet-saved book is never blocked.
//     Rationale for the reset rule (corrected by Matt): a re-check IS worth
//     running when the book has changed, and it genuinely can - a collector who
//     has color touch cut out to remove the restoration will get a different UV
//     result afterwards, and confirming the touch is gone is the whole point.
//     Work like that is followed by a re-grade, i.e. a paid pass. What the limit
//     stops is re-shooting an UNCHANGED book, the only case where repeat runs
//     cost money and tell the user nothing new.
// (2) A stale-high local balance could drive the STORED credit count below zero
//     (decrementCredit fires an unconditional Firestore increment(-1) off the
//     LOCAL number). The 9646 floor now refuses the assessment before that can
//     happen, clients whose debit the server performed never call it, and the UI
//     clamps the displayed balance at 0. Full was the easiest endpoint to
//     overdraft on: it had no auth AND no credit check, and its client gate
//     (typeof window._userCredits === 'number') skipped entirely while the
//     balance was still loading.
// (3) List view's PRINT bar gradient matched to the printed label's own
//     (#c97a14 / #dd9430 / #e8b571); its ink moved to the label's #0d0d0f
//     because the old #3a2a18 fell to 4.12:1 on the new darkest stop.
// (4) Admin: the 4-char User ID (stored as transferCode) is now SHOWN on every
//     row of the Users list, so the thing you search by is visible in the list
//     you search. It was already in the search haystack but rendered nowhere
//     except the user modal, where it was labelled "CODE" - now "USER ID".
//     Search is name / email / User ID only; the Firebase uid is deliberately
//     NOT searchable. 'Ref Out' and 'Ref In' sort buttons removed.
// v5.19: CREDIT FLOOR + SAVE LOCK + LABELS + ADS TAGS.
// (1) SERVER-SIDE CREDIT FLOOR (note 9646). New lib/credits.js, used by
//     assess.js, assess_deep.js, assess_full.js and assess_card.js: the balance
//     is checked BEFORE any model call, 402 if short, refunded on failure or a
//     gate termination. Two modes - clients sending `serverCredits: true` get an
//     atomic debit and a returned balance; older native builds, which still
//     decrement client-side, get the floor only so they are never charged twice.
//     Batch passes (cacheProfile 'batch') and the UV Check are exempt at cost 0.
//     ALSO FIXED while in there: assess_deep.js and assess_full.js never
//     verified the caller at all - they allowed Authorization in CORS and never
//     read it. Both now require a valid Firebase ID token.
// (2) SAVE LOCK (note 9651). #save-btn is disabled and reads "Uploading
//     photos..." while a pre-upload is in flight, so an item can no longer be
//     saved with half its image URLs. Counter, not boolean - Deep and Main can
//     each have one open. The title field's oninput no longer re-enables it.
// (3) LABELS. The Robograder mascot on Wide and Large now takes the price pad's
//     exact box and size (Wide 220x220 @ top:18/right:282; Large 340x336 @
//     top:28/right:322) and disappears when the price tag is on, matching Case
//     and Square. .info yields the same column in both states. Large's score box
//     went 396 -> 378 at 27px margins (Wide's 6.25%-of-height proportion), with
//     every interior metric scaled by the same 0.9545.
// (4) GOOGLE ADS. Duplicate gtag block and orphaned GTM noscript removed from
//     index.html; the Ads destination now rides the hostname-gated GA4 tag so it
//     is stripped from native builds. /get fires all three button conversions
//     explicitly by label - the Web app button is same-host and can never be an
//     auto-detected outbound click.
// v5.18: UV CHECK + BATCH DEFECT LIST.
// (1) The 8-image Restoration Check is now a 2-image UV CHECK, and it is FREE.
//     SIX of the eight were ordinary-light shots (exterior staples x2, outer
//     edge, interior front/back, interior staples) already examined by
//     Main/Deep/Full, which flag restoration themselves at no charge. The two
//     that always required a blacklight - UV Front and UV Back - are the two
//     that survive. What no other pass can see is COLOR TOUCH: added ink that
//     fluoresces differently under UV. So that is the whole remaining job:
//     UV Front + UV Back, a short prompt, one question. No credit is charged
//     and none is gated.
//     assess_deep.js mode 'restoration' now requires exactly 2 images.
// (2) BATCH now replaces the book's defect list with the list from the pass
//     that landed CLOSEST TO THE BATCH AVERAGE (ties -> lower grade, then
//     earlier pass). Previously the batch wrote an averaged grade but kept the
//     pre-batch Deep's defect list, so a book could show a 5.5 next to the
//     defects that argued for a 7. Batch passes 2..N therefore emit their
//     defect list again (they still emit no prose) - ~$0.006/pass, ~$0.024 a
//     5-pass batch, at Opus 5 $25/M out.
// (3) robograde-panel.js: 'Page Quality - Interior' rows drop the location and
//     render as 'Page Quality - <designation>', wrap instead of clipping, and
//     are suppressed entirely when pages are White.
// v5.05 (addendum): HIGH non-structural WEAR now floors its face too — a
// single HIGH full-length spine-wear-with-color-loss seats Spine <=1.0, a HIGH
// color-breaking Front/Back wear/crease drops a full band, 2+ HIGH on a face -> the
// very bottom (was: only enumerated STRUCTURAL defects floored a face). Fixes
// 9FIQPM (F1.5->~0.5-1.0, RG 3.5->~2.0) and JLA #29 (spine 1.5->1.0, ~5.0->4.5).
// v5.05: scoring + defect-attribution fixes off Matt's screenshots.
// (1) Cap-shave now pulls the confidence-hold from DEFECT-BEARING faces first,
// then the safe filler order front->back->spine (was blindly front->back->spine).
// A spine-only-defect book (Darkstars #0) now shows the deduction on Spine (1.5)
// + Front (safe), Back stays 2.0; Main 9.0 -> Deep restores Front -> 9.5 -> Full
// 10 only if the spine defect clears. roboscore_v3.js + 3 inlined copies + forComic
// now passes per-face defect flags (severity-bearing only). (2) CHECK 0 hardened:
// same character/title is NOT a match — the cover ARTWORK must match; foreign/
// reprint price, "Volume 1"/reprint marks, mismatched layout = WRONG reference, and
// the discrepancy-default (differences=damage) fires ONLY after the reference passes
// the sanity check (fixes Luke Cage #1 pulling the 1985 reprint + inventing "black
// border -> edge chipping"). (3) Staple-rust MIGRATION onto paper and a LARGE/DARK
// stain are now HIGH and cap their face to the lowest band (Luke Cage RG was too
// soft). (4) Face-vs-landmark rule: the UPC/barcode/price box are FRONT landmarks,
// so a barcode-anchored defect is Front, never Back; shared edges assigned by the
// photo that shows them (fixes ASM #300 front edge-rub filed as Back).
export const ROBOGRADE_VERSION = '6.61';

// ── THE GRADING EPOCH ───────────────────────────────────────────────────────
// READ claude/HOW_WE_WORK_READ_FIRST.md SECTION 10a BEFORE CHANGING THIS.
//
// ROBOGRADE_VERSION above is the BUILD number. It moves on every change -
// a CSS fix, a copy change, anything - because it is how a change gets
// referred to and how check-native-bundles.mjs catches a stale app bundle.
//
// GRADING_EPOCH is the version the ASSESSMENT last actually changed at. It
// does NOT move when the build version moves. It moves only when a grading
// prompt, a ceiling, a cap or a scoring rule changes - and then it is set to
// whatever ROBOGRADE_VERSION is being bumped to in that same edit.
//
// WHY THE SPLIT EXISTS, so nobody collapses it again: this value is stamped on
// assessments and timing rows, and calibration_eval.mjs and defect_diff.mjs
// POOL THEIR RESULTS BY IT. Two runs that share an epoch are comparable; two
// that do not, are not. When one number did both jobs it moved ~100 times in
// six weeks for UI work, and no epoch ever accumulated enough runs to measure
// anything. TASKLIST already carries the scar: "do NOT pool with earlier
// versions - the floor rule changed in 5.26."
//
// THE RULE, in one line: did this edit change what a grade would be? Then move
// the epoch to the new build version. Otherwise leave it exactly as it is.
//
// check-cache-prefix.mjs enforces half of it automatically - if a cached
// prompt prefix moves and the epoch did not, it fails. The half it cannot see
// is a change to a ceiling, a cap or a scoring rule in code rather than in a
// prompt. That half is a person remembering, which is why it is written down
// in HOW_WE_WORK and not only here.
export const GRADING_EPOCH = '6.55';
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
