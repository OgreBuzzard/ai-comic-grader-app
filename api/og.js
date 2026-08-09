// api/og.js — server-rendered public listing with per-assessment Open Graph tags.
//
// /id/:id rewrites here (see vercel.json). SMS / link-preview crawlers do NOT run
// JavaScript, so the client-side og:image injection in public.html never reaches
// them. This function resolves the ID via the public lookup, injects the book's
// FRONT image + real title/description into the public.html <head> SERVER-SIDE,
// and returns the full page. Human visitors still get the normal SPA — its own
// JS reads the id from the URL path and renders as before.
//
// Data comes from /api/lookup (the same public-safe whitelist), so this never
// exposes anything the public page couldn't already show.

const OG_TITLE_TAG = '<meta property="og:title" content="Robograder Assessment">';
const OG_DESC_TAG  = '<meta property="og:description" content="View this comic\'s Robograde score and condition assessment.">';
const OG_TYPE_TAG  = '<meta property="og:type" content="website">';

// Cache the static template in warm-lambda memory (fetched once per instance).
let _tpl = null;
async function getTemplate(origin) {
  if (_tpl) return _tpl;
  const r = await fetch(origin + '/public.html');
  if (!r.ok) throw new Error('template fetch ' + r.status);
  _tpl = await r.text();
  return _tpl;
}

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export default async function handler(req, res) {
  const proto = String(req.headers['x-forwarded-proto'] || 'https').split(',')[0];
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  const origin = `${proto}://${host}`;
  const id = String((req.query && req.query.id) || '').toUpperCase();

  let image = null;
  let title = 'Robograder Assessment';
  let desc = "View this comic's Robograde score and condition assessment.";

  try {
    if (/^[0-9A-NP-Z]{6}$/.test(id)) {
      const r = await fetch(`${origin}/api/lookup?id=${encodeURIComponent(id)}`);
      if (r.ok) {
        const d = await r.json();
        if (Array.isArray(d.images) && d.images[0]) image = d.images[0];  // front image
        const isCard = d.type === 'card';
        const name = isCard
          ? (d.title || 'Card')  // card number lives in the message text; keep the preview caption to the name only
          : ([d.title, d.issue ? '#' + d.issue : ''].filter(Boolean).join(' ').trim() || 'Comic');
        title = `Robograder: ${name}`;
        const rgScore = (d.roboGrade && d.roboGrade.score != null)
          ? Math.round(d.roboGrade.score)
          : (d.cardData && d.cardData.robograde && d.cardData.robograde.total != null)
            ? Math.round(d.cardData.robograde.total)
            : null;
        const bits = [];
        if (rgScore != null) bits.push(`Robograde ${rgScore}`);
        if (!isCard && d.predictedGrade) bits.push(`Predicted ${d.predictedGrade}`);
        desc = bits.length ? bits.join(' · ') : `Robograde condition assessment for ${name}`;
      }
    }
  } catch (e) { /* fall back to defaults */ }

  let html;
  try {
    html = await getTemplate(origin);
  } catch (e) {
    // Template unreachable — bounce to the static page so the user still sees it.
    res.setHeader('Location', '/public.html');
    return res.status(302).end();
  }

  // Replace the static title/description with the per-assessment values, and
  // inject the image + twitter tags (public.html carries none statically).
  html = html.replace(OG_TITLE_TAG, `<meta property="og:title" content="${esc(title)}">`);
  html = html.replace(OG_DESC_TAG, `<meta property="og:description" content="${esc(desc)}">`);
  const imgTags = image
    ? `\n<meta property="og:image" content="${esc(image)}">\n<meta name="twitter:image" content="${esc(image)}">\n<meta name="twitter:card" content="summary_large_image">`
    : '\n<meta name="twitter:card" content="summary">';
  html = html.replace(OG_TYPE_TAG, OG_TYPE_TAG + imgTags);

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'public, max-age=300, s-maxage=600');
  return res.status(200).send(html);
}
