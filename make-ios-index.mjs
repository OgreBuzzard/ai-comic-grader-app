#!/usr/bin/env node
// make-ios-index.mjs — generate the iOS Capacitor web/index.html from production index.html
//
// Usage:  node make-ios-index.mjs <path-to-production-index.html> <output-path>
// e.g.    node make-ios-index.mjs index.html web/index.html
//
// WHY THIS EXISTS (S17): the iOS app loads local files, and its index.html is a
// PATCHED copy of production. Hand-maintaining that copy loses fixes. This script
// applies every iOS delta mechanically. If production drifts so an anchor no longer
// matches, the script FAILS LOUDLY instead of silently producing a broken build.
//
// THE iOS DELTAS (do not remove any without understanding the S16 handoff):
//  D1. Fetch interceptor — /api/* → https://robograder.app (local files have no server)
//  D2/D3. initializeAuth(app,{persistence:indexedDBLocalPersistence}) instead of getAuth(app)
//      — getAuth's popup/redirect startup handshake HANGS in WKWebView and silently
//      queues every auth op behind it. NEVER revert this in the iOS file.
//  D4. getRedirectResult-on-load removed — triggered SOAuthorizationCoordinator interference
//  D5. raw.githubusercontent asset URLs → local relative paths
//  D6. In-app browser sheet sign-in (SFSafariViewController via @capacitor/browser):
//      open auth bridge in a sheet, poll /api/ios-auth while it's up, Browser.close()
//      on token, signInWithCustomToken. Falls back to external Safari + same poll
//      loop if the Browser plugin isn't available.
//  D7. Combined splash/sign-in: signed-out state slides the sign-in controls up into
//      the splash composition instead of cutting to the separate #auth-screen.

import { readFileSync, writeFileSync } from 'fs';

