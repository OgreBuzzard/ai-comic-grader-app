export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'API key not configured' });
  const COMICVINE_API_KEY = process.env.COMICVINE_API_KEY || '';
  const { images, grader = 'CGC', cgcGrade = null, cgcGraderNotes = '', psaGraderNotes = '', title = '', issueNumber = '', issueDate = '' } = req.body;
  if (!images || images.length === 0) return res.status(400).json({ error: 'No images provided' });

  const imageBlocks = images.map(img => {
    const [header, data] = img.split(',');
    const mediaType = header.match(/data:(.*);base64/)[1];
    return { type: 'image', source: { type: 'base64', media_type: mediaType, data } };
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

  // Fetch page quality reference image (used for all raw book assessments)
  let pqError = null;
  async function fetchPageQualityReference(baseUrl) {
    try {
      const url = `${baseUrl}/Grade_Reference/pq.jpg`;
      const resp = await fetchWithTimeout(url, {}, 4000);
      if (!resp.ok) { pqError = `HTTP ${resp.status}`; return null; }
      const buf = await resp.arrayBuffer();
      const b64 = Buffer.from(buf).toString('base64');
      return { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: b64 } };
    } catch (e) {
      pqError = e.message;
      return null;
    }
  }

  // Fetch grade reference image for the assessed grade
  async function fetchGradeReference(grade, baseUrl) {
    const validGrades = ['0.5','1.0','1.5','1.8','2.0','2.5','3.0','3.5','4.0','4.5','5.0','5.5','6.0','6.5','7.0','7.5','8.0','8.5','9.0','9.2','9.4','9.6','9.8','9.9','10.0'];
    const gradeStr = grade === 'NG' ? 'NG' : String(parseFloat(grade).toFixed(1));
    if (!validGrades.includes(gradeStr) && gradeStr !== 'NG') return null;
    const filename = gradeStr.replace('.', '_') + '.jpg';
    const url = `${baseUrl}/Grade_Reference/${filename}`;
    try {
      const resp = await fetchWithTimeout(url, {}, 4000);
      if (!resp.ok) return null;
      const buf = await resp.arrayBuffer();
      const b64 = Buffer.from(buf).toString('base64');
      const ct = resp.headers.get('content-type') || 'image/jpeg';
      return { type: 'image', source: { type: 'base64', media_type: ct, data: b64 } };
    } catch (e) {
      return null;
    }
  }


  // Fetch known copy reference images for a specific title/issue if a ref folder exists
  const knownCopiesDiag = {};
  async function fetchKnownCopies(title, issue) {
    try {
      const slug = title.replace(/[^a-zA-Z0-9-]+/g, '_').replace(/^_|_$/g, '');
      const issueClean = String(issue).replace(/[^a-zA-Z0-9.]/g, '_');
      const folderName = `${slug}_${issueClean}_Ref`;
      const apiUrl = `https://api.github.com/repos/OgreBuzzard/ai-comic-grader-app/contents/${encodeURIComponent(folderName)}`;
      const listResp = await fetchWithTimeout(apiUrl, { headers: { 'User-Agent': 'ComicGraderApp/1.0' } }, 3000);
      knownCopiesDiag.folderName = folderName;
      knownCopiesDiag.apiStatus = listResp.status;
      if (!listResp.ok) { knownCopiesDiag.error = `HTTP ${listResp.status}`; return null; }
      const files = await listResp.json();
      knownCopiesDiag.isArray = Array.isArray(files);
      knownCopiesDiag.fileCount = Array.isArray(files) ? files.length : 0;
      if (!Array.isArray(files)) { knownCopiesDiag.error = 'not array: ' + JSON.stringify(files).slice(0, 100); return null; }
      const allJpegs = files.filter(f => /\.(jpg|jpeg)$/i.test(f.name));
      if (allJpegs.length === 0) return null;
      // Sort by grade value and pick 5 evenly spaced across the range
      const graded = allJpegs.map(f => {
        const m = f.name.match(/([\d]+[._][\d]+)\.jpe?g$/i);
        const val = m ? parseFloat(m[1].replace('_', '.')) : 0;
        return { f, val };
      }).sort((a, b) => a.val - b.val);
      const step = Math.max(1, Math.floor(graded.length / 3));
      const jpegFiles = graded.filter((_, i) => i % step === 0).slice(0, 3).map(g => g.f);
      const imageBlocks = await Promise.all(jpegFiles.map(async f => {
        try {
          const imgResp = await fetchWithTimeout(f.download_url, {}, 3000);
          if (!imgResp.ok) return null;
          const buf = await imgResp.arrayBuffer();
          const b64 = Buffer.from(buf).toString('base64');
          const gradeMatch = f.name.match(/([\d.]+)\.jpe?g$/i);
          const gradeLabel = gradeMatch ? gradeMatch[1] : f.name;
          return { gradeLabel, block: { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: b64 } } };
        } catch (e) { return null; }
      }));
      const valid = imageBlocks.filter(Boolean);
      return valid.length > 0 ? valid : null;
    } catch (e) { return null; }
  }

  // Build grader notes context to append to prompts
  const notesContext = [];
  if (cgcGraderNotes && cgcGraderNotes.trim()) {
    notesContext.push(`OFFICIAL CGC GRADER NOTES FOR THIS BOOK:\n${cgcGraderNotes.trim()}\nThese are the official defects documented by CGC graders. Factor in any interior defects listed here (staple rust, page quality issues, centerfold detachment, interior tanning, etc.) that may not be visible in the photos when forming your regrade assessment.`);
  }
  if (psaGraderNotes && psaGraderNotes.trim()) {
    notesContext.push(`OFFICIAL PSA GRADER NOTES FOR THIS BOOK:\n${psaGraderNotes.trim()}\nThese are the official defects documented by PSA graders. Factor these in when forming your assessment.`);
  }
  const notesBlock = notesContext.length > 0 ? '\n\n' + notesContext.join('\n\n') : '';

  const isCGC = grader !== 'PSA';

  // Fetch ComicVine cover reference image if title and issue are available
  let referenceImageBlock = null;
  const baseUrl = req.headers['host']
    ? `https://${req.headers['host']}`
    : (process.env.VERCEL_PROJECT_PRODUCTION_URL
    ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`
    : '');

  // Run ComicVine cover fetch and page quality fetch in parallel
  let pageQualityImageBlock = null;
  const cvDiag = { step: 'init', searchTitle: '', volCount: 0, candidateCount: 0, error: null, hasKey: !!COMICVINE_API_KEY, hasTitle: !!title, hasIssue: !!issueNumber };
  if (isCGC) {
    const cvFetch = (title && issueNumber && COMICVINE_API_KEY) ? (async () => {
      try {
        const searchTitle = title.replace(/^The\s+/i, '').trim();
        cvDiag.searchTitle = searchTitle;
        cvDiag.step = 'vol_fetch';
        const cleanIssue = String(issueNumber).replace(/^0+/, '') || '0';
        function parseIssueDate(dateStr) {
          if (!dateStr) return null;
          const parts = String(dateStr).trim().split('/');
          if (parts.length < 2) return null;
          const month = parseInt(parts[0], 10);
          let year = parseInt(parts[1], 10);
          if (isNaN(month) || isNaN(year)) return null;
          if (year < 100) year = year <= 29 ? 2000 + year : 1900 + year;
          return { month, year };
        }
        const parsedDate = parseIssueDate(issueDate);
        const volumeUrl = `https://comicvine.gamespot.com/api/volumes/?api_key=${COMICVINE_API_KEY}&format=json&filter=name:${encodeURIComponent(searchTitle)}&field_list=id,name,start_year&limit=20`;
        const volResp = await fetchWithTimeout(volumeUrl, { headers: { 'User-Agent': 'ComicGraderApp/1.0' } }, 6000);
        cvDiag.volHttpStatus = volResp.status;
        if (volResp.ok) {
          const volData = await volResp.json();
          cvDiag.volTotalResults = volData.number_of_total_results || 0;
          cvDiag.volNames = (volData.results || []).map(v => v.name).slice(0, 5);
          const titleLower = searchTitle.toLowerCase();
          const volumes = (volData.results || []).filter(v => {
            if (!v.name) return false;
            const vl = v.name.toLowerCase();
            return vl === titleLower || vl === 'the ' + titleLower || vl.replace(/^the\s+/, '') === titleLower;
          });
          cvDiag.volCount = volumes.length;
          cvDiag.step = 'issue_fetch';
          if (volumes.length > 0) {
            const issueResults = await Promise.all(volumes.map(async vol => {
              try {
                const issueUrl = `https://comicvine.gamespot.com/api/issues/?api_key=${COMICVINE_API_KEY}&format=json&filter=volume:${vol.id},issue_number:${encodeURIComponent(cleanIssue)}&field_list=id,cover_date,image&limit=5`;
                const issResp = await fetchWithTimeout(issueUrl, { headers: { 'User-Agent': 'ComicGraderApp/1.0' } }, 6000);
                if (!issResp.ok) return null;
                const issData = await issResp.json();
                return (issData.results || []).length ? issData.results[0] : null;
              } catch (e) { return null; }
            }));
            const candidates = issueResults.filter(Boolean);
            cvDiag.candidateCount = candidates.length;
            cvDiag.step = 'pick_best';
            let best = null;
            if (parsedDate && candidates.length > 1) {
              for (const c of candidates) {
                if (!c.cover_date) continue;
                const [cvYear, cvMonth] = c.cover_date.split('-').map(Number);
                if (cvYear === parsedDate.year && cvMonth === parsedDate.month) { best = c; break; }
              }
              if (!best) {
                for (const c of candidates) {
                  if (!c.cover_date) continue;
                  const [cvYear] = c.cover_date.split('-').map(Number);
                  if (cvYear === parsedDate.year) { best = c; break; }
                }
              }
            }
            if (!best) best = candidates[0];
            cvDiag.step = 'img_fetch';
            if (best && best.image && best.image.medium_url) {
              const imgResp = await fetchWithTimeout(best.image.medium_url, {}, 4000);
              cvDiag.imgHttpStatus = imgResp.status;
              if (imgResp.ok) {
                const imgBuffer = await imgResp.arrayBuffer();
                referenceImageBlock = { type: 'image', source: { type: 'base64', media_type: imgResp.headers.get('content-type') || 'image/jpeg', data: Buffer.from(imgBuffer).toString('base64') } };
                cvDiag.step = 'success';
              }
            } else {
              cvDiag.step = 'no_image_url';
            }
          }
        }
      } catch (e) { cvDiag.error = e.message; cvDiag.step = 'exception'; }
    })() : Promise.resolve();

    const pqFetch = baseUrl ? fetchPageQualityReference(baseUrl).then(r => { pageQualityImageBlock = r; }) : Promise.resolve();
    await Promise.all([cvFetch, pqFetch]);
  }






  const cgcPrompt = `You are a CGC comic book grading expert. Analyze the provided photos and return a JSON object.

STEP 1 — MANDATORY STRUCTURAL INSPECTION (do this before anything else):
Examine every corner and every edge of the cover in the photos with maximum care. Look specifically for:
- Any missing paper, chips, or pieces torn away from corners or edges
- Any holes through the cover
- Any tears that result in paper loss

If you see ANY missing piece or chip — even small — you MUST list it first in graderNotes with its location and approximate size. A missing corner piece of 1" is an extremely significant defect that places a hard ceiling on the grade. Do not let overall cover impression override what you can see at the corners. Check the lower right corner, lower left corner, upper right corner, and upper left corner individually and explicitly.

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
- One bullet per defect, each on its own line starting with •
- Only document defects that are PRESENT. Never note the absence of a defect (e.g. never write "no missing piece" or "no chips detected")
- Group identical defects across corners when possible (e.g. "Upper corners: blunted with minor wear" instead of separate bullets for left and right)
- ALWAYS check for missing pieces, chips, or tears first — these are structural defects with hard grade ceilings and must be listed first if present
- A missing corner or edge piece of 1/4" or more must be noted explicitly as "Missing piece" or "Chip out" with location and approximate size
- Use official CGC terminology. Always note whether stress lines are color-breaking or not.
- Omit if book is essentially perfect (9.8+)

MISSING PIECE / CHIP OUT GRADE CEILINGS (CGC):
- Small chip (under 1/4"): caps around 9.0–9.4 depending on location
- Moderate chip (1/4"–1/2"): caps around 8.0–8.5
- Large chip or missing piece (over 1/2"): caps around 4.0–6.0
- Very large missing piece (over 1"): caps around 2.0–4.0
These ceilings apply regardless of other defects — a book cannot grade above its structural damage.

UV: only for white covers with tanning on unprinted areas. Ink-protection mask available.
Press: spine roll=yes, edge fraying=no, corner creases=yes, tanning=no.

Return ONLY valid JSON, no markdown.${notesBlock}`;

  const psaPrompt = `You are a PSA comic book grading expert. The CGC AI assessment for this comic assigned a grade of ${cgcGrade || 'unknown'}. Assess whether PSA would grade this book differently.

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
Start from the CGC grade of ${cgcGrade || 'unknown'}. Consider whether any of the following apply to THIS SPECIFIC BOOK based on what you can see:

Reasons PSA might grade HIGHER:
- The book presents exceptionally well — strong color saturation, flat spine, clean overall presentation — in a way that PSA's eye-appeal emphasis would reward beyond what the defect list suggests
- Silver or Bronze Age books with good eye appeal, where PSA's newer-entrant tendency toward generosity has been documented
- Defects are minor and isolated, and the overall impression of the book is stronger than the technical grade implies
- The book has been pressed and the remaining defects are minimal relative to the strong presentation

Reasons PSA might grade LOWER:
- Tape of any kind — PSA always treats tape as a defect, never as restoration
- Accumulated small defects that collectively undermine eye appeal more than any single defect would suggest
- Prominent spine stress that significantly affects the visual presentation even if technically graded as "light"

It's reasonable for most mid-grade Silver Age books in good condition to come back half a point higher at PSA given current calibration patterns. It's also reasonable to find no difference for books where defects are clear and enumerable rather than presentation-based. Use your judgment on the specific book in front of you. Do not invent defects or characteristics not visible in the photos. If psaNotes is empty string, grade must equal ${cgcGrade || 'unknown'}.

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
            ...(referenceImageBlock ? [
              { type: 'text', text: 'REFERENCE IMAGE: The following image is a clean cover scan of this exact issue from ComicVine, showing how the book should look without damage. Use it to identify missing pieces, color loss, and damage by comparing against your assessment photos.' },
              referenceImageBlock
            ] : []),
            ...(pageQualityImageBlock ? [
              { type: 'text', text: 'PAGE QUALITY REFERENCE: The following image shows the CGC page quality color scale from White (10) down to Tan (5). If any of your assessment photos show interior pages, compare the non-inked white space color against this scale to determine page quality. When in doubt, round up — most Silver and Bronze Age books grade at Off-White or higher.' },
              pageQualityImageBlock
            ] : []),
            ...imageBlocks,
            { type: 'text', text: 'Please assess this comic. IMPORTANT: Before listing any other defects, examine each corner individually for missing pieces or chips. Then return the JSON grading object.' }
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

    // Normalize grade to always include decimal (e.g. "10" → "10.0", "9" → "9.0")
    if (parsed.grade && !String(parsed.grade).includes('.')) {
      parsed.grade = parseFloat(parsed.grade).toFixed(1);
    }

  const CGC_GRADE_DESCRIPTIONS = {
    "10.0": `Perfect in every way. No stress lines, razor sharp corners, flat cover, no bends or creases. Full gloss, vibrant colors, no tanning/foxing/soiling. White pages only.`,
    "9.9": `One small non-color-breaking bend or one non-color-breaking spine stress line allowed. Perfectly cut, no edge or corner wear. Off-white to white pages acceptable.`,
    "9.8": `One or two handling defects allowed: a very small color-breaking stress line, a couple of light bends, tiny wear on one corner or around a staple. Cream to off-white pages rarely acceptable.`,
    "9.6": `A few very small defects: small color-breaking stress lines, very small corner wear, tiny edge crease, very small staple tear, very light tanning, one very small stain. Nothing below cream to off-white pages.`,
    "9.4": `One or a couple of light handling defects: small spine split, one or two small color-breaking corner/edge creases, very small chip, very slight spine roll. Several small non-color-breaking stress lines or a few color-breaking ones.`,
    "9.2": `More apparent regular handling defects. Still considerable eye appeal requiring close inspection. An accumulation of several tiny flaws or one significant flaw (crease, tear, missing piece, stain, or tanning).`,
    "9.0": `Color-breaking defects more evident. Minor fraying or small 1/4" missing piece allowed. Small areas of tape or sticky residue acceptable. Cover may be partially detached from one staple.`,
    "8.5": `Bridge between 9.0 and 8.0. One or two defects barely exceeding 9.0 limits: length of crease, number of stress lines, size of chip or tear. Light fraying to corners or color-breaking edge wear. Limit for light tan to off-white pages.`,
    "8.0": `Considerable minor defects or a couple of moderate ones. 1"-2" color-breaking corner/edge crease, up to 1" tear, 1/2" spine split, 1/2"x1/2" piece missing. Moderate rust on staples. Small spine roll of 1/8".`,
    "7.5": `One or two defects barely exceeding 8.0, or accumulation. 2" color-breaking crease or 1" tear (not both). Moderate foxing or tanning (not simultaneously with significant tears/creases). Slight spine roll.`,
    "7.0": `More prominent creasing and tears. Crease up to 4". 1" spine split, 1/4" spine roll. Mostly sharp edges and corners still expected. One fully detached staple (of two). Color-breaking reader's crease ~half spine length.`,
    "6.5": `Accumulation of small defects or one large one. Tape up to 1" allowed. Maximum grade for slightly brittle pages. Cover partially detached from both staples allowed. Tears accumulate up to 2".`,
    "6.0": `Mid-grade. Creases up to 7" accumulation. 1.5" spine split. Spine rolled up to 1/2". Up to 1"x1" piece missing from cover. Two interior wraps detached. Heavy rust on staples.`,
    "5.5": `Accumulation of 6.0 defects appearing below 6.0. Full color-breaking subscription crease on front allowed. One full and one half staple detachment. Tear up to 3". Heavy fingerprints on cover.`,
    "5.0": `Larger accumulation of 6.0 defects. 2" spine split. Up to 3" tape strip on outer cover. Creases up to half the cover. Heavy fading but colors not completely washed out. Up to 10" interior tear.`,
    "4.5": `Lower end of mid-grade. Up to 2"x2" missing from cover. Tears totaling up to 4". Spine roll up to 1". One full punch hole through entire book.`,
    "4.0": `Complete but with accumulation of defects: tears, creases, missing pieces, spine roll, staining, tanning, staple detachments. Usually highest grade for fully detached cover. Spine split up to 3".`,
    "3.5": `Threshold for brittle pages (lowest page quality allowed). Both staples removed = max 3.5. Detached covers/pages reattached with tape usually not higher than 3.5.`,
    "3.0": `One major defect to cover, or large accumulation of average defects. Spine split up to 5", 6" cover tear, 3" tear through book. Up to 3"x3" piece missing from cover.`,
    "2.5": `Worn and tattered. Heavy creasing, tears, staining, pieces out. Tape often present repairing detached cover or large spine split. Spine split greater than half spine length.`,
    "2.0": `Same defects as 2.5 but more severe or numerous. Still complete and readable. Few singularly quantifiable defects: mostly split spine, very large staining affecting most of book.`,
    "1.8": `Most common single defect: fully split spine (clean, little missing paper, no major repairs). Missing interior parts up to 4"x4" affecting story. Only one of these major defects present.`,
    "1.5": `Fully split spine reattached with tape or staples. Or missing pieces slightly exceeding 3"x3" from cover with significant other defects. Structural integrity compromised but still complete and readable.`,
    "1.0": `Heavily damaged. Up to 1/4 of cover missing. Full splitting of interior and cover from brittleness. Still relatively complete and readable.`,
    "0.5": `Accumulation of extensive defects, or missing significant portions of cover or interior. 1/3 or more of front or back cover can be missing. Missing pages common. Requires gentle handling.`,
    "NG": `No Grade. Missing entire cover (coverless), or front cover present with less than half interior pages, or back cover present with less than 3/4 interior pages.`,
  };

    // Fetch grade reference and known copies in parallel
    const [knownCopiesAvailable, gradeRefImage] = isCGC && !parsed.labelDetected ? await Promise.all([
      (title && issueNumber) ? fetchKnownCopies(title, issueNumber) : Promise.resolve(null),
      parsed.grade ? fetchGradeReference(parsed.grade, baseUrl) : Promise.resolve(null)
    ]) : [null, null];

    // Run grade reference and known copies refinement passes in parallel
    let gradeRefSuccessLocal = false;
    let knownCopiesRef = false;

    const refineResults = await Promise.all([
      // Grade reference pass
      (async () => {
        if (!isCGC || parsed.labelDetected || !parsed.grade || !gradeRefImage) return null;
        const gradeDesc = CGC_GRADE_DESCRIPTIONS[parsed.grade] || '';
        const refPrompt = `You previously assessed this comic as grade ${parsed.grade}. CGC ${parsed.grade} definition: ${gradeDesc} The reference image shows an example CGC ${parsed.grade} copy with annotated defects. Compare your assessment photos against this definition and reference image. Adjust your grade if warranted. Return the same JSON format with your refined grade and updated graderNotes and aiAssessment. If ${parsed.grade} still seems correct, return the same grade.${notesBlock}`;
        try {
          const refResp = await fetchWithTimeout('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
            body: JSON.stringify({
              model: 'claude-haiku-4-5-20251001',
              max_tokens: 650,
              system: systemPrompt,
              messages: [{ role: 'user', content: [
                { type: 'text', text: `GRADE REFERENCE for ${parsed.grade}: The following image shows what a CGC ${parsed.grade} book looks like with annotated defects.` },
                gradeRefImage,
                ...imageBlocks,
                { type: 'text', text: refPrompt }
              ]}]
            })
          }, 20000);
          if (!refResp.ok) return null;
          const refData = await refResp.json();
          const refText = refData.content?.map(b => b.text || '').join('') || '';
          const refClean = refText.replace(/```json|```/g, '').trim();
          const refParsed = JSON.parse(refClean);
          if (refParsed.grade) {
            if (!String(refParsed.grade).includes('.')) refParsed.grade = parseFloat(refParsed.grade).toFixed(1);
            return { type: 'gradeRef', result: refParsed };
          }
          return null;
        } catch (e) { return null; }
      })(),

      // Known copies pass
      (async () => {
        if (!isCGC || parsed.labelDetected || !knownCopiesAvailable) return null;
        const knownCopies = knownCopiesAvailable;
        const gradeList = knownCopies.map(c => c.gradeLabel).join(', ');
        const knownPrompt = `You have assessed this comic as grade ${parsed.grade}. The following images show verified CGC-graded copies of the same issue (${title} #${issueNumber}) at known grades: ${gradeList}. Each image is labeled with its grade. Compare the book you assessed against these known copies and determine where it falls. Explicitly state which two grades it falls between, or confirm it matches a specific grade. Adjust your grade if the comparison warrants it. Return the same JSON format with your refined grade, updated graderNotes, and updated aiAssessment that mentions which known copies it was compared against and where it fell.${notesBlock}`;
        const knownContent = [
          { type: 'text', text: `KNOWN GRADED COPIES OF ${title} #${issueNumber}:` },
          ...knownCopies.flatMap(c => [{ type: 'text', text: `Grade ${c.gradeLabel}:` }, c.block]),
          ...imageBlocks,
          { type: 'text', text: knownPrompt }
        ];
        try {
          const knownResp = await fetchWithTimeout('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
            body: JSON.stringify({
              model: 'claude-haiku-4-5-20251001',
              max_tokens: 400,
              system: systemPrompt,
              messages: [{ role: 'user', content: knownContent }]
            })
          }, 25000);
          if (!knownResp.ok) return null;
          const knownData = await knownResp.json();
          const knownText = knownData.content?.map(b => b.text || '').join('') || '';
          const knownClean = knownText.replace(/```json|```/g, '').trim();
          const knownParsed = JSON.parse(knownClean);
          if (knownParsed.grade) {
            if (!String(knownParsed.grade).includes('.')) knownParsed.grade = parseFloat(knownParsed.grade).toFixed(1);
            return { type: 'knownCopies', result: knownParsed };
          }
          return null;
        } catch (e) { return null; }
      })()
    ]);

    // Apply results — known copies wins if both succeed (more specific)
    for (const r of refineResults) {
      if (!r) continue;
      if (r.type === 'gradeRef') { parsed = r.result; gradeRefSuccessLocal = true; }
    }
    for (const r of refineResults) {
      if (!r) continue;
      if (r.type === 'knownCopies') { parsed = r.result; knownCopiesRef = true; }
    }

    // Attach diagnostic info (preserve gradeRef if already set by refinement pass)
    const gradeRefSucceeded = gradeRefSuccessLocal || parsed._diagnostics?.gradeRef === true;
    parsed._diagnostics = {
      comicvineRef: referenceImageBlock !== null,
      pageQualityRef: pageQualityImageBlock !== null,
      gradeRef: gradeRefSucceeded,
      knownCopiesRef,
      knownCopiesDiag,
      pqError,
      cvDiag: cvDiag || null
    };
    return res.status(200).json(parsed);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
