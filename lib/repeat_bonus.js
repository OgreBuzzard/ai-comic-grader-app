// lib/repeat_bonus.js — Repeat-Purchase Discount (Short Box escalating bonus).
//
// The PRICE never changes ($99.99 Short Box). Repeat Short Box buyers get more
// CREDITS for that fixed price: +20 per prior Short Box in an unbroken <=6mo
// chain, capped at +100 (so 100 -> 120 -> 140 -> 160 -> 180 -> 200). Short Box
// only. Production, non-refunded purchases only. Cross-platform (all count).
//
// Server-authoritative: verify_iap / verify_play / webhook compute the bonus at
// grant time from the account's prior Short Box purchases and grant 100 + bonus.
//
// Kill-switch: after REPEAT_BONUS_UNTIL the logic goes dormant and Short Box
// grants the flat 100. Not advertised as limited-time — a quiet escape hatch.

export const REPEAT_BONUS_UNTIL = '2026-12-31';   // dormant after this date (UTC)
export const SHORT_BOX_BASE = 100;
export const REPEAT_STEP = 20;                     // +20 per prior Short Box
export const REPEAT_MAX_BONUS = 100;              // cap (=> 200 total)
const WINDOW_MS = 183 * 24 * 60 * 60 * 1000;   // ~6 months (repeat-bonus qualification window; was 1 year)

export function repeatBonusActive(now = Date.now()) {
  const until = Date.parse(REPEAT_BONUS_UNTIL + 'T23:59:59Z');
  return Number.isFinite(until) && now <= until;
}

// Tier of a purchase doc — tier field first (new), then productId, then the
// legacy credits map. Used by repeat-bonus AND referral tier detection so a
// 120/140/... Short Box is still recognized as short_box.
export function tierOf(p) {
  if (!p) return null;
  if (p.tier) return p.tier;
  const pid = p.productId || '';
  if (/shortbox/i.test(pid)) return 'short_box';
  if (/\.wall$/i.test(pid)) return 'comic_wall';
  if (/\.stack$/i.test(pid)) return 'comic_stack';
  const base = (typeof p.baseCredits === 'number') ? p.baseCredits : p.credits;
  return ({ 5: 'comic_stack', 20: 'comic_wall', 100: 'short_box' })[base] || null;
}

export function isProductionNonRefunded(p) {
  if (!p) return false;
  if (p.refunded) return false;
  if (p.environment && p.environment !== 'Production') return false;
  return true;
}

// Normalize a purchase doc's timestamp to ms (Firestore Timestamp | ISO | ms).
export function purchaseMs(p) {
  const c = p && p.createdAt;
  if (c && typeof c.toMillis === 'function') return c.toMillis();
  if (typeof (p && p.createdAtMs) === 'number') return p.createdAtMs;
  if (typeof c === 'string') return Date.parse(c) || 0;
  return 0;
}

// The production, non-refunded Short Box purchase timestamps (ms) in a set of
// purchase-doc datas.
export function shortBoxTimes(purchaseDatas) {
  return (purchaseDatas || [])
    .filter(p => isProductionNonRefunded(p) && tierOf(p) === 'short_box')
    .map(purchaseMs)
    .filter(Boolean);
}

// Bonus for a NEW Short Box purchased at `now`, given the ms timestamps of the
// account's PRIOR production, non-refunded Short Box purchases.
export function shortBoxBonusForNext(priorMsList, now = Date.now()) {
  if (!repeatBonusActive(now)) return 0;
  const times = (priorMsList || []).filter(t => Number.isFinite(t) && t > 0).sort((a, b) => a - b);
  if (!times.length) return 0;                          // first Short Box -> +0
  const mostRecent = times[times.length - 1];
  if (now - mostRecent > WINDOW_MS) return 0;             // chain broken -> fresh
  let chain = 1;                                        // mostRecent is 1 prior
  for (let i = times.length - 1; i > 0; i--) {
    if (times[i] - times[i - 1] <= WINDOW_MS) chain++;
    else break;
  }
  return Math.min(chain, REPEAT_MAX_BONUS / REPEAT_STEP) * REPEAT_STEP;
}

