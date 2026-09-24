// lib/version.js
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
export const ROBOGRADE_VERSION = '5.24';
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
