#!/usr/bin/env node
// make-android-index.mjs — generate the Android Capacitor web/index.html from
// production index.html. Sibling of make-ios-index.mjs.
//
// Usage:  node make-android-index.mjs <path-to-production-index.html> <output-path>
// e.g.    node make-android-index.mjs index.html android/app/src/main/assets/public/index.html
//
// WHY THIS EXISTS: the Android app (like iOS) loads LOCAL web assets in a
// WebView and its index.html is a PATCHED copy of production. Hand-maintaining
// that copy loses fixes. This script applies every Android delta mechanically
// and FAILS LOUDLY if a production anchor drifts, so a broken build can't ship
// silently. Mirrors make-ios-index.mjs exactly in spirit.
//
// RELATIONSHIP TO make-ios-index.mjs:
//   SHARED deltas (identical intent): fetch interceptor, initializeAuth +
//   indexedDBLocalPersistence, remove getRedirectResult-on-load, local asset
//   URLs, disable cross-origin SSE streaming, StoreKit/Billing modal price IDs.
//   ANDROID-ONLY: the native runtime script (hardware back button + hide the
//   Apple button, which has no native path on Android), and the billing helpers
//   post to /api/verify_play with a Google Play {purchaseToken, productId}
//   instead of iOS's StoreKit {jws} → /api/verify_iap.
//   NOT PORTED from iOS: the splash sign-in choreography (D7) and Dynamic-Island
//   safe-area deltas (D15/D16/D17) are iPhone-specific cosmetics. Android uses
//   the base #auth-screen with the existing native sign-in buttons, which the
//   base file already shows for ANY native platform via isNativePlatform().
//
// The @capacitor-firebase/authentication plugin (iosNativeSignIn) already does
// NATIVE Google sign-in on Android — no delta needed for the primary sign-in.

import { readFileSync, writeFileSync, copyFileSync, existsSync } from 'fs';
import { dirname, join } from 'path';

const [, , inPath, outPath] = process.argv;
if (!inPath || !outPath) {
  console.error('Usage: node make-android-index.mjs <production-index.html> <output-index.html>');
  process.exit(1);
}

let html = readFileSync(inPath, 'utf8');
let applied = 0;

function mustReplace(label, anchor, replacement) {
  const i = html.indexOf(anchor);
  if (i === -1) {
    console.error(`FAIL [${label}]: anchor not found. Production index.html has drifted — update this delta.`);
    console.error('--- anchor was ---\n' + anchor.slice(0, 300));
    process.exit(1);
  }
  if (html.indexOf(anchor, i + 1) !== -1) {
    console.error(`FAIL [${label}]: anchor matches more than once — make it more specific.`);
    process.exit(1);
  }
  html = html.slice(0, i) + replacement + html.slice(i + anchor.length);
  applied++;
  console.log(`ok  [${label}]`);
}