// Convenience: from an array of purchase-doc datas (the account's purchases,
// NOT including the new one), compute { bonus, priorTimes } for a new Short Box.
export function computeShortBoxBonus(purchaseDatas, now = Date.now()) {
  const priorTimes = (purchaseDatas || [])
    .filter(p => isProductionNonRefunded(p) && tierOf(p) === 'short_box')
    .map(purchaseMs)
    .filter(Boolean);
  return { bonus: shortBoxBonusForNext(priorTimes, now), priorCount: priorTimes.length };
}

// The bonus the NEXT Short Box would earn, given this account ALREADY owns the
// listed Short Box times (including the one just granted). For the Buy-page cache.
export function nextBonusAfter(shortBoxTimesIncludingLatest, now = Date.now()) {
  if (!repeatBonusActive(now)) return 0;
  const times = (shortBoxTimesIncludingLatest || []).filter(t => Number.isFinite(t) && t > 0).sort((a, b) => a - b);
  if (!times.length) return 0;
  const mostRecent = times[times.length - 1];
  if (now - mostRecent > WINDOW_MS) return 0;
  let chain = 1;
  for (let i = times.length - 1; i > 0; i--) {
    if (times[i] - times[i - 1] <= WINDOW_MS) chain++;
    else break;
  }
  // The next Short Box would have `chain` priors (all currently owned).
  return Math.min(chain, REPEAT_MAX_BONUS / REPEAT_STEP) * REPEAT_STEP;
}

// ─────────────────────────────────────────────────────────────────────────────
// GENERALIZED TIERED REPEAT BONUS (all three tiers, cross-tier unlock, one clock)
//
// Each product carries a bump level 0–5. Level of product P = number of prior
// production, non-refunded purchases at P's tier OR HIGHER, within the active
// (shared) ≤1-year chain, capped at 5. Bonus = level × 20% × base:
//   Comic Stack (base 5):  +1 / level  → 5,6,7,8,9,10
//   Comic Wall  (base 20): +4 / level  → 20,24,28,32,36,40
//   Short Box   (base 100):+20 / level → 100,120,…,200   (identical to legacy)
//
// Buying a tier bumps that tier and every LOWER tier, never higher. ONE SHARED
// CLOCK: any purchase (any tier) within the rolling year keeps the whole chain
// alive; a >1-year gap between consecutive purchases resets all levels to 0.
// Gated by REPEAT_BONUS_UNTIL, production-only, same as the Short Box logic.
// `price` is the shelf price in whole dollars. It is here, next to `base`,
// because the parity rule below is a comparison of DOLLARS PER CREDIT and
// cannot be computed without it. These must stay in step with the Buy page's
// own table in index.html (search `key: "comic_stack"`).
export const TIER_CONFIG = {
  comic_stack: { rank: 1, base: 5,   price: 10 },
  comic_wall:  { rank: 2, base: 20,  price: 30 },
  short_box:   { rank: 3, base: 100, price: 100 },
};
export const MAX_LEVEL = 5;
export const STEP_FRAC = 0.20;

// The active shared chain: production, non-refunded purchases (any tier), as
// {ms, rank}, trimmed to the unbroken suffix where each consecutive gap ≤1yr and
// the most recent is within 1yr of `now`. Empty when the clock has expired.
function activeChainItems(purchaseDatas, now) {
  const items = (purchaseDatas || [])
    .filter(isProductionNonRefunded)
    .map(p => ({ ms: purchaseMs(p), rank: (TIER_CONFIG[tierOf(p)] || {}).rank || 0 }))
    .filter(x => x.ms > 0 && x.rank > 0)
    .sort((a, b) => a.ms - b.ms);
  if (!items.length) return [];
  const mostRecent = items[items.length - 1].ms;
  if (now - mostRecent > WINDOW_MS) return [];              // shared clock expired → reset
  let start = items.length - 1;
  for (let i = items.length - 1; i > 0; i--) {
    if (items[i].ms - items[i - 1].ms <= WINDOW_MS) start = i - 1; else break;
  }
  return items.slice(start);
}

// Level (0–5) a NEW purchase of `tier` would earn, given the account's PRIOR
// production non-refunded purchases (this purchase not yet written).
export function levelForNextPurchase(purchaseDatas, tier, now = Date.now()) {
  if (!repeatBonusActive(now)) return 0;
  const cfg = TIER_CONFIG[tier]; if (!cfg) return 0;
  const chain = activeChainItems(purchaseDatas, now);
  const n = chain.filter(x => x.rank >= cfg.rank).length;   // priors at this tier OR higher
  return Math.min(n, MAX_LEVEL);
}

