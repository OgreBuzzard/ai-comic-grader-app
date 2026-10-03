// lib/ablation.js — NAMED PROMPT-CLAUSE ABLATION. Diagnostic only, off by default.
// =============================================================================
// WHY THIS EXISTS
//
// The grading prompt is ~22,000 tokens of corrections accumulated against ONE
// model. Opus 5.5 grades +0.63 higher than Opus 5 and lists fewer defects, and
// nobody knows which of those corrections is responsible — or whether any of
// them is still earning its place on Opus 5 either. Swapping the model and
// reading the grade, which is what the first 5.5 attempt did, cannot answer
// that. Removing one named clause at a time can.
//
// See shared/_LIBRARY/OPUS_55_ABLATION_PLAN.md for the arms and the hard stop.
//
// ── HOW IT WORKS, AND WHY NOT INSIDE THE TEMPLATE LITERAL ───────────────────
// The clauses are plain text inside the systemPrompt template literal in
// api/assess.js. This file does NOT touch that literal: it edits the ASSEMBLED
// string afterwards, by locating each clause between a start marker and an end
// marker. That is deliberate. Threading ${...} calls through a 22,000-token
// template literal is exactly how 5.29 shipped with a module dead on arrival
// (a backtick inside a CSS comment), and a parse check will not catch it.
//
// ── IT FAILS LOUD ───────────────────────────────────────────────────────────
// If a clause's start marker is not found, apply() THROWS. A silent no-op is the
// worst possible failure here: the arm runs, costs $3.25, reports "no effect",
// and the conclusion is that the clause does not matter when in fact it was
// never removed. If a prompt edit breaks a marker, the round stops instead.
//
// ── WHEN THE PROMPT IS EDITED ───────────────────────────────────────────────
// Markers are short and distinctive so ordinary rewording elsewhere does not
// break them. Reword a CLAUSE ITSELF and its arm will throw — fix the marker
// here in the same commit, and note that results from before and after are not
// comparable.

// kind 'insert': place `text` immediately AFTER the first occurrence of `after`.
//                 Added 2026-10-02: every arm until now subtracted, and all four
//                 came back null. Subtracting can only measure what is already
//                 there; the severity-binding variant ADDS a rule. The field is
//                 still called `ablate` on the wire for compatibility — read the
//                 ids as "prompt variants", of which a removal is one kind.
// kind 'remove': delete from `from` up to (not including) `to`.
//                `to` of '\n' means "to the end of that line".
// kind 'replace': apply each [find, replaceWith] pair. Used where a clause is
//                referred to elsewhere, so deleting it would leave the prompt
//                talking about a rule that is no longer there.
import { defectAliasPromptBlock } from './defect_index.js';
const ALIAS_BLOCK = defectAliasPromptBlock();

