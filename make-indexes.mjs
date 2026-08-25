#!/usr/bin/env node
// =============================================================================
// make-indexes.mjs — regenerate the SERVED insert/coupon JSON indexes from the
// curated ES-module source lists, so /insert_index.json and /coupon_index.json
// can never silently drift from lib/insert_list.js & lib/coupon_list.js.
//
// Usage:  node make-indexes.mjs
// Run it after editing either list, then commit the regenerated JSON.
//
// The source lists are browser/Vercel ES modules. Rather than depend on the
// repo's module resolution, we read each file's text, strip the leading
// `export ` keywords, and evaluate it in an isolated scope to pull out the data
// arrays. Only pure data/const literals are read; no list function is invoked.
// =============================================================================
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = dirname(fileURLToPath(import.meta.url));

function loadSymbols(relPath, wanted) {
  const src = readFileSync(join(ROOT, relPath), 'utf8').replace(/^\s*export\s+/gm, '');
  const fn = new Function(src + '\nreturn { ' + wanted.join(', ') + ' };');
  return fn();
}

const ins = loadSymbols('lib/insert_list.js', ['INSERT_INDEX_VERSION', 'INSERT_ERA', 'INSERT_BOOKS', 'INSERT_TITLES']);
const insertIndex = {
  version: ins.INSERT_INDEX_VERSION,
  era: ins.INSERT_ERA,
  books: ins.INSERT_BOOKS,
  candidates: ins.INSERT_TITLES,
};

const cou = loadSymbols('lib/coupon_list.js', ['COUPON_INDEX_VERSION', 'COUPON_BOOKS']);
const couponIndex = {
  version: cou.COUPON_INDEX_VERSION,
  books: cou.COUPON_BOOKS,
};

writeFileSync(join(ROOT, 'insert_index.json'), JSON.stringify(insertIndex, null, 2) + '\n');
writeFileSync(join(ROOT, 'coupon_index.json'), JSON.stringify(couponIndex, null, 2) + '\n');

console.log(`insert_index.json  ->  ${insertIndex.books.length} books, ${insertIndex.candidates.length} candidates  (v${insertIndex.version})`);
console.log(`coupon_index.json  ->  ${couponIndex.books.length} books  (v${couponIndex.version})`);