// Bonus credits a NEW purchase of `tier` would earn.
export function bonusForNextPurchase(purchaseDatas, tier, now = Date.now()) {
  const cfg = TIER_CONFIG[tier]; if (!cfg) return 0;
  return Math.round(levelForNextPurchase(purchaseDatas, tier, now) * STEP_FRAC * cfg.base);
}

export function baseCreditsForTier(tier) {
  const cfg = TIER_CONFIG[tier]; return cfg ? cfg.base : 0;
}

// The bonus each tier's NEXT purchase would earn (for the Buy-page cache). Pass
// the account's purchases INCLUDING the one just granted.
// S24: now reports the EFFECTIVE bonus (earned or parity-unlocked), because the
// Buy page's whole job here is to show the customer the better deal one tier up
// the moment it exists. Reporting the earned figure would cache exactly the
// offer this mechanism was built to replace.
export function nextBonuses(purchaseDatas, now = Date.now()) {
  const L = effectiveLevels(purchaseDatas, now);
  return {
    comic_stack: Math.round(L.comic_stack.level * STEP_FRAC * TIER_CONFIG.comic_stack.base),
    comic_wall:  Math.round(L.comic_wall.level  * STEP_FRAC * TIER_CONFIG.comic_wall.base),
    short_box:   Math.round(L.short_box.level   * STEP_FRAC * TIER_CONFIG.short_box.base),
  };
}

// Most-recent production non-refunded purchase (ms) — drives the shared-clock
// "still active" check on the Buy page. 0 when none.
export function lastPurchaseAtMs(purchaseDatas) {
  const times = (purchaseDatas || []).filter(isProductionNonRefunded).map(purchaseMs).filter(Boolean);
  return times.length ? Math.max(...times) : 0;
}

// ─────────────────────────────────────────────────────────────────────────────
// CROSS-TIER PARITY UNLOCK (Matt, 2026-10-19)
//
// THE PROBLEM, in his words: a customer who has bought the Comic Stack three
// times is on +60%, so their next Stack is 8 credits for $10 — $1.25 a credit.
// The Comic Wall, which they have never bought, still sits at its base 20
// credits for $30 — $1.50 a credit. **Moving up a tier would cost them more per
// credit than staying put.** The ladder that is supposed to pull people upward
// is pushing them down.
//
// It gets worse the longer they stay: at +100% the Stack is $1.00 a credit,
// which beats an unbonused Short Box.
//
// THE RULE: NO TIER IS EVER A WORSE DEAL PER CREDIT THAN A CHEAPER TIER.
//
// A tier's level is the greater of
//   (a) its EARNED level — prior purchases at that tier or higher, as before, and
//   (b) its PARITY level — the lowest level at which its price per credit is no
//       worse than the best price per credit the account can get at any tier
//       BELOW it.
// Capped at MAX_LEVEL either way. (a) is untouched, so nothing anyone has
// already earned goes down.
//
// Worked against Matt's own three cases:
//   Stack at +60% = $1.250  ->  Wall needs $1.250  -> level 1 -> 24 for $30  ✓
//   Wall  at +80% = $0.8333 ->  Box  needs $0.8333 -> level 1 -> 120 for $100 ✓
//   Wall at +100% = $0.750  ->  Box  needs $0.7143 -> level 2 -> 140 for $100 ✓
// The third is the live customer he saw buy a sixth Comic Wall.
//
// ONE DIVERGENCE FROM HOW HE DESCRIBED IT, and it is deliberate. He said the
// Wall should unlock after THREE Stacks. By the price rule it falls behind at
// TWO: next Stack $1.429 against an unbonused Wall at $1.50. The gap is small
// (7 cents a credit, where three Stacks makes it 25 cents), so this is a
// judgement call and not a correction — moving the trigger to three means
// changing (b) to "strictly better than", which is one word here.
//
// WHY A PRICE RULE AND NOT A PURCHASE COUNT: the counts that produce his three
// examples are 3, 4 and 5 — there is no constant "every N purchases" that fits
// them, because what actually drives each one is where the two price curves
// cross. Encode the thing that is really true and the numbers fall out; encode
// the counts and they have to be re-derived by hand every time a price or a
// credit count changes. (And they WILL change: these are the numbers on the
// Buy page.)
//
// CEILINGS, so nobody has to wonder: the deepest a parity unlock can reach is
// Wall level 3 (32 credits) and Short Box level 2 (140 credits), both from a
// customer sitting at Stack +100%. It cannot run away.

