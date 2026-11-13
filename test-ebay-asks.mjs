// test-ebay-asks.mjs — v6.56
//
// The pure half of api/ebay_asks.js: what counts as a slabbed listing, how a
// grade band is built, and what gets summarised. No network.
//
// The three things that must never regress:
//   1. a listing is only usable if its title carries a grading company AND a
//      NUMBER — "CGC graded" tells us nothing about condition;
//   2. the figure is a MEDIAN and the count travels with it, because an
//      asking price is not a comp and a bare number reads as a valuation;
//   3. below MIN_LISTINGS we return nothing. Three listings is not a market.
// Run: node test-ebay-asks.mjs

import { parseSlabGrade, median, bandFor, summarise, isJunkListing, titleHasIssue, isNonUniversalLabel } from './api/ebay_asks.js';

let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) { pass++; console.log('  ok    ' + n); } else { fail++; console.log('  FAIL  ' + n + (x ? '\n        ' + x : '')); } };

// ── what is a slab ────────────────────────────────────────────────────────
ok('CGC with a grade', parseSlabGrade('AMAZING SPIDER-MAN 129 CGC 9.4 WHITE PAGES')?.grade === 9.4);
ok('CBCS counts', parseSlabGrade('Fantastic Four 1 CBCS 4.5')?.company === 'CBCS');
ok('PSA counts', parseSlabGrade('Hulk 181 PSA 8')?.grade === 8);
ok('PSA 10 parses as 10, not 1', parseSlabGrade('Hulk 181 PSA 10')?.grade === 10);
ok('punctuation between name and number', parseSlabGrade('ASM 300 CGC: 9.8')?.grade === 9.8);
ok('lowercase', parseSlabGrade('asm 300 cgc 9.6')?.grade === 9.6);
ok('"CGC graded" with NO number is rejected', parseSlabGrade('ASM 300 CGC graded gem') === null,
  'a company name without a grade says nothing about condition');
ok('"ready for CGC" is rejected', parseSlabGrade('ASM 300 raw, press ready for CGC') === null);
ok('a raw listing is rejected', parseSlabGrade('Amazing Spider-Man 129 VF/NM beautiful copy') === null);
ok('no title is rejected, not thrown', parseSlabGrade(null) === null && parseSlabGrade('') === null);
ok('a grade out of range is rejected', parseSlabGrade('ASM 1 CGC 99') === null);

// ── median ────────────────────────────────────────────────────────────────
ok('odd count', median([10, 30, 20]) === 20);
ok('even count averages the middle two', median([10, 20, 30, 40]) === 25);
ok('empty is null', median([]) === null);
{
  const real = [200, 220, 240, 260, 280];
  const withFantasy = real.concat([5000]);
  const mean = a => a.reduce((x, y) => x + y, 0) / a.length;
  ok('one fantasy Buy-It-Now barely moves the median but wrecks the mean',
    Math.abs(median(withFantasy) - median(real)) <= 20 && mean(withFantasy) - mean(real) > 700,
    'this is the whole reason the endpoint reports a median — median moved '
      + (median(withFantasy) - median(real)) + ', mean moved ' + Math.round(mean(withFantasy) - mean(real)));
}

// ── the band walks LADDER RUNGS, not 0.5 steps ────────────────────────────
ok('one rung either side of 9.4 is 9.2-9.6', bandFor(9.4, 1).lo === 9.2 && bandFor(9.4, 1).hi === 9.6);
ok('one rung either side of 4.5 is 4.0-5.0', bandFor(4.5, 1).lo === 4.0 && bandFor(4.5, 1).hi === 5.0,
  'numeric distance would make these two bands mean different things');
ok('two rungs from 9.4 reaches 9.0 and 9.8', bandFor(9.4, 2).lo === 9.0 && bandFor(9.4, 2).hi === 9.8);
ok('the top of the ladder clamps', bandFor(10.0, 2).hi === 10.0);
ok('the bottom clamps', bandFor(0.5, 2).lo === 0.5);
ok('a non-ladder grade falls back to numeric', bandFor(7.3, 1).lo === 6.8);

