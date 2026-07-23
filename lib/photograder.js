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
  const byCat = {};
  for (const f of priorFlags) if (f && f.category) byCat[f.category] = f;
  for (const cat of PHOTO_CATEGORIES) {
    const curLetter = _norm(current[cat]);
    const priorLetter = _norm(prior[cat]);
    if (curLetter && (curLetter === 'B' || curLetter === 'C')) {
      const madeWorse = !priorLetter || LETTER_RANK[curLetter] > LETTER_RANK[priorLetter];
      const curFlag = curFlags.find(f => f && f.category === cat);
      if (madeWorse && curFlag) byCat[cat] = curFlag;
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
export const PHOTOGRADER_RUBRIC_MAIN = `PHOTOGRADER — grade the QUALITY of the PHOTOGRAPHS (not the comic) in four categories, each A, B, or C. A = clean/ideal; B = a minor issue but detail still readable; C = a clear problem that hides part of the book or reduces how much can be assessed. Use the WORST single photo for each category — one bad photo sets that category's letter. Be strict; a typical phone photo is a B.
  FOCUS — sharpness. A: crisp detail. B: slightly soft, text/defects still readable. C: visibly blurry, fine detail lost.
  LIGHTING — glare/shadow. A: even, no glare. B: minor sheen or uneven light. C: a glare/reflection band or shadow covers a meaningful area and hides detail.
  CROPPING — how tightly the book fills the frame (full-cover shots only). A: book fills the frame, little surrounding surface. B: a visible margin of table/background around the book. C: book fills much less than the frame; large table/hands/objects in shot.
  ANGLE — squareness. A: straight-on and square; spine/edges/staples angled to reveal defects. B: slight tilt or keystone. C: strongly skewed/rotated so edges are distorted or defects hidden.
For each category return the letter, and ONLY for B or C a TERSE flag naming the image and the problem — no prose. e.g. "Back Cover — glare hiding lower half", "Front Cover — too much table, crop in".`;

// Model-facing rubric for DEEP/FULL passes (close-ups only → Focus/Lighting).
export const PHOTOGRADER_RUBRIC_CLOSEUP = `PHOTOGRADER — these are close-up photos, so grade only FOCUS and LIGHTING of THESE images, each A, B, or C (A ideal, B minor issue, C clear problem hiding detail). Use the worst image for each. Do NOT grade Cropping or Angle for close-ups. BUT if an image that should be a tight close-up instead shows more than about one quarter of the cover, flag it as "not close enough". Return the two letters, and only for B or C a terse flag naming the image and the problem — no prose.`;

export const PHOTOGRADER_CATEGORIES = PHOTO_CATEGORIES;
export const PHOTOGRADER_PM_BASE = PM_BASE;
