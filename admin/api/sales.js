// /api/sales.js  (admin project)
// iOS App Store sales, pulled from the App Store Connect "Sales and Reports" API.
// Signs an ES256 JWT with the .p8 key (Node crypto — no extra dependency),
// fetches the DAILY SALES SUMMARY report for a window of dates, gunzips + parses
// the TSV, and returns per-day units + developer proceeds grouped by currency.
//
// ENV (admin Vercel project):
//   ASC_ISSUER_ID     — Issuer ID (shown above the Active keys table in ASC)
//   ASC_KEY_ID        — 10-char Key ID (the AuthKey_XXXXXXXXXX.p8 code)
//   ASC_VENDOR_NUMBER — Vendor Number (Payments and Financial Reports, top-left)
//   ASC_P8_KEY        — the full .p8 contents (BEGIN/END PRIVATE KEY). Paste with
//                       real newlines, or with \n escapes — both are handled.
//
// NOTES / CAVEATS (flag for Matt to verify against a known payout):
//   * Apple daily reports lag ~1 day; today + often yesterday won't exist yet
//     (those dates return 404, which we treat as "no data yet", not an error).
//   * "Developer Proceeds" in the report is PER UNIT, in the row's currency, so a
//     row's proceeds = Units × Developer Proceeds. Currencies are NOT converted —
//     proceeds are returned grouped by currency (USD/CAD/AUD/GBP/NZD). Combine
//     with FX later if you want a single number.
//   * Refunds show as negative Units, so they net out correctly.

import crypto from 'node:crypto';
import zlib from 'node:zlib';

function parseServiceAccount() {
  let raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!raw) throw new Error('FIREBASE_SERVICE_ACCOUNT not set');
  if (raw.includes('\\"')) raw = raw.replace(/\\"/g, '"').replace(/\\\\/g, '\\');
  return JSON.parse(raw);
}

// Build a short-lived ES256 JWT for the App Store Connect API.
function ascJwt() {
  const kid = process.env.ASC_KEY_ID;
  const iss = process.env.ASC_ISSUER_ID;
  let pem = process.env.ASC_P8_KEY || '';
  if (!kid || !iss || !pem) throw new Error('ASC_KEY_ID / ASC_ISSUER_ID / ASC_P8_KEY not all set');
  if (pem.includes('\\n')) pem = pem.replace(/\\n/g, '\n'); // un-escape if pasted with \n
  const now = Math.floor(Date.now() / 1000);
  const enc = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const signingInput =
    enc({ alg: 'ES256', kid, typ: 'JWT' }) + '.' +
    enc({ iss, iat: now, exp: now + 60 * 15, aud: 'appstoreconnect-v1' });
  const sig = crypto
    .sign('sha256', Buffer.from(signingInput), { key: crypto.createPrivateKey(pem), dsaEncoding: 'ieee-p1363' })
    .toString('base64url');
  return signingInput + '.' + sig;
}

const YMD = (d) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d); // day boundary = midnight Pacific

// Fetch + parse one day's SALES SUMMARY report. Returns null on 404 (no data).
async function fetchDay(jwt, vendor, dateStr) {
  const qs = new URLSearchParams({
    'filter[frequency]': 'DAILY',
    'filter[reportType]': 'SALES',
    'filter[reportSubType]': 'SUMMARY',
    'filter[vendorNumber]': vendor,
    'filter[version]': '1_1',
    'filter[reportDate]': dateStr,
  });
  const r = await fetch('https://api.appstoreconnect.apple.com/v1/salesReports?' + qs, {
    headers: { Authorization: 'Bearer ' + jwt, Accept: 'application/a-gzip' },
  });
  if (r.status === 404) return null;            // no sales / report not ready
  if (!r.ok) throw new Error(`ASC ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const tsv = zlib.gunzipSync(Buffer.from(await r.arrayBuffer())).toString('utf8').trim();
  if (!tsv) return { units: 0, proceeds: {} };
  const [head, ...rows] = tsv.split('\n');
  const cols = head.split('\t');
  const iUnits = cols.indexOf('Units');
  const iProc = cols.indexOf('Developer Proceeds');
  const iCur = cols.indexOf('Currency of Proceeds');
  let units = 0;
  const proceeds = {};
  for (const line of rows) {
    const c = line.split('\t');
    const u = parseInt(c[iUnits], 10) || 0;
    const per = parseFloat(c[iProc]) || 0;
    const cur = (c[iCur] || 'USD').trim();
    units += u;
    proceeds[cur] = +( (proceeds[cur] || 0) + u * per ).toFixed(2);
  }
  return { units, proceeds };
}

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  try {
    const { initializeApp, getApps, cert } = await import('firebase-admin/app');
    const { getAuth } = await import('firebase-admin/auth');
    if (!getApps().length) initializeApp({ credential: cert(parseServiceAccount()) });

    const auth = req.headers.authorization || '';
    const m = auth.match(/^Bearer\s+(.+)$/);
    if (!m) return res.status(401).json({ error: 'Unauthorized' });
    let decoded;
    try { decoded = await getAuth().verifyIdToken(m[1]); }
    catch { return res.status(401).json({ error: 'Unauthorized' }); }
    const adminEmails = (process.env.ADMIN_EMAILS || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
    const callerEmail = (decoded.email || '').toLowerCase();
    if (!callerEmail || !adminEmails.includes(callerEmail)) {
      console.warn(`[admin-sales] denied: ${callerEmail || '<no email>'}`);
      return res.status(403).json({ error: 'Forbidden' });
    }

    const vendor = process.env.ASC_VENDOR_NUMBER;
    if (!vendor) return res.status(500).json({ error: 'ASC_VENDOR_NUMBER not set' });

    // Window: default last 30 days (bounded). Apple's most recent 1-2 days may 404.
    const days = Math.min(parseInt(req.query.days, 10) || 30, 90);
    const jwt = ascJwt();

    const out = [];
    const totals = { units: 0, proceeds: {} };
    let reportedThrough = null;
    for (let i = 1; i <= days; i++) {                 // start at yesterday
      const d = new Date(Date.now() - i * 86400000);
      const ds = YMD(d);
      let day;
      try { day = await fetchDay(jwt, vendor, ds); }
      catch (e) { console.warn(`[admin-sales] ${ds}: ${e.message}`); continue; }
      if (!day) continue;
      if (!reportedThrough) reportedThrough = ds; // newest date with data
      out.push({ date: ds, units: day.units, proceeds: day.proceeds });
      totals.units += day.units;
      for (const [cur, amt] of Object.entries(day.proceeds)) {
        totals.proceeds[cur] = +((totals.proceeds[cur] || 0) + amt).toFixed(2);
      }
    }
    out.reverse(); // chronological

    return res.status(200).json({
      ios: { days: out, totals, reportedThrough, windowDays: days },
      generatedAt: new Date().toISOString(),
    });
  } catch (e) {
    console.error('[admin-sales] error:', e);
    return res.status(500).json({ error: e.message || 'sales fetch failed' });
  }
}
