// backfill_shortbox_cache.mjs — one-off backfill.
//
// Sets nextShortBoxBonus + lastShortBoxAt on every Short Box owner's user doc so
// the Buy page shows the repeat-bonus preview BEFORE their next purchase. Going
// forward the grant endpoints keep this cache current; this seeds it for people
// who bought before the feature shipped. Display-only (no credits granted).
// Idempotent — safe to re-run.
//
// RUN from the app repo root (needs ./lib/repeat_bonus.js):
//   FIREBASE_SERVICE_ACCOUNT='<json>' node backfill_shortbox_cache.mjs --dry   # preview
//   FIREBASE_SERVICE_ACCOUNT='<json>' node backfill_shortbox_cache.mjs         # apply
// or place the service-account JSON at ./service-account.json (DO NOT COMMIT IT).
import { readFileSync } from 'node:fs';
import { initializeApp, cert } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { shortBoxTimes, nextBonusAfter } from './lib/repeat_bonus.js';

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
  const times = shortBoxTimes(purchases);            // production, non-refunded Short Boxes
  if (!times.length) { skipped++; continue; }
  const lastShortBoxAt = new Date(Math.max(...times)).toISOString();
  const nextShortBoxBonus = nextBonusAfter(times, now);   // bonus their NEXT Short Box earns
  console.log(`${uid}: ${times.length} Short Box(es) -> nextBonus +${nextShortBoxBonus}, last ${lastShortBoxAt}${DRY ? '  [dry]' : ''}`);
  if (!DRY) await db.collection('users').doc(uid).set({ nextShortBoxBonus, lastShortBoxAt }, { merge: true });
  updated++;
}
console.log(`\n${DRY ? '(dry run) would update' : 'updated'} ${updated} Short Box owner(s); ${skipped} non-Short-Box buyers skipped.`);
process.exit(0);
