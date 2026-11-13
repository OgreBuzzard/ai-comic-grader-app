// test-post-cleaning.mjs — v6.49
//
// The Post-Cleaning panel renders from a record written by api/assess_clean.js,
// and that record is the only thing two credits buy. A render that throws on a
// partial comparison takes the whole Detail view down with it, so the cases
// below are mostly "what if this field isn't there".
//
// The renderers are SLICED out of index.html, not copied, so this tests what
// ships. Run: node test-post-cleaning.mjs

import { readFileSync } from 'node:fs';

let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) { pass++; console.log('  ok    ' + n); } else { fail++; console.log('  FAIL  ' + n + (x ? '\n        ' + x : '')); } };

const html = readFileSync(new URL('./index.html', import.meta.url), 'utf8');
const slice = (from, to, what) => {
  const i = html.indexOf(from), j = html.indexOf(to, i + from.length);
  if (i === -1 || j === -1) throw new Error('test-post-cleaning: could not find ' + what
    + '. Renamed or moved — this test is now checking nothing. Fix the slice.');
  return html.slice(i, j);
};

const src =
  'const esc = s => String(s == null ? "" : s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");\n'
  + 'const window = { RoboScoreV3: { forComic: o => (o && o.roboGrade && o.roboGrade.score != null) ? { grade: Math.round(o.roboGrade.score / 10 * 2) / 2 } : null, formatGrade: g => Number(g).toFixed(1) } };\n'
  + slice('function _fmvWithheld(item) {', '// ── POST-CLEANING RESULTS', 'the FMV guard')
  // One contiguous run: the palette, both renderers and the slot labels, in
  // file order. Slicing them separately invites exactly the ordering mistake
  // that is impossible here.
  + slice('const _PC = {', '\n// ── CLEANING COMPARE — the capture screen', 'the renderers')
  + '\nexport { _fmvWithheld, renderPostCleaningResults, renderPostCleaningPhotos };\n';

const M = await import('data:text/javascript;base64,' + Buffer.from(src).toString('base64'));
const { _fmvWithheld, renderPostCleaningResults, renderPostCleaningPhotos } = M;

const full = {
  predictedGrade: '7.5',
  roboGrade: { score: 78, defects: [] },
  cleanBeforeResult: { grade: '6.5', roboGrade: { score: 68 } },
  cleanAfterResult:  { grade: '7.5', roboGrade: { score: 78 } },
  cleanBeforeImages: ['b0.jpg', null, 'b2.jpg'],
  cleanAfterImages:  ['a0.jpg', 'a1.jpg', null],
  cleanComparison: {
    writeUp: 'Three edge defects resolved; the spine ticks survived.',
    counts: { resolved: 3, survived: 2, introduced: 0 },
    resolved: [{ type: 'Soiling', location: 'front cover' }],
    introduced: [],
    restorationAppeared: false,
    pageQualityMove: { before: 'Cream', after: 'Off-White', suspicious: false },
    gradeDelta: 1.0, runNumber: 1, at: '2026-11-07T00:00:00.000Z',
  },
};

// ── the happy path ────────────────────────────────────────────────────────
{
  const h = renderPostCleaningResults(full);
  ok('renders', h.length > 400);
  ok('says POST-CLEANING, not the old name', h.includes('POST-CLEANING') && !/CLEANING COMPARE/.test(h));
  ok('shows the run number', h.includes('RUN 1'));
  ok('shows both predicted grades', h.includes('6.5') && h.includes('7.5'));
  ok('shows the three counts', h.includes('>3<') && h.includes('>2<') && h.includes('>0<'));
  ok('shows the signed grade delta', h.includes('+1'));
  ok('shows the page quality move', h.includes('Cream') && h.includes('Off-White'));
  ok('shows the write-up', h.includes('spine ticks survived'));
  ok('lists a resolved defect', h.includes('Soiling'));
  ok('no restoration banner when none appeared', !h.includes('RESTORATION DETECTED'));
}

