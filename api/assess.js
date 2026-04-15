export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'API key not configured' });
  const COMICVINE_API_KEY = process.env.COMICVINE_API_KEY || '';
  const { images, grader = 'CGC', cgcGrade = null, cgcGraderNotes = '', psaGraderNotes = '', title = '', issueNumber = '', issueDate = '' } = req.body;
  if (!images || images.length === 0) return res.status(400).json({ error: 'No images provided' });

  // Normalize media type — Anthropic rejects image/jpg
  function normalizeMediaType(mt) {
    if (!mt || mt === 'image/jpg') return 'image/jpeg';
    return mt;
  }

  const imageBlocks = images.map(img => {
    const [header, data] = img.split(',');
    const raw = (header.match(/data:(.*);base64/) || [])[1] || 'image/jpeg';
    return { type: 'image', source: { type: 'base64', media_type: normalizeMediaType(raw), data } };
  });

  // Fetch with timeout helper
  async function fetchWithTimeout(url, options = {}, timeoutMs = 5000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const resp = await fetch(url, { ...options, signal: controller.signal });
      return resp;
    } finally {
      clearTimeout(timer);
    }
  }

  // Fetch page quality reference image
  async function fetchPageQualityReference(baseUrl) {
    try {
      const url = `${baseUrl}/Grade_Reference/pq.jpg`;
      const resp = await fetchWithTimeout(url, {}, 4000);
      if (!resp.ok) return null;
      const buf = await resp.arrayBuffer();
      const b64 = Buffer.from(buf).toString('base64');
      return { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: b64 } };
    } catch (e) { return null; }
  }

  // Fetch grade reference image for the assessed grade
  async function fetchGradeReference(grade, baseUrl) {
    const validGrades = ['5.0','5.5','6.0','6.5','7.0','7.5','8.0','8.5','9.0','9.2','9.4','9.6','9.8','9.9','10.0'];
    const gradeStr = String(parseFloat(grade).toFixed(1));
    if (!validGrades.includes(gradeStr)) return null;
    const filename = gradeStr.replace('.', '_') + '.jpg';
    const url = `${baseUrl}/Grade_Reference/${filename}`;
    try {
      const resp = await fetchWithTimeout(url, {}, 4000);
      if (!resp.ok) return null;
      const buf = await resp.arrayBuffer();
      const b64 = Buffer.from(buf).toString('base64');
      const ct = resp.headers.get('content-type') || 'image/jpeg';
      return { type: 'image', source: { type: 'base64', media_type: normalizeMediaType(ct), data: b64 } };
    } catch (e) { return null; }
  }

  // Build grader notes context
  const notesContext = [];
  if (cgcGraderNotes && cgcGraderNotes.trim()) {
    notesContext.push(`OFFICIAL CGC GRADER NOTES FOR THIS BOOK:\n${cgcGraderNotes.trim()}\nThese are the official defects documented by CGC graders. Factor in any interior defects listed here (staple rust, page quality issues, centerfold detachment, interior tanning, etc.) that may not be visible in the photos when forming your regrade assessment.`);
  }
  if (psaGraderNotes && psaGraderNotes.trim()) {
    notesContext.push(`OFFICIAL PSA GRADER NOTES FOR THIS BOOK:\n${psaGraderNotes.trim()}\nThese are the official defects documented by PSA graders. Factor these in when forming your assessment.`);
  }
  const notesBlock = notesContext.length > 0 ? '\n\n' + notesContext.join('\n\n') : '';

  // PSA-only path (regrade from existing CGC grade — no images needed beyond reference)
  if (grader === 'PSA' && cgcGrade) {
    const psaPrompt = `You are a PSA comic book grading expert. The CGC AI assessment for this comic assigned a grade of ${cgcGrade}. Assess whether PSA would grade this book differently.

Return this JSON:
{
  "grade": "your AI PSA grade — must be one of: 10, 9.8, 9.6, 9.4, 9.2, 9.0, 8.5, 8.0, 7.5, 7.0, 6.5, 6.0, 5.5, 5.0, 4.5, 4.0, 3.5, 3.0, 2.5, 2.0, 1.5, 1.0, 0.5, 0.3",
  "psaNotes": "1-2 sentences explaining why PSA would grade this differently, grounded in what you can observe about this specific book. Empty string if same grade.",
  "labelDetected": false,
  "officialPSAGrade": null,
  "officialPSACert": null
}

CONTEXT:
PSA entered comic grading in mid-2025 and is still establishing its calibration. Early real-world data from collectors who submitted the same books to both companies suggests PSA tends to run slightly more generous than CGC on average, particularly on Silver and Bronze Age material — though not universally. PSA's graders come from a card grading background where eye appeal and overall presentation are weighted more holistically alongside defect enumeration.

HOW TO APPROACH THIS:
Start from the CGC grade of ${cgcGrade}. Consider whether any of the following apply to THIS SPECIFIC BOOK based on what you can see:

Reasons PSA might grade HIGHER:
- The book presents exceptionally well — strong color saturation, flat spine, clean overall presentation — in a way that PSA's eye-appeal emphasis would reward beyond what the defect list suggests
- Silver or Bronze Age books with good eye appeal, where PSA's newer-entrant tendency toward generosity has been documented
- Defects are minor and isolated, and the overall impression of the book is stronger than the technical grade implies
- The book has been pressed and the remaining defects are minimal relative to the strong presentation

Reasons PSA might grade LOWER:
- Tape of any kind — PSA always treats tape as a defect, never as restoration
- Accumulated small defects that collectively undermine eye appeal more than any single defect would suggest
- Prominent spine stress that significantly affects the visual presentation even if technically graded as "light"

It's reasonable for most mid-grade Silver Age books in good condition to come back half a point higher at PSA given current calibration patterns. It's also reasonable to find no difference for books where defects are clear and enumerable rather than presentation-based. Use your judgment on the specific book in front of you. Do not invent defects or characteristics not visible in the photos. If psaNotes is empty string, grade must equal ${cgcGrade}.

If a PSA label is visible: set labelDetected=true, officialPSAGrade to label grade, officialPSACert to cert number.

Return ONLY valid JSON, no markdown.`;

    try {
      const response = await fetchWithTimeout('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({
          model: 'claude-haiku-4-5',
          max_tokens: 512,
          system: psaPrompt,
          messages: [{ role: 'user', content: [...imageBlocks, { type: 'text', text: 'Assess PSA grade variance for this comic. Return ONLY valid JSON.' }] }]
        })
      }, 20000);
      if (!response.ok) return res.status(500).json({ error: 'PSA API error: ' + await response.text() });
      const data = await response.json();
      const text = data.content[0].text.trim().replace(/^```json\s*/i,'').replace(/^```\s*/i,'').replace(/```\s*$/i,'').trim();
      const parsed = JSON.parse(text);
      if (parsed.grade && !String(parsed.grade).includes('.')) parsed.grade = parseFloat(parsed.grade).toFixed(1);
      return res.status(200).json(parsed);
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  // ─────────────────────────────────────────────────────────────
  // UNIFIED CGC + ROBOGRADE ASSESSMENT — single API call
  // Both graders observe the same images; only their rules differ.
  // ─────────────────────────────────────────────────────────────

  const baseUrl = req.headers['host']
    ? `https://${req.headers['host']}`
    : (process.env.VERCEL_PROJECT_PRODUCTION_URL ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}` : '');

  let referenceImageBlock = null;
  let pageQualityImageBlock = null;

  // Fetch ComicVine + page quality in parallel
  const cvFetch = (title && issueNumber && COMICVINE_API_KEY) ? (async () => {
    try {
      const searchTitle = title.replace(/^The\s+/i, '').trim();
      const cvSearchUrl = `https://comicvine.gamespot.com/api/search/?api_key=${COMICVINE_API_KEY}&format=json&query=${encodeURIComponent(searchTitle + ' ' + issueNumber)}&resources=issue&field_list=image,volume,issue_number&limit=5`;
      const cvResp = await fetchWithTimeout(cvSearchUrl, { headers: { 'User-Agent': 'ComicGraderApp/1.0' } }, 5000);
      if (cvResp.ok) {
        const cvData = await cvResp.json();
        const results = cvData.results || [];
        const match = results.find(r => {
          const issNum = String(r.issue_number || '').replace(/^0+/, '');
          const targetIss = String(issueNumber).replace(/^0+/, '');
          return issNum === targetIss;
        }) || results[0];
        if (match && match.image && match.image.medium_url) {
          const imgResp = await fetchWithTimeout(match.image.medium_url, {}, 4000);
          if (imgResp.ok) {
            const imgBuffer = await imgResp.arrayBuffer();
            referenceImageBlock = { type: 'image', source: { type: 'base64', media_type: normalizeMediaType(imgResp.headers.get('content-type') || 'image/jpeg'), data: Buffer.from(imgBuffer).toString('base64') } };
          }
        }
      }
    } catch (e) { /* CV fetch failed — proceed without */ }
  })() : Promise.resolve();

  const pqFetch = baseUrl ? fetchPageQualityReference(baseUrl).then(r => { pageQualityImageBlock = r; }) : Promise.resolve();
  await Promise.all([cvFetch, pqFetch]);

  // ── UNIFIED PROMPT ──────────────────────────────────────────
  const unifiedPrompt = `You are a comic book condition expert. Analyze the provided photos ONCE and return a single JSON object with three grading assessments — CGC, PSA, and RoboGrade — all based on the same visual observations.

STEP 1 — MANDATORY STRUCTURAL INSPECTION (do this before anything else):
Examine every corner and every edge of the cover in the photos with maximum care. Look specifically for:
- Any missing paper, chips, or pieces torn away from corners or edges
- Any holes through the cover
- Any tears that result in paper loss

If you see ANY missing piece or chip — even small — you MUST list it first in cgc.graderNotes with its location and approximate size. A missing corner piece of 1" is an extremely significant defect that places a hard ceiling on the grade. Do not let overall cover impression override what you can see at the corners. Check the lower right corner, lower left corner, upper right corner, and upper left corner individually and explicitly.

MISSING PIECE GRADE CEILINGS:
- Small chip under 1/4": max ~9.0 depending on location
- Moderate chip 1/4"–1/2": max ~8.0
- Large chip or piece over 1/2": max ~5.0
- Missing piece over 1": max ~3.0
- Missing piece over 2": Incomplete designation

STEP 2 — Check if a CGC or PSA grading label/slab is visible in any photo. If so:
- Read the grade, cert number, and page quality directly from the label
- Read the CENTER of the label for special designations (Married Pages, pedigree collection names, restoration notes)
- Read the RIGHT SIDE of the label for key issue notations (first appearances, deaths, new costumes, significant story events)

PAGE QUALITY CALIBRATION:
Phone cameras under artificial light make pages look significantly more yellowed than they are in neutral light. Always assign ONE TIER HIGHER than what you see in the photo.
- Photo looks "Cream to Off-White" → assign "Off-White"
- Photo looks "Off-White" → assign "Off-White to White"
- Only assign "Cream to Off-White" if tanning is heavy, brown, and completely unambiguous
- "Off-White" is the Silver Age baseline. "Off-White to White" is common for Bronze Age.
- NEVER use abbreviations. Always write the full designation.

CGC GRADE CALIBRATION:
- Assign 9.0–9.6 when defects are minor. Do not cap at 8.5 out of caution.
- Strong eye appeal, flat spine, bright colors, sharp corners = high grade.
- Challenge existing CGC grades when evidence warrants.
- Your grade in cgc.grade MUST match the grade you state in cgc.aiAssessment.

CGC GRADER NOTES FORMAT:
- One bullet per defect, each on its own line starting with •
- ALWAYS check for missing pieces, chips, or tears first
- Use official CGC terminology. Always note whether stress lines are color-breaking or not.
- Omit if book is essentially perfect (9.8+)

INDEX OF DEFECTS — GRADE IMPACT REFERENCE:
Key: [minimal = little/no impact] [moderate = impact based on severity] [significant = common/major impact]

Defect               | Minimal (little/no impact) | Moderate (severity-dependent) | Significant (common/major)
---------------------|---------------------------|-------------------------------|---------------------------
Distribution ink     | 0.5–6.5                   | 7.0–8.0                       | 8.5–9.9
Stress lines         | 0.5–6.5                   | 7.0–8.5                       | 9.0–10.0
Bend                 | 0.5–7.5                   | 8.0–9.8                       | 9.9–10.0
Stamp                | 0.5–7.5                   | 8.0–9.2                       | 9.4–10.0
Printer tear         | 0.5–7.5                   | 8.0–9.2                       | 9.4–10.0
Soiling              | 0.5–6.5                   | 7.0–8.5                       | 9.0–10.0
Bindery chip         | 0.5–6.5                   | 7.0–8.5                       | 9.0–10.0
Bindery tear         | 0.5–6.5                   | 7.0–8.5                       | 9.0–10.0
Crease               | 0.5–2.5                   | 3.0–4.0 / 5.5–8.0             | 4.5–5.0 / 8.5–10.0
Stain                | 0.5–1.5                   | 1.8–3.5                       | 4.0–10.0
Rust stains          | 0.5–5.5                   | 6.0–8.0                       | 8.5–10.0
Fingerprints         | 0.5–4.5                   | 5.0–7.0                       | 7.5–10.0
Staple rust          | 0.5–4.5                   | 5.0–7.0                       | 7.5–10.0
Staple tears         | 0.5–4.5                   | 5.0–7.0                       | 7.5–10.0
Foxing               | 0.5–4.5                   | 5.0–7.0                       | 7.5–10.0
Tanning              | 0.5–4.5                   | 5.0–7.0                       | 7.5–10.0
Writing              | 0.5–4.5                   | 5.0–7.0                       | 7.5–10.0
Tear                 | 0.5–2.0                   | 2.5–4.0 / 5.5–6.0             | 4.5–5.0 / 6.5–10.0
Missing piece (cover)| 0.5 only                  | 1.0–1.5                       | 1.8–9.6 (always severe)
Fade                 | 0.5–3.5                   | 4.0–6.5                       | 7.0–10.0
Spine roll           | 0.5–3.5                   | 4.0–6.0                       | 6.5–10.0
Spine split          | 0.5–1.0                   | 1.5–2.5                       | 3.0–9.9
Sticker              | 0.5–4.5                   | 5.0–7.5                       | 8.0–10.0
Tape                 | 0.5–2.5                   | 3.0–5.0                       | 5.5–9.9
Detached cover       | 0.5–2.0                   | 2.5–4.0                       | 4.5–9.2
Missing page/wrap    | 0.5 only                  | —                             | 1.0 and above (always red)

CRITICAL IMPLICATIONS FOR GRADING:
- A defect that is "minimal" at low grades becomes "significant" at high grades.
- Missing piece (cover) and missing page/wrap are significant at virtually all grade levels.
- When assessing a book in the 8.0–10.0 range, treat stress lines, bends, soiling, distribution ink, stamps, and printer tears as potentially grade-defining defects.

UV: only for white covers with tanning on unprinted areas. Ink-protection mask available.
Press: spine roll=yes, edge fraying=no, corner creases=yes, tanning=no.

PSA ASSESSMENT RULES:
Start from your CGC grade. PSA entered comic grading in mid-2025 and tends to run slightly more generous than CGC on Silver and Bronze Age material with good eye appeal. PSA graders weight overall presentation holistically.
- Grade HIGHER if: exceptional eye appeal, flat spine, strong color saturation, pressed book with minimal remaining defects
- Grade LOWER if: tape (PSA always penalizes tape), accumulated small defects undermining eye appeal, prominent spine stress
- Grade SAME if: defects are clear and enumerable rather than presentation-based
- If psaNotes is empty string, psa.grade must equal cgc.grade

ROBOGRADE RULES:
RoboGrade is an AI-native scoring system using a point-deduction model. Start each cover at 100 and subtract points for each visible defect using the table below. Only deduct for defects you can actually see in the photos.

POINT DEDUCTION TABLE:

Creases:
- Color-breaking crease, full width (6"+): −30 to −35
- Color-breaking crease, partial (3"–6"): −15 to −25
- Color-breaking crease, small (under 3"): −5 to −12
- Non-color-breaking crease, any length: −1 to −4

Corners:
- Blunting 3/16" radius or larger: −8
- Blunting 2/16" radius: −6
- Blunting 1/16" radius: −3
- Blunting barely visible: −1

Spine:
- Spine split, full length: −30
- Spine split, partial: −10 to −20
- Spine stress lines, 5+ color-breaking: −15 to −20
- Spine stress lines, 3–4 non-color-breaking: −4
- Spine stress lines, 1–2 non-color-breaking: −2
- Spine roll, heavy: −8

Soiling / Foxing / Staining:
- Heavy soiling or staining (10%+ cover area): −10 to −15
- Moderate soiling (5%–10%): −5 to −8
- Light soiling or foxing (3%–5%): −2.4 to −4
- Trace soiling (under 3%): −1

Color Fading:
- Heavy fading (full cover, washed out): −8 to −12
- Moderate fading (full cover, noticeable): −4 to −7
- Light fading (partial or subtle): −1 to −3

Tears / Missing Pieces:
- Missing piece over 1": −40+
- Missing piece 1/4"–1": −15 to −35
- Small chip under 1/4": −8 to −12
- Tear without missing paper, over 1": −10 to −20
- Tear without missing paper, under 1": −3 to −8

Other:
- Tape (any): −15 to −25
- Writing on cover: −5 to −15
- Sticker or sticker residue: −5 to −10
- Staple rust visible: −3 to −6
- Water damage: −5 to −20 depending on severity

CALCULATION:
- frontRawScore = 100 − (sum of front deductions)
- backRawScore = 100 − (sum of back deductions)
- roboGrade = round((frontRawScore × 0.80) + (backRawScore × 0.20)) to nearest whole number
- Report as a single integer (e.g. 49, not 49.4, not a 10.0 scale)

For each defect, record: name, location, measurement (if estimable), colorBreaking (true/false), and pointsDeducted.

Return ONLY this JSON structure, no markdown:
{
  "cgc": {
    "title": "series title — strip any leading The",
    "issue": "issue number e.g. 57 or A1 for annuals",
    "issueDate": "cover date as printed e.g. 2/68",
    "publisher": "publisher name",
    "grade": "your AI CGC grade as string e.g. 7.0",
    "pageQuality": "use FULL FORM ONLY — one of: White, Off-White to White, Off-White, Cream to Off-White, Cream, Light Tan to Off-White, Light Tan to Cream, Light Tan, Tan to Off-White, Tan to Cream, Tan, Dark Tan to Off-White, Dark Tan, Brown to Off-White, Brown to Tan, Brown, Brown/Brittle, Slightly Brittle, Brittle",
    "graderNotes": "bullet-pointed defect list using official CGC terminology, one defect per line starting with •. Empty string if book is essentially perfect.",
    "aiAssessment": "2-4 sentences. Lead with overall impression. Name dominant defects. State grade and rationale. Note press/UV/clean recommendations. If an existing CGC grade is visible on a label, compare your assessment to it.",
    "labelNotes": "Key issue notations and special designations from label center and right side only. Empty string if none.",
    "press": true,
    "uv": false,
    "clean": false,
    "labelDetected": false,
    "officialCGCGrade": null,
    "officialCGCCert": null,
    "officialPageQuality": null
  },
  "psa": {
    "grade": "PSA grade string",
    "psaNotes": "1-2 sentences on variance. Empty string if same as CGC.",
    "labelDetected": false,
    "officialPSAGrade": null,
    "officialPSACert": null
  },
  "roboGrade": {
    "grade": 74,
    "frontDefects": [{"name": "defect name", "location": "where on cover", "measurement": "e.g. 7 in or 2/16 in radius", "colorBreaking": false, "pointsDeducted": 4.0}],
    "backDefects": [],
    "assessmentNotes": "1-2 sentences on what drove this RoboGrade. Note any defects that could not be assessed from photos.",
    "version": "1.0"
  }
}${notesBlock}`;

  try {
    const response = await fetchWithTimeout('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: 'claude-opus-4-6',
        max_tokens: 2048,
        system: unifiedPrompt,
        messages: [{
          role: 'user',
          content: [
            ...(referenceImageBlock ? [
              { type: 'text', text: 'REFERENCE IMAGE: The following image is a clean cover scan of this exact issue from ComicVine, showing how the book should look without damage. Use it to identify missing pieces, color loss, and damage by comparing against your assessment photos.' },
              referenceImageBlock
            ] : []),
            ...(pageQualityImageBlock ? [
              { type: 'text', text: 'PAGE QUALITY REFERENCE: The following image shows the CGC page quality color scale. Compare interior page photos against this scale to determine page quality. When in doubt, round up.' },
              pageQualityImageBlock
            ] : []),
            ...imageBlocks,
            { type: 'text', text: 'Please assess this comic. Before listing any other defects, examine each corner individually for missing pieces or chips. Then return the unified JSON grading object with cgc, psa, and roboGrade keys.' }
          ]
        }]
      })
    }, 40000);

    if (!response.ok) {
      const err = await response.text();
      return res.status(500).json({ error: 'Anthropic API error: ' + err });
    }

    const data = await response.json();
    const text = data.content[0].text.trim();
    const clean = text.replace(/^```json\s*/i,'').replace(/^```\s*/i,'').replace(/```\s*$/i,'').trim();

    let parsed;
    try { parsed = JSON.parse(clean); }
    catch (e) { return res.status(500).json({ error: 'Failed to parse response: ' + text }); }

    // Normalize grades
    if (parsed.cgc?.grade && !String(parsed.cgc.grade).includes('.')) {
      parsed.cgc.grade = parseFloat(parsed.cgc.grade).toFixed(1);
    }
    if (parsed.psa?.grade && !String(parsed.psa.grade).includes('.')) {
      parsed.psa.grade = parseFloat(parsed.psa.grade).toFixed(1);
    }

    // Grade reference refinement pass (CGC only, grade in 5.0–10.0 range, no label detected)
    let gradeRefSucceeded = false;
    if (!parsed.cgc?.labelDetected && parsed.cgc?.grade) {
      const refImage = baseUrl ? await fetchGradeReference(parsed.cgc.grade, baseUrl) : null;
      if (refImage) {
        const refPrompt = `You previously assessed this comic as CGC grade ${parsed.cgc.grade}. Here is the official CGC grading reference page for ${parsed.cgc.grade}. Compare your assessment photos against this reference. If the reference shows the book should look better or worse than what you assessed, adjust your CGC grade. Return the SAME full JSON structure (cgc, psa, roboGrade) with any refined grades. If ${parsed.cgc.grade} still seems correct, return the same grades.${notesBlock}`;
        try {
          const refResp = await fetchWithTimeout('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
            body: JSON.stringify({
              model: 'claude-haiku-4-5',
              max_tokens: 2048,
              system: unifiedPrompt,
              messages: [{
                role: 'user',
                content: [
                  { type: 'text', text: `GRADE REFERENCE for ${parsed.cgc.grade}: The following image shows what a CGC ${parsed.cgc.grade} book looks like with annotated defects.` },
                  refImage,
                  ...imageBlocks,
                  { type: 'text', text: refPrompt }
                ]
              }]
            })
          }, 25000);
          if (refResp.ok) {
            const refData = await refResp.json();
            const refText = refData.content?.map(b => b.text || '').join('') || '';
            const refClean = refText.replace(/```json|```/g, '').trim();
            const refParsed = JSON.parse(refClean);
            if (refParsed.cgc?.grade) {
              if (!String(refParsed.cgc.grade).includes('.')) refParsed.cgc.grade = parseFloat(refParsed.cgc.grade).toFixed(1);
              parsed = refParsed;
              gradeRefSucceeded = true;
            }
          }
        } catch (e) { /* Refinement failed — use original */ }
      }
    }

    // Attach diagnostics
    parsed._diagnostics = {
      comicvineRef: referenceImageBlock !== null,
      pageQualityRef: pageQualityImageBlock !== null,
      gradeRef: gradeRefSucceeded
    };

    // Return the full unified object — index.html destructures cgc, psa, roboGrade from it
    return res.status(200).json(parsed);

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
