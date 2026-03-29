export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'API key not configured' });
  const { images, grader = 'CGC', cgcGrade = null } = req.body;
  if (!images || images.length === 0) return res.status(400).json({ error: 'No images provided' });

  const imageBlocks = images.map(img => {
    const [header, data] = img.split(',');
    const mediaType = header.match(/data:(.*);base64/)[1];
    return { type: 'image', source: { type: 'base64', media_type: mediaType, data } };
  });

  const isCGC = grader !== 'PSA';

  const cgcPrompt = `You are a CGC comic book grading expert. Analyze the provided photos and return a JSON object.

FIRST: Check if a CGC or PSA grading label/slab is visible in any photo. If so:
- Read the grade, cert number, and page quality directly from the label
- Read the CENTER of the label for special designations (Married Pages, pedigree collection names, restoration notes)
- Read the RIGHT SIDE of the label for key issue notations (first appearances, deaths, new costumes, significant story events)
- Skip the left side (creator credits — not needed)

Return this JSON structure:
{
  "title": "series title — strip any leading The",
  "issue": "issue number e.g. 57 or A1 for annuals",
  "issueDate": "cover date as printed e.g. 2/68",
  "publisher": "publisher name",
  "grade": "your AI CGC grade as string e.g. 7.0",
  "pageQuality": "use FULL FORM ONLY — one of: White, Off-White to White, Off-White, Cream to Off-White, Cream, Light Tan to Off-White, Light Tan to Cream, Light Tan, Tan to Off-White, Tan to Cream, Tan, Dark Tan to Off-White, Dark Tan, Brown to Off-White, Brown to Tan, Brown, Brown/Brittle, Slightly Brittle, Brittle",
  "graderNotes": "bullet-pointed defect list using official CGC terminology, one defect per line starting with •. Empty string if book is essentially perfect.",
  "aiAssessment": "2-4 sentences. Lead with overall impression. Name dominant defects. State grade and rationale. Note press/UV/clean recommendations. If an existing CGC grade is visible on a label, compare your assessment to it and note whether a regrade might yield a different result.",
  "labelNotes": "Key issue notations and special designations from the label's center and right side only. Examples: '1st app. Spider-Man', 'Death of Gwen Stacy', 'Part of the John Burke Collection', 'Married Pages'. Empty string if none or no label visible.",
  "press": true/false/null,
  "uv": true/false/null,
  "clean": true/false/null,
  "labelDetected": false,
  "officialCGCGrade": null,
  "officialCGCCert": null,
  "officialPageQuality": null
}

If a CGC label IS visible: set labelDetected=true, officialCGCGrade to the grade on the label, officialCGCCert to the cert number, officialPageQuality to the page quality on the label (full form, not abbreviated).

PAGE QUALITY — CRITICAL CALIBRATION:
Phone cameras under artificial light make pages look significantly more yellowed than they are in neutral light. Always assign ONE TIER HIGHER than what you see in the photo.
- Photo looks "Cream to Off-White" → assign "Off-White"
- Photo looks "Off-White" → assign "Off-White to White"
- Only assign "Cream to Off-White" if tanning is heavy, brown, and completely unambiguous
- "Off-White" is the Silver Age baseline. "Off-White to White" is common for Bronze Age.
- NEVER use abbreviations. Always write the full designation.

GRADE CALIBRATION:
- Assign 9.0–9.6 when defects are minor. Do not cap at 8.5 out of caution.
- Strong eye appeal, flat spine, bright colors, sharp corners = high grade.
- Challenge existing CGC grades when evidence warrants.
- Your grade in the "grade" field MUST match the grade you state in aiAssessment. They must be identical.

GRADER NOTES FORMAT:
- One bullet per defect: • Spine stress lines, color-breaking, light
- Omit if book is essentially perfect (9.8+)
- Use official CGC terminology. Always note whether stress lines are color-breaking or not.

UV: only for white covers with tanning on unprinted areas. Ink-protection mask available.
Press: spine roll=yes, edge fraying=no, corner creases=yes, tanning=no.

Return ONLY valid JSON, no markdown.`;

  const psaPrompt = `You are a PSA comic book grading expert. The CGC assessment for this comic has already been completed and assigned an AI CGC grade of ${cgcGrade || 'unknown'}. Your ONLY job is to determine if PSA would grade this differently from that CGC grade, and explain why.

Return this JSON:
{
  "grade": "your AI PSA grade as string — must be one of PSA's valid grades: 10, 9.8, 9.6, 9.4, 9.2, 9.0, 8.5, 8.0, 7.5, 7.0, 6.5, 6.0, 5.5, 5.0, 4.5, 4.0, 3.5, 3.0, 2.5, 2.0, 1.5, 1.0, 0.5, 0.3",
  "psaNotes": "1-3 sentences describing ONLY where PSA would grade differently from the CGC grade of ${cgcGrade || 'unknown'}. Reference the CGC grade explicitly. Empty string '' if PSA would give the same grade.",
  "labelDetected": false,
  "officialPSAGrade": null,
  "officialPSACert": null
}

CRITICAL: The CGC grade for this book is ${cgcGrade || 'unknown'}. Your PSA grade must be compared against that specific number. If you think PSA would give the same grade, set psaNotes to "" and set grade equal to the CGC grade.

PSA differs from CGC in these specific ways:
- PSA explicitly weights eye appeal more heavily — a book that presents beautifully may grade higher even with noted defects
- PSA may run slightly more generous on Silver/Bronze Age books
- PSA's restoration designation is "Conserved" (professional) vs "Restored" (amateur); tape is always a defect
- If PSA would give the same grade as CGC, psaNotes must be empty string ""

If a PSA label is visible: set labelDetected=true, officialPSAGrade to label grade, officialPSACert to cert number.

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
