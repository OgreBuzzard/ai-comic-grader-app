# CGC Comic Collection App — Handoff Document
*For use at the start of a new chat session to restore full context*

---

## What This Project Is

A comic book collection database app for Matt, built as a single `index.html` PWA deployed on Vercel. Data is stored in Firestore. Images are stored directly in Firestore documents as base64 strings. The app is installable to iPhone home screen.

The primary ongoing workflow is:
1. Matt uploads photos of a comic in the app (or in chat)
2. The app calls the Vercel serverless function which proxies to Claude for grading
3. Claude assesses condition using CGC standards and auto-populates the form fields
4. Matt confirms and saves — entry goes directly to Firestore

---

## URLs and Repos

| Thing | Value |
|-------|-------|
| Live app | https://ai-comic-grader-app.vercel.app |
| GitHub repo | https://github.com/OgreBuzzard/ai-comic-grader-app |
| Firebase project | ai-comic-grader |
| Firestore | Standard mode, test mode rules |

**IMPORTANT — repo name:** The Vercel project is connected to `OgreBuzzard/ai-comic-grader-app` (with `-app` suffix). There is also an old repo `OgreBuzzard/ai-comic-grader` (no `-app`) which should be deleted — it is outdated and was the source of much confusion. Always push to `ai-comic-grader-app`.

---

## Files

| File | Location | Purpose |
|------|----------|---------|
| `index.html` | GitHub repo root | The entire app |
| `api/assess.js` | GitHub repo `api/` folder | Vercel serverless function — proxies Anthropic API calls |
| `manifest.json` | GitHub repo root | PWA manifest |
| `sw.js` | GitHub repo root | Service worker |
| `HANDOFF.md` | GitHub repo root | This document |
| `Claude_Grading_Skill.pdf` | `/mnt/project/` | Full CGC grading reference |

---

## How to Update the App

1. Download `index.html` from Claude
2. Go to `github.com/OgreBuzzard/ai-comic-grader-app`
3. Click `index.html` → edit/upload to replace
4. Commit — Vercel auto-deploys in ~30 seconds
5. Verify by checking Vercel dashboard for new deployment with correct file size (~98KB)

**File size check:** index.html should be ~98KB. If Vercel shows 3.9MB, the wrong file was deployed.

---

## Database State (as of session end Mar 25, 2026)

- **114 entries** in Firestore across 34 titles
- **Images stored in Firestore** as base64 in document fields — no longer in index.html
- index.html SEED_COMICS has `images: []` for all entries — images live only in Firestore
- New books added via app form go directly to Firestore with images

### Entries with Photos and Claude Assessments

| ID | Title | Issue | Grade | CGC | Pages | Press | UV | Clean | Seller | Acquired | Cost |
|----|-------|-------|-------|-----|-------|-------|----|----|-------|----------|------|
| comic:0047 | Avengers | 3 | 3.0 | — | Cream to OW | N | N | N | ECCC | 2025-03-06 | $230 |
| comic:0048 | Avengers | 4 | 7.0 | 7.0 (cert 4552645001) | OW | N | N | N | eBay | 2024-06-28 | $3,200 |
| comic:0083 | MSH Secret Wars | 1 | 9.4 | — | W | Y | N | N | Front Row Card Show, Tacoma | 2025-07-26 | $50 |
| comic:user_asm57 | Amazing Spider-Man | 57 | 7.0 | — | OW/W | N | Y | N | Tyson at Amazing Heroes | 2026-03-18 | $120 |
| comic:user_asm64 | Amazing Spider-Man | 64 | 8.5 | — | OW/W | Y | Y | N | Tyson at Amazing Heroes | 2026-03-18 | $90 |
| comic:user_asm67 | Amazing Spider-Man | 67 | 8.0 | — | OW/W | Y | N | N | Tyson at Amazing Heroes | 2026-03-18 | $90 |
| comic:user_asm45 | Amazing Spider-Man | 45 | 7.5 | — | Cream to OW | N | N | N | Michael at Poteet's Pop Culture | 2025-10-25 | $220 |

---

## Schema

Every entry has these fields:

```
id, title, issue, issueDate, publisher,
grade,              ← Matt's or Claude's raw assessment grade
cgcGrade,           ← Official CGC grade if slabbed
cgcCert,            ← CGC cert number
pageQuality,        ← CGC page quality designation
graderNotes,        ← CGC-format defect notes
cgcNotes,           ← Notes from CGC label
myAssessment,       ← Claude's 2-3 sentence grading rationale
notes,              ← Personal/historical notes
slabbingDate,       ← Date CGC graded it (YYYY-MM-DD)
dateAcquired,       ← YYYY-MM-DD
purchasePrice,      ← Number
taxesFeesShipping, gradingCost, cgcShipping, ← Numbers
fmv,                ← Fair market value
fmvDate,            ← YYYY-MM
press,              ← true/false/null
uv,                 ← true/false/null
clean,              ← true/false/null
seller,             ← Free text
dateAdded,          ← ISO timestamp
images              ← Array of base64 JPEG data URLs (stored in Firestore)
```

---

## Assess Book Button — Current State

The button is working as of Mar 25, 2026 session. Flow:
1. Matt chooses photos in the Add Book form
2. Assess Book button appears below thumbnails (full width, purple)
3. App compresses images to 1200px / JPEG 80% and POSTs to `/api/assess`
4. Vercel serverless function at `api/assess.js` proxies to Anthropic API
5. Claude returns JSON with grade, graderNotes, pageQuality, myAssessment, press/UV/clean
6. Form fields auto-populate

