export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'API key not configured' });
  const { images, grader = 'CGC' } = req.body;
  if (!images || images.length === 0) return res.status(400).json({ error: 'No images provided' });

  const imageBlocks = images.map(img => {
    const [header, data] = img.split(',');
    const mediaType = header.match(/data:(.*);base64/)[1];
    return { type: 'image', source: { type: 'base64', media_type: mediaType, data } };
  });

  const isCGC = grader !== 'PSA';

  const cgcPrompt = `You are a CGC comic book grading expert. Analyze the provided photos and return a JSON object.

FIRST: Check if a CGC or PSA grading label/slab is visible in any photo. If so, read the grade, cert number, and page quality directly from the label.

Return this JSON structure:
{
  "title": "series title — strip any leading The ",
  "issue": "issue number e.g. 57 or A1 for annuals",
  "issueDate": "cover date as printed e.g. 2/68",
  "publisher": "publisher name",
  "grade": "your AI CGC grade as string e.g. 7.0",
  "pageQuality": "one of: White, Off-White to White, Off-White, OW/W, Cream to OW, Cream, C/OW, OW, W, Light Tan to OW, Light Tan to Cream, Light Tan, Tan to OW, Tan to Cream, Tan, Dark Tan to OW, Dark Tan, Brown to OW, Brown to Tan, Brown, Brown/Brittle, Slightly Brittle, Brittle",
  "graderNotes": "bullet-pointed defect list using official CGC terminology, one defect per line starting with •. Empty string if book is essentially perfect.",
  "aiAssessment": "2-4 sentences. Lead with overall impression. Name dominant defects. State grade and rationale. Note press/UV/clean recommendations. If an existing CGC grade is visible on a label, compare your assessment to it and note whether a regrade might yield a different result.",
  "press": true/false/null,
  "uv": true/false/null,
  "clean": true/false/null,
  "labelDetected": false,
  "officialCGCGrade": null,
  "officialCGCCert": null,
  "officialPageQuality": null
}

If a CGC label IS visible: set labelDetected=true, officialCGCGrade to the grade on the label, officialCGCCert to the cert number, officialPageQuality to the page quality on the label.

PAGE QUALITY — CRITICAL CALIBRATION:
Phone cameras under artificial light make pages look significantly more yellowed than they are in neutral light. Always assign ONE TIER HIGHER than what you see in the photo.
- Photo looks "Cream to OW" → assign "Off-White"
- Photo looks "Off-White" → assign "Off-White to White"  
- Only assign "Cream to OW" if tanning is heavy, brown, and completely unambiguous
- "Off-White" is the Silver Age baseline. "Off-White to White" is common for Bronze Age.

GRADE CALIBRATION:
- Assign 9.0–9.6 when defects are minor. Do not cap at 8.5 out of caution.
- Strong eye appeal, flat spine, bright colors, sharp corners = high grade.
- Challenge existing CGC grades when evidence warrants.

GRADER NOTES FORMAT:
- One bullet per defect: • Spine stress lines, color-breaking, light
- Omit if book is essentially perfect (9.8+)
- Use official CGC terminology. Always note whether stress lines are color-breaking or not.

UV: only for white covers with tanning on unprinted areas. Ink-protection mask available.
Press: spine roll=yes, edge fraying=no, corner creases=yes, tanning=no.

Return ONLY valid JSON, no markdown.`;

  const psaPrompt = `You are a PSA comic book grading expert analyzing photos already assessed by CGC standards. Your job is ONLY to note where PSA's grading approach would produce a meaningfully different result.

Return this JSON:
{
  "grade": "your AI PSA grade as string e.g. 7.0",
  "psaNotes": "1-3 sentences describing ONLY where PSA would grade differently from CGC, or empty string if PSA would grade approximately the same. Do not repeat defects already listed in CGC notes. Only include this field if there is a genuine PSA-specific difference worth noting.",
  "labelDetected": false,
  "officialPSAGrade": null,
  "officialPSACert": null
}

PSA differs from CGC in these ways that matter:
- PSA explicitly weights eye appeal more heavily — a book that presents beautifully may grade higher at PSA even with noted defects
- PSA's "Conserved" designation covers professional archival work; tape is always a defect never restoration
- PSA may run slightly more generous on Silver/Bronze Age books as a newer entrant establishing its market
- If PSA would give the same grade, psaNotes should be empty string ""

If a PSA label is visible in the photo: set labelDetected=true, officialPSAGrade to label grade, officialPSACert to cert number.

PAGE QUALITY: Same camera bias applies — lean one tier whiter than photo suggests.

Return ONLY valid JSON, no markdown.`;

  const systemPrompt = isCGC ? cgcPrompt : psaPrompt;

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-opus-4-6',
        max_tokens: 1024,
        system: systemPrompt,
        messages: [{
          role: 'user',
          content: [
            ...imageBlocks,
            { type: 'text', text: 'Please assess this comic and return the JSON grading object.' }
          ]
        }]
      })
    });

    if (!response.ok) {
      const err = await response.text();
      return res.status(500).json({ error: 'Anthropic API error: ' + err });
    }

    const data = await response.json();
    const text = data.content[0].text.trim();
    const clean = text.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```\s*$/i, '').trim();

    let parsed;
    try { parsed = JSON.parse(clean); }
    catch (e) { return res.status(500).json({ error: 'Failed to parse response: ' + text }); }

    return res.status(200).json(parsed);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