// ── A1: fetch interceptor + Android native runtime ───────────────────────────
// Same /api/* + JSON-data routing as iOS D1, plus an Android-only runtime block:
//   • Hardware/gesture BACK button: without a handler, Android's back gesture
//     closes the whole app from any screen. We close open modals / go back in
//     history first, and only let the OS background the app at the root.
//   • Hide the "Sign in with Apple" button on Android — there is no native Apple
//     path on the device; Google is the native sign-in. (Kept in the DOM for
//     iOS; removed at runtime here.)
//   • Add a platform class for any Android-specific CSS hooks later.
mustReplace('A1 fetch interceptor + android runtime', '<head>', `<head>
<script>
// ANDROID LOCAL APP: route /api/* AND the server-hosted JSON data files to
// production. value-keys.json and fmv.json live ONLY at the repo root (served by
// Vercel); they are NOT bundled into the local Android web assets. Routing them
// to the server means they read off the deployed repo and update WITHOUT a Play
// Store rebuild — same as /api/. (manifest.json is deliberately NOT routed.)
(function() {
  var _origFetch = window.fetch;
  window.fetch = function(url, opts) {
    if (typeof url === 'string' && (url.startsWith('/api/') || url === '/value-keys.json' || url === '/fmv.json' || url === '/fmv_comics.json' || url === '/fmv_pokemon.json' || url === '/insert_index.json' || url === '/coupon_index.json')) {
      url = 'https://robograder.app' + url;
    }
    return _origFetch.call(this, url, opts);
  };
})();
// Android native runtime: back button, platform class, hide Apple sign-in.
(function() {
  function isAndroid() {
    try { return window.Capacitor && typeof window.Capacitor.getPlatform === 'function' && window.Capacitor.getPlatform() === 'android'; }
    catch (e) { return false; }
  }
  document.addEventListener('DOMContentLoaded', function() {
    if (!isAndroid()) return;
    document.documentElement.classList.add('platform-android');
    // Hide the Apple button (no native Apple sign-in on Android).
    try {
      document.querySelectorAll('button[onclick*="iosNativeSignIn(\\'apple\\')"]').forEach(function(b) { b.style.display = 'none'; });
    } catch (e) {}
    // Hardware back button: dismiss any visible modal, else history-back, else
    // let the app background at the root. @capacitor/app must be installed.
    try {
      var App = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.App;
      if (App && typeof App.addListener === 'function') {
        App.addListener('backButton', function(ev) {
          // Delegate to the app's view-aware handler (closes camera/cropper/
          // lightbox/buy-modal, then detail/edit -> list). Exit only when it
          // reports there is nothing left to pop.
          try {
            if (typeof window.rgHandleBack === 'function' && window.rgHandleBack()) return;
          } catch (e) {}
          if (App.exitApp) App.exitApp();
        });
      }
    } catch (e) {}
  });
})();
</script>`);

// ── A2: firebase-auth import gains initializeAuth + indexedDBLocalPersistence ─
// Android WebView, like WKWebView, benefits from indexedDB persistence and
// avoids the popup/redirect startup handshake (native sign-in returns a
// credential we exchange via signInWithCredential). Identical to iOS D2.
mustReplace('A2 auth import',
`import { getAuth, GoogleAuthProvider, OAuthProvider, signInWithPopup, signInWithRedirect, getRedirectResult, signInWithCredential, signInWithCustomToken, signOut, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js";`,
`import { getAuth, GoogleAuthProvider, OAuthProvider, signInWithPopup, signInWithRedirect, getRedirectResult, signInWithCredential, signInWithCustomToken, signOut, onAuthStateChanged, initializeAuth, indexedDBLocalPersistence } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js";`);

// ── A3: initializeAuth instead of getAuth ────────────────────────────────────
mustReplace('A3 initializeAuth',
`const auth = getAuth(app);`,
`const auth = initializeAuth(app, { persistence: indexedDBLocalPersistence });`);

// ── A4: remove getRedirectResult on load ─────────────────────────────────────
mustReplace('A4 remove getRedirectResult',
`// Capacitor iOS: check for redirect result on page load
if (window.Capacitor && window.Capacitor.isNativePlatform()) {
  getRedirectResult(auth).catch(() => {});
}`,
`// Native (iOS/Android): redirect result check REMOVED — native sign-in returns
// a credential exchanged via signInWithCredential, not a redirect.
`);

// ── A5: asset URLs → local ───────────────────────────────────────────────────
{
  const prefix = 'https://raw.githubusercontent.com/OgreBuzzard/ai-comic-grader-app/main/assets/';
  const n = html.split(prefix).length - 1;
  if (n === 0) {
    console.error('FAIL [A5 asset URLs]: no raw.githubusercontent asset URLs found — check the prefix.');
    process.exit(1);
  }
  html = html.split(prefix).join('assets/');
  applied++;
  console.log(`ok  [A5 asset URLs] (${n} rewritten)`);
}