// ── restoration: the honesty constraint ───────────────────────────────────
{
  const r = JSON.parse(JSON.stringify(full));
  r.cleanComparison.restorationAppeared = true;
  const h = renderPostCleaningResults(r);
  ok('restoration banner appears', h.includes('RESTORATION DETECTED ON THE AFTER PHOTOS'));
  ok('states what each PASS found, never what was done to the book',
    /did not detect restoration and the after pass did/.test(h)
    && !/was restored|has been restored|someone restored/i.test(h));
  ok('the banner comes BEFORE the grades',
    h.indexOf('RESTORATION DETECTED') < h.indexOf('ROBOGRADE'));
  ok('FMV is withheld', _fmvWithheld(r) === true);
}
ok('FMV is NOT withheld on a clean comparison', _fmvWithheld(full) === false);
ok('FMV is NOT withheld on a book that never ran one', _fmvWithheld({}) === false
  && _fmvWithheld(null) === false);

// ── partial and malformed records must not throw ──────────────────────────
const survives = (name, item) => {
  try { const h = renderPostCleaningResults(item); ok(name, typeof h === 'string'); }
  catch (e) { ok(name, false, e.message); }
};
survives('no comparison at all renders nothing',
  (() => { const h = renderPostCleaningResults({}); return h === '' ? {} : null; })() !== null ? {} : {});
ok('no comparison returns an empty string', renderPostCleaningResults({}) === ''
  && renderPostCleaningResults(null) === '');
survives('a comparison with nothing but counts', { cleanComparison: { counts: {} } });
survives('no before/after results', { cleanComparison: full.cleanComparison });
survives('null defect lists', { cleanComparison: { resolved: null, introduced: null, counts: {} } });
survives('junk inside a defect list', { cleanComparison: { resolved: [null, {}, 5], counts: {} } });
survives('no page quality move', { cleanComparison: { pageQualityMove: {}, counts: {} } });
survives('no date', { cleanComparison: { counts: {}, at: null } });

// ── escaping ──────────────────────────────────────────────────────────────
{
  const x = { cleanComparison: { counts: {}, writeUp: '<script>alert(1)</script>' } };
  const h = renderPostCleaningResults(x);
  ok('the write-up is escaped', h.includes('&lt;script&gt;') && !h.includes('<script>'));
}

// ── the photo pairs ───────────────────────────────────────────────────────
{
  const h = renderPostCleaningPhotos(full);
  ok('photo rows render', h.includes('POST-CLEANING PHOTOS'));
  ok('a row is a BEFORE/AFTER pair', (h.match(/BEFORE/g) || []).length >= 2 && h.includes('AFTER'));
  ok('only slots with a photo on either side get a row',
    (h.match(/display:flex;gap:6px;align-items:flex-start/g) || []).length === 3);
  ok('a missing side is a placeholder, not a broken image',
    h.includes('border:1px dashed'));
  ok('no photos at all renders nothing', renderPostCleaningPhotos({}) === ''
    && renderPostCleaningPhotos({ cleanBeforeImages: [], cleanAfterImages: [] }) === '');
}