**API key:** Matt's Anthropic API key is stored as `ANTHROPIC_API_KEY` environment variable in Vercel. Auto-billing is enabled. If credits run out: console.anthropic.com → Plans & Billing.

---

## Rules and Decisions

### Grading Workflow
- Matt uploads photos (front cover, back cover, spine raking light, all 4 corner macros, interior pages spread)
- Claude assesses using `Claude_Grading_Skill.pdf` in project files
- Claude states grade, grader notes, page quality, and Press/UV/Clean recommendation
- Matt confirms or challenges
- If Matt disputes a defect on manual inspection and can't find it, revise the grade

### CGC Grading Rules
- Use official CGC defect terminology only — never paraphrase defect names
- Always note whether stress lines are color-breaking or not
- When uncertain between two grades, explain the determining factor

### UV Treatment Rule (IMPORTANT)
Predominantly white covers with tanning on non-inked/unprinted areas are UV candidates. Matt has a 3D-printed ink-protection mask. Apply this rule automatically.

- ASM #57 (white cover, right-edge fraying) → UV: Y
- ASM #64 (predominantly white cover) → UV: Y
- ASM #67 (dark cover) → UV: N
- Avengers #4 (tanned cover, UV already tried, went 7.5→7.0) → UV: N

### Press Candidates
- Spine roll → Press: Y
- Edge fraying → Press: N
- Corner creases → Press: Y (generally)
- Tanning → Press: N

### Avengers #4 (DO NOT recommend third submission)
- Originally CGC 7.5 (cert 1206646001)
- UV-treated → came back 7.0 (cert 4552645001)
- Third submission not recommended

### MSH Secret Wars #1
- Grade: 9.4 — very light bend bottom-left corner, possibly non-color-breaking
- Galactus misprint variant — known printing variant, does not affect value
- Press: Y — could return 9.6

### Issue Formatting
- Annual issues: A1 → "Annual #1" (handled by `formatIssue()`)
- Regular issues: "#45", "#64", etc.

### Title Normalization
- Always "Amazing Spider-Man" with hyphen

### Image Handling
- Do not crop images — Matt crops his own photos
- Keep green cutting mat and ruler visible
- App compresses to 1200px / JPEG 80% before sending to assess function
- Store 4-6 images per entry in Firestore

### Seller Tracking
- Michael at Poteet's Pop Culture → ASM #45
- Tyson at Amazing Heroes → ASM #57, #64, #67
- eBay → Avengers #4
- ECCC → Avengers #3
- Front Row Card Show, Tacoma → MSH Secret Wars #1

---

## Architecture

### Data Flow
- App loads → reads all comics from Firestore via `onSnapshot` (live sync)
- Add/edit → saves directly to Firestore
- Images stored as base64 in Firestore document (no Firebase Storage needed — Spark plan)
- SEED_COMICS in index.html has `images: []` — only used to seed Firestore on first launch if empty

### Vercel Serverless Function (`api/assess.js`)
- Receives POST with `{ images: [base64strings] }`
- Calls `api.anthropic.com/v1/messages` with `claude-opus-4-6`
- Returns parsed JSON with grading fields
- API key stored as Vercel environment variable `ANTHROPIC_API_KEY`

---

## Known Issues / Things Not to Repeat

1. **Two GitHub repos exist** — `ai-comic-grader` (old, ignore/delete) and `ai-comic-grader-app` (correct one, use this). Always push to `-app`.

2. **Do not attempt to auto-crop images** — unreliable. Matt crops himself.

3. **Avengers #4 third submission** — do not recommend it.

4. **Firebase Storage not available on Spark plan** — images go in Firestore documents directly, not Storage.

5. **index.html must stay ~98KB** — if it grows large again, run the strip-images tool to remove base64 from SEED_COMICS (images are in Firestore, SEED_COMICS doesn't need them).

6. **Cloudflare project exists but is unused** — was created during setup, abandoned in favor of Vercel. Ignore it.

---

## Photo Protocol

Matt photographs on a green cutting mat with ruler. Standard shot list:
1. Front cover
2. Back cover
3. Spine (landscape, raking light)
4. Top-left corner (macro)
5. Top-right corner (macro)
6. Bottom-left corner (macro)
7. Bottom-right corner (macro)
8. Interior pages spread (page quality)

Ruler is intentional — provides scale reference for defect sizing.

---

## Grading Reference Quick Summary

*(Full reference in `Claude_Grading_Skill.pdf`)*

| Grade | Label | Description |
|-------|-------|-------------|
| 9.8 | NM/M | Nearly perfect |
| 9.4 | NM | Minor wear/defects |
| 9.0 | VF/NM | Minor handling defects |
| 8.5 | VF+ | Moderate or several small defects |
| 8.0 | VF | Moderate defect or accumulation |
| 7.5 | VF- | Above average with defects |
| 7.0 | FN/VF | Major defect or accumulation |
| 6.0 | FN | Major defect + smaller |
| 5.0 | VG/FN | Several moderate defects |
| 3.0 | G/VG | Significant handling, moderate-to-major defects |

**Key defect categories**: Crease, Distortion, Missing Part, Stain, Substance, Tanning, Tear

**Grader notes format**: `Spine stress lines, color-breaking. Light crease, top-left corner. Wear, right edge.`
