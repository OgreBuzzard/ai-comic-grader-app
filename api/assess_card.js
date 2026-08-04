// api/assess_card.js — PSA trading-card grading (Pokémon MVP).
//
// Standalone card grader that mirrors assess.js patterns but does NOT touch the
// working comics path. Flow:
//   1. Auth (Firebase ID token).
//   2. Identify the card (cheap Haiku pass) -> {name, set, number, year, variant}.
//   3. Fetch a clean reference scan from TCGdex (free, no key) by name (+ number).
//   4. Grade with the model using buildPSACardGradingPrompt() from lib/grading_cards.js.
//   5. Return the parsed JSON. The CLIENT persists the item (type:'card' + cardData)
//      and spends the credit, exactly like comics (credits are client-managed).
//
// NOT yet wired to the client; testable via API. The full assess.js ->
// thin-orchestrator refactor is a later cleanup — this ships the card path
// without disturbing comics.
//
// ESM note: a static Node built-in import keeps Vercel treating this as ESM
// (matches verify_iap/verify_play); firebase-admin loads dynamically.
import process from 'node:process';
import { buildPSACardGradingPrompt } from '../lib/grading_cards.js';

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const IDENTIFY_MODEL = 'claude-haiku-4-5-20251001';   // cheap identification pass
const GRADE_MODEL = 'claude-opus-5';                  // matches assess.js PRIMARY_MODEL

const IDENTIFY_PROMPT =
  'You are looking at the FRONT of a single trading card (most likely Pokémon). ' +
  'Identify it. Respond with ONLY a JSON object and nothing else: ' +
  '{"name": string, "set": string|null, "number": string|null, "year": number|null, "variant": string|null}. ' +
  'For "number" use the printed collector number exactly as shown (e.g. "025/094" or "RC24/RC25"). ' +
  'If a field is not legible, use null.';

function normalizeMediaType(mt) {
  if (!mt) return 'image/jpeg';
  const clean = mt.toLowerCase().split(';')[0].trim();
  if (['image/jpeg', 'image/png', 'image/gif', 'image/webp'].includes(clean)) return clean;
  if (clean === 'image/jpg') return 'image/jpeg';
  return 'image/jpeg';
}

// A client data-URL ("data:image/jpeg;base64,....") -> Anthropic image block.
function toImageBlock(dataUrl) {
  const [header, data] = String(dataUrl).split(',');
  const m = header && header.match(/data:(.*);base64/);
  return { type: 'image', source: { type: 'base64', media_type: normalizeMediaType(m && m[1]), data } };
}

async function fetchTimeout(url, options = {}, timeoutMs = 8000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try { return await fetch(url, { ...options, signal: controller.signal }); }
  finally { clearTimeout(timer); }
}

// Anthropic messages call returning the first text block; one retry on failure.
async function anthropicText(apiKey, body, timeoutMs) {
  const headers = { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' };
  let lastErr;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const r = await fetchTimeout(ANTHROPIC_URL, { method: 'POST', headers, body: JSON.stringify(body) }, timeoutMs);
      if (!r.ok) { lastErr = new Error('anthropic ' + r.status + ': ' + (await r.text()).slice(0, 300)); continue; }
      const j = await r.json();
      const tb = Array.isArray(j.content) ? j.content.find(b => b.type === 'text') : null;
      return { text: tb ? tb.text : '', usage: j.usage || null, model: j.model || body.model };
    } catch (e) { lastErr = e; }
  }
  throw lastErr || new Error('anthropic call failed');
}

// Pull the first balanced {...} JSON object out of a model response.
function extractJson(text) {
  if (!text) return null;
  const start = text.indexOf('{');
  if (start === -1) return null;
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false; continue; }
    if (c === '"') inStr = true;
    else if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) { try { return JSON.parse(text.slice(start, i + 1)); } catch { return null; } } }
  }
  return null;
}