// ── summarise ─────────────────────────────────────────────────────────────
const L = (t, p) => ({ title: t, price: { value: String(p), currency: 'USD' } });
{
  const items = [
    L('ASM 129 CGC 9.4', 300), L('ASM 129 CGC 9.2', 250), L('ASM 129 CGC 9.6', 400),
    L('ASM 129 raw nice copy', 90), L('ASM 129 CGC 5.0', 60)
  ];
  const s = summarise(items, 9.4);
  ok('only in-band slabs count', s.n === 3, JSON.stringify(s));
  ok('the median is of those three', s.median === 300, JSON.stringify(s));
  ok('the 5.0 is excluded by the band', s.low === 250 && s.high === 400);
  ok('not widened when one rung sufficed', s.widened === false);
  ok('the band travels with the number', s.band.lo === 9.2 && s.band.hi === 9.6);
}
{
  // only two at one rung; widening to two rungs finds enough
  const items = [
    L('FF 1 CGC 4.5', 9000), L('FF 1 CGC 4.0', 8000), L('FF 1 CGC 3.5', 7000), L('FF 1 CGC 5.5', 12000)
  ];
  const s = summarise(items, 4.5);
  ok('widens a rung when the tight band is too thin', s.n >= 3 && s.widened === true, JSON.stringify(s));
  ok('a widened band is flagged so the UI can show it', s.widened === true);
}
{
  const s = summarise([L('ASM 129 CGC 9.4', 300), L('ASM 129 CGC 9.4', 310)], 9.4);
  ok('two listings is not a market', s.n === 0 && s.reason === 'too-few-in-band', JSON.stringify(s));
}
ok('no slabs at all says so', summarise([L('ASM 129 raw', 90)], 9.4).reason === 'no-slabbed-listings');
ok('an empty result is handled', summarise([], 9.4).n === 0);
ok('a non-USD listing is dropped', summarise(
  [L('ASM 129 CGC 9.4', 300), L('ASM 129 CGC 9.4', 310),
   { title: 'ASM 129 CGC 9.4', price: { value: '300', currency: 'GBP' } }], 9.4).n === 0,
  'mixing currencies into one median would be nonsense');
{
  // Four in-band slabs, one with no price. The priced three must survive and
  // the unpriced one must not become a $0 that drags the median to nothing.
  // (Written with four, not three: with three the MIN_LISTINGS rule would
  // swallow the drop and the test would pass for the wrong reason.)
  const s = summarise([L('ASM 129 CGC 9.4', 300), L('ASM 129 CGC 9.2', 250),
                       L('ASM 129 CGC 9.6', 400), { title: 'ASM 129 CGC 9.4' }], 9.4);
  ok('a listing with no price is dropped, not counted as 0',
    s.n === 3 && s.median === 300 && s.low === 250, JSON.stringify(s));
}

// ── THE ISSUE NUMBER ──────────────────────────────────────────────────────
// Every one of these is a real title from the first live debug dump. The band
// for "Fantastic Four 1" contained issues 5, 55, 7, 52 and 13, because eBay's
// keyword search returns any issue of the title and nothing checked.
ok('the asked-for issue matches', titleHasIssue('Fantastic Four #1 CGC 4.5 Origin & 1st Appearance Marvel 1961', '1'));
ok('a different issue does not', !titleHasIssue('Fantastic Four #5 CGC 4.5 (1962) Marvel Comics', '1'));
ok('#55 is not #5', !titleHasIssue('Marvel Fantastic Four 55 CGC 4.5 1966 1st Silver Surfer', '5'));
ok('#13 is not #1', !titleHasIssue('Fantastic Four #13 CGC 4.5 1st Watcher and Red Ghost', '1'));
ok('#52 is not #5', !titleHasIssue('Fantastic Four # 52 (1966) CGC 5.0 1st Black Panther', '5'));
ok('a YEAR is not an issue number', !titleHasIssue('Fantastic Four CGC 4.5 Marvel 1961', '1'),
  'the 1 in 1961 must not count');
ok('a GRADE is not an issue number', !titleHasIssue('Fantastic Four CGC 5.0 Marvel', '5'),
  'the 5 in "5.0" must not count');
