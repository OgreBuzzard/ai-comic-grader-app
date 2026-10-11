#!/usr/bin/env node
/*
 * lib/main_prompt_check.mjs — guard on the Main cached prefix.
 *
 * WHY. lib/main_prompt.js holds the ~19,800-token prefix that /api/assess sends
 * with cache_control on every Main, and that /api/cachewarm.js sends on every
 * keep-warm ping. Those two must be byte-identical or the ping writes a second
 * cache entry forever and pays 2x input to do it. This script is the cheap
 * check that they still agree, plus a structural audit of the prefix itself.
 *
 * It does NOT call the model and costs nothing.
 *
 *   node lib/main_prompt_check.mjs            report
 *   node lib/main_prompt_check.mjs --sha      print only the sha256
 *
 * RUN IT AFTER ANY EDIT TO THE PROMPT. A failure here is cheaper than a month
 * of cold Mains.
 */
import fs from 'node:fs';
import crypto from 'node:crypto';
import { buildMainPrefix } from './main_prompt.js';

const shaOnly = process.argv.includes('--sha');
const prefix = buildMainPrefix(null);
const sha = crypto.createHash('sha256').update(prefix).digest('hex');
if (shaOnly) { console.log(sha); process.exit(0); }

let fail = 0;
const ok  = (c, m) => { console.log((c ? '  ok    ' : '  FAIL  ') + m); if (!c) fail++; };

console.log('\nMAIN CACHED PREFIX');
console.log('  chars  ' + prefix.length);
console.log('  ~tok   ' + Math.round(prefix.length / 3.8) + ' (rough; the API is authoritative)');
console.log('  sha256 ' + sha + '\n');

// 1. assess.js must take the prefix from here and nowhere else.
const assess = fs.readFileSync(new URL('../api/assess.js', import.meta.url), 'utf8');
ok(/import \{ buildMainPrefix \} from '\.\.\/lib\/main_prompt\.js'/.test(assess),
   'api/assess.js imports buildMainPrefix');
ok(/const systemPrompt = buildMainPrefix\(_ki\) \+ `§§CACHE_SPLIT§§/.test(assess),
   'api/assess.js builds systemPrompt as prefix + §§CACHE_SPLIT§§ + the rest');
ok(!/const systemPrompt = `You are an expert/.test(assess),
   'the old inline prefix is gone from api/assess.js (no second copy to drift)');

// 2. cachewarm must send the SAME call, not a lookalike.
const warm = fs.readFileSync(new URL('../api/cachewarm.js', import.meta.url), 'utf8');
ok(/import \{ buildMainPrefix \} from '\.\.\/lib\/main_prompt\.js'/.test(warm),
   'api/cachewarm.js imports the same builder');
ok(/buildMainPrefix\(null\)/.test(warm),
   "the ping sends the _ki === null variant — the one ordinary Mains produce");
const warmTtl = /cache_control: \{ type: 'ephemeral', ttl: '1h' \}/.test(warm);
const assessTtl = /_cacheTtl === '1h' \? \{ type: 'ephemeral', ttl: '1h' \}/.test(assess);
ok(warmTtl && assessTtl, "both use a 1h ephemeral cache_control");
ok(/extended-cache-ttl-2025-04-11/.test(warm) && /extended-cache-ttl-2025-04-11/.test(assess),
   'both send the extended-cache-ttl beta header');

// 3. the prefix must stay a pure function of _ki, or the ping's variant is wrong.
const mod = fs.readFileSync(new URL('./main_prompt.js', import.meta.url), 'utf8');
const tmpl = mod.slice(mod.indexOf('return `'));
const interps = [...tmpl.matchAll(/\$\{([^}]{0,60})/g)].map(m => m[1].trim());
const allowed = i => i.startsWith('_ki ?') || i === 'defectIndexPromptBlock()' || i === 'gradeTierContext()';
ok(interps.every(allowed),
   'the prefix interpolates only _ki, defectIndexPromptBlock() and gradeTierContext()' +
   (interps.every(allowed) ? '' : '\n          unexpected: ' + interps.filter(i => !allowed(i)).join(' | ')));
ok(buildMainPrefix(null) === buildMainPrefix(null), 'the prefix is deterministic across calls');
ok(buildMainPrefix(null) !== buildMainPrefix({ title: 'x', issue: '1' }),
   'the _ki variant really is a different prefix (so the ping must not send it)');
ok(!/\$\{/.test(prefix), 'no unresolved ${...} left in the rendered prefix');
ok(!prefix.includes('§§CACHE_SPLIT§§'), 'the split marker is NOT inside the cached prefix');
ok(prefix.endsWith('\n'), 'the prefix ends with a newline (assess.js appends the marker directly)');
ok(prefix.length > 40000, 'the prefix is long enough to be worth caching');

console.log(fail
  ? '\n' + fail + ' FAILED. Do not deploy until this is clean — a mismatched prefix costs\n' +
    'about +$0.22 on every Main, silently.\n'
  : '\nAll checks passed.\n' +
    'If the prompt changed, the sha above changed too, and the first Mains after\n' +
    'the deploy will be cold. That is normal. What is NOT normal is /api/cachewarm\n' +
    "reporting a cache WRITE on every ping — that means this prefix and the one\n" +
    'assess.js sends have come apart.\n');
process.exit(fail ? 1 : 0);
