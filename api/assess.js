export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'API key not configured' });
  }

  const { images, grader = 'CGC' } = req.body;
  if (!images || images.length === 0) {
    return res.status(400).json({ error: 'No images provided' });
  }

  const imageBlocks = images.map(img => {
    const [header, data] = img.split(',');
    const mediaType = header.match(/data:(.*);base64/)[1];
    return { type: 'image', source: { type: 'base64', media_type: mediaType, data } };
  });

  const isCGC = grader !== 'PSA';

  const cgcPrompt = `You are a CGC comic book grading expert. Analyze the provided photos and return a JSON object with these exact fields:

- title: series title — strip any leading "The " (e.g. "The Amazing Spider-Man" becomes "Amazing Spider-Man")
- issue: issue number as string, e.g. "57" or "A1" for annuals
- issueDate: cover date as printed, e.g. "2/68"
- publisher: publisher name
- grade: numeric grade as string, e.g. "7.0"
- pageQuality: must be exactly one of: "White", "Off-White to White", "Off-White", "OW/W", "Cream to OW", "Cream", "C/OW", "OW", "W", "Light Tan to OW", "Light Tan to Cream", "Light Tan", "Tan to OW", "Tan to Cream", "Tan", "Dark Tan to OW", "Dark Tan", "Brown to OW", "Brown to Tan", "Brown", "Brown/Brittle", "Slightly Brittle", "Brittle"
- graderNotes: CGC-format defect notes, concise, using official CGC terminology
- myAssessment: 2-3 sentence rationale. If the book has an existing CGC grade, be willing to challenge it and note if it could plausibly grade higher or lower on resubmission.
- press: true if pressing recommended, false if not, null if unclear
- uv: true if UV recommended (white cover with tanning on unprinted areas), false if not, null if unclear
- clean: true if cleaning recommended, false if not, null if unclear

PAGE QUALITY CALIBRATION — CRITICAL:
Phone camera images under indoor artificial lighting make comic pages appear significantly more yellowed and tanned than they actually are under neutral lighting, which is how CGC graders assess them. You must correct for this systematic bias.

RULE: Always assign page quality ONE TIER HIGHER (whiter) than what you observe in the photo.
- Pages appearing "Cream to OW" in photo → assign "Off-White" 
- Pages appearing "Off-White" in photo → assign "Off-White to White"
- Pages appearing "Off-White to White" in photo → consider "White" for well-preserved books
- Only assign "Cream to OW" if tanning is severe, heavy, and completely unambiguous — not just slightly warm or aged-looking edges
- "Off-White" (OW) is the standard baseline for Silver Age (1956-1969) books in good condition, not "Cream to OW"
- "Off-White to White" (OW/W) is common for Bronze Age (1970-1985) books in good condition
- "Cream to OW" is reserved for books with clearly visible, significant brownish toning throughout — it is NOT the default for vintage books

GRADE CALIBRATION:
- Assign high grades (9.0-9.6) when warranted by strong eye appeal, flat spine, bright colors, sharp corners
- Do not cap grades at 8.5 out of excessive caution — if defects are minor, go higher
- CGC grades vary by up to a full point between submissions; challenge existing grades when you see evidence for a different outcome

UV rule: Recommend UV only for predominantly white covers with tanning on non-inked/unprinted areas. A 3D-printed ink-protection mask is available.
Press rule: Spine roll = pressable. Edge fraying = NOT pressable. Corner creases = pressable. Tanning = NOT pressable.
Use official CGC defect terminology only. Always note whether stress lines are color-breaking or not.
Return ONLY valid JSON with no preamble or markdown.`;

  const psaPrompt = `You are a PSA comic book grading expert. PSA launched comic grading in July 2025. Analyze the provided photos and return a JSON object:

- title: series title — strip any leading "The "
- issue: issue number as string
- issueDate: cover date as printed
- publisher: publisher name
- grade: numeric PSA grade as string
- pageQuality: must be exactly one of: "White", "Off-White to White", "Off-White", "Cream to Off-White", "Cream", "Light Tan to Off-White", "Light Tan", "Tan", "Brown", "Brittle"
- graderNotes: PSA-format notes emphasizing eye appeal
- myAssessment: 2-3 sentence rationale. PSA values eye appeal — give benefit of the doubt at grade boundaries.
- press: true/false/null
- uv: true/false/null
- clean: true/false/null

PAGE QUALITY CALIBRATION: Phone cameras make pages look more tanned than in person. Assign ONE TIER HIGHER than what you see. Only assign "Cream to Off-White" if tanning is severe and unmistakable.
GRADE CALIBRATION: PSA explicitly values eye appeal. Flat spine, bright colors, sharp corners = high grade. Be willing to go high.
PSA grade points: 10, 9.8, 9.6, 9.4, 9.2, 9.0, 8.5, 8.0, 7.5, 7.0, 6.5, 6.0, 5.0, 4.0, 3.0, 2.0, 1.0, 0.5, 0.3
Return ONLY valid JSON with no preamble or markdown.`;

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
            { type: 'text', text: 'Please assess this comic book and return the JSON grading object.' }
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
    try {
      parsed = JSON.parse(clean);
    } catch (e) {
      return res.status(500).json({ error: 'Failed to parse response: ' + text });
    }

    return res.status(200).json(parsed);

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