// ── A6: disable SSE streaming on native (cross-origin WebView) ───────────────
// The website grades via a SAME-ORIGIN SSE stream. The app rewrites the assess
// call to https://robograder.app (cross-origin); a streamed SSE response over a
// cross-origin fetch stalls in the WebView. Force the non-streaming JSON path.
// Same replacement as iOS D9 (the isNativePlatform() guard already covers
// Android). Cost-neutral: same prompt, same single call.
mustReplace('A6 disable native streaming',
`function supportsResponseStreaming() {
  try {
    return typeof ReadableStream !== "undefined" && typeof TextDecoder !== "undefined" && new Response(new ReadableStream).body && typeof new Response(new ReadableStream).body.getReader === "function";
  } catch (e) {
    return false;
  }
}`,
`function supportsResponseStreaming() {
  // Native (iOS/Android): force non-streaming. Cross-origin SSE stalls in the WebView.
  if (window.Capacitor && window.Capacitor.isNativePlatform()) return false;
  try {
    return typeof ReadableStream !== "undefined" && typeof TextDecoder !== "undefined" && new Response(new ReadableStream).body && typeof new Response(new ReadableStream).body.getReader === "function";
  } catch (e) {
    return false;
  }
}`);

// ── A7: Google Play Billing via @capgo/native-purchases ──────────────────────
// Mirrors iOS D8 but for Android: the SAME @capgo NativePurchases plugin drives
// Google Play Billing. purchaseProduct returns a Transaction whose transactionId
// IS the Google Play purchaseToken on Android. We POST {purchaseToken, productId}
// to /api/verify_play (NOT verify_iap — Android has no StoreKit JWS). Crediting
// is server-side and idempotent (keyed on the Google order id).

// 7a: buyCredits routes to Play Billing on native (PWA keeps Stripe below).
mustReplace('A7a buyCredits native branch',
`  try {
    const token = await window._currentUser.getIdToken();
    const resp = await fetch("/api/checkout", {`,
`  try {
    if (window.Capacitor && window.Capacitor.isNativePlatform()) { await _androidBuyCredits(pkg); return; }
    const token = await window._currentUser.getIdToken();
    const resp = await fetch("/api/checkout", {`);

