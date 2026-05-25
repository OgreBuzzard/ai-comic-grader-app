# CGC Grade Tier Reference — v3.95 Draft for Review

**Purpose:** Replace the loose `CGC_GRADE_TIERS` constant currently in `api/assess.js`. This is the canonical grade-by-grade reference the model consults in Phase 3 (Confirming) to verify its candidate grade.

**Source:** Facts derived from CGC's published grading guide. Wording is original. No CGC prose preserved verbatim.

**Token target:** This is denser and more quantified than the current version. Expected to be ~2,000 tokens. The wire-up of `gradeTierContext()` means only 3-4 tiers ship in any given assessment, so input cost per call goes DOWN compared to the current full-list dump.

---

## How to read these tiers

Each tier describes what a book at that grade looks like. The descriptions are written so the model can confirm "yes, the defects I catalogued match what a [grade] book should have" or recognize "no, the defects I catalogued are more consistent with the tier above/below."

When multiple thresholds in one tier are listed, they are alternatives — any one of them justifies the grade. Multiple thresholds present simultaneously typically push the book to a lower tier.

---

## 10.0 — GEM MINT

Perfect. Spine free of stress lines. All four corners razor-sharp. Cover flat, no bends or creases. Staples clean, tight, centered, no rust or discoloration around staple holes. Full gloss. Vibrant color, no fading. No tanning, foxing, soiling, stains, fingerprints, or dust shadows. No post-distribution writing or stamps (witnessed signatures permitted). Most pedigree markings allowed. Interior pages must be White — not Off-White to White. No distribution ink, printer tears, bindery tears, Marvel tears. No miscuts (a very slight miswrap or minor off-register acceptable on vintage). No modern-era ink defects (smear, lift, transfer, missing ink). Vintage allowance: slight blade pulls on Golden Age (especially Gaines File copies), light roller marks on Silver Age. Practically nonexistent before 1975; only one pre-1975 book has ever received this grade.

## 9.9 — MINT

One small non-color-breaking cover bend allowed, or one non-color-breaking spine stress line. Cover perfectly cut and well-centered. No edge or corner wear. A very small amount of distribution ink is allowed; no ink smears, lift, transfer, distortion, or missing ink. Off-White to White pages acceptable; Off-White is not. Full gloss and color. Staples free of rust, discoloration, or wear around the staple holes. Usually the highest grade for 1970s and 1980s comics. Fewer than 50 copies from the 1950s-60s have been graded 9.9. Only three 1940s books have ever received it.

## 9.8 — NEAR MINT / MINT

For most pre-2000 issues this is the realistic ceiling. One or two handling defects allowed: a very small color-breaking spine stress line, or a couple of light cover bends. Tiny wear allowed on one corner or around a staple. Cream to Off-White pages are essentially not allowed.

Many printing defects acceptable, particularly when run-wide. Modern allowance includes ink lift/distortion/smear/transfer and slight cover rippling. Silver/Bronze allowance: slightly impacted staples, slight distribution ink, printer creases, minor Siamese pages, light ink transfer, extra manufacturing staples, one very small printer/Marvel tear, light transfer stain. Golden allowance: very small bindery tear or chip, slightly off-register cover, miswraps, very thin/light dust shadows, very minor cover tanning, small unobtrusive date or store stamps, minor writing where unobtrusive.

## 9.6 — NEAR MINT+

