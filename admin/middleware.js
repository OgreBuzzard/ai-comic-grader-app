// Second gate for the admin project (admin.robograder.app).
//
// This runs at the EDGE, before any page or /api/* function executes, and is a
// pre-authentication gate that sits IN FRONT of the existing Firebase-ID-token +
// ADMIN_EMAILS allowlist check. Nobody can even load the dashboard HTML or reach
// an admin API route without first presenting the shared secret.
//
// It uses a signed cookie rather than HTTP Basic Auth on purpose: the dashboard's
// own fetches set `Authorization: Bearer <firebase token>`, so a Basic-Auth
// scheme on that same header would collide. A cookie rides along on same-origin
// requests (both the HTML load and every /api/* fetch) without touching
// Authorization, so it double-gates the API too.
//
// SETUP (one time):
//   1. In the ADMIN Vercel project → Settings → Environment Variables, add:
//        ADMIN_GATE_SECRET = <a HEX-ONLY random string>   (e.g. `openssl rand -hex 24`)
//      IMPORTANT: use hex/letters+digits only. A key with & # + % / = or spaces
//      gets mangled in the URL query string and will fail to unlock.
//   2. Redeploy.
//   3. Unlock your browser once by visiting:
//        https://admin.robograder.app/?k=<that same secret>
//      The middleware sets an HttpOnly cookie and redirects to a clean URL.
//      The cookie lasts 1 year; repeat on any new device/browser.
//
// FAIL-OPEN on missing secret: if ADMIN_GATE_SECRET is not set, the gate is
// INACTIVE and requests pass through (you are still protected by the Firebase +
// allowlist check underneath). This prevents locking yourself out with a
// half-finished deploy. The gate only becomes active once the env var exists.
//
// To rotate: change ADMIN_GATE_SECRET, redeploy, re-unlock with the new value.
// Old cookies stop working immediately.

export const config = {
  // Run on everything EXCEPT static asset noise and Firebase's auth helper paths
  // (the Google sign-in popup lives on Google/firebaseapp.com, not here, but we
  // exclude /__/ defensively in case the authDomain proxies through this host).
  matcher: ['/((?!_next/static|_next/image|favicon.ico|robots.txt|__/).*)'],
};

const COOKIE = 'rg_admin_gate';

// Constant-time-ish string compare to avoid trivial timing leaks.
function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length !== b.length) return false;
  let out = 0;
  for (let i = 0; i < a.length; i++) out |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return out === 0;
}

function readCookie(header, name) {
  if (!header) return null;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    if (part.slice(0, idx).trim() === name) return part.slice(idx + 1).trim();
  }
  return null;
}

export default function middleware(request) {
  // .trim() so a stray space/newline pasted into the Vercel env value can't
  // silently break every unlock. Use a hex-only secret to avoid URL mangling.
  const secret = (process.env.ADMIN_GATE_SECRET || '').trim();

  const url = new URL(request.url);

  // Gate inactive until the secret is configured — fail open (Firebase gate still applies).
  if (!secret) return undefined;

  // Unlock path: /?k=<secret> sets the cookie and redirects to a clean URL.
  // searchParams.get() URL-decodes; .trim() drops any stray whitespace.
  const provided = url.searchParams.get('k');
  if (provided != null) {
    if (safeEqual(provided.trim(), secret)) {
      const clean = new URL(request.url);
      clean.searchParams.delete('k');
      return new Response(null, {
        status: 302,
        headers: {
          Location: clean.pathname + clean.search,
          'Set-Cookie': `${COOKIE}=${secret}; Path=/; Max-Age=${60 * 60 * 24 * 365}; HttpOnly; Secure; SameSite=Lax`,
          'Cache-Control': 'no-store',
        },
      });
    }
    // Wrong key — fall through to the block response below.
  }

  // Already unlocked?
  const cookieVal = readCookie(request.headers.get('cookie'), COOKIE);
  if (cookieVal != null && safeEqual(cookieVal.trim(), secret)) return undefined;

  // Blocked. JSON for API calls, a tiny page for navigations.
  const isApi = url.pathname.startsWith('/api/');
  if (isApi) {
    return new Response(JSON.stringify({ error: 'gate: locked' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    });
  }
  return new Response(
    '<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1">' +
      '<body style="font-family:system-ui;background:#0d0d0f;color:#c9c4bd;display:flex;' +
      'align-items:center;justify-content:center;height:100vh;margin:0;text-align:center">' +
      '<div><div style="font-size:15px;letter-spacing:2px;text-transform:uppercase;color:#6a5a4a">Robograder Admin</div>' +
      '<div style="margin-top:10px;font-size:13px;color:#7a746c">Locked. Append <code>?k=&lt;key&gt;</code> to unlock.</div></div></body>',
    { status: 401, headers: { 'Content-Type': 'text/html', 'Cache-Control': 'no-store' } }
  );
}