// ── the in-overlay results panel (v6.64) ──────────────────────────────────
// Source checks, not render checks: mountCleanResults talks to the scan module
// and the DOM. What has to hold is that it EXISTS, that the run calls it, and
// that the four things Matt specified are in it — because the bug being fixed
// here was a panel that was never mounted at all, which no amount of testing
// the Detail-view renderers could have caught.
{
  ok('mountCleanResults exists', html.includes('function mountCleanResults('));
  ok('the run mounts it', /mountCleanResults\(formData\.cleanBeforeResult/.test(html));
  ok('there is a way out of the overlay',
    html.includes('function completeCleanAssessment(') && html.includes('btn.onclick = completeCleanAssessment'));
  ok('BEFORE and AFTER are both columns', html.includes('col("BEFORE"') && html.includes('col("AFTER"'));
  ok('the panel is the scan placeholder too, so it is up from frame one',
    html.includes('window._cleanPanelHtml = _cleanPanelMarkup('));
  ok('the tracker waits for the photo sweep',
    /_run\.promise\.then\(_mount\)/.test(html));
  // The markup moved into _cleanPanelMarkup in 6.65 so the same layout can be
  // the scan placeholder AND the final panel. Slice from there.
  const panel = html.slice(html.indexOf('function _cleanPanelMarkup('),
                           html.indexOf('async function completeCleanAssessment('));
  ok('After RG starts at 0',   /val: "0",/.test(panel));
  ok('After PG starts at 0.0', /val: "0\.0",/.test(panel));
  ok('both After badges animate from the bottom',
    /animateV3LadderFromTo\(rgEl, 0,/.test(panel) && /animateGradeListFromTo\(pgEl, CGC_GRADE_LIST\[0\]/.test(panel));
  ok('NO page quality pill in the panel (spec decision 6)',
    !/pageQuality|Page Quality/i.test(panel));
  ok('restoration turns the After pair purple', panel.includes('restorationAppeared') && panel.includes('#241036'));
}

// ── the confirm card is not hard-coded to Batch (v6.64) ───────────────────
{
  ok('the confirm card takes a title and a button label',
    html.includes('function _batchConfirm(message, opts)'));
  ok('Post-Cleaning passes its own',
    html.includes('title: "Run Post-Cleaning Assessment?"') && html.includes('cta: "RUN POST-CLEANING"'));
  ok('Batch still says Batch', html.includes('"Run Batch Assessment?"') && html.includes('"RUN BATCH"'));
}

// ── the run cannot hang forever (v6.64) ───────────────────────────────────
{
  ok('_batchApi supports a timeout', html.includes('opts && opts.timeoutMs') && html.includes('AbortController'));
  ok('the clean run sets one', html.includes('timeoutMs: 200000'));
}

// ── the cleaned-book Detail view (v6.65) ──────────────────────────────────
{
  ok('isPostCleaned requires both sides',
    html.includes('item.cleanAssessmentRan && item.cleanBeforeResult && item.cleanAfterResult'));
  ok('there is a BEFORE shim and an AFTER shim',
    html.includes('function _cleanBeforeItem(') && html.includes('function _cleanAfterItem('));
  ok('the AFTER container is drawn first', /renderCleanAfterContainer\(selected\);[\s\S]{0,400}_cleanBand\("BEFORE"/.test(html));
  ok('the BEFORE container is closed', html.includes('close the BEFORE container'));
  ok('everything below AFTER reads the BEFORE shim',
    html.includes('const _aSrc = _postCleaned ? _cleanBeforeItem(selected) : selected;')
    && html.includes('aiCgcGrade(_aSrc)') && html.includes('_fmvWithheld(_aSrc)'));
  ok('the photo columns replace the single set', html.includes('if (_postCleaned) html += renderCleanPhotoColumns(selected);')
    && html.includes('if (!_postCleaned && selected.images?.length > 0)'));
  const after = html.slice(html.indexOf('function renderCleanAfterContainer('),
                           html.indexOf('function renderCleanPhotoColumns('));
  ok('AFTER carries the score panel, the predicted grade and the write-up',
    after.includes('buildRoboGradeDisplay(A.roboGrade, A)') && after.includes('_cleanPredictedBox(A)')
    && after.includes('Post-Cleaning Assessment') && after.includes('C.writeUp'));
  ok('the photograder is frozen into BEFORE and carried on AFTER',
    html.includes('photograder: item.photograder || rg.photograder || null'));
  ok('one eBay lookup per book, on the live grade only',
    html.includes('(_isCardItem || _postCleaned) ? null : _ebayAsksQuery'));
}

console.log('\n' + pass + ' passed, ' + fail + ' failed.');
process.exit(fail ? 1 : 0);
