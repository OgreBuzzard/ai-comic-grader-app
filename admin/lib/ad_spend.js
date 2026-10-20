// admin/lib/ad_spend.js
// ACTUAL paid-ad spend from Meta (Marketing API) + Google (Google Ads API).
// Returns spend in CENTS: per-platform + combined windows (day/week/month/all-time)
// plus a combined per-day map for the revenue-vs-spend chart.
//
// FULLY FAULT-TOLERANT: any missing token or API error for a platform falls back
// to a flat estimate for THAT platform only (dated from the ads launch forward, so
// all-time/chart are never misstated pre-launch). getAdSpend() never throws — the
// dashboard keeps working with zero config, and lights up per-platform as each
// token is added. Cached in-memory ~10 min per warm serverless instance.
//
// ENV (all optional; absent => that platform uses the estimate):
//   META_ADS_TOKEN            long-lived System User token with ads_read
//   META_AD_ACCOUNT_ID        e.g. act_1789385462515396 (defaulted below)
//   GOOGLE_ADS_DEVELOPER_TOKEN   NO LONGER REQUIRED - sunset 2026-09-09, see fetchGoogleDaily
//   GOOGLE_ADS_CLIENT_ID / GOOGLE_ADS_CLIENT_SECRET / GOOGLE_ADS_REFRESH_TOKEN
//   GOOGLE_ADS_CUSTOMER_ID    digits only, defaulted below (605-372-0191)
//   GOOGLE_ADS_LOGIN_CUSTOMER_ID  (only if the account is under an MCC)
//   GOOGLE_ADS_API_VERSION    default v25 (v18 was long dead; monthly releases since Jan 2026) — 404 => bump

const DAY = 86400000;
const ADS_LAUNCH_MS = Date.parse('2026-09-10T00:00:00Z'); // clean-ad relaunch; stopgap estimate anchor (real spend comes from the Meta/Google APIs)
const EST_DAILY_CENTS = { meta: 1600, google: 1600 };      // fallback $16/day each
const CACHE_MS = 10 * 60 * 1000;
const LOOKBACK_DAYS = 35;

let _cache = null; // { at, data }

function estByDay(centsPerDay) {
  const out = {};
  const now = Date.now();
  for (let t = ADS_LAUNCH_MS; t <= now; t += DAY) {  // elapsed days only — no phantom future day
    out[new Date(t).toISOString().slice(0, 10)] = centsPerDay;
  }
  return out;
}

function windowsFromByDay(byDay) {
  const now = Date.now();
  let week = 0, month = 0, all = 0;
  for (const k of Object.keys(byDay)) {
    const cents = byDay[k] || 0;
    all += cents;
    const age = (now - Date.parse(k + 'T00:00:00Z')) / DAY;
    if (age < 7) week += cents;
    if (age < 30) month += cents;
  }

  // dayCents = TODAY's spend, falling back to YESTERDAY's ONLY while today has
  // not been reported yet. A day the platform omits means it spent NOTHING that
  // day.
  //
  // BUG FOUND 2026-10-20, and it was alarming rather than cosmetic. This used to
  // be "the value of the latest row present", described as the current daily
  // rate. But a paused account stops producing daily rows altogether, so the
  // latest row stays forever on the last day that actually spent money. Both the
  // Meta and the Google accounts had been paused for days - Google's own UI said
  // "None of your ads are running" and both read $0.00 for today - and the admin
  // still reported Ads $34.73/24h. Matt reasonably read that as $34.73 a day
  // still going out of the door.
  //
  // weekCents/monthCents were never affected: they are real rolling windows, so
  // they legitimately still carry the pre-pause spend and will decay on their own.
  const dayKey  = new Date(now).toISOString().slice(0, 10);
  const prevKey = new Date(now - DAY).toISOString().slice(0, 10);
  const dayCents = (dayKey in byDay)  ? (byDay[dayKey]  || 0)
                 : (prevKey in byDay) ? (byDay[prevKey] || 0)
                 : 0;

  return { dayCents, weekCents: week, monthCents: month, allTimeCents: all };
}

async function fetchMetaDaily() {
  const token = process.env.META_ADS_TOKEN;
  const acct = process.env.META_AD_ACCOUNT_ID || 'act_1789385462515396';
  if (!token) return null;
  const since = new Date(Date.now() - LOOKBACK_DAYS * DAY).toISOString().slice(0, 10);
  const until = new Date(Date.now() + DAY).toISOString().slice(0, 10);
  const tr = encodeURIComponent(JSON.stringify({ since, until }));
  const url = `https://graph.facebook.com/v20.0/${acct}/insights` +
    `?level=account&fields=spend&time_increment=1&time_range=${tr}` +
    `&access_token=${encodeURIComponent(token)}`;
  const r = await fetch(url);
  if (!r.ok) throw new Error('meta insights ' + r.status + ' ' + (await r.text()).slice(0, 160));
  const j = await r.json();
  const byDay = {};
  for (const row of (j.data || [])) {
    if (row.date_start) byDay[row.date_start] = Math.round(parseFloat(row.spend || '0') * 100);
  }
  return byDay;
}