A handful of very small defects allowed, no more than one or two at once. Examples (any one or two): a few very small color-breaking spine stress lines, very small wear to one or two corners, a tiny edge-only crease, a very small edge or staple tear, very light cover tanning, slight staple discoloration, one very small light stain (foxing spot, tiny rust mark, small disturbed-ink spot). One very small manufacturing piece-out (bindery, Marvel, or printer chip) allowed; no handling-caused missing pieces. Squarebounds: one small staple-caused hole, very small (~1/16") spine split, very minor printer tears. Minor gloss imperfections visible only in raking light acceptable. Golden Age: slight one-sided miscut allowed. Page quality minimum: Cream to Off-White. Interior may have minor defects (small folds, couple of minor tears, a chip-out). Staples firmly attached. This is the realistic ceiling for many early Silver Age keys (Amazing Fantasy #15, Showcase #4, FF #1) and for some black-cover books (Amazing Spider-Man #28, the 35¢ Star Wars #1 variant).

## 9.4 — NEAR MINT

Threshold of ultra-high grades. Light handling defects begin to appear but only one or a few at once, depending on size. Allowable: a very small spine split, one or two small color-breaking corner or edge creases, a very small chip-out, a very slight spine roll, several small non-color-breaking spine stress lines OR a few color-breaking ones. Cover may have a handful of bends or a small corner indent/crunch. A light stacking bend or polybag crease acceptable. Centerfold may be fully detached from one staple. Slightest fading, very light cover tanning, one small fingerprint affecting ink, extremely light staple rust, small erasure mark, or minor gloss smudging allowed. A very small, light stain (water, tape, foxing) acceptable. Slight pressing side effects (pebbling, cockling, warping, faring, reverse spine roll) allowed — usually the only flaw on an otherwise 9.6 or 9.8 book.

## 9.2 — NEAR MINT-

Regular handling defects more apparent; eye appeal still strong but close inspection required. Most printing defects no longer matter at this grade (ink flaws, miswraps, printer creases). Tear/missing-piece printing defects (bindery, printer, Marvel) judged on size. Very light silverfish damage in one or two small areas acceptable. Very light tanning to outer cover allowed; interior tanning may be slightly darker. Many 9.2s are otherwise-9.6/9.8 books downgraded for cover tanning. Pattern: either an accumulation of several tiny defects OR one significant defect (crease, tear, missing piece, stain, tanning). Origin (printing vs. handling) becomes less relevant.

## 9.0 — VERY FINE / NEAR MINT

Color-breaking defects more evident, particularly creases and spine stress lines — still small and few, but now countable and measurable. Minor fraying to an edge or corner OR a small (~1/4") missing piece allowed. Squarebound: spine split up to ~1/4". Small areas of tape or sticky residue (common on '80s covers) OR a very small (~1/8") tape pull acceptable. Allowed if singular: a very small interior cover sticker, a subscription sticker on exterior, a small unwitnessed signature on cover, OR an extremely small piece of non-functional tape (not reattaching anything). Cover may be partially detached from one staple (front OR back, not both). Any one of these defects requires the book to otherwise be free of most other 9.0-range defects.

## 8.5 — VERY FINE+

Bridge between the quantifiable 9.0 range and the broader 8.0 range. Resembles a 9.0 but falls short — usually one or two defects barely exceeding 9.0 limits: a slightly-longer crease, more spine stress lines, a larger chip or tear. Light corner fraying or color-breaking edge wear may be present. A couple of small staple tears OR a clean set of staple holes through only the cover allowed. Interior page tear up to 4" acceptable. A few small Marvel tears OR a couple of small Marvel chips allowed — not many at once. Light outer cover tanning common on Silver/Golden Age 8.5s. Moderate interior cover tanning allowed only if mostly defect-free elsewhere. This is the upper limit for books with Light Tan to Off-White pages.

## 8.0 — VERY FINE

Threshold grade — high-end aesthetic with notable defect accumulation (or a couple of moderate defects). For Golden Age, 8.0 is impressive. Allowable defects (in roughly the alternative sense): a 1"-2" color-breaking corner or edge crease; a light non-color-breaking reader's crease; a bindery tear, staple tear, or spine split up to ~1/2"; regular tears or an accumulation of Marvel tears up to 1"; a ~1/2"×1/2" missing cover piece OR a small 1/8" area of corner chews OR large printer holes; silverfish damage between 1"-2"; a small spine roll of ~1/8"; a small tape pull of ~1/4"; moderate staple rust.

Staining: very light overall, including a moderate tape stain, light foxing areas, a light 1/2"-1" water stain, heavy transfer stains on vintage, OR moderate gloss stains visible in raking light. 1"-2" area of fingerprints allowed depending on severity. Erasure marks up to 1" affecting ink and gloss permitted. Pen/pencil/marker writing allowed with size/location/medium dependent. Moderate-to-heavy soiling possible.

Heavy pressing defects often fall here (warping, cockling, pebbling causing significant cover buckling, significant spine impressions). Most printing defects ignored at 8.0; vintage heavy miscut may downgrade if eye appeal hurt. **Tape: a piece up to ~1/2"×1/2" can be present and may be reattaching a small cover piece.** A punch hole through only the cover or one small wormhole acceptable. Address sticker or circular price sticker on cover (common on Silver Age Marvels) allowed. Squarebound: cover up to ~1/2 detached from interior.

## 7.5 — VERY FINE-

One or two defects, or an accumulation that barely exceeds 8.0 limits. Still high-grade for many books; should retain attractive overall qualities. When many defects are present, consider them collectively.

## 7.0 — FINE / VERY FINE

Longer cover tears possible. Color discoloration, fading, light soiling, light stains. Cover may be detached at one staple. Centerfold detached at both staples possible. Tape repairs may be present (noted on label).

## 6.5 — FINE+

Significant accumulation of wear. Some structural defects begin to appear.

## 6.0 — FINE

Multiple defects: longer tears, soiling, fading. Missing inserts possible. Tape may be present.

## 5.5 — FINE-

Substantial wear. Cover gloss significantly reduced.

## 5.0 — VERY GOOD / FINE

Moderate-to-substantial defect accumulation.

## 4.5 / 4.0 — VERY GOOD+ / VERY GOOD

Major defects begin: larger tears, heavy creases, abrasions, severe stains, possible faded cover inks. Some story or ad pages may be missing. Interior panels or coupons may be cut. Excessive tape possible. An otherwise high-grade book missing only story pages OR only the front cover OR only the back cover (not both) starts here.

## 3.5 / 3.0 — GOOD/VERY GOOD / GOOD+

One major cover defect, or a large accumulation of average defects. 3.0-specific thresholds: spine split or splits totaling up to 5" (~half the spine); a 6" cover tear; a 3" tear through the entire book. Missing paper: cover piece-out totals up to 3"×3"; a 4"-5" piece torn off and reattached with tape (the detachment is treated like a tear, further downgraded for the tape). Chews removing up to 1"×1" of an entire corner; or 3 large punch holes through the book. Extreme worm holes through interior pages can land here even with unaffected cover.

3.0 staining: may affect up to a third of the book, leaving a dark tide line, washing out gloss, often warping paper. 3.0 fading: not affecting paper or gloss — only ink, leaving covers nearly black-and-white in appearance (every color except black completely washed out).

## 2.5 — GOOD+

Often worn and tattered. Moderate-to-heavy creasing, tears, staining, pieces out. Tape often present, typically repairing a detached cover or large spine split. Eye appeal significantly affected but the book is still complete and solid.

Few defects can singularly land a book at 2.5: spine splitting, brittleness, missing pieces, staining. Some 2.5s look much higher in grade because the defect is along an edge or affects only the interior. A book with only a spine split greater than half the spine length (common on Golden Age) grades 2.5 but looks nicer. Squarebound can still grade 2.5 with a fully split-and-detached front OR back cover, not both. If other defects are cumulatively severe, the book grades lower than 2.5.

Heavy interior wrap splitting from brittleness can land here — several completely-split wraps, or a half-split through most/all wraps. Common on 1930s-40s books, rare after mid-1960s.

Cover missing pieces: roughly 9 square inches missing can drop a mid-grade book to 2.5, and lower as the book otherwise approaches 2.5. Interior missing pieces (cut-out coupons or panels) hurt visual appeal less and may qualify for a Qualified grade.

Stains at 2.5: large and noticeable, typically affecting at least half the cover, dark, possibly with color loss. Tide lines and moderate-to-heavy rippling or cockling may be present.

## 2.0 — GOOD

Same defect range as 2.5 but slightly more severe or numerous. With the exception of large stains, no aesthetic defect alone pushes a book to 2.0 — though aesthetic defects combined with structural ones contribute.

Quantifiable defects that can lower a book to 2.0: missing pieces, a mostly-split spine. Tears and creases must be very heavy and numerous to land here singularly (harder to quantify). Staining can land here when very large and affecting most of the book.

When grading a heavily-worn book with accumulated problems, exact defect quantification becomes nearly impossible. Accuracy depends on mental comparison to other 2.0 copies.

## 1.8 — GOOD-

Most common single-defect path to 1.8: a fully split spine. Must be a relatively clean split with little/no missing paper along the spine and no major tape/staple repairs. Cover otherwise in decent shape, may include minor tears, chip-outs, light staining, moderate creasing, or light-to-moderate spine roll. More severe defects push lower.

Alternative single-defect paths: interior missing parts affecting story or ads totaling up to 4"×4" (or 3"×3" or 2"×2" if grade is otherwise low); interior wraps fully split from brittleness (cover spine still intact).

Only one of these three defects can be present for 1.8 — all three scenarios mean the book looks higher in grade because damage is on the spine or interior. Like 2.5 and 2.0, a 1.8 otherwise suffers from accumulated defects requiring mental comparison.

## 1.5 — FAIR / GOOD

Same accumulation pattern as 1.8 but more severe. Still complete and readable, but structural integrity may be compromised by large tears, splits, or brittleness. Defects often repaired with tape, which makes assessment easier.

Quantifiable: a fully split spine that has been reattached with tape or staples (a clean fully-split spine alone is 1.8; tape/staple repair drops it to 1.5). If the split is accompanied by missing pieces or moderate-to-extensive other cover defects, the grade may drop here. Tape and/or staple repairs combined with such accumulation may drop further.

Missing pieces from the cover can slightly exceed 3"×3"; interior missing can slightly exceed 4"×4". Significant other defects in conjunction may push lower. A fully laminated cover lands at 1.5 (full-comic lamination is 0.5).

## 1.0 — FAIR

Considerably worn, heavy cover damage that can exhibit any defect outlined above. Must still be relatively complete and readable. Up to 1/4 of the cover can be missing (single piece or cumulative); up to 1/3 of interior story/ad pages missing. Chews up to 2"×2" usually relegated to a corner. Full splitting of both interior and cover from brittleness allowed. Extreme brittleness with significant edge paper loss may land here (often too fragile for CGC encapsulation). 1.0 books can still be attractive when suffering only two or three major defects (e.g., a fully split spine plus a coupon-out on an interior page) — these are prime conservation/restoration candidates.

## 0.5 — POOR

Bottom of the grading scale. Three scenarios: extensive defect accumulation, significant missing cover or interior, or both. Almost no limit on any single defect's severity. No one defect alone lands a book at 0.5 (staining comes closest, but typically combined with heavy color loss, staple disintegration, or brittleness). Most 0.5 books suffer from many defects together that have marred the cover image and compromised structure, requiring gentle handling.

Cover missing thresholds: 1/3+ of the front or back cover (often the top 1/3 of front, the "masthead," ripped off and returned for credit on unsold newsstand copies). Full front cover OR full back cover may be missing (not both — that's NG). Interior threshold: 1/2 of a page missing as a baseline; usually a full page or wrap missing (most often centerfold or pin-up). Limits: if full cover or only front cover present, up to half the interior may be missing. If only back cover present, no more than 1/4 of interior may be missing. Exceeding these limits → NG.

CGC often Qualifies books missing interior parts/pages/wraps if the book otherwise grades higher than 3.0 (also true for missing inserts: posters, 3-D glasses, tattoo stickers, trading cards). Cover missing parts never get Qualified. Married parts (rebuilt from two incomplete copies) also get Qualified, with the book then considered complete.

## NG — NO GRADE

Coverless books most often. Also: front cover present with less than half of interior pages; back cover present with less than 3/4 of interior. Vintage keys (Golden/Silver Age) sometimes certified NG anyway to confirm authenticity. Color-copy covers attached to coverless books still get NG with a label notation; if attached via tape or extra staples it's a Universal NG; if attached via restoration materials (glue, wheat paste, rice paper) it's a Restored NG.

---

## Multi-defect interaction (the rule that's been missing)

When a book has multiple defects from different categories, the grade is determined by the WORST applicable tier, then nudged DOWN further based on the others.

Example: a book has a 1" tear (consistent with 8.0), a 1/4" missing piece (also 8.0/9.0 range), AND tape on the spine (tape size/location matters — small acceptable at 8.0, larger means lower). Three defects of similar severity place the book solidly at 8.0; not below, because each individual defect is within 8.0 allowances, but not above because they accumulate.

Example: a book has tape on the spine (placement and quantity matters), paper loss on the back cover (3"x3", 3.0 range), AND a 6" cover tear (3.0 range), AND extensive cumulative wear. The 3.0-range defects place the book at 3.0 max. The accumulated wear pushes lower. The tape, depending on size, may or may not push further. Realistic landing: 1.5-2.0.

**Cap thinking is wrong.** There is no "tape caps at X.X" rule. Tape's effect depends on its size, location, and what else is wrong with the book. A small piece of non-functional tape on an otherwise pristine book → 9.0. A piece of tape spanning the spine on an otherwise heavily-damaged book → may already be at 2.0, the tape doesn't necessarily lower it further.

**Missing pieces also gradient.** A bindery chip on a 9.6. A 1/4" missing piece on a 9.0. A 1/2"×1/2" missing piece on an 8.0. A 3"×3" on a 3.0. A 1/3 cover missing on a 0.5. There is no single "missing piece = bad grade" cap.
