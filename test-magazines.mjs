// test-magazines.mjs — v6.51
//
// Magazines are a comic SUBTYPE (format:"magazine"), not a third top-level
// type. The two things that must never regress:
//   1. an adult item is never publishable, at any of the three enforcement
//      points — and the one that matters is the public page, because the other
//      two run in a browser an old build can be;
//   2. a magazine identifies by its cover DATE when it has no issue number.
// Sliced out of the shipping files. Run: node test-magazines.mjs

import { readFileSync } from 'node:fs';

let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) { pass++; console.log('  ok    ' + n); } else { fail++; console.log('  FAIL  ' + n + (x ? '\n        ' + x : '')); } };

const html = readFileSync(new URL('./index.html', import.meta.url), 'utf8');
const slice = (from, to, what) => {
  const i = html.indexOf(from), j = html.indexOf(to, i + from.length);
  if (i === -1 || j === -1) throw new Error('test-magazines: could not find ' + what
    + '. Renamed or moved — this test is checking nothing. Fix the slice.');
  return html.slice(i, j);
};

const src =
  slice('const FORMAT_COMIC = "comic"', 'function _publicEligibleOwnership', 'the subtype + adult guard')
  + slice('function _publicEligibleOwnership(own) {', '\n// S20: generic branded message modal', 'the ownership rule')
  + '\nexport { itemFormat, isMagazine, isAdultItem, canBePublic, FORMAT_MAGAZINE };\n';
const M = await import('data:text/javascript;base64,' + Buffer.from(src).toString('base64'));
const { itemFormat, isMagazine, isAdultItem, canBePublic } = M;

// ── the subtype ───────────────────────────────────────────────────────────
ok('a plain comic is format "comic"', itemFormat({ type: 'comic' }) === 'comic' && !isMagazine({ type: 'comic' }));
ok('a magazine is recognised', isMagazine({ type: 'comic', format: 'magazine' }));
ok('an unknown format falls back to comic', itemFormat({ format: 'zine' }) === 'comic');
ok('null is a comic, not a crash', itemFormat(null) === 'comic' && isMagazine(null) === false);
ok('a CARD is untouched by any of this', itemFormat({ type: 'card' }) === 'comic' && !isMagazine({ type: 'card' }),
  'the subtype must not change how cards behave — they branch on `type`, not `format`');

// ── the adult guard ───────────────────────────────────────────────────────
ok('an adult item is adult', isAdultItem({ adultContent: true }));
ok('only the exact boolean counts', !isAdultItem({ adultContent: 'yes' }) && !isAdultItem({ adultContent: 1 }),
  'a truthy string must not silently flag an item — and a falsy one must not silently clear it');
ok('an ordinary owned comic can be public', canBePublic({ ownership: 'Owned' }));
ok('a watched comic can be public', canBePublic({ ownership: 'Watching' }));
ok('a SOLD comic cannot (unchanged rule)', !canBePublic({ ownership: 'Sold' }));
ok('an adult item cannot be public even when Owned', !canBePublic({ ownership: 'Owned', adultContent: true }));
ok('an adult item cannot be public when Watching', !canBePublic({ ownership: 'Watching', adultContent: true }));
ok('the adult guard beats ownership, not the other way round',
  !canBePublic({ ownership: 'Owned', adultContent: true }) && !canBePublic({ ownership: 'Sold', adultContent: false }));

// ── enforcement point 3 lives in api/lookup.js and must stay there ────────
{
  const lookup = readFileSync(new URL('./api/lookup.js', import.meta.url), 'utf8');
  ok('the public endpoint refuses an adult item',
    /comic\.adultContent === true/.test(lookup) && /This assessment is private/.test(lookup));
  const i = lookup.indexOf('comic.adultContent === true');
  const j = lookup.indexOf('verificationState');
  ok('it refuses BEFORE it builds the public record', i > -1 && j > -1 && i < j,
    'the refusal has to come before anything is assembled, or an adult record is built and then discarded');
  ok('the refusal does not say WHY — it must not confirm an adult item exists at this ID',
    !/adult/i.test(lookup.slice(i, i + 400).split('\n').filter(l => /error:/.test(l)).join(' ')));
}

// ── the FMV index is optional and empty on day one ────────────────────────
{
  const idx = JSON.parse(readFileSync(new URL('./fmv_magazines.json', import.meta.url), 'utf8'));
  const comics = JSON.parse(readFileSync(new URL('./fmv_comics.json', import.meta.url), 'utf8'));
  ok('the magazine index exists and parses', !!idx.books);
  ok('its tier ladder matches the comic one exactly',
    JSON.stringify(idx.tiers) === JSON.stringify(comics.tiers),
    'a different ladder would mean "$50-$100" meant two different things on two screens');
}

// ── the Watching regression, v6.52 ────────────────────────────────────────
// Watching has been public-eligible since v6.51, but the two "SWITCHED TO
// PRIVATE" modals each carried their OWN copy of the eligibility rule and one
// still read `next !== "Owned"`. Switching a public book Owned -> Watching
// therefore announced it had been made private, on a book that stayed public.
// Both modals now fire off what actually changed, so the message cannot drift
// from the rule again. These checks exist to stop a third copy appearing.
ok('no modal carries its own copy of the ownership rule',
  !/next !== "Owned" && _wasPublic/.test(html),
  'that literal IS the v6.52 bug - the modal must derive from the change, not re-test ownership');
ok('the detail modal fires off the actual change',
  /if \(update\.publicListing === false && _wasPublic\) \{/.test(html));
ok('the form modal fires off the actual change',
  /if \(!_nowPublic && _wasPublic\) \{/.test(html));
ok('the detail guard tests the COMIC, not the ownership string',
  /const _nextItem = \{ \.\.\.comic, ownership: next \};/.test(html)
  && !/canBePublic\(\{ \.\.\.next, ownership: next\.ownership \}\)/.test(html),
  'spreading a string gave {0:"W",...} with ownership undefined, so canBePublic always said yes');
ok('both modals can name the adult guard as the cause',
  (html.match(/adult titles can't be listed publicly/g) || []).length === 2);

console.log('\n' + pass + ' passed, ' + fail + ' failed.');
process.exit(fail ? 1 : 0);