export const CLAUSES = {
  // ── A arms: clauses that tell the model NOT to call a defect. The hypothesis
  // is that a model better calibrated about its own uncertainty obeys these
  // MORE often, which would produce 5.5's exact signature: fewer defects, a
  // higher grade, and LOWER variance than Opus 5.
  A1: {
    label: 'EVIDENCE STANDARD — do not manufacture minor wear / under-grading a clean book is a HARD ERROR',
    kind: 'remove',
    from: '  • Clean high-grade books are common and legitimate.',
    to: '\n'
  },
  A2: {
    label: 'PRESENCE vs SEVERITY — if unsure whether a defect is PRESENT, omit it',
    kind: 'remove',
    from: '  • PRESENCE vs SEVERITY uncertainty:',
    to: '\n'
  },
  A3: {
    label: 'CHECK EACH PASS tail — "Absence is fine — do not invent"',
    kind: 'remove',
    from: ' Absence is fine — do not invent; only list what you actually see.',
    to: '\n'
  },
  A4: {
    label: 'banded-wear GUARD — never as a precautionary hedge on a clean-presenting book',
    kind: 'remove',
    from: 'GUARD (per the EVIDENCE STANDARD):',
    to: '\n'
  },
  A5: {
    label: 'the 4–8 written-defect limit (raised rather than deleted — three later rules refer to it)',
    kind: 'replace',
    pairs: [
      ['a typical Silver Age book has 4–8 worth noting, not 12–15.',
       'list every defect you can actually see.'],
      ['the 4–8 limit governs how many you WRITE', 'the listing limit governs how many you WRITE'],
      ['(which defects the 4–8 cap may drop)', '(which defects the listing limit may drop)']
    ]
  },

  // ── R arms: the COUNTERWEIGHTS. These were added to pull Opus 5 down off
  // specific over-grades. They were sized against Opus 5, so on 5.5 they may be
  // mis-sized rather than needing removal. Removing them from Opus 5 also
  // measures how much of its good bias is the prompt rather than the model —
  // worth knowing whatever ships.
  R1: {
    label: 'CUMULATIVE-FRONT-DEFECT RULE (Front ≤ 30)',
    kind: 'remove',
    from: 'CUMULATIVE-FRONT-DEFECT RULE:',
    to: 'MID-GRADE EXTENSION:'
  },
  R2: {
    label: 'LIGHT-ACCUMULATION-ACROSS-FACES (Front ≤ 37, seats in the Fine band)',
    kind: 'remove',
    from: 'LIGHT-ACCUMULATION-ACROSS-FACES',
    to: 'EYE APPEAL IS NOT A SCORE'
  },
  R3: {
    label: 'BUT wear that IS visible is NOT clean — count it fully',
    kind: 'remove',
    from: '  • BUT wear that IS visible is NOT clean',
    to: '\n'
  },

  // ── S1: BIND THE DEFECT INDEX TO SEVERITY ────────────────────────────────
  // THE EVIDENCE (handoff §56). Grade is an almost deterministic function of
  // severity-weighted defect load: load (High=3, Med=2, Low=1) against grade is
  // r = -0.967 on Opus 5 and r = -0.976 on Opus 5.5. The engine is faithful.
  // Mean load is 8.5 on Opus 5 and 5.3 on 5.5, a 37% drop, and the per-book load
  // drop against the per-book grade gap is r = -0.830. The whole gap is load.
  //
  // Load is count x severity, which is why every single-factor investigation
  // failed: count alone is r = -0.17, and mean severity moves only 1.82 -> 1.68.
  // Neither is dramatic. The product is.
  //
  // WHY THIS SHAPE OF RULE. api/assess.js already injects the CGC defect index,
  // but its legend says "use only to sanity-check the ceiling" — advisory, and
  // advisory is the instruction class 5.5 ignores (A2 null, §53; R1/R2 null and
  // it returns Front 45 against a "MUST be <= 37", §52). This makes the index a
  // LOOKUP that assigns severity: find the row, compare redStart to the working
  // grade, set severity. Not a judgement and not a cap — a table read.
  //
  // ASM 8 is the case it is built from. Opus 5 calls the missing piece High on
  // all three reps and grades 3.5. 5.5 called it High once (3.5), named it
  // something else once (4.0), and did not list it at all once (4.0). The index
  // has missing piece cover at [0.5, 0.5] — red at every grade.
  S1: {
    label: 'bind the CGC defect index to severity assignment, with aliases',
    kind: 'insert',
    after: 'Use only to sanity-check the ceiling for defects you actually observe.',
    text: '\n\nINDEX-BOUND SEVERITY — APPLY THIS AS A LOOKUP, NOT A JUDGEMENT. For every defect you record, find its row in the index above, then: if the row\'s <red> value is AT OR BELOW the grade this book would otherwise receive, that defect is grade-limiting here and its severity is HIGH — not Med, however ordinary the defect looks. If <red> is above that grade but <yellow> is at or below it, severity is MED or LOW on its own merits. If <yellow> is above that grade, the defect is minor and severity is LOW. Worked example: a book presenting around 4.0 that carries a missing piece — missing piece cover is 0.5/0.5, so <red> 0.5 is at or below 4.0, and the missing piece is HIGH. A book presenting around 8.0 with soiling — soiling is 7.0/9.0, so <red> 9.0 is above 8.0 and <yellow> 7.0 is at or below it: Med or Low on its merits. Do this before scoring any category. Severity assigned this way is not negotiable downward on the grounds that the book otherwise presents well.\n\nTHE INDEX USES CGC VOCABULARY AND YOU DO NOT. Match by meaning, never by exact wording — a defect you can name is in the index under CGC\'s term for it. ALIASES: ' + ALIAS_BLOCK + '. If a defect genuinely has no row, score it on its merits and do not treat the absence as evidence that it is minor. CORNER WEAR / CORNER BLUNTING HAS NO ROW ON PURPOSE and is the case that matters most: it is handling damage carried by the CGC grade-tier definitions, not by this index. Do NOT read it onto the bindery chip or bindery tear rows \u2014 those are MANUFACTURING defects, which is why they only turn red at 8.0 and are excused below it, and corner wear is not excused below it.'
  }
};