ok('9.4 is not issue 4', !titleHasIssue('Amazing Spider-Man CGC 9.4 Marvel', '4'));
ok('no hash, spaces either side', titleHasIssue('Fantastic Four 1 CGC 5.0', '1'));
ok('space after the hash', titleHasIssue('Fantastic Four # 52 (1966) CGC 5.0', '52'));
ok('three digits', titleHasIssue('The Incredible Hulk 181 CGC 6.0 1st WOLVERINE', '181'));
ok('leading zeros in the title', titleHasIssue('Action Comics #007 CGC 3.0', '7'));
ok('a non-numeric issue is not rejected', titleHasIssue('Whatever CGC 9.8', '1A'),
  'if we cannot check it, we must not drop it');
// The ordinal rule. Comic titles are packed with "1st Appearance" and this
// caught three of the nine live listings on its own.
ok('"1st Appearance" is not issue 1',
  !titleHasIssue('Fantastic Four #13 CGC 4.5 1st Watcher and Red Ghost', '1'));
ok('"1st App" is not issue 1',
  !titleHasIssue('Fantastic Four #5 Origin & 1st App Dr. Doom 1962 CGC 5.0', '1'));
ok('"2nd" is not issue 2', !titleHasIssue('Batman 423 2nd Print CGC 9.6', '2'));
ok('but a real #1 with "1st Appearance" in it still matches',
  titleHasIssue('Fantastic Four #1 CGC 4.5 Origin & 1st Appearance of Fantastic Four Marvel 1961', '1'),
  'the ordinal rule must not throw out the book it is protecting');

// ── non-universal CGC labels ──────────────────────────────────────────────
// Both of these are real titles from the first live sample.
ok('RESTORED is excluded', isNonUniversalLabel('Fantastic Four #1 CGC 4.5 RESTORED 1961 1st app.'),
  'purple label — same number, materially different market');
ok('Qualified is excluded', isNonUniversalLabel('Incredible Hulk (1974) #181 CGC 6.5 Qualified'));
ok('Signature Series is NOT excluded',
  !isNonUniversalLabel('Fantastic Four #1 - Marvel Comics 1961 CGC 4.0 1st App FF SIGNED STAN LEE'),
  'a universal-grade book with an autograph is still the same comic in the same condition');
ok('an ordinary listing is not excluded', !isNonUniversalLabel('Fantastic Four #1 CGC 4.5 Marvel 1961'));

// ── the whole filter chain against the real FF 1 dump ─────────────────────
{
  const R = (t, p) => ({ title: t, price: { value: String(p), currency: 'USD' } });
  const live = [
    R('Fantastic Four #5 Origin & 1st App Dr. Doom Silver Age Marvel Comic 1962 CGC 5.0', 7500),
    R('Fantastic Four #1 CGC 4.5 Origin & 1st Appearance of Fantastic Four Marvel 1961', 14990),
    R('FANTASTIC FOUR #1 CGC 5.0 OW/WH PAGES // ORIGIN+1ST APPEARANCE OF FANTASTIC FOUR', 20900),
    R('Marvel Fantastic Four 55 CGC 4.5 1966 1st Appearance Silver Surfer', 109.99),
    R('Fantastic Four #5 CGC 4.5 (1962) Marvel Comics "Meet..Doctor Doom!" WHITE PAGES', 7500),
    R('Fantastic Four #7 CGC 5.0 Marvel 1962 Kurrgo Planet X Stan Lee Jack Kirby', 475),
    R('Fantastic Four # 52 (1966) CGC 5.0 Kirby 1st Black Panther (T\'Challa), Wakanda', 625),
    R('Fantastic Four #13 CGC 4.5 1st Watcher and Red Ghost Stan Lee Jack Kirby', 450),
    R('Fantastic Four #52 CGC 5.0 Marvel Comics 1966 1st Appearance Of Black Panther', 615)
  ];
  const before = summarise(live, 4.5);                 // no issue = old behaviour
  const after  = summarise(live, 4.5, '1');
  ok('without the issue check this really did return nine listings', before.n === 9,
    'reproducing the live bug: ' + JSON.stringify({ n: before.n, median: before.median }));
  ok('with it, only the two real #1s survive', after.n === 2 || after.reason === 'too-few-in-band',
    JSON.stringify(after));
  ok('and the $109.99 Fantastic Four 55 is gone',
    !(after.n > 0 && after.low === 109.99), JSON.stringify(after));
}

