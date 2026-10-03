// lib/version.js
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
export const ROBOGRADE_VERSION = '5.35';
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
