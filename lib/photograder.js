// lib/photograder.js
// =============================================================================
// Photograder — grades PHOTO QUALITY (not the comic) in four categories
// (Focus, Lighting, Cropping, Angle), each A / B / C, and converts those letters
// into the Precision Modifier (PM) — the ± range shown on the RoboGrade score.
// Worse photos → wider PM, because a worse photo makes the grade genuinely less
// certain. Photograder NEVER moves the grade or sub-grades; it only sets the ±.
//
// Design decisions (see shared/PHOTOGRADER_SPEC.md):
//   • Letters → penalty: A=0, B=+1, C=+2, summed over the 4 categories → 0..8.
//   • PM = base[tier, slabbed] + penalty, then MONOTONICALLY clamped so a deeper
//     pass can only tighten or hold the PM, never widen it. (A first Main is
//     always computed fresh — a re-shoot may legitimately widen it.)
//   • "Worst photo wins" per category: the model returns the worst letter for
//     each dimension across the photos THAT pass saw; the endpoint merges with
//     the prior tier so the running letters reflect every photo so far.
//   • Close-up macros/staples are exempt from Cropping/Angle (Focus/Lighting
//     only). Deep/Full therefore only ever update Focus/Lighting; Cropping/Angle
//     carry forward from Main.
// =============================================================================

const LETTER_PENALTY = { A: 0, B: 1, C: 2 };
const LETTER_RANK = { A: 0, B: 1, C: 2 }; // for worst-of comparisons
const PHOTO_CATEGORIES = ['focus', 'lighting', 'cropping', 'angle'];

// Base PM by tier and book type. Penalty (0..8) adds on top; max = base + 8.
// Slabbed books can't be opened, so there is no slabbed Full.
const PM_BASE = {
  raw:     { main: 8,  deep: 3, full: 1 },
  slabbed: { main: 12, deep: 8 },
};

function _norm(L) {
  const u = String(L == null ? '' : L).trim().toUpperCase();
  return (u === 'A' || u === 'B' || u === 'C') ? u : null;
}

// Sum of the four letters → 0..8. Missing / '?' categories contribute 0.
export function photograderPenalty(letters) {
  if (!letters) return 0;
  let p = 0;
  for (const c of PHOTO_CATEGORIES) {
    const L = _norm(letters[c]);
    if (L) p += LETTER_PENALTY[L];
  }
  return Math.min(8, p);
}

// Worst (highest-penalty) of two letters. Null-safe: an absent letter loses.
export function worstLetter(a, b) {
  const na = _norm(a), nb = _norm(b);
  if (!na) return nb;
  if (!nb) return na;
  return LETTER_RANK[nb] > LETTER_RANK[na] ? nb : na;
}

// Merge a tier's fresh grades into the running Photograder record.
//   prior:   the record carried in from the previous tier (null on first Main).
//   current: { focus, lighting, cropping?, angle?, flags? } from this pass.
// Focus/Lighting take the worst of prior vs. current (every photo counts).
// Cropping/Angle carry forward from prior when the current pass didn't grade
// them (Deep/Full only see close-ups). Flags are kept one-per-B/C-category,
// preferring the source of the current worst letter.
export function mergePhotograder(prior, current) {
  prior = prior || {};
  current = current || {};
  const out = { focus: null, lighting: null, cropping: null, angle: null, flags: [] };

  out.focus = worstLetter(prior.focus, current.focus);
  out.lighting = worstLetter(prior.lighting, current.lighting);
  // Cropping/Angle: only set by full-cover shots (Main). Carry prior unless the
  // current pass actually supplied one (e.g. a re-shot Main).
  out.cropping = _norm(current.cropping) || _norm(prior.cropping);
  out.angle = _norm(current.angle) || _norm(prior.angle);

  // Flags: start from prior, then for any category the current pass made worse
  // (or first-set), replace that category's flag with the current one.
  const priorFlags = Array.isArray(prior.flags) ? prior.flags : [];
  const curFlags = Array.isArray(current.flags) ? current.flags : [];
  const _fcat = f => (f && f.category ? String(f.category).toLowerCase().trim() : '');
  const byCat = {};
  for (const f of priorFlags) { const c = _fcat(f); if (c) byCat[c] = { ...f, category: c }; }
  for (const cat of PHOTO_CATEGORIES) {
    const curLetter = _norm(current[cat]);
    const priorLetter = _norm(prior[cat]);
    if (curLetter && (curLetter === 'B' || curLetter === 'C')) {
      const madeWorse = !priorLetter || LETTER_RANK[curLetter] > LETTER_RANK[priorLetter];
      const curFlag = curFlags.find(f => _fcat(f) === cat);
      if (madeWorse && curFlag) byCat[cat] = { ...curFlag, category: cat };
    }
  }
  // Drop flags for any category that ended up A (or unset).
  out.flags = PHOTO_CATEGORIES
    .filter(cat => { const L = _norm(out[cat]); return L === 'B' || L === 'C'; })
    .map(cat => byCat[cat])
    .filter(Boolean);
  return out;
}