// 7b: inject Play Billing helpers + hook _androidLoadPrices into showBuyCredits.
mustReplace('A7b play billing helpers + showBuyCredits hook',
`function showBuyCredits() {
  const modal = document.getElementById("buy-credits-modal");
  if (modal) modal.style.display = "flex";
  refreshPromoRow();
  refreshReferralEligibility();
  refreshShortBoxCard();
}`,
`__PLAY__
function showBuyCredits() {
  const modal = document.getElementById("buy-credits-modal");
  if (modal) modal.style.display = "flex";
  refreshPromoRow();
  refreshReferralEligibility();
  refreshShortBoxCard();
  if (window.Capacitor && window.Capacitor.isNativePlatform()) _androidLoadPrices();
}`.replace('__PLAY__', `
// ── Android Google Play Billing via @capgo/native-purchases (NativePurchases) ─
// purchaseProduct -> transactionId(=purchaseToken) -> /api/verify_play verifies
// with the Play Developer API + credits -> refresh. Idempotent server-side
// (keyed on Google order id). Product IDs mirror iOS (shortbox2 is the live one).
const PLAY_PRODUCT_IDS = {
  comic_stack: 'app.robograder.credits.stack',
  comic_wall:  'app.robograder.credits.wall',
  short_box:   'app.robograder.credits.shortbox2',
};
const PLAY_CREDITS = { comic_stack: 5, comic_wall: 20, short_box: 100 };

function _isCancelError(e) {
  if (!e) return false;
  const msg = ((e.message || '') + '').toLowerCase();
  const code = ((e.code != null ? e.code : '') + '').toLowerCase();
  // Google Play user-cancel surfaces as BillingResponse 1 ("USER_CANCELED").
  return /cancel/.test(msg) || /cancel/.test(code) || code === '1';
}

async function _androidBuyCredits(pkg) {
  const NP = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.NativePurchases;
  const productId = PLAY_PRODUCT_IDS[pkg];
  if (!NP || !productId) { window.rgPopup("Purchases are unavailable right now. Please try again.", { type: "error" }); return; }
  let txn;
  try {
    txn = await NP.purchaseProduct({
      productIdentifier: productId, productType: 'inapp', quantity: 1,
      isConsumable: true, autoAcknowledgePurchases: true
    });
  } catch (e) {
    if (!_isCancelError(e)) {
      const msg = ((e && (e.message || e.code)) || 'Unknown error') + '';
      window.rgPopup("Purchase failed: " + msg, { type: "error" });
    }
    return;
  }
  // On Android the plugin exposes the Google Play purchaseToken as transactionId.
  const purchaseToken = txn && (txn.transactionId || txn.purchaseToken);
  if (!purchaseToken) { window.rgPopup("Purchase couldn't be verified (no token). If you were charged, email support@robograder.app.", { type: "error" }); return; }
  try {
    const idToken = await window._currentUser.getIdToken();
    const resp = await fetch("/api/verify_play", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + idToken },
      body: JSON.stringify({ purchaseToken, productId })
    });
    const data = await resp.json().catch(function(){ return {}; });
    if (resp.ok && data.ok) { await loadUserCredits(); hideBuyCredits(); window.rgPopup("Added " + data.credits + " assessments to your account.", { type: "success", title: "Purchase complete" }); }
    else { window.rgPopup("We couldn't credit your purchase: " + (data.error || "unknown error") + "\\n\\nIf you were charged, your receipt is on file — email support@robograder.app and we'll fix it.", { type: "error" }); }
  } catch (e) {
    window.rgPopup("Network error verifying your purchase. If you were charged, reopen the app or email support@robograder.app.", { type: "error" });
  }
}

let _playPriceCache = null;
function _applyPlayPrices(products) {
  const byId = {};
  Object.keys(PLAY_PRODUCT_IDS).forEach(function(k) { byId[PLAY_PRODUCT_IDS[k]] = k; });
  (products || []).forEach(function(p) {
    const key = byId[p.identifier];
    if (!key) return;
    const priceEl = document.getElementById('price-' + key);
    if (priceEl && p.priceString) priceEl.textContent = p.priceString;
    const unitEl = document.getElementById('unit-' + key);
    const credits = PLAY_CREDITS[key];
    if (unitEl && typeof p.price === 'number' && credits) {
      try { unitEl.textContent = '(' + new Intl.NumberFormat(undefined, { style: 'currency', currency: p.currencyCode || 'USD' }).format(p.price / credits) + ' each)'; } catch (e) {}
    }
  });
}
async function _playFetchPrices() {
  const NP = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.NativePurchases;
  if (!NP) return null;
  const res = await NP.getProducts({ productIdentifiers: Object.values(PLAY_PRODUCT_IDS), productType: 'inapp' });
  const products = (res && res.products) || [];
  if (products.length) _playPriceCache = products;
  return products;
}
async function _androidLoadPrices() {
  if (_playPriceCache) { _applyPlayPrices(_playPriceCache); return; }
  try { const products = await _playFetchPrices(); if (products) _applyPlayPrices(products); }
  catch (e) { console.log('[iap] getProducts failed:', e && e.message); }
}
`));

// 7c/d/e: give the modal price/unit divs IDs so Play prices inject (identical to
// iOS D8c/d/e — these just add IDs and are platform-agnostic).
mustReplace('A7c modal ids comic_stack',
`          <div style="font-size:15px;font-weight:700;color:#1a1008;margin-top:1px">$10</div>
          <div style="font-size:13px;color:#3a2a1a;margin-top:3px">5 assessments</div>
          <div style="font-size:12px;color:#6a5a4a;margin-top:1px">($2.00 each)</div>`,
`          <div id="price-comic_stack" style="font-size:15px;font-weight:700;color:#1a1008;margin-top:1px">$10</div>
          <div style="font-size:13px;color:#3a2a1a;margin-top:3px">5 assessments</div>
          <div id="unit-comic_stack" style="font-size:12px;color:#6a5a4a;margin-top:1px">($2.00 each)</div>`);