// ── GOOGLE ADS ACCESS CHANGED UNDER US (checked 2026-10-19) ────────────────
// Two things in here were written against a world that no longer exists, and
// between them they guarantee this function can never return a number:
//
//   1. DEVELOPER TOKENS WERE SUNSET ON 2026-09-09. API access levels now
//      attach to a GOOGLE CLOUD PROJECT, not to a token. The API ignores a
//      developer-token header today and a future major version will reject it.
//      This function REQUIRED one to be set before it would even try, so it
//      returned null forever and the admin showed Google as `missing` — which
//      the Spending line then rendered as part of a partial total.
//      Requirement dropped: the header is sent only if the variable happens to
//      still be set.
//   2. THE VERSION DEFAULT WAS `v18`. v19 was sunset on 2026-02-11 and the API
//      moved to monthly releases in January 2026, so v18 is long dead and every
//      call 404s. Defaulted to v25, the oldest version there is current
//      evidence for — SET `GOOGLE_ADS_API_VERSION` to whatever is actually
//      current; a 404 here means bump it.
//
// WHAT MATT HAS TO DO (no manager account needed):
//   a. In the Google Cloud Console, open the Google Ads API page for the
//      project and make sure BILLING IS ACTIVE — a free-trial or suspended
//      billing account is rejected outright.
//   b. Apply for an access level there (NOT from the Ads API Center, which is
//      no longer processed). Explorer is automated and enough for reading our
//      own account's spend; Basic needs brand verification first and is
//      reviewed in minutes. A Test-level project calling a production account
//      returns CLOUD_PROJECT_NOT_APPROVED_FOR_PRODUCTION.
//   c. Create an OAuth client and a refresh token for that project, then set
//      GOOGLE_ADS_CLIENT_ID / _CLIENT_SECRET / _REFRESH_TOKEN in the ADMIN
//      Vercel project (admin is its own project — the main app's env vars are
//      not visible here).
//   d. GOOGLE_ADS_CUSTOMER_ID defaults to 6053720191; set it if that is wrong.
//      GOOGLE_ADS_LOGIN_CUSTOMER_ID only if the account sits under an MCC.
async function fetchGoogleDaily() {
  const devToken = process.env.GOOGLE_ADS_DEVELOPER_TOKEN;   // optional, ignored by the API since 2026-09-09
  const clientId = process.env.GOOGLE_ADS_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_ADS_CLIENT_SECRET;
  const refreshToken = process.env.GOOGLE_ADS_REFRESH_TOKEN;
  if (!clientId || !clientSecret || !refreshToken) return null;
  const customerId = (process.env.GOOGLE_ADS_CUSTOMER_ID || '6053720191').replace(/[^0-9]/g, '');
  const ver = process.env.GOOGLE_ADS_API_VERSION || 'v25';
  // 1) refresh -> access token
  const tokRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, refresh_token: refreshToken, grant_type: 'refresh_token' }),
  });
  if (!tokRes.ok) throw new Error('google oauth ' + tokRes.status);
  const accessToken = (await tokRes.json()).access_token;
  // 2) GAQL: daily cost, last 30 days
  const headers = { Authorization: 'Bearer ' + accessToken, 'Content-Type': 'application/json' };
  if (devToken) headers['developer-token'] = devToken;   // harmless while it is still accepted; not required
  const login = process.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID;
  if (login) headers['login-customer-id'] = login.replace(/[^0-9]/g, '');
  const query = 'SELECT segments.date, metrics.cost_micros FROM customer WHERE segments.date DURING LAST_30_DAYS';
  const r = await fetch(`https://googleads.googleapis.com/${ver}/customers/${customerId}/googleAds:searchStream`, {
    method: 'POST', headers, body: JSON.stringify({ query }),
  });
  if (!r.ok) throw new Error('google ads ' + r.status + ' ' + (await r.text()).slice(0, 200));
  const j = await r.json();
  const chunks = Array.isArray(j) ? j : [j];
  const byDay = {};
  for (const chunk of chunks) {
    for (const row of (chunk.results || [])) {
      const d = row.segments && row.segments.date;
      const micros = row.metrics && row.metrics.costMicros;
      if (d) byDay[d] = (byDay[d] || 0) + Math.round((Number(micros || 0) / 1e6) * 100);
    }
  }
  return byDay;
}

export async function getAdSpend() {
  if (_cache && Date.now() - _cache.at < CACHE_MS) return _cache.data;
  const [metaByDay, googleByDay] = await Promise.all([
    fetchMetaDaily().catch(e => { console.warn('[ad_spend] meta:', e.message); return null; }),
    fetchGoogleDaily().catch(e => { console.warn('[ad_spend] google:', e.message); return null; }),
  ]);
  // S22 (Matt): a platform that is NOT reporting contributes ZERO, not a guess.
  // The old behaviour substituted $16/day, which silently replaced Google's real
  // ~$169 with a ~$96 invention and made the dashboard confidently wrong. A
  // number that is missing is honest; a number that is fabricated is not.
  // `source` tells the UI which platforms are absent so the total can be
  // labelled as partial rather than read as fact.
  const metaSrc = metaByDay ? 'api' : 'missing';
  const googleSrc = googleByDay ? 'api' : 'missing';
  const mDay = metaByDay || {};
  const gDay = googleByDay || {};
  const meta = windowsFromByDay(mDay);
  const google = windowsFromByDay(gDay);
  const byDayCombined = {};
  for (const m of [mDay, gDay]) for (const k of Object.keys(m)) byDayCombined[k] = (byDayCombined[k] || 0) + (m[k] || 0);
  const ads = {
    dayCents: meta.dayCents + google.dayCents,
    weekCents: meta.weekCents + google.weekCents,
    monthCents: meta.monthCents + google.monthCents,
    allTimeCents: meta.allTimeCents + google.allTimeCents,
  };
  const data = { source: { meta: metaSrc, google: googleSrc }, meta, google, ads, byDayCombined };
  _cache = { at: Date.now(), data };
  return data;
}
