// check-undefined-names.mjs — v6.42
//
// WHY THIS EXISTS. v6.41 shipped one line that killed every Deep assessment:
//
//     dbg(`deep refund test: ...`)
//
// inside assessHighGrade. `dbg` is a LOCAL const declared inside mountResults,
// a different function, so the call threw ReferenceError the moment a Deep
// came back. The surrounding catch turned that into the generic "Assessment
// failed. Please try again. (No credit was used.)" — while the server had
// already finished the work and charged for it. Every gate we had passed:
// `node --check` only parses, and a parser cannot see that a name has nowhere
// to resolve to. It is the second Deep-breaking regression to pass clean.
//
// So: a real scope check. It runs ESLint with ONE rule, no-undef, over all of
// index.html's inline script blocks CONCATENATED into a single virtual file.
// Concatenated, because those blocks share one global scope at runtime -
// linting them separately would report thousands of false positives for names
// defined one block over, and a check that cries wolf gets switched off.
//
// Run: node check-undefined-names.mjs
// Exits 1 on any undefined name.

import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

const SRC = 'index.html';
const html = readFileSync(SRC, 'utf8');

// Same extraction as check-index-syntax.mjs: opening tag, then body up to the
// matching close. Blocks with a src= attribute have no body to lint.
const blocks = [];
const re = /<script\b([^>]*)>([\s\S]*?)<\/script>/g;
let m;
while ((m = re.exec(html)) !== null) {
  const attrs = m[1] || '';
  if (/\bsrc\s*=/.test(attrs)) continue;
  if (/\btype\s*=\s*["'](?!text\/javascript|module|application\/javascript)/.test(attrs)) continue;
  const line = html.slice(0, m.index).split('\n').length;
  blocks.push({ line, isModule: /\btype\s*=\s*["']module["']/.test(attrs), code: m[2] });
}

// An `import` statement cannot appear inside a block statement, and deleting
// it would unbind every name it brings in - which is most of the Firebase SDK.
// So rewrite each import into a declaration that binds exactly the same names
// and nothing else. One line in, one line out, so the line map stays true.
function importsToBindings(code) {
  return code
    .replace(/^\s*import\s+\*\s+as\s+([A-Za-z_$][\w$]*)\s+from\s+[^;\n]+;?\s*$/gm,
             'const $1 = {};')
    .replace(/^\s*import\s+\{([^}]*)\}\s+from\s+[^;\n]+;?\s*$/gm,
             'const {$1} = {};')
    .replace(/^\s*import\s+([A-Za-z_$][\w$]*)\s*,\s*\{([^}]*)\}\s+from\s+[^;\n]+;?\s*$/gm,
             'const $1 = {}, {$2} = {};')
    .replace(/^\s*import\s+([A-Za-z_$][\w$]*)\s+from\s+[^;\n]+;?\s*$/gm,
             'const $1 = {};')
    .replace(/^\s*import\s+[^;\n]+;?\s*$/gm, ';');   // side-effect import
}

// One virtual file, with a line map back to index.html. A module block's
// import statements are stripped: they declare names the other blocks then use
// through window, and leaving them in would make the whole file a module,
// which changes the scoping rules for everything else.
let out = '';
const map = [];          // virtual line -> { srcLine }
const push = (text, srcLineStart) => {
  const lines = text.split('\n');
  lines.forEach((l, i) => { out += l + '\n'; map.push(srcLineStart + i); });
};
for (const b of blocks) {
  if (b.isModule) {
    // A module has its OWN top-level scope, so its let/const do not collide
    // with a classic script's. Concatenating them flat invents conflicts that
    // do not exist at runtime ("Identifier 'db' has already been declared").
    // A block statement models that exactly. Its imports are stripped: they
    // bind names the other blocks reach through window, and keeping them would
    // make the whole virtual file a module and change scoping for everything.
    push('{', b.line);
    push(importsToBindings(b.code), b.line);
    push('}', b.line);
  } else {
    // Classic scripts genuinely DO share one global scope, so they stay flat -
    // and a real duplicate declaration between two of them is a real bug.
    push(b.code, b.line);
  }
}

// The scratch file has to live under the CWD: eslint refuses anything outside
// its base path, and the base path is where it is invoked from. A FIXED name,
// overwritten each run and gitignored, so the check needs no delete permission
// to be re-runnable - cleanup below is best-effort and never fatal.
const dir = join(process.cwd(), '.rg-undef');
mkdirSync(dir, { recursive: true });
const file = join(dir, 'all-blocks.js');
writeFileSync(file, out);
const BROWSER_GLOBALS = [
  // Browser + platform names this file legitimately reaches for. Anything NOT
  // in here and not declared in the file is what we want to hear about.
  'window','document','navigator','location','history','console','alert','confirm','prompt',
  'setTimeout','clearTimeout','setInterval','clearInterval','requestAnimationFrame',
  'cancelAnimationFrame','queueMicrotask','fetch','Headers','Request','Response','FormData',
  'URL','URLSearchParams','Blob','File','FileReader','Image','Audio','Option','CSS','DOMParser',
  'localStorage','sessionStorage','indexedDB','caches','crypto','performance',
  'screen','matchMedia','getComputedStyle','scrollTo','scrollBy','open','close','print',
  'addEventListener','removeEventListener','dispatchEvent','Event','CustomEvent','MouseEvent',
  'KeyboardEvent','TouchEvent','PointerEvent','AbortController','AbortSignal','MutationObserver',
  'IntersectionObserver','ResizeObserver','Worker','structuredClone','btoa','atob',
  'HTMLElement','HTMLCanvasElement','HTMLImageElement','Node','NodeList','Element','Text',
  'XMLHttpRequest','WebSocket','OffscreenCanvas','createImageBitmap','ImageData','Path2D',
  'TextEncoder','TextDecoder','Intl','globalThis','self','top','parent','frames','devicePixelRatio',
  'innerWidth','innerHeight','pageXOffset','pageYOffset','scrollX','scrollY','visualViewport',
  'speechSynthesis','SpeechSynthesisUtterance','Notification','ServiceWorker','clients',
  // Third-party tags that define themselves before our code runs, plus the
  // UMD `module` guard. Real at runtime, invisible to a static read.
  'fbq','_fbq','dataLayer','gtag','ga','module','require','exports',
  'Capacitor','QRCode','html2canvas','jspdf','jsPDF','Panzoom','firebase',
  'ReadableStream','JSZip','Cropper',
  // Injected into the iOS bundle by make-ios-index.mjs, so they are absent from
  // index.html BY DESIGN and their only caller is guarded by isNativePlatform().
  // Verified present in make-ios-index.mjs before being listed here - do not add
  // a name to this line to silence a finding without checking that first.
  '_iosFetchPrices','_applyIosPrices',
];
const globalsObj = {};
for (const n of BROWSER_GLOBALS) globalsObj[n] = 'readonly';
writeFileSync(join(dir, 'eslint.config.mjs'),
  'export default [{\n' +
  "  files: ['**/*.js'],\n" +
  '  languageOptions: {\n' +
  "    ecmaVersion: 'latest',\n" +
  "    sourceType: 'script',\n" +
  '    globals: ' + JSON.stringify(globalsObj) + ',\n' +
  '  },\n' +
  // v6.60: no-use-before-define JOINS no-undef, and it earned its place.
  // `const g` sat BELOW a branch that read `g`, so a facsimile with a manual
  // FMV curve threw "Cannot access 'g' before initialization" out of
  // matchFMV and froze the app on "ASSESSING..." with the credit charged.
  // no-undef cannot see that: `g` IS defined in scope, just later. A
  // temporal-dead-zone read is a name that resolves to nothing at the moment
  // it runs, which is the same failure this script exists for.
  // functions:false and classes:false because declarations hoist and flagging
  // them would bury the real finding in hundreds of false positives;
  // variables:true is the whole point.
  "  rules: { 'no-undef': 'error',\n" +
  "           'no-use-before-define': ['error', { functions: false, classes: false, variables: true }] },\n" +
  '}];\n');


const cleanup = () => { try { rmSync(dir, { recursive: true, force: true }); } catch (e) {} };

// v6.65: maxBuffer. eslint's JSON formatter attaches the file's whole SOURCE to
// a result that has messages, so the payload is index.html's combined blocks -
// about 1.1MB once this file passed ~19,000 lines. Node's default maxBuffer is
// 1MB, so execFileSync started throwing ENOBUFS and the gate reported "eslint
// returned something that is not JSON" against a perfectly valid file. It was
// reading a TRUNCATED payload, not a broken one, and it would have kept failing
// forever as the app grew.
let raw = '';
try {
  raw = execFileSync('npx', ['eslint', '--no-ignore', '-f', 'json',
                             '-c', join(dir, 'eslint.config.mjs'), file],
                     { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
} catch (e) {
  raw = (e.stdout || '').toString();       // eslint exits 1 when it finds something
  if (!raw.trim()) {
    console.error('could not run eslint:', (e.stderr || e.message || '').toString().slice(0, 400));
    console.error('install it with:  npm i -D eslint@9.15.0');
    cleanup();
    process.exit(2);
  }
}
cleanup();

let results = [];
try { results = JSON.parse(raw); } catch (e) {
  console.error('eslint returned something that is not JSON:', raw.slice(0, 300));
  process.exit(2);
}
const all = (results[0] && results[0].messages) || [];

// TWO RULES, TWO SEVERITIES, AND THE SPLIT MATTERS.
//
// no-undef is fatal: the name resolves to NOTHING, anywhere, ever.
//
// no-use-before-define is ADVISORY, because ESLint judges textual position
// and not execution order. The overwhelming majority of its hits are a
// function body referring to a `let` declared further down the file — which
// is completely safe, because the function is not called until long after
// that line has run. Making those fail the build would bury the one real
// finding in forty safe ones, and a gate that cries wolf gets ignored. That
// is the "a check that encodes the wrong belief is worse than no check" rule
// in HOW_WE_WORK §3.
//
// THE DANGEROUS CASE, and the one that cost an app freeze and a charged
// credit on 2026-11-13: the read and the declaration are in the SAME
// straight-line path, so the read really does hit the temporal dead zone.
// Nothing here can tell those apart automatically — read each one and ask
// "does this line run before that declaration does?"
const fatal = all.filter(m => m.ruleId === 'no-undef');
const tdz   = all.filter(m => m.ruleId === 'no-use-before-define');

if (tdz.length) {
  console.log('\n' + tdz.length + ' use-before-define (ADVISORY — most are safe; see the note in this file):\n');
  for (const x of tdz) console.log('  ' + SRC + ':' + map[x.line - 1] + '  ' + x.message);
}

if (!fatal.length) {
  console.log((tdz.length ? '\n' : '') + '  ok    every name resolves (' + blocks.length
              + ' inline block(s), ' + map.length + ' lines)'
              + (tdz.length ? '  [' + tdz.length + ' advisory]' : ''));
  process.exit(0);
}
console.log('\n' + fatal.length + ' UNDEFINED NAME(S) — each one throws the moment that line runs:\n');
for (const x of fatal) {
  const src = map[x.line - 1];
  console.log('  ' + SRC + ':' + src + '  ' + x.message);
}
console.log('\nA name with nowhere to resolve to is a ReferenceError waiting for a user.');
process.exit(1);