mustReplace('A7d modal ids comic_wall',
`          <div style="font-size:15px;font-weight:700;color:#1a1008;margin-top:1px">$30</div>
          <div style="font-size:13px;color:#3a2a1a;margin-top:3px">20 assessments</div>
          <div style="font-size:12px;color:#6a5a4a;margin-top:1px">($1.50 each)</div>`,
`          <div id="price-comic_wall" style="font-size:15px;font-weight:700;color:#1a1008;margin-top:1px">$30</div>
          <div style="font-size:13px;color:#3a2a1a;margin-top:3px">20 assessments</div>
          <div id="unit-comic_wall" style="font-size:12px;color:#6a5a4a;margin-top:1px">($1.50 each)</div>`);

mustReplace('A7e modal ids short_box',
`          <div style="font-size:15px;font-weight:700;color:#1a1008;margin-top:1px">$100</div>
          <div style="font-size:13px;color:#3a2a1a;margin-top:3px">100 assessments</div>
          <div id="unit-short_box" style="font-size:12px;color:#6a5a4a;margin-top:1px">($1.00 each)</div>`,
`          <div id="price-short_box" style="font-size:15px;font-weight:700;color:#1a1008;margin-top:1px">$100</div>
          <div style="font-size:13px;color:#3a2a1a;margin-top:3px">100 assessments</div>
          <div id="unit-short_box" style="font-size:12px;color:#6a5a4a;margin-top:1px">($1.00 each)</div>`);

// ── A8: force Firestore long-polling on Android ──────────────────────────────
// The production client uses experimentalAutoDetectLongPolling. Auto-detect's
// probe is unreliable in the Android WebView (slow/failed initial connect,
// recurring WebChannel transport errors). Forcing long-polling skips detection
// and connects reliably — verified delivering the full collection on-device.
// Android-only; iOS/web keep auto-detect.
mustReplace('A8 force Firestore long-polling',
`const db = initializeFirestore(app, {
  experimentalAutoDetectLongPolling: true
});`,
`const db = initializeFirestore(app, {
  experimentalForceLongPolling: true
});`);

// ── A9: neutralize the iOS StoreKit price prefetch on Android ─────────────────
// The base app calls _iosPrefetchPrices() at startup, which invokes
// _iosFetchPrices() — a function INJECTED ONLY by make-ios-index.mjs. It's
// guarded by isNativePlatform, which is ALSO true on Android, so on Android the
// call reaches _iosFetchPrices() (undefined) and throws an uncaught
// ReferenceError right after the first snapshot resolves. That aborts the render
// and the app hangs on Loading with the data already in memory. Rewire the
// prefetch to the Play Billing helpers (defined in A7); typeof-guarded + wrapped
// so it can never throw even if a helper is missing.
mustReplace('A9 android price prefetch → Play Billing',
`  _iosPricePrefetched = true;
  _iosFetchPrices().then(function(p) { if (p) _applyIosPrices(p); }).catch(function() {});`,
`  _iosPricePrefetched = true;
  try { if (typeof _playFetchPrices === 'function') _playFetchPrices().then(function(p) { if (p && typeof _applyPlayPrices === 'function') _applyPlayPrices(p); }).catch(function() {}); } catch (e) {}`);

writeFileSync(outPath, html);
console.log(`\nAll ${applied} deltas applied. Wrote ${outPath} (${html.length.toLocaleString()} bytes).`);

// Re-stage the locally-bundled sibling files (robograde-panel.js, etc.) next to
// the generated index so they can NEVER go stale in the app bundle — this is how
// the Photograder render was lost in 1.0.4. Parse the index for /*.js|css refs,
// copy each from the source dir to the output dir.
{
  const srcDir = dirname(inPath), outDir = dirname(outPath);
  const siblings = [...new Set([...html.matchAll(/(?:src|href)="\/([a-zA-Z0-9_.\-]+\.(?:js|css))"/g)].map(m => m[1]))];
  let copied = 0;
  for (const f of siblings) {
    const from = join(srcDir, f), to = join(outDir, f);
    if (from === to || !existsSync(from)) continue;
    try { copyFileSync(from, to); copied++; console.log(`  staged sibling: ${f}`); }
    catch (e) { console.error(`  WARN could not stage ${f}: ${e.message}`); }
  }
  console.log(`Staged ${copied} bundled sibling file(s) alongside the index.`);
}