// Compute the PM for a pass. `priorPM` is the ± the previous tier produced
// (null on Main). Monotonic clamp applies only to Deep/Full.
export function computePhotograderPM(letters, tier, slabbed, priorPM) {
  const table = slabbed ? PM_BASE.slabbed : PM_BASE.raw;
  const base = table[tier];
  if (base == null) {
    // slabbed Full shouldn't occur; hold the prior PM if we have it.
    return priorPM != null ? priorPM : (slabbed ? 12 : 8);
  }
  let pm = base + photograderPenalty(letters);
  if (tier !== 'main' && priorPM != null && pm > priorPM) pm = priorPM;
  return pm;
}

// Model-facing rubric for the MAIN pass (all four categories, full-cover shots).
export const PHOTOGRADER_RUBRIC_MAIN = `PHOTOGRADER — grade the QUALITY of the PHOTOGRAPHS (not the comic) in four categories, each A, B, or C. The question is whether each photo is a proper grading photo — the whole book, square to the camera, sharp, and readable — or whether its quality would reduce how accurately YOU can grade. A DELIBERATE, WELL-FRAMED photo is an A even if the light is warm/bright or a little background shows around the book — do not nitpick a good-faith grading shot. But you MUST grade down a careless snapshot: one that is blurry, shot at an angle, has the book small in the frame or surrounded by clutter (desk, keyboard, hands, lap, other objects), or has glare/shadow hiding detail. Do not hand out straight A's to a clearly poor photo. Use the WORST single photo for each category, and judge each category independently.
  FOCUS — A: sharp, or only slightly soft — fine detail still readable. B: noticeably soft; small text or fine defects are hard to read. C: visibly blurry; detail is lost.
  LIGHTING — A: the surface reads clearly (even, warm, or bright light are all fine). B: dim, uneven, or a sheen that makes part of the surface hard to read. C: glare or shadow hides a meaningful area of the book.
  CROPPING — A: the book fills most of the frame with only a thin margin of background. B: the book fills roughly half the frame or less, OR noticeable clutter (desk, keyboard, hands, lap, other objects) shares the shot. C: the book is small in the frame, OR part of it is cut off, OR surrounding clutter dominates the shot. When cropping is B or C, the note MUST tell the user to move closer / re-frame or use the in-app cropping tool.
  ANGLE — A: straight-on and square, or only a slight tilt. B: a clear tilt, keystone, or rotation — the book looks trapezoidal or noticeably rotated. C: strongly angled, rotated, or receding so edges/corners are distorted or hard to judge.
For each category return the letter. For every category graded B or C, add an object to the "flags" array: {"category": one of focus|lighting|cropping|angle (lowercase), "image": the photo name (e.g. "Front Cover", "Back Cover", "Interior", "Spine"), "note": a TERSE problem phrase, no prose}. Example flags: {"category":"cropping","image":"Back Cover","note":"book small in frame, clutter around it — move closer or use the crop tool"}, {"category":"angle","image":"Back Cover","note":"rotated and skewed — shoot straight-on"}, {"category":"focus","image":"Spine","note":"blurry — hold steadier"}. A categories get no flag.`;

// Model-facing rubric for DEEP/FULL passes (close-ups only → Focus/Lighting).
export const PHOTOGRADER_RUBRIC_CLOSEUP = `PHOTOGRADER — these are close-up photos, so grade only FOCUS and LIGHTING of THESE images, each A, B, or C. A steady, well-lit close-up is an A even if the light is warm or bright — don't nitpick a good-faith shot. But grade down a careless one: A: detail readable (sharp or only slightly soft; even/warm/bright light fine). B: noticeably soft, dim, or uneven so the close-up detail is hard to read. C: blurry, or glare/shadow hides the detail. Use the worst image for each. Do NOT grade Cropping or Angle for close-ups. Return the two letters, and for every category graded B or C add an object to the "flags" array: {"category": "focus" or "lighting", "image": the photo name, "note": a terse problem phrase, no prose}. Example: {"category":"focus","image":"Top-Left Corner","note":"blurry — hold steadier / retake"}.`;

export const PHOTOGRADER_CATEGORIES = PHOTO_CATEGORIES;
export const PHOTOGRADER_PM_BASE = PM_BASE;
