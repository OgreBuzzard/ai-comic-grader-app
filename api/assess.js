export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'API key not configured' });

  // Anthropic only accepts these four media types — normalize everything else to image/jpeg
  function normalizeMediaType(mt) {
    if (!mt) return 'image/jpeg';
    const clean = mt.toLowerCase().split(';')[0].trim();
    const valid = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
    if (valid.includes(clean)) return clean;
    if (clean === 'image/jpg') return 'image/jpeg';
    return 'image/jpeg'; // safe fallback
  }
  const COMICVINE_API_KEY = process.env.COMICVINE_API_KEY || '';
  const { images, grader = 'CGC', cgcGrade = null, cgcGraderNotes = '', psaGraderNotes = '', title = '', issueNumber = '' } = req.body;
  if (!images || images.length === 0) return res.status(400).json({ error: 'No images provided' });

  const imageBlocks = images.map(img => {
    const [header, data] = img.split(',');
    const rawType = header.match(/data:(.*);base64/)[1];
    return { type: 'image', source: { type: 'base64', media_type: normalizeMediaType(rawType), data } };
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
  async function fetchPageQualityReference(baseUrl) {
    try {
      const url = `${baseUrl}/Grade_Reference/pq.jpg`;
      const resp = await fetchWithTimeout(url, {}, 4000);
      if (!resp.ok) return null;
      const buf = await resp.arrayBuffer();
      const b64 = Buffer.from(buf).toString('base64');
      return { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: b64 } };
    } catch (e) {
      return null;
    }
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
    } catch (e) {
      return null;
    }
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

  const isCGC = true; // Unified prompt — PSA and RoboGrade derived within single pass

  // Fetch ComicVine cover reference image if title and issue are available
  let referenceImageBlock = null;
  const baseUrl = req.headers['host']
    ? `https://${req.headers['host']}`
    : (process.env.VERCEL_PROJECT_PRODUCTION_URL
    ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`
    : '');

  // Run ComicVine cover fetch and page quality fetch in parallel
  let pageQualityImageBlock = null;
  if (isCGC) {
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
              referenceImageBlock = { type: 'image', source: { type: 'base64', media_type: normalizeMediaType(imgResp.headers.get('content-type')), data: Buffer.from(imgBuffer).toString('base64') } };
            }
          }
        }
      } catch (e) { /* CV fetch failed — proceed without reference */ }
    })() : Promise.resolve();

    const pqFetch = baseUrl ? fetchPageQualityReference(baseUrl).then(r => { pageQualityImageBlock = r; }) : Promise.resolve();
    await Promise.all([cvFetch, pqFetch]);
  }






  // ── Census lookup ──────────────────────────────────────────────────────────
  const _CENSUS = {"amazing spiderman_300":{"t":"Amazing Spider-Man","i":"300","n":40292,"avg":8.58,"p98":5.4,"p96":14.4,"p94":16.1,"phi":35.9},"spawn_1":{"t":"Spawn","i":"1","n":38159,"avg":9.55,"p98":48.8,"p96":24.2,"p94":11.7,"phi":85.0},"amazing spiderman_361":{"t":"Amazing Spider-Man","i":"361","n":33917,"avg":9.35,"p98":22.8,"p96":33.7,"p94":18.3,"phi":74.8},"new mutants_98":{"t":"New Mutants","i":"98","n":32416,"avg":9.09,"p98":17.1,"p96":26.0,"p94":17.4,"phi":60.6},"wolverine limited series_1":{"t":"Wolverine Limited Series","i":"1","n":32345,"avg":9.02,"p98":18.5,"p96":22.2,"p94":16.8,"phi":57.7},"uncanny xmen_266":{"t":"Uncanny X-Men","i":"266","n":28297,"avg":9.13,"p98":17.8,"p96":26.3,"p94":17.9,"phi":62.1},"amazing spiderman_252":{"t":"Amazing Spider-Man","i":"252","n":27182,"avg":8.86,"p98":8.7,"p96":19.0,"p94":18.4,"phi":46.1},"venom lethal protector_1":{"t":"Venom: Lethal Protector","i":"1","n":26104,"avg":9.54,"p98":53.0,"p96":21.1,"p94":10.5,"phi":84.8},"wolverine_1":{"t":"Wolverine","i":"1","n":23121,"avg":9.09,"p98":18.9,"p96":21.3,"p94":17.1,"phi":57.4},"star wars_1":{"t":"Star Wars","i":"1","n":22008,"avg":8.65,"p98":12.0,"p96":13.7,"p94":14.5,"phi":40.2},"amazing spiderman_129":{"t":"Amazing Spider-Man","i":"129","n":20025,"avg":6.88,"p98":1.1,"p96":3.1,"p94":5.0,"phi":9.3},"incredible hulk_181":{"t":"Incredible Hulk","i":"181","n":19707,"avg":6.53,"p98":0.9,"p96":2.2,"p94":3.3,"phi":6.5},"giantsize xmen_1":{"t":"Giant-Size X-Men","i":"1","n":15045,"avg":6.69,"p98":1.9,"p96":3.4,"p94":4.6,"phi":10.0},"amazing spiderman_238":{"t":"Amazing Spider-Man","i":"238","n":13978,"avg":8.67,"p98":7.0,"p96":16.1,"p94":14.8,"phi":38.0},"amazing spiderman_194":{"t":"Amazing Spider-Man","i":"194","n":13690,"avg":8.03,"p98":4.8,"p96":10.3,"p94":11.6,"phi":26.7},"fantastic four_48":{"t":"Fantastic Four","i":"48","n":10878,"avg":5.3,"p98":0.5,"p96":1.0,"p94":1.3,"phi":2.8},"amazing spiderman_1":{"t":"Amazing Spider-Man","i":"1","n":11651,"avg":6.96,"p98":40.4,"p96":8.3,"p94":2.7,"phi":51.4},"xmen_94":{"t":"X-Men","i":"94","n":11275,"avg":6.8,"p98":0.5,"p96":1.3,"p94":3.1,"phi":4.9},"amazing spiderman_50":{"t":"Amazing Spider-Man","i":"50","n":8704,"avg":5.46,"p98":0.1,"p96":0.2,"p94":0.7,"phi":1.0},"incredible hulk_180":{"t":"Incredible Hulk","i":"180","n":9791,"avg":6.74,"p98":0.9,"p96":2.2,"p94":3.8,"phi":6.9},"iron man_1":{"t":"Iron Man","i":"1","n":9740,"avg":6.18,"p98":0.5,"p96":1.1,"p94":2.2,"phi":3.8},"amazing spiderman_121":{"t":"Amazing Spider-Man","i":"121","n":9009,"avg":7.11,"p98":1.2,"p96":3.0,"p94":5.3,"phi":9.5},"xmen_101":{"t":"X-Men","i":"101","n":9391,"avg":7.68,"p98":2.8,"p96":6.0,"p94":8.7,"phi":17.5},"daredevil_1":{"t":"Daredevil","i":"1","n":7090,"avg":4.44,"p98":0.0,"p96":0.5,"p94":0.6,"phi":1.1},"fantastic four_52":{"t":"Fantastic Four","i":"52","n":8383,"avg":5.3,"p98":0.1,"p96":0.2,"p94":0.6,"phi":0.8},"amazing spiderman_122":{"t":"Amazing Spider-Man","i":"122","n":7654,"avg":7.3,"p98":1.6,"p96":3.3,"p94":6.9,"phi":11.7},"captain america_100":{"t":"Captain America","i":"100","n":6993,"avg":6.44,"p98":0.7,"p96":1.0,"p94":2.4,"phi":4.2},"avengers_57":{"t":"Avengers","i":"57","n":7051,"avg":6.46,"p98":0.3,"p96":0.9,"p94":2.1,"phi":3.2},"avengers_4":{"t":"Avengers","i":"4","n":5775,"avg":4.79,"p98":0.1,"p96":0.5,"p94":0.7,"phi":1.3},"avengers_1":{"t":"Avengers","i":"1","n":6023,"avg":3.81,"p98":0.0,"p96":0.1,"p94":0.2,"phi":0.3},"amazing fantasy_15":{"t":"Amazing Fantasy","i":"15","n":5744,"avg":5.06,"p98":6.8,"p96":9.1,"p94":5.5,"phi":21.4},"fantastic four_1":{"t":"Fantastic Four","i":"1","n":3203,"avg":3.33,"p98":0.0,"p96":0.1,"p94":0.1,"phi":0.2},"tales of suspense_39":{"t":"Tales of Suspense","i":"39","n":3050,"avg":4.11,"p98":0.0,"p96":0.2,"p94":0.7,"phi":0.9},"journey into mystery_83":{"t":"Journey Into Mystery","i":"83","n":2668,"avg":3.81,"p98":0.0,"p96":0.0,"p94":0.4,"phi":0.5},"amazing spiderman_33":{"t":"Amazing Spider-Man","i":"33","n":3432,"avg":6.75,"p98":1.7,"p96":3.9,"p94":4.9,"phi":10.4},"avengers_3":{"t":"Avengers","i":"3","n":2072,"avg":5.31,"p98":0.0,"p96":0.5,"p94":0.8,"phi":1.3},"amazing spiderman_64":{"t":"Amazing Spider-Man","i":"64","n":2789,"avg":7.95,"p98":3.4,"p96":7.6,"p94":10.5,"phi":21.5},"amazing spiderman_67":{"t":"Amazing Spider-Man","i":"67","n":2078,"avg":7.51,"p98":0.9,"p96":2.8,"p94":7.7,"phi":11.3}};
  function _censusKey(t, i) {
    return (t||'').toLowerCase().replace(/^the\s+/i,'').replace(/[^a-z0-9\s]/g,'').replace(/\s+/g,' ').trim()
      + '_' + String(i||'').toLowerCase().trim();
  }
  function getCensusContext(t, i) {
    const d = _CENSUS[_censusKey(t, i)];
    if (!d) return '';
    return `\n\nCGC CENSUS DATA FOR THIS BOOK (${d.t} #${d.i}):`
      + `\nTotal CGC submissions: ${d.n.toLocaleString()} copies`
      + `\nAverage CGC grade: ${d.avg}`
      + `\nGrade distribution: 9.8=${d.p98}%, 9.6=${d.p96}%, 9.4=${d.p94}%, 9.4+=${d.phi}%`
      + `\nCALIBRATION: Anchor your grade to this data. If ${d.phi}% of submissions grade 9.4+,`
      + ` a high-grade copy is realistic. The average of ${d.avg} shows what most copies look like.`;
  }
  const censusContext = getCensusContext(title, issueNumber);

  // ── Photo availability ──────────────────────────────────────────────────────
  const hasPQPhoto   = pageQualityImageBlock !== null;
  const hasBackCover = images.length >= 2;
  const photoCount   = images.length;
  const baseConf     = photoCount >= 4 ? 8 : photoCount === 3 ? 12 : 16;

  // ── RoboGrade formula string (resolved now, embedded in prompt) ─────────────
  let roboFormula;
  if (!hasBackCover) {
    roboFormula = 'RoboGrade = FrontCoverScore × 1.0 (no back cover photo provided)';
  } else if (!hasPQPhoto && !cgcGrade) {
    roboFormula = 'RoboGrade = (FrontCoverScore × 0.78) + (BackCoverScore × 0.22)  [PQ excluded — no photo, no graded reference]';
  } else {
    roboFormula = 'RoboGrade = (FrontCoverScore × 0.70) + (BackCoverScore × 0.20) + (PageQualityScore × 0.10)';
  }
  const backScoreDefault  = hasBackCover  ? '0.0'  : 'null';
  const pqScoreDefault    = (hasPQPhoto || cgcGrade) ? '0' : 'null';

  // ── Unified system prompt: one image pass, neutral first, three grades ───────
  const systemPrompt = `You are an expert comic book condition analyst. Examine the photos ONCE and record neutral observations, then derive three independent grades from those observations.

════════════════════════════════════
PHASE 1 — NEUTRAL OBSERVATIONS
════════════════════════════════════

STRUCTURAL CHECK (mandatory first):
Examine every corner and every edge. Look for missing pieces, chips, tears, holes. Check all four corners individually and explicitly. If ANY missing piece or chip exists, note its location and approximate size first.

DEFECT INVENTORY — for every defect record:
• Type (use official CGC terminology)
• Location (which corner, edge, or area)
• Measurement (use the ruler visible in photos for scale)
• Coverage % (estimated % of total cover area affected)
• Whether any crease is color-breaking

PAGE QUALITY:
Assess from any interior photo. Cameras under artificial light make pages look more yellowed — assign ONE TIER HIGHER than what you see in the photo.
Full designations only: White, Off-White to White, Off-White, Cream to Off-White, Cream, Light Tan to Cream, Light Tan, Tan, Brown, Brown/Brittle, Brittle.

COVER SCORES for RoboGrade (0–100 each, calculated INDEPENDENTLY per cover):
Start each cover at 100. Apply deductions:
Deduction = Coverage% × Severity Multiplier
• Missing piece/chip: 15× (hard ceilings: >1/4"→max 60, >1/2"→max 40, detached→0)
• Tape: 10×
• Color-breaking crease: 8–12× (8=minor, 10=moderate, 12=severe)
• Staining: 4–6×
• Non-CB crease: 3–5×
• Spine stress lines: 2–4× (2=1–2 lines, 3=3–5, 4=6+ or CB)
• Soiling/foxing: 1–2×
• Color fading: 1–3×
• Spine roll: 2–4× (raking light photo)
• Surface creasing: 2–3× (raking light photo)
Corner blunting (not coverage formula — use radius directly):
  1/16" = −3 pts | 2/16" = −6 pts | 3/16" = −10 pts | 4/16"+ = −15 pts per corner.
Front and back must be scored INDEPENDENTLY — they will almost never be identical on a used book.

PQ score: White=100, OW/W=92, OW=82, C/OW=70, Cream=58, LT/C=45, LT=32, Tan=20, Brown=8, Brittle=0

════════════════════════════════════
PHASE 2 — THREE GRADES FROM YOUR OBSERVATIONS
════════════════════════════════════

── ROBOGRADE (primary, AI-native) ──
${roboFormula}
Score rounded to one decimal. Confidence base: ±${baseConf}.
Add +3 for glare/poor focus, +2 no raking light, +2 staples not visible, +4 restoration suspected.
List every defect individually — one object per defect with coverage%, multiplier, and deduction. Sort by deduction descending.

── CGC GRADE ──
Apply CGC standards to your defect inventory from Phase 1.
Grade calibration:
• Assign 9.0–9.6 for minor defects. Do not cap at 8.5 out of caution.
• Strong eye appeal + flat spine + bright colors + sharp corners = high grade.
• At high grades (8.5+), stress lines, bends, soiling, and printer tears become potentially grade-defining.
• Missing piece ceilings: <1/4"→max ~9.0 | 1/4"–1/2"→max ~8.0 | >1/2"→max ~5.0 | >1"→max ~3.0
• UV: white covers with tanning on unprinted areas only.
• Press: spine roll=yes | edge fraying=no | corner creases=yes | tanning=no.
Grader notes: one bullet per defect starting with •, official CGC terminology, always note CB vs non-CB.

── PSA GRADE ──
PSA has no published standard. Derive PSA from your CGC grade.
PSA graders come from a card background and emphasize eye appeal holistically. Early market data suggests PSA runs slightly more generous than CGC on Silver/Bronze Age material — not universally.
Start from your CGC grade. Adjust:
  HIGHER when: strong eye appeal beyond defect list, Silver/Bronze Age with good overall presentation.
  LOWER when: tape present (PSA always notes tape), accumulated small defects undermine eye appeal.
  SAME when: defects are clearly enumerable and eye appeal matches technical grade.
Do not invent defects not visible in photos. If same grade, psaNotes must be empty string.

If a CGC or PSA label is visible: read grade, cert number, page quality, and key issue notations directly from it.
${censusContext}${notesBlock}

════════════════════════════════════
RETURN ONLY THIS JSON — no markdown, no preamble
════════════════════════════════════
{
  "title": "series title, strip leading The",
  "issue": "e.g. 57 or A1",
  "issueDate": "cover date e.g. 2/68",
  "publisher": "publisher name",
  "pageQuality": "full designation e.g. Off-White to White",
  "grade": "CGC AI grade e.g. 7.0",
  "graderNotes": "• one bullet per defect, official CGC terminology",
  "aiAssessment": "2-4 sentences: overall impression, dominant defects, grade rationale, press/UV/clean recs",
  "labelNotes": "key issue notations from label if visible, empty string if none",
  "press": true,
  "uv": false,
  "clean": null,
  "labelDetected": false,
  "officialCGCGrade": null,
  "officialCGCCert": null,
  "officialPageQuality": null,
  "psaGrade": "PSA AI grade",
  "psaNotes": "why PSA differs, empty string if same",
  "officialPSAGrade": null,
  "officialPSACert": null,
  "roboGrade": {
    "version": "1.0",
    "tier": "Standard",
    "score": 0.0,
    "confidenceRange": ${baseConf},
    "frontCoverScore": 0.0,
    "backCoverScore": ${backScoreDefault},
    "pageQualityScore": ${pqScoreDefault},
    "pageQuality": "",
    "frontDefects": [{"type":"","location":"","measurement":"","coverage":"","colorBreaking":false,"multiplier":0,"deduction":0.0}],
    "backDefects": [],
    "rakingLightDefects": [],
    "stapleCondition": "",
    "restorationFlags": [],
    "assessmentNotes": ""
  }
}`;


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
    // Strip any markdown fencing and extract just the JSON object
    let clean = text.replace(/```json/gi, '').replace(/```/g, '').replace(/'''/g, '').trim();
    // If there's still non-JSON preamble, find the first { and last }
    const firstBrace = clean.indexOf('{');
    const lastBrace = clean.lastIndexOf('}');
    if (firstBrace > 0 || (firstBrace === 0 && lastBrace < clean.length - 1)) {
      if (firstBrace !== -1 && lastBrace !== -1) clean = clean.slice(firstBrace, lastBrace + 1);
    }

    let parsed;
    try { parsed = JSON.parse(clean); }
    catch (e) { return res.status(500).json({ error: 'Failed to parse response: ' + text }); }

    // Normalize grade to always include decimal (e.g. "10" → "10.0", "9" → "9.0")
    if (parsed.grade && !String(parsed.grade).includes('.')) {
      parsed.grade = parseFloat(parsed.grade).toFixed(1);
    }

    // Grade reference refinement pass (CGC only, grade in 5.0–10.0 range)
    if (isCGC && !parsed.labelDetected && parsed.grade) {
      const refImage = baseUrl ? await fetchGradeReference(parsed.grade, baseUrl) : null;
      if (refImage) {
        const refPrompt = `You previously assessed this comic as grade ${parsed.grade}. Here is the official CGC grading reference page for ${parsed.grade}. Compare your assessment photos against this reference. If the reference shows the book should look better or worse than what you assessed, adjust your grade. Return the same JSON format with your refined grade and updated graderNotes and aiAssessment. If ${parsed.grade} still seems correct, return the same grade.${notesBlock}`;
        try {
          const refResp = await fetchWithTimeout('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
            body: JSON.stringify({
              model: 'claude-opus-4-5',
              max_tokens: 1000,
              system: systemPrompt,
              messages: [{
                role: 'user',
                content: [
                  { type: 'text', text: `GRADE REFERENCE for ${parsed.grade}: The following image shows what a CGC ${parsed.grade} book looks like with annotated defects.` },
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
            if (refParsed.grade) {
              if (!String(refParsed.grade).includes('.')) refParsed.grade = parseFloat(refParsed.grade).toFixed(1);
              const _sRobo = parsed.roboGrade;
              const _sPsa  = parsed.psaGrade;
              const _sPsaN = parsed.psaNotes;
              parsed = refParsed;
              if (_sRobo && !parsed.roboGrade) parsed.roboGrade = _sRobo;
              if (_sPsa  && !parsed.psaGrade)  parsed.psaGrade  = _sPsa;
              if (_sPsaN && !parsed.psaNotes)  parsed.psaNotes  = _sPsaN;
              parsed._diagnostics = { comicvineRef: referenceImageBlock !== null, gradeRef: true };
            }
          }
        } catch (e) {
          // Refinement failed — use original assessment
        }
      }
    }

    // Attach diagnostic info
    const gradeRefSucceeded = parsed._diagnostics?.gradeRef === true;
    parsed._diagnostics = {
      comicvineRef: referenceImageBlock !== null,
      pageQualityRef: pageQualityImageBlock !== null,
      gradeRef: gradeRefSucceeded,
      psaGrade:  !!(parsed.psaGrade),
      roboGrade: !!(parsed.roboGrade)
    };
    if (parsed.psaGrade && !String(parsed.psaGrade).includes('.')) {
      parsed.psaGrade = parseFloat(parsed.psaGrade).toFixed(1);
    }
    return res.status(200).json(parsed);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