export const CLAUSE_IDS = Object.keys(CLAUSES);

// Normalises whatever arrived in the request body into a clean id list.
// Unknown ids are returned separately rather than ignored, so a typo in an arm
// is reported instead of quietly producing a baseline run.
export function parseAblation(raw) {
  const list = Array.isArray(raw) ? raw
             : (typeof raw === 'string' ? raw.split(',') : []);
  const ids = [], unknown = [];
  for (const x of list) {
    const id = String(x || '').trim().toUpperCase();
    if (!id) continue;
    if (CLAUSES[id]) { if (!ids.includes(id)) ids.push(id); }
    else unknown.push(id);
  }
  return { ids, unknown };
}

// Returns { prompt, applied, removedChars }. THROWS if any requested clause
// could not be located — see "IT FAILS LOUD" above.
export function applyAblation(prompt, ids) {
  let out = String(prompt);
  const applied = [];
  const before = out.length;

  for (const id of ids) {
    const c = CLAUSES[id];
    if (!c) throw new Error('ablation: unknown clause id ' + id);

    if (c.kind === 'replace') {
      for (const [find, repl] of c.pairs) {
        if (!out.includes(find)) {
          throw new Error('ablation ' + id + ': text not found in prompt: "' + find.slice(0, 60) + '…" — the prompt was edited; fix lib/ablation.js');
        }
        out = out.split(find).join(repl);
      }
      applied.push(id);
      continue;
    }

    if (c.kind === 'insert') {
      const i = out.indexOf(c.after);
      if (i === -1) {
        throw new Error('variant ' + id + ': anchor not found: "' + c.after.slice(0, 60) + '…" — the prompt was edited; fix lib/ablation.js');
      }
      const at = i + c.after.length;
      out = out.slice(0, at) + c.text + out.slice(at);
      applied.push(id);
      continue;
    }

    const i = out.indexOf(c.from);
    if (i === -1) {
      throw new Error('ablation ' + id + ': start marker not found: "' + c.from.slice(0, 60) + '…" — the prompt was edited; fix lib/ablation.js');
    }
    let j;
    if (c.to === '\n') {
      j = out.indexOf('\n', i);
      if (j === -1) j = out.length;
    } else {
      j = out.indexOf(c.to, i + c.from.length);
      if (j === -1) {
        throw new Error('ablation ' + id + ': end marker not found after start: "' + c.to.slice(0, 60) + '…" — fix lib/ablation.js');
      }
    }
    out = out.slice(0, i) + out.slice(j);
    applied.push(id);
  }

  // NEGATIVE on an insert variant. Named for its original use; read it as a
  // signed character delta.
  return { prompt: out, applied, removedChars: before - out.length };
}