const [, , inPath, outPath] = process.argv;
if (!inPath || !outPath) {
  console.error('Usage: node make-ios-index.mjs <production-index.html> <output-index.html>');
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

// ── D1: fetch interceptor ────────────────────────────────────────────────────
mustReplace('D1 fetch interceptor', '<head>', `<head>
<script>
// iOS LOCAL APP: intercept fetch calls to /api/* and route to production server.
// This file is ONLY used in the iOS Capacitor app, so no Capacitor detection needed.
(function() {
  var _origFetch = window.fetch;
  window.fetch = function(url, opts) {
    if (typeof url === 'string' && url.startsWith('/api/')) {
      url = 'https://robograder.app' + url;
    }
    return _origFetch.call(this, url, opts);
  };
})();
</script>`);

// ── D2: firebase-auth import gains initializeAuth + indexedDBLocalPersistence ─
mustReplace('D2 auth import',
`import { getAuth, GoogleAuthProvider, signInWithPopup, signInWithRedirect, getRedirectResult, signInWithCustomToken, signOut, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js";`,
`import { getAuth, GoogleAuthProvider, signInWithPopup, signInWithRedirect, getRedirectResult, signInWithCustomToken, signOut, onAuthStateChanged, initializeAuth, indexedDBLocalPersistence } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js";`);

// ── D3: initializeAuth instead of getAuth ────────────────────────────────────
mustReplace('D3 initializeAuth',
`const auth = getAuth(app);`,
`const auth = initializeAuth(app, { persistence: indexedDBLocalPersistence });`);

// ── D4: remove getRedirectResult on load ─────────────────────────────────────
mustReplace('D4 remove getRedirectResult',
`// Capacitor iOS: check for redirect result on page load
if (window.Capacitor && window.Capacitor.isNativePlatform()) {
  getRedirectResult(auth).catch(() => {});
}`,
`// iOS: redirect result check REMOVED — the auth bridge handles sign-in
// via signInWithCustomToken, not redirect. The getRedirectResult call
// was triggering SOAuthorizationCoordinator interference on iOS.`);

// ── D5: asset URLs → local ───────────────────────────────────────────────────
{
  const prefix = 'https://raw.githubusercontent.com/OgreBuzzard/ai-comic-grader-app/main/assets/';
  const n = html.split(prefix).length - 1;
  if (n === 0) {
    console.error('FAIL [D5 asset URLs]: no raw.githubusercontent asset URLs found — check the prefix.');
    process.exit(1);
  }
  html = html.split(prefix).join('assets/');
  applied++;
  console.log(`ok  [D5 asset URLs] (${n} rewritten)`);
}

// ── D6: in-app browser sheet sign-in ─────────────────────────────────────────
mustReplace('D6 browser sheet sign-in',
`    if (window.Capacitor && window.Capacitor.isNativePlatform()) {
      // iOS app: open Safari auth bridge, then poll for the custom token
      const session = 'ios_' + Date.now() + '_' + Math.random().toString(36).slice(2, 10);
      window.open('https://robograder.app/auth-ios.html?s=' + session, '_blank');
      // Show polling status
      const iosStatus = document.getElementById('auth-ios-status');
      if (iosStatus) iosStatus.style.display = 'block';
      const poll = async () => {
        for (let i = 0; i < 120; i++) {
          await new Promise(r => setTimeout(r, 2000));
          try {
            const resp = await fetch('/api/ios-auth?session=' + session);
            if (resp.ok) {
              const data = await resp.json();
              if (data.customToken) {
                if (iosStatus) iosStatus.textContent = 'Signed in! Loading your collection...';
                await window._signInWithCustomToken(window._auth, data.customToken);
                await loadItems();
                return true;
              }
            }
          } catch (_) {}
        }
        return false;
      };
      const ok = await poll();
      if (!ok) {
        if (iosStatus) iosStatus.textContent = 'Sign-in timed out. Tap Continue to try again.';
      }
      return;
    }`,
`    if (window.Capacitor && window.Capacitor.isNativePlatform()) {
      // iOS app (S17): open the auth bridge in external Safari. When sign-in
      // completes, auth-ios.html redirects to the custom scheme robograder://
      // auth-complete, which iOS hands back to this app — foregrounding it. A
      // visibilitychange listener then polls /api/ios-auth for the custom token
      // and finishes sign-in. NO Capacitor plugin required (the @capacitor/browser
      // SPM package does not register in this no-bundler build). External Safari
      // also shares the user's existing Google session, so returning users often
      // skip the Google login entirely.
      const session = 'ios_' + Date.now() + '_' + Math.random().toString(36).slice(2, 10);
      const iosStatus = document.getElementById('splash-signin-status') || document.getElementById('auth-ios-status');
      if (iosStatus) { iosStatus.style.display = 'block'; iosStatus.textContent = 'Opening sign-in…'; }
      window._iosPendingSession = session;
      // Hook visibilitychange ONCE. Fires when the app returns to the foreground
      // (via the robograder:// scheme handback, or a manual switch as a fallback).
      if (!window._iosVisibilityHooked) {
        window._iosVisibilityHooked = true;
        document.addEventListener('visibilitychange', async function() {
          if (document.visibilityState !== 'visible' || !window._iosPendingSession) return;
          var s = window._iosPendingSession;
          var status = document.getElementById('splash-signin-status') || document.getElementById('auth-ios-status');
          if (status) { status.style.display = 'block'; status.textContent = 'Finishing sign-in…'; }
          for (var attempt = 0; attempt < 20; attempt++) {
            if (window._iosPendingSession !== s) return; // a newer attempt superseded this one
            try {
              var resp = await fetch('/api/ios-auth?session=' + s);
              if (resp.ok) {
                var data = await resp.json();
                if (data.customToken) {
                  window._iosPendingSession = null;
                  if (status) status.textContent = 'Signed in! Loading your collection…';
                  await window._signInWithCustomToken(window._auth, data.customToken);
                  if (typeof window.exitSplashSigninAndShowApp === 'function') window.exitSplashSigninAndShowApp();
                  await loadItems();
                  return;
                }
              }
            } catch (e) {}
            await new Promise(function(r) { setTimeout(r, 1000); });
          }
          if (status) status.textContent = 'Sign-in not detected. Tap Continue to try again.';
        });
      }
      window.open('https://robograder.app/auth-ios.html?s=' + session, '_blank');
      return;
    }`);

// ── D7a: splash markup — subtitle + sign-in panel ────────────────────────────
mustReplace('D7a splash markup',
`  <img id="splash-logo" src="assets/Robograder_Logo.webp" alt="Robograder"
       onerror="this.style.display='none'">
  <div id="splash-subtitle">COMIC GRADING APP</div>
</div>`,
`  <img id="splash-logo" src="assets/Robograder_Logo.webp" alt="Robograder"
       onerror="this.style.display='none'">
  <div id="splash-subtitle">COMIC GRADING APP</div>
  <div id="splash-signin">
    <div class="splash-signin-with">
      Sign in securely with
      <svg width="18" height="18" viewBox="0 0 24 24"><path fill="#c8c8c8" d="M17.05 20.28c-.98.95-2.05.88-3.08.4-1.09-.5-2.08-.48-3.24 0-1.44.62-2.2.44-3.06-.4C2.79 15.25 3.51 7.59 9.05 7.31c1.35.07 2.29.74 3.08.8 1.18-.24 2.31-.93 3.57-.84 1.51.12 2.65.72 3.4 1.8-3.12 1.87-2.38 5.98.48 7.13-.57 1.5-1.31 2.99-2.54 4.09zM12.03 7.25c-.15-2.23 1.66-4.07 3.74-4.25.29 2.58-2.34 4.5-3.74 4.25z"/></svg>
      or
      <svg width="18" height="18" viewBox="0 0 48 48"><path fill="#c8c8c8" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/><path fill="#c8c8c8" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/><path fill="#c8c8c8" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/><path fill="#c8c8c8" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.18 1.48-4.97 2.31-8.16 2.31-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/></svg>
    </div>
    <button id="splash-continue-btn" onclick="signInGoogle()">Continue</button>
    <div id="splash-signin-status">Waiting for sign-in to complete...</div>
    <div class="splash-signin-terms">By signing in you agree to our terms of service. Your collection data is private to your account.</div>
  </div>
</div>`);

// ── D7b: splash CSS — subtitle, panel, signin-mode choreography ──────────────
mustReplace('D7b splash CSS',
`    @keyframes splashLogoDropIn {
      to {
        transform: translate(-50%, 0);
        opacity: 1;
      }
    }`,
`    @keyframes splashLogoDropIn {
      to {
        transform: translate(-50%, 0);
        opacity: 1;
      }
    }
    /* ── iOS combined splash/sign-in (S17) ──────────────────────────────
       When signed out, sign-in controls slide up into the splash
       composition instead of cutting to the separate auth screen.
       .signin-mode  — added by enterSplashSignin() when auth resolves null
       .signin-fast  — added when re-showing a dismissed splash (sign-out);
                       skips the long entrance choreography delays. */
    #splash-subtitle {
      position: absolute;
      left: 50%;
      top: calc(env(safe-area-inset-top, 0px) + 5vh + 7vh);
      transform: translate(-50%, -120vh);
      text-align: center;
      font-size: 16px;
      letter-spacing: 1.5px;
      font-weight: 700;
      color: #1a1a1a;
      opacity: 0;
      pointer-events: none;
      z-index: 2;
      white-space: nowrap;
    }
    #splash.assets-ready #splash-subtitle {
      animation: splashSubtitleIn 0.6s cubic-bezier(0.22, 1, 0.36, 1) 0.95s forwards;
    }
    @keyframes splashSubtitleIn {
      to { transform: translate(-50%, 0); opacity: 0.9; }
    }
    #splash-signin {
      position: absolute;
      left: 0; right: 0; bottom: 0;
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 14px;
      padding: 12vh 24px calc(env(safe-area-inset-bottom, 0px) + 4.5vh);
      background: linear-gradient(to top, rgba(10,10,10,0.94) 0%, rgba(10,10,10,0.82) 55%, rgba(10,10,10,0) 100%);
      transform: translateY(110%);
      opacity: 0;
      pointer-events: none;
      z-index: 3;
    }
    #splash.signin-mode #splash-signin { pointer-events: auto; }
    #splash.assets-ready.signin-mode #splash-signin {
      animation: splashSigninUp 0.55s cubic-bezier(0.22, 1, 0.36, 1) 1.6s forwards;
    }
    #splash.assets-ready.signin-mode.signin-fast #splash-signin {
      animation-delay: 0.15s;
    }
    @keyframes splashSigninUp {
      to { transform: translateY(0); opacity: 1; }
    }
    .splash-signin-with {
      display: flex; align-items: center; justify-content: center; gap: 8px;
      font-size: 13px; color: #b8b8b8;
    }
    #splash-continue-btn {
      display: flex; align-items: center; justify-content: center;
      background: #2e7d32; color: #ffffff;
      box-shadow: 0 4px 14px rgba(0,0,0,0.35);
      border: none; border-radius: 10px;
      padding: 14px 28px; font-size: 16px; font-weight: 700;
      cursor: pointer; width: 280px; max-width: 80vw;
    }
    #splash-continue-btn:active { filter: brightness(0.92); }
    #splash-signin-status {
      display: none;
      font-size: 13px; color: #cfcfcf; text-align: center;
    }
    .splash-signin-terms {
      font-size: 11px; color: #8a8a8a; text-align: center; max-width: 280px; line-height: 1.5;
    }
    /* iOS splash position overrides (S17). Logo sits higher (clear of the
       Dynamic Island), robot drops lower so it clears the sign-in panel. */
    #splash-logo {
      top: calc(env(safe-area-inset-top, 0px) + 2vh) !important;
    }
    #splash-robot {
      top: calc(56% - 25px) !important;
    }
    #splash.signin-mode #splash-robot {
      top: calc(52% - 25px) !important;
    }`);

// ── D7c: splash sign-in mode helpers (window.enterSplashSignin / exit) ───────
mustReplace('D7c splash helpers',
`// Show iOS-specific auth UI when running in Capacitor
if (window.Capacitor && window.Capacitor.isNativePlatform()) {
  var _pwaBtns = document.getElementById('auth-pwa-buttons');
  var _iosBtns = document.getElementById('auth-ios-buttons');
  if (_pwaBtns) _pwaBtns.style.display = 'none';
  if (_iosBtns) _iosBtns.style.display = 'flex';
}`,
`// Show iOS-specific auth UI when running in Capacitor
if (window.Capacitor && window.Capacitor.isNativePlatform()) {
  var _pwaBtns = document.getElementById('auth-pwa-buttons');
  var _iosBtns = document.getElementById('auth-ios-buttons');
  if (_pwaBtns) _pwaBtns.style.display = 'none';
  if (_iosBtns) _iosBtns.style.display = 'flex';
}

// iOS combined splash/sign-in (S17): the signed-out state lives ON the splash.
// enterSplashSignin() — called when auth resolves to no user. Keeps (or
// re-shows) the splash and slides the sign-in panel up into it.
window.enterSplashSignin = function() {
  var splash = document.getElementById('splash');
  var authScreen = document.getElementById('auth-screen');
  var appEl = document.getElementById('app');
  if (!splash) { if (authScreen) authScreen.style.display = 'flex'; return; }
  if (appEl) appEl.style.display = 'none';
  if (authScreen) authScreen.style.display = 'none';
  if (splash.style.display === 'none' || splash.classList.contains('exit')) {
    // Re-showing after sign-out (or a dismissed splash): skip entrance choreography.
    splash.classList.remove('exit');
    splash.style.display = '';
    splash.classList.add('assets-ready');
    splash.classList.add('signin-fast');
    document.body.style.overflow = 'hidden';
  }
  splash.classList.add('signin-mode');
};
// exitSplashSigninAndShowApp() — called after a successful sign-in.
window.exitSplashSigninAndShowApp = function() {
  var splash = document.getElementById('splash');
  var authScreen = document.getElementById('auth-screen');
  var appEl = document.getElementById('app');
  if (splash) splash.classList.remove('signin-mode', 'signin-fast');
  if (authScreen) authScreen.style.display = 'none';
  if (appEl) appEl.style.display = '';
  if (typeof window.signalAppReady === 'function') window.signalAppReady();
  // If the splash was previously dismissed (sign-out -> sign-in again), the
  // app-ready listener inside runSplash is spent (once:true) — dismiss directly.
  setTimeout(function() {
    if (splash && splash.style.display !== 'none' && !splash.classList.contains('exit')) {
      splash.classList.add('exit');
      document.body.classList.add('app-ready');
      setTimeout(function() { splash.style.display = 'none'; document.body.style.overflow = ''; }, 460);
    }
  }, 60);
};`);

// ── D7d: onAuthStateChanged signed-out branch → splash sign-in ───────────────
mustReplace('D7d onAuthStateChanged signed-out',
`  } else {
    window._loadingState = false;
    if (authScreen) authScreen.style.display = "flex";
    if (appEl) appEl.style.display = "none";
    if (!window._firebaseReady) {
      window._firebaseReady = true;
      window.dispatchEvent(new Event("firebase-ready"));
    }
    if (typeof window.signalAppReady === "function") window.signalAppReady();
  }
});`,
`  } else {
    window._loadingState = false;
    // iOS: sign-in lives on the splash (no separate auth screen, splash stays up)
    if (appEl) appEl.style.display = "none";
    if (!window._firebaseReady) {
      window._firebaseReady = true;
      window.dispatchEvent(new Event("firebase-ready"));
    }
    if (typeof window.enterSplashSignin === "function") window.enterSplashSignin();
    else if (authScreen) authScreen.style.display = "flex";
  }
});`);

// ── D7e: auth fallback timer → splash sign-in ────────────────────────────────
mustReplace('D7e tryRevealAuthScreen',
`  const authScreen = document.getElementById("auth-screen");
  if (authScreen) authScreen.style.display = "flex";
  if (typeof window.signalAppReady === "function") window.signalAppReady();
}`,
`  // iOS: sign-in lives on the splash (no separate auth screen, splash stays up)
  if (typeof window.enterSplashSignin === "function") window.enterSplashSignin();
  else {
    const authScreen = document.getElementById("auth-screen");
    if (authScreen) authScreen.style.display = "flex";
  }
}`);

// ── D7f: runSplash — don't force-dismiss or click-dismiss in signin-mode ─────
mustReplace('D7f max-dwell guard',
`  setTimeout(() => {
    if (!dismissed) dismiss();
  }, MAX_DWELL_MS);
  splash.addEventListener("click", () => {
    const elapsed = Date.now() - splashStartTime;
    if (elapsed >= MIN_DWELL_MS) dismiss();
  });`,
`  setTimeout(() => {
    if (!dismissed && !splash.classList.contains("signin-mode")) dismiss();
  }, MAX_DWELL_MS);
  splash.addEventListener("click", () => {
    if (splash.classList.contains("signin-mode")) return;
    const elapsed = Date.now() - splashStartTime;
    if (elapsed >= MIN_DWELL_MS) dismiss();
  });`);

// ── D8: Path B in-app purchasing (S17) ───────────────────────────────────────
// iOS can't navigate its own webview to Stripe (it would replace the app UI with
// no way back). Open Stripe in the system browser instead, then refresh the
// credit count when the app returns to the foreground. Crediting itself is
// already handled server-side by the Stripe webhook — the app just re-reads the
// balance. (Apple permits external payment links for US apps post-Epic ruling.)
mustReplace('D8 purchase external browser',
`    const data = await resp.json();
    if (data.url) {
      window.location.href = data.url;
    } else {
      alert("Failed to start checkout: " + (data.error || "Unknown error"));
    }`,
`    const data = await resp.json();
    if (data.url) {
      if (window.Capacitor && window.Capacitor.isNativePlatform()) {
        // iOS: open Stripe in the system browser, not the app's webview, and
        // refresh credits when the user returns. The webhook does the crediting.
        window._purchaseInFlight = true;
        if (!window._purchaseVisHooked) {
          window._purchaseVisHooked = true;
          document.addEventListener('visibilitychange', async function() {
            if (document.visibilityState !== 'visible' || !window._purchaseInFlight) return;
            window._purchaseInFlight = false;
            // The webhook may lag a moment behind the redirect; poll the balance.
            for (var i = 0; i < 8; i++) {
              try { await loadUserCredits(); } catch (e) {}
              await new Promise(function(r) { setTimeout(r, 1500); });
            }
          });
        }
        window.open(data.url, '_blank');
      } else {
        window.location.href = data.url;
      }
    } else {
      alert("Failed to start checkout: " + (data.error || "Unknown error"));
    }`);

// ── D9: disable SSE streaming on iOS (S17) ───────────────────────────────────
// The website grades via a SAME-ORIGIN SSE stream. The iOS app rewrites the
// assess call to https://robograder.app (cross-origin), and a streamed SSE
// response over a cross-origin fetch STALLS/FAILS in WKWebView ("Load failed").
// Forcing supportsResponseStreaming() to false steers iOS to the existing
// non-streaming fallback path (plain JSON response), which cross-origin fetch
// handles fine. The scan animation is cosmetic and runs on its own timer, so
// there is no visible difference. Cost-neutral: same prompt, same single call.
mustReplace('D9 disable iOS streaming',
`function supportsResponseStreaming() {
  try {
    return typeof ReadableStream !== "undefined" && typeof TextDecoder !== "undefined" && new Response(new ReadableStream).body && typeof new Response(new ReadableStream).body.getReader === "function";
  } catch (e) {
    return false;
  }
}`,
`function supportsResponseStreaming() {
  // iOS: force non-streaming. Cross-origin SSE stalls in WKWebView.
  if (window.Capacitor && window.Capacitor.isNativePlatform()) return false;
  try {
    return typeof ReadableStream !== "undefined" && typeof TextDecoder !== "undefined" && new Response(new ReadableStream).body && typeof new Response(new ReadableStream).body.getReader === "function";
  } catch (e) {
    return false;
  }
}`);

// ── D15: viewport-fit cover for iOS (Dynamic Island) ─────────────────────────
// The PWA uses viewport-fit=contain to fix a PWA-only ~49px black band on the
// splash/scan (the band is the body bg showing in the iOS Safari toolbar zone
// when cover lets content extend edge-to-edge under the bars). The iOS Capacitor
// app does NOT have that band (no browser toolbar), but it DOES need cover so the
// header/splash sit correctly under the Dynamic Island. So: PWA = contain,
// iOS = cover. This delta restores cover for the iOS build only.
mustReplace('D15 viewport-fit cover (iOS)',
'<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, viewport-fit=contain">',
'<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, viewport-fit=cover">');

// ── D16: header clears the Dynamic Island on iOS ─────────────────────────────
// DISABLED for a test: D15 (viewport-fit=cover) alone makes the header's
// existing env(safe-area-inset-top) padding report the real Dynamic Island
// inset, which may already be enough. If the header clears the Island with
// D15 alone, leave this off (the max(...,59px) floor was overcompensation for
// a build that was never properly tested). If the header hides, re-enable.
// mustReplace('D16 header Dynamic Island (iOS)',
// '#header { background: #ffffff; border-bottom: 1px solid #d8d0c8; padding: calc(env(safe-area-inset-top, 0px) + 10px) 14px 10px; position: sticky; top: 0; z-index: 100; }',
// '#header { background: #ffffff; border-bottom: 1px solid #d8d0c8; padding: calc(max(env(safe-area-inset-top, 0px), 59px) + 10px) 14px 10px; position: sticky; top: 0; z-index: 100; }');

// ── D17: raise the splash subtitle on iOS ────────────────────────────────────
// The PWA base CSS positions #splash-subtitle at 5vh+9vh. On iOS it should sit
// higher (5vh+7vh). The D7b delta also defines #splash-subtitle, but the base
// rule appears LATER in the generated file and would win, so rewrite the base
// value directly here. PWA file keeps 9vh (untouched).
mustReplace('D17 subtitle 7vh (iOS)',
'top: calc(env(safe-area-inset-top, 0px) + 5vh + 9vh);',
'top: calc(env(safe-area-inset-top, 0px) + 5vh + 7vh);');

writeFileSync(outPath, html);
console.log(`\nAll ${applied} deltas applied. Wrote ${outPath} (${html.length.toLocaleString()} bytes).`);
