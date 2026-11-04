#!/usr/bin/env node
/*
 * check-cache-prefix.mjs — fail the deploy when a prompt change silently
 * invalidates the warm cache.
 *
 * WHY THIS EXISTS
 * The Main and Deep prompts each have a long static PREFIX that Anthropic
 * caches, and a keep-warm ping that re-reads it on a schedule so a real user's
 * first assessment of the day hits a warm entry instead of paying full input
 * price. The prefix is the cache KEY: change one character of it and every
 * cached entry is dead, the ping starts warming an entry nothing reads, and
 * nothing anywhere says so. It took three weeks to notice last time, and the
 * cause was a prompt-shaped change nobody connected to caching.
 *
 * Any prompt edit is a cache event. A person cannot be relied on to remember
 * that, and a note in a document has already failed at it once. So this is a
 * machine check: the prefix shas are recorded in cache_prefix_manifest.json,
 * and if the live ones differ, this exits non-zero and says what to do.
 *
 * It is NOT a nag to be silenced. Seeing it means the prompt changed, which is
 * usually intended — what it is asking is that you confirm the keep-warm path
 * still points at the new prefix BEFORE the change goes live, and then record
 * the new sha.
 *
 *   node check-cache-prefix.mjs           compare; exit 1 if adrift
 *   node check-cache-prefix.mjs --update  accept the current shas (do this
 *                                         AFTER verifying the ping)
 */
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const MANIFEST = path.join(ROOT, 'cache_prefix_manifest.json');

const { buildMainPrefix } = await import('./lib/main_prompt.js');
const { buildDeepPrefix, deepVariantFlags, DEEP_VARIANTS } = await import('./lib/deep_prompt.js');

const sha = t => createHash('sha256').update(t).digest('hex').slice(0, 16);

// Every prefix the keep-warm ping is responsible for. A variant missing from
// here is a variant nothing watches, so adding a variant means adding a row.
const live = { main: sha(buildMainPrefix(null)) };
for (const v of DEEP_VARIANTS) live['deep:' + v] = sha(buildDeepPrefix(deepVariantFlags(v)));

const update = process.argv.includes('--update');
const prev = fs.existsSync(MANIFEST) ? JSON.parse(fs.readFileSync(MANIFEST, 'utf8')) : null;

if (update || !prev) {
  fs.writeFileSync(MANIFEST, JSON.stringify({
    note: 'Written by check-cache-prefix.mjs. Do not hand-edit. A change here '
        + 'means the cached prompt prefix changed and the keep-warm ping has '
        + 'been re-verified against it.',
    updatedAt: new Date().toISOString(),
    prefixes: live
  }, null, 2) + '\n');
  console.log(prev ? '  recorded current prefix shas:' : '  created cache_prefix_manifest.json:');
  for (const [k, v] of Object.entries(live)) console.log(`    ${k.padEnd(12)} ${v}`);
  process.exit(0);
}

const drift = [];
for (const [k, v] of Object.entries(live)) {
  const was = prev.prefixes ? prev.prefixes[k] : undefined;
  if (was === undefined) drift.push(`${k}: NEW (${v}) — not in the manifest`);
  else if (was !== v) drift.push(`${k}: ${was} -> ${v}`);
}
for (const k of Object.keys(prev.prefixes || {})) {
  if (!(k in live)) drift.push(`${k}: GONE — in the manifest but no longer built`);
}

if (!drift.length) {
  console.log(`  \x1b[32m✓\x1b[0m cached prompt prefixes unchanged (${Object.keys(live).length} checked)`);
  process.exit(0);
}

console.log('\n\x1b[31m✗ THE CACHED PROMPT PREFIX CHANGED.\x1b[0m\n');
for (const d of drift) console.log('    ' + d);
console.log(`
  Every cached entry for the changed prefix is now dead, and the keep-warm ping
  is warming a key nothing will read until it is re-pointed. Deploying without
  checking means every Main or Deep pays full input price until someone
  notices — which last time took three weeks.

  Do this, in order:
    1. Deploy the prompt change.
    2. Hit  /api/cachewarm?mode=status  and confirm the ping's prefix sha
       matches the endpoint's, and that pingTokens matches mainTokens.
    3. Then:  node check-cache-prefix.mjs --update
`);
process.exit(1);