// ── reprints and facsimiles ───────────────────────────────────────────────
// Matt, 2026-11-12: "You'll still find facsimiles in CGC cases." The specific
// trap is the GOLDEN RECORD reprints — 1966 reprints of JIM 83, ASM 1,
// Avengers 4 and FF 1, genuinely slabbed, genuinely collectable, low hundreds
// where the originals are five figures. Price band alone cannot separate them;
// only the title can.
ok('a facsimile is rejected', isJunkListing('Fantastic Four #1 Facsimile Edition CGC 9.8'));
ok('a Golden Record reprint is rejected', isJunkListing('Fantastic Four 1 Golden Record Reprint CGC 4.5'),
  'this is the one that made FF 1 come back at a $615 median');
ok('"golden records" plural too', isJunkListing('ASM #1 Golden Records CGC 5.0'));
ok('a second printing is rejected', isJunkListing('Batman 423 2nd Print CGC 9.6'));
ok('"second printing" spelled out', isJunkListing('Batman 423 Second Printing CGC 9.6'));
ok('a lot is rejected', isJunkListing('Lot of 5 Amazing Spider-Man CGC'));
ok('a poster is rejected', isJunkListing('Fantastic Four 1 Poster CGC'));
ok('a plain original is NOT rejected', !isJunkListing('Fantastic Four #1 1961 CGC 4.5 Marvel'));
ok('a VARIANT is not rejected', !isJunkListing('Absolute Batman #1 Jock Variant CGC 9.8'),
  'a variant is a real copy of the real book - over-filtering costs us real comps');
ok('a sketch cover is not rejected', !isJunkListing('Absolute Batman 1 Sketch Cover CGC 9.8'));
ok('empty/null is safe', !isJunkListing(null) && !isJunkListing(''));
{
  const L3 = (t, p) => ({ title: t, price: { value: String(p), currency: 'USD' } });
  const s2 = summarise([
    L3('Fantastic Four 1 CGC 4.5', 20900),
    L3('Fantastic Four 1 Golden Record Reprint CGC 4.5', 300),
    L3('Fantastic Four 1 Golden Record CGC 4.0', 280),
    L3('Fantastic Four #1 CGC 5.0', 24000),
    L3('Fantastic Four 1 Facsimile CGC 4.5', 60)
  ], 4.5);
  ok('the reprints are gone before the median is taken',
    s2.n === 2 || s2.reason === 'too-few-in-band',
    'only the two real copies should survive — got ' + JSON.stringify(s2));
}

// ── the spread alarm ──────────────────────────────────────────────────────
// Added after the FIRST LIVE CALL, which is the only reason it exists. FF 1 at
// 4.5 returned median $615 with a high of $20,900. No real CGC 4.5 Fantastic
// Four #1 sells for $615, so most of that band was a different book sharing a
// title and an issue number. A median computed over the wrong books is worse
// than no median, and nothing in the response said so.
{
  const L2 = (t, p) => ({ title: t, price: { value: String(p), currency: 'USD' } });
  const bad = summarise([
    L2('Fantastic Four 1 CGC 4.5', 20900), L2('Fantastic Four 1 CGC 4.5', 400),
    L2('Fantastic Four 1 CGC 4.0', 300), L2('Fantastic Four 1 CGC 5.0', 615)
  ], 4.5);
  ok('a wild spread is flagged suspect', bad.suspect === true, JSON.stringify(bad));
  ok('and the ratio is reported so it can be shown', bad.spreadRatio > 8);

  const good = summarise([
    L2('ASM 129 CGC 9.4', 4400), L2('ASM 129 CGC 9.4', 4625),
    L2('ASM 129 CGC 9.2', 3900), L2('ASM 129 CGC 9.6', 8400)
  ], 9.4);
  ok('a normal spread is NOT flagged', good.suspect === false, JSON.stringify(good));
}

// ── it must not become a gate ─────────────────────────────────────────────
{
  const { readFileSync } = await import('node:fs');
  const html = readFileSync(new URL('./index.html', import.meta.url), 'utf8');
  ok('nothing gates on eBay asks',
    !/ebayAsks?[^\n]*(fmvTier|deepUnlock|fullUnlock|conciergeGate)/i.test(html),
    'an asking price must never decide whether a tier unlocks');
}

console.log('\n  ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
