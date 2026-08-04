// lib/repeat_bonus.js — Repeat-Purchase Discount (Short Box escalating bonus).
//
// The PRICE never changes ($99.99 Short Box). Repeat Short Box buyers get more
// CREDITS for that fixed price: +20 per prior Short Box in an unbroken <=1yr
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
const YEAR_MS = 365 * 24 * 60 * 60 * 1000;

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
  if (now - mostRecent > YEAR_MS) return 0;             // chain broken -> fresh
  let chain = 1;                                        // mostRecent is 1 prior
  for (let i = times.length - 1; i > 0; i--) {
    if (times[i] - times[i - 1] <= YEAR_MS) chain++;
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
  if (now - mostRecent > YEAR_MS) return 0;
  let chain = 1;
  for (let i = times.length - 1; i > 0; i--) {
    if (times[i] - times[i - 1] <= YEAR_MS) chain++;
    else break;
  }
  // The next Short Box would have `chain` priors (all currently owned).
  return Math.min(chain, REPEAT_MAX_BONUS / REPEAT_STEP) * REPEAT_STEP;
}
