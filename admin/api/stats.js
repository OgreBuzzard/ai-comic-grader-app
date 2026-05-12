// /api/stats.js — DIAGNOSTIC VERSION
// Reports what's actually in FIREBASE_SERVICE_ACCOUNT without exposing the value.

export default async function handler(req, res) {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;

  if (raw === undefined) {
    return res.status(500).json({
      diagnostic: 'FIREBASE_SERVICE_ACCOUNT is undefined — env var not set or not deployed',
    });
  }

  // Character codes of the first 5 and last 5 characters.
  // 123 = { (correct opening for JSON)
  // 8220 = " left smart quote (WRONG — not valid JSON)
  // 8221 = " right smart quote (WRONG)
  // 34 = " straight quote (correct)
  // 32 = space, 9 = tab, 10 = newline, 13 = carriage return (any of these at start = problem)
  // 65279 = BOM (byte order mark — invisible, common paste-from-Word issue)
  const firstChars = [];
  const lastChars = [];
  for (let i = 0; i < Math.min(5, raw.length); i++) {
    firstChars.push({ pos: i, char: raw[i], code: raw.charCodeAt(i) });
  }
  for (let i = Math.max(0, raw.length - 5); i < raw.length; i++) {
    lastChars.push({ pos: i, char: raw[i], code: raw.charCodeAt(i) });
  }

  // Try to parse and report exactly where it fails
  let parseError = null;
  try {
    JSON.parse(raw);
    parseError = 'NONE — JSON parses successfully';
  } catch (e) {
    parseError = e.message;
  }

  // Look for smart quotes anywhere in the first 200 chars
  let smartQuotesFound = [];
  for (let i = 0; i < Math.min(raw.length, 200); i++) {
    const code = raw.charCodeAt(i);
    if (code === 8220 || code === 8221 || code === 8216 || code === 8217) {
      smartQuotesFound.push({ pos: i, code });
      if (smartQuotesFound.length >= 5) break;
    }
  }

  return res.status(500).json({
    diagnostic: 'FIREBASE_SERVICE_ACCOUNT env var inspection',
    length: raw.length,
    firstChars,
    lastChars,
    parseError,
    smartQuotesFound: smartQuotesFound.length > 0 ? smartQuotesFound : 'none in first 200 chars',
    interpretation: {
      shouldStartWith: '{ (charCode 123)',
      shouldEndWith: '} (charCode 125)',
      validQuoteCharCode: 34,
      invalidSmartQuoteCodes: [8216, 8217, 8220, 8221],
      bomCode: 65279,
    },
  });
}