// Dollars per credit for `tier` at `level`.
export function pricePerCredit(tier, level) {
  const cfg = TIER_CONFIG[tier];
  if (!cfg) return Infinity;
  const credits = cfg.base + Math.round(level * STEP_FRAC * cfg.base);
  return credits > 0 ? cfg.price / credits : Infinity;
}

// The lowest level (0..MAX_LEVEL) at which `tier` costs no more per credit than
// `targetPerCredit`. MAX_LEVEL if it never gets there.
function lowestLevelAtOrUnder(tier, targetPerCredit) {
  for (let L = 0; L <= MAX_LEVEL; L++) {
    // Rounded to the cent: a difference below that is not a real difference to
    // anyone looking at a price, and floating point should not decide a grant.
    if (Math.round(pricePerCredit(tier, L) * 100) <= Math.round(targetPerCredit * 100)) return L;
  }
  return MAX_LEVEL;
}

// All three EFFECTIVE levels at once, resolved in ASCENDING TIER ORDER.
//
// The order is not an optimisation, it is the correctness condition. Parity only
// ever flows UPWARD, so each tier must be compared against the price the tiers
// below it will ACTUALLY be offered at — including any parity unlock they have
// themselves just received — not against their earned price.
//
// The bug this fixes, caught by a monotonicity test rather than by reading:
// a customer with five Comic Stacks sits at Stack $1.00 and, by parity, Wall
// $0.9375. Comparing the Short Box against the tiers' EARNED prices gave
// best-below = $1.00, so the Short Box stayed at level 0 — $1.00 a credit,
// DEARER than the Wall it is supposed to be an upgrade from. Exactly the
// inversion this whole mechanism exists to prevent, reintroduced one tier up.
export function effectiveLevels(purchaseDatas, now = Date.now()) {
  const tiers = Object.entries(TIER_CONFIG).sort((a, b) => a[1].rank - b[1].rank);
  const levels = {};
  let bestBelow = Infinity;          // best $/credit offered by any tier already resolved
  for (const [tier, cfg] of tiers) {
    const earned = levelForNextPurchase(purchaseDatas, tier, now);
    let level = earned;
    if (repeatBonusActive(now) && Number.isFinite(bestBelow)) {
      level = Math.min(MAX_LEVEL, Math.max(earned, lowestLevelAtOrUnder(tier, bestBelow)));
    }
    levels[tier] = { level, earned };
    bestBelow = Math.min(bestBelow, pricePerCredit(tier, level));
  }
  return levels;
}

// The EFFECTIVE level for a new purchase of `tier`: earned, or parity, whichever
// is higher. This is what grant time should use.
export function effectiveLevelForNextPurchase(purchaseDatas, tier, now = Date.now()) {
  if (!TIER_CONFIG[tier]) return 0;
  return effectiveLevels(purchaseDatas, now)[tier].level;
}

// Bonus credits for a new purchase of `tier`, parity included. Drop-in
// replacement for bonusForNextPurchase() at grant time and on the Buy page.
export function effectiveBonusForNextPurchase(purchaseDatas, tier, now = Date.now()) {
  const cfg = TIER_CONFIG[tier];
  if (!cfg) return 0;
  return Math.round(effectiveLevelForNextPurchase(purchaseDatas, tier, now) * STEP_FRAC * cfg.base);
}

// Everything the Buy page needs to show the three tiers honestly: credits,
// price per credit, and whether this tier's bonus is there because the customer
// EARNED it at this tier or because a lower tier unlocked it. The second is
// what Matt wants surfaced — "you've unlocked a better deal one tier up" — and
// the page cannot say that without being told which is which.
export function tierOffers(purchaseDatas, now = Date.now()) {
  const out = {};
  const levels = effectiveLevels(purchaseDatas, now);
  for (const [tier, cfg] of Object.entries(TIER_CONFIG)) {
    const { level, earned } = levels[tier];
    const bonus = Math.round(level * STEP_FRAC * cfg.base);
    out[tier] = {
      base: cfg.base,
      price: cfg.price,
      level,
      earnedLevel: earned,
      unlockedByLowerTier: level > earned,
      bonus,
      credits: cfg.base + bonus,
      perCredit: +pricePerCredit(tier, level).toFixed(4),
    };
  }
  return out;
}
