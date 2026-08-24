// backfill_repeat_bonus_cache.mjs — one-off backfill (all tiers).
//
// Generalizes backfill_shortbox_cache.mjs to the tiered repeat-purchase bonus.
// Sets nextBonuses ({comic_stack, comic_wall, short_box}) + lastPurchaseAt on
// every buyer's user doc so the Buy page shows each tier's repeat-bonus preview
// BEFORE their next purchase. DISPLAY-ONLY — grants NO credits and changes NO
// balances. The grant endpoints already compute the correct bonus live from
// purchase history, so correctness does not depend on this; it only seeds the
// preview cache for people who bought before the tiered feature shipped (useful
// for a repeat-buyer outreach email). Idempotent — safe to re-run.
//
// Legacy fields (nextShortBoxBonus / lastShortBoxAt) are kept in sync for any
// old client build still reading them.
//
// RUN from the app repo root (needs ./lib/repeat_bonus.js):
//   FIREBASE_SERVICE_ACCOUNT='<json>' node backfill_repeat_bonus_cache.mjs --dry   # preview
//   FIREBASE_SERVICE_ACCOUNT='<json>' node backfill_repeat_bonus_cache.mjs         # apply
// or place the service-account JSON at ./service-account.json (DO NOT COMMIT IT).
import { readFileSync } from 'node:fs';
import { initializeApp, cert } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { nextBonuses, lastPurchaseAtMs } from './lib/repeat_bonus.js';

const DRY = process.argv.includes('--dry');
let raw = process.env.FIREBASE_SERVICE_ACCOUNT;
if (!raw) { try { raw = readFileSync('./service-account.json', 'utf8'); } catch {} }
if (!raw) { console.error('Set FIREBASE_SERVICE_ACCOUNT env or add ./service-account.json'); process.exit(1); }
if (raw.includes('\\"')) raw = raw.replace(/\\"/g, '"').replace(/\\\\/g, '\\');
let sa; try { sa = JSON.parse(raw); } catch { sa = JSON.parse(Buffer.from(raw, 'base64').toString('utf8')); }

initializeApp({ credential: cert(sa) });
const db = getFirestore();

const snap = await db.collection('purchases').get();
const byUser = new Map();
snap.forEach(d => {
  const p = d.data() || {};
  if (!p.userId) return;
  if (!byUser.has(p.userId)) byUser.set(p.userId, []);
  byUser.get(p.userId).push(p);
});

const now = Date.now();
let updated = 0, skipped = 0;
for (const [uid, purchases] of byUser) {
  const lastMs = lastPurchaseAtMs(purchases);          // most recent production, non-refunded
  if (!lastMs) { skipped++; continue; }                // no qualifying purchases
  const nb = nextBonuses(purchases, now);              // per-tier next-purchase bonus (shared clock)
  const lastPurchaseAt = new Date(lastMs).toISOString();
  console.log(`${uid}: next stack +${nb.comic_stack}, wall +${nb.comic_wall}, sb +${nb.short_box}; last ${lastPurchaseAt}${DRY ? '  [dry]' : ''}`);
  if (!DRY) {
    await db.collection('users').doc(uid).set({
      nextBonuses: nb,
      lastPurchaseAt,
      nextShortBoxBonus: nb.short_box,   // legacy (older client builds)
      lastShortBoxAt: lastPurchaseAt,    // legacy
    }, { merge: true });
  }
  updated++;
}
console.log(`\n${DRY ? '(dry run) would update' : 'updated'} ${updated} buyer(s); ${skipped} with no qualifying purchase skipped.`);
process.exit(0);