// Free reference scan from TCGdex (tcgdex.dev) — NO API key. Best-effort;
// returns an Anthropic image block + resolved name, or null. (pokemontcg.io moved
// to the paid Scrydex service in 2026; TCGdex is the free, keyless replacement.)
async function fetchPokemonReference(ident) {
  const name = (ident && ident.name || '').trim();
  if (!name) return null;
  const listResp = await fetchTimeout('https://api.tcgdex.net/v2/en/cards?name=' + encodeURIComponent(name), {}, 6000);
  if (!listResp.ok) return null;
  const list = await listResp.json();
  if (!Array.isArray(list) || !list.length) return null;
  const num = String((ident && ident.number) || '').split('/')[0].replace(/[^0-9A-Za-z]/g, '').replace(/^0+/, '');
  const withImg = list.filter(c => c && c.image);
  const pick = (num && withImg.find(c => String(c.localId || '').replace(/^0+/, '') === num)) || withImg[0] || null;
  if (!pick) return null;
  // TCGdex `image` is a base URL; append quality + extension. PNG for Anthropic compat.
  const imgResp = await fetchTimeout(pick.image + '/high.png', {}, 8000);
  if (!imgResp.ok) return null;
  const buf = Buffer.from(await imgResp.arrayBuffer());
  return { block: { type: 'image', source: { type: 'base64', media_type: 'image/png', data: buf.toString('base64') } }, name: pick.name || name };
}

async function verifyUid(req) {
  try {
    const auth = req.headers.authorization || req.headers.Authorization || '';
    const m = auth.match(/^Bearer\s+(.+)$/);
    if (!m) return null;
    if (!process.env.FIREBASE_SERVICE_ACCOUNT) return null;
    const { initializeApp, getApps, cert } = await import('firebase-admin/app');
    const { getAuth } = await import('firebase-admin/auth');
    if (!getApps().length) initializeApp({ credential: cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)) });
    const decoded = await getAuth().verifyIdToken(m[1]);
    return decoded.uid;
  } catch (e) { console.warn('[assess_card] auth failed:', e && e.message); return null; }
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not set' });

  const uid = await verifyUid(req);
  if (!uid) return res.status(401).json({ error: 'Unauthorized' });

  const body = req.body || {};
  const images = Array.isArray(body.images) ? body.images.filter(Boolean) : [];
  if (!images.length) return res.status(400).json({ error: 'At least a front photo is required' });
  const highGrade = !!body.highGrade;

  const t0 = Date.now();
  const userBlocks = images.map(toImageBlock);

  // 1) Identify (cheap) — best-effort; grading still runs if this fails.
  let identification = {};
  try {
    const idOut = await anthropicText(apiKey, {
      model: IDENTIFY_MODEL, max_tokens: 200,
      messages: [{ role: 'user', content: [userBlocks[0], { type: 'text', text: IDENTIFY_PROMPT }] }],
    }, 15000);
    identification = extractJson(idOut.text) || {};
  } catch (e) { console.warn('[assess_card] identify failed:', e && e.message); }

  // 2) TCGdex reference scan — best-effort.
  let referenceBlock = null, referenceUsed = false, referenceName = null;
  try {
    const ref = await fetchPokemonReference(identification);
    if (ref) { referenceBlock = ref.block; referenceUsed = true; referenceName = ref.name; }
  } catch (e) { console.warn('[assess_card] reference fetch failed:', e && e.message); }

  // 3) Grade.
  const prompt = buildPSACardGradingPrompt({
    referenceImageProvided: referenceUsed,
    referenceCardName: referenceName,
    photoCountProvided: images.length,
    isHighGradeFlow: highGrade,
  });
  const content = [...userBlocks];
  if (referenceBlock) content.push(referenceBlock);
  content.push({ type: 'text', text: prompt });

  let card;
  try {
    const gradeOut = await anthropicText(apiKey, {
      model: GRADE_MODEL, max_tokens: 16384,
      messages: [{ role: 'user', content }],
    }, 120000);
    card = extractJson(gradeOut.text);
    if (!card) return res.status(502).json({ error: 'Could not parse grade JSON from model', raw: (gradeOut.text || '').slice(0, 500) });
  } catch (e) {
    console.error('[assess_card] grade failed:', e && (e.stack || e.message));
    return res.status(502).json({ error: (e && e.message) || 'Grade failed' });
  }

  console.log('[assess_card] uid=' + uid + ' card="' + (card.cardIdentification && card.cardIdentification.name) + '" psa=' + card.psaGrade + ' rg=' + (card.robograde && card.robograde.total) + ' ref=' + referenceUsed + ' ' + (Date.now() - t0) + 'ms');
  return res.status(200).json({ ok: true, card, identification, referenceUsed, ms: Date.now() - t0 });
}
