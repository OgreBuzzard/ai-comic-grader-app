export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'API key not configured' });
  }

  const { images } = req.body;
  if (!images || images.length === 0) {
    return res.status(400).json({ error: 'No images provided' });
  }

  // Build image content blocks
  const imageBlocks = images.map(img => {
    const [header, data] = img.split(',');
    const mediaType = header.match(/data:(.*);base64/)[1];
    return {
      type: 'image',
      source: { type: 'base64', media_type: mediaType, data }
    };
  });

  const systemPrompt = `You are a CGC comic book grading expert. Analyze the provided photos of a comic book and return a JSON object with these fields:
- title: series title (string)
- issue: issue number as string, e.g. "57" or "A1" for annuals
- issueDate: cover date as printed, e.g. "2/68"
- publisher: publisher name
- grade: your numeric grade as a string, e.g. "7.0"
- pageQuality: CGC page quality designation — must be one of exactly these values: "White", "Off-White to White", "Off-White", "OW/W", "Cream to OW", "Cream", "C/OW", "OW", "W", "Light Tan to OW", "Light Tan to Cream", "Light Tan", "Tan to OW", "Tan to Cream", "Tan", "Dark Tan to OW", "Dark Tan", "Brown to OW", "Brown to Tan", "Brown", "Brown/Brittle", "Slightly Brittle", "Brittle"
- graderNotes: CGC-format defect notes, concise, using official CGC terminology
- myAssessment: 2-3 sentence grading rationale explaining dominant defects and grade
- press: true if pressing is recommended, false if not, null if unclear
- uv: true if UV treatment is recommended (predominantly white cover with tanning on unprinted areas), false if not, null if unclear
- clean: true if cleaning is recommended, false if not, null if unclear

UV rule: Recommend UV (true) only for predominantly white covers with tanning on non-inked/unprinted areas. A 3D-printed ink-protection mask is available that blocks all ink during UV treatment, making it low risk on white covers.

Press rule: Spine roll = pressable. Edge fraying = NOT pressable. Corner creases = generally pressable. Tanning = NOT pressable.

Use official CGC defect terminology only. Always note whether stress lines are color-breaking or not. Return ONLY valid JSON with no preamble or markdown.`;

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

    // Strip markdown fences if present
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
