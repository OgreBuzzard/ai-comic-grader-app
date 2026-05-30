// api/value_keys.js
//
// Value-key registry: the canonical list of comics that qualify for Deep
// Assessment regardless of score. The idea (S14): score-gated Deep already
// triggers on books CGC has signaled value for. But a low-grade copy of a
// historic key — Detective Comics #27 at 1.5, X-Men #1 at 2.0 — is still
// a high-stakes book where buyers will want the most precise assessment
// available. This list captures those.
//
// Hard exclusions enforced by matchValueKey():
//   1. Facsimile / reprint editions never match. The `printing` field on
//      the comic must be empty (original printing). A 2019 Hulk #181
//      facsimile is not the 1974 first Wolverine; it's a $20 reprint.
//   2. Cross-publisher collisions are disambiguated by publisher. Star
//      Trek #1 exists for Gold Key (1967, valuable), Marvel (1980), DC
//      (1984), and others — only the Gold Key first is on this list.
//
// Update process (until admin-edit UI exists, post-beta):
//   - Edit this file directly. Push to repo, Vercel auto-deploys, /api/
//     value_keys serves the new list. The client fetches once per page
//     load and caches in memory for the session.
//
// Two consumers:
//   - GET /api/value_keys (this file, as a Vercel function) returns the
//     list as JSON for the client.
//   - Direct ES import from server-side code (none today, but the door
//     is open for future census-style anchoring in assess.js).

// ── The list ─────────────────────────────────────────────────────────────
//
// Each entry has: title (the canonical / most common return from the model),
// issue (a string — we compare as strings to handle '17 (#1)' and similar),
// publisher (used only for collision disambiguation; null when unique),
// and aliases (alternate title strings the model might return — added when
// a book is known to come back under multiple names).
//
// Title-matching strategy (see matchValueKey below):
//   1. Lowercase + strip leading "The" + collapse whitespace on both sides.
//   2. Direct match on title OR any alias.
//   3. Issue string compared after stripping leading zeros and # signs.
//   4. Publisher checked only when the matched entry has publisher set.

const VALUE_KEYS = [
  // ── Top tier: pre-1940 origins ─────────────────────────────────────────
  { title: 'Action Comics',          issue: '1',     publisher: null,        aliases: [] },
  { title: 'Action Comics',          issue: '10',    publisher: null,        aliases: [] },
  { title: 'Detective Comics',       issue: '27',    publisher: null,        aliases: [] },
  { title: 'Detective Comics',       issue: '29',    publisher: null,        aliases: [] },
  { title: 'Detective Comics',       issue: '31',    publisher: null,        aliases: [] },
  { title: 'Detective Comics',       issue: '33',    publisher: null,        aliases: [] },
  { title: 'Detective Comics',       issue: '38',    publisher: null,        aliases: [] },
  { title: 'Superman',               issue: '1',     publisher: null,        aliases: [] },
  { title: 'Batman',                 issue: '1',     publisher: null,        aliases: [] },
  { title: 'All-American Comics',    issue: '16',    publisher: null,        aliases: [] },
  { title: 'Adventure Comics',       issue: '40',    publisher: null,        aliases: [] },
  { title: 'Flash Comics',           issue: '1',     publisher: null,        aliases: [] },

  // ── Pre-1945: war-era keys ─────────────────────────────────────────────
  { title: 'Marvel Comics',          issue: '1',     publisher: null,        aliases: ['Marvel Mystery Comics'] },
  { title: 'Captain America Comics', issue: '1',     publisher: null,        aliases: [] },
  { title: 'Pep Comics',             issue: '22',    publisher: null,        aliases: [] },
  { title: 'Whiz Comics',            issue: '2',     publisher: null,        aliases: ['Whiz Comics'] },  // Published as #2; collectors sometimes call it #1
  { title: 'More Fun Comics',        issue: '52',    publisher: null,        aliases: [] },
  { title: 'More Fun Comics',        issue: '55',    publisher: null,        aliases: [] },
  { title: 'More Fun Comics',        issue: '73',    publisher: null,        aliases: [] },
  { title: 'All-Star Comics',        issue: '3',     publisher: null,        aliases: [] },
  { title: 'All-Star Comics',        issue: '8',     publisher: null,        aliases: [] },
  { title: 'Sensation Comics',       issue: '1',     publisher: null,        aliases: [] },
  { title: 'Wonder Woman',           issue: '1',     publisher: null,        aliases: [] },
  { title: 'Archie Comics',          issue: '1',     publisher: null,        aliases: [] },
  { title: 'Sub-Mariner Comics',     issue: '1',     publisher: null,        aliases: [] },
  { title: 'Suspense Comics',        issue: '3',     publisher: null,        aliases: [] },
  { title: 'Punch Comics',           issue: '12',    publisher: null,        aliases: [] },
  { title: 'Detective Comics',       issue: '69',    publisher: null,        aliases: [] },
  { title: 'Detective Comics',       issue: '140',   publisher: null,        aliases: [] },
  { title: 'Detective Comics',       issue: '168',   publisher: null,        aliases: [] },
  { title: 'Phantom Lady',           issue: '17',    publisher: null,        aliases: [] },
  { title: 'Chamber of Chills Magazine', issue: '19', publisher: null,       aliases: ['Chamber of Chills'] },
  { title: 'Startling Comics',       issue: '49',    publisher: null,        aliases: [] },
  { title: 'Black Cat Comics',       issue: '50',    publisher: null,        aliases: [] },
  { title: 'Shock SuspenStories',    issue: '6',     publisher: null,        aliases: [] },

  // ── Dell Four Color (anthology — multiple keys live here) ─────────────
  { title: 'Four Color',             issue: '16',    publisher: 'Dell',      aliases: ['Four Color Comics'] },  // First Donald Duck (Carl Barks)
  { title: 'Four Color',             issue: '386',   publisher: 'Dell',      aliases: ['Four Color Comics'] },  // First Uncle Scrooge

  // ── Silver Age keys ────────────────────────────────────────────────────
  { title: 'Showcase',               issue: '4',     publisher: null,        aliases: [] },   // First Silver Age Flash
  { title: 'Showcase',               issue: '22',    publisher: null,        aliases: [] },   // First Silver Age Green Lantern
  { title: 'Brave and the Bold',     issue: '28',    publisher: null,        aliases: ['The Brave and the Bold'] },  // First JLA
  { title: 'Action Comics',          issue: '242',   publisher: null,        aliases: [] },   // First Brainiac
  { title: 'Action Comics',          issue: '252',   publisher: null,        aliases: [] },   // First Supergirl
  { title: 'Adventure Comics',       issue: '247',   publisher: null,        aliases: [] },   // First Legion of Super-Heroes
  { title: 'Batman',                 issue: '121',   publisher: null,        aliases: [] },   // First Mr. Freeze
  { title: 'Tales to Astonish',      issue: '13',    publisher: null,        aliases: [] },   // First Groot
  { title: 'Tales to Astonish',      issue: '27',    publisher: null,        aliases: [] },   // First Ant-Man (Hank Pym)
  { title: 'Amazing Adult Fantasy',  issue: '15',    publisher: null,        aliases: ['Amazing Fantasy'] },  // Cataloged either way
  { title: 'Amazing Fantasy',        issue: '15',    publisher: null,        aliases: ['Amazing Adult Fantasy'] },  // Spider-Man
  { title: 'Fantastic Four',         issue: '1',     publisher: null,        aliases: [] },
  { title: 'Fantastic Four',         issue: '2',     publisher: null,        aliases: [] },   // First Skrulls
  { title: 'Fantastic Four',         issue: '4',     publisher: null,        aliases: [] },   // Silver Age Sub-Mariner
  { title: 'Fantastic Four',         issue: '5',     publisher: null,        aliases: [] },   // First Doctor Doom
  { title: 'Fantastic Four',         issue: '48',    publisher: null,        aliases: [] },   // First Silver Surfer / Galactus
  { title: 'Fantastic Four',         issue: '49',    publisher: null,        aliases: [] },
  { title: 'Fantastic Four',         issue: '52',    publisher: null,        aliases: [] },   // First Black Panther
  { title: 'Incredible Hulk',        issue: '1',     publisher: null,        aliases: ['Hulk'] },
  { title: 'Incredible Hulk',        issue: '2',     publisher: null,        aliases: ['Hulk'] },
  { title: 'Incredible Hulk',        issue: '180',   publisher: null,        aliases: ['Hulk'] }, // Cameo Wolverine
  { title: 'Incredible Hulk',        issue: '181',   publisher: null,        aliases: ['Hulk'] }, // First full Wolverine
  { title: 'Journey into Mystery',   issue: '83',    publisher: null,        aliases: [] },   // First Thor
  { title: 'Journey into Mystery',   issue: '85',    publisher: null,        aliases: [] },   // First Loki
  { title: 'Tales of Suspense',      issue: '39',    publisher: null,        aliases: [] },   // First Iron Man
  { title: 'Strange Tales',          issue: '110',   publisher: null,        aliases: [] },   // First Doctor Strange
  { title: 'Sgt. Fury and His Howling Commandos', issue: '1', publisher: null, aliases: ['Sgt Fury and His Howling Commandos','Sgt. Fury','Sergeant Fury and His Howling Commandos'] },
  { title: 'X-Men',                  issue: '1',     publisher: null,        aliases: ['Uncanny X-Men'] },
  { title: 'X-Men',                  issue: '4',     publisher: null,        aliases: ['Uncanny X-Men'] },     // First Magneto-as-villain (Quicksilver, Scarlet Witch)
  { title: 'X-Men',                  issue: '12',    publisher: null,        aliases: ['Uncanny X-Men'] },     // First Juggernaut
  { title: 'X-Men',                  issue: '94',    publisher: null,        aliases: ['Uncanny X-Men'] },     // New team begins
  { title: 'X-Men',                  issue: '101',   publisher: null,        aliases: ['Uncanny X-Men'] },     // First Phoenix
  { title: 'Amazing Spider-Man',     issue: '1',     publisher: null,        aliases: ['Spider-Man'] },
  { title: 'Amazing Spider-Man',     issue: '2',     publisher: null,        aliases: ['Spider-Man'] },        // First Vulture
  { title: 'Amazing Spider-Man',     issue: '3',     publisher: null,        aliases: ['Spider-Man'] },        // First Doc Ock
  { title: 'Amazing Spider-Man',     issue: '4',     publisher: null,        aliases: ['Spider-Man'] },        // First Sandman
  { title: 'Amazing Spider-Man',     issue: '14',    publisher: null,        aliases: ['Spider-Man'] },        // First Green Goblin
  { title: 'Amazing Spider-Man',     issue: '50',    publisher: null,        aliases: ['Spider-Man'] },        // First Kingpin
  { title: 'Amazing Spider-Man',     issue: '121',   publisher: null,        aliases: ['Spider-Man'] },        // Death of Gwen Stacy
  { title: 'Amazing Spider-Man',     issue: '129',   publisher: null,        aliases: ['Spider-Man'] },        // First Punisher
  { title: 'Amazing Spider-Man Annual', issue: '1',  publisher: null,        aliases: ['Spider-Man Annual'] }, // Sinister Six
  { title: 'Avengers',               issue: '1',     publisher: null,        aliases: [] },
  { title: 'Avengers',               issue: '4',     publisher: null,        aliases: [] },   // Silver Age Cap returns
  { title: 'Daredevil',              issue: '1',     publisher: null,        aliases: [] },
  { title: 'Justice League of America', issue: '1',  publisher: null,        aliases: ['JLA'] },
  { title: 'Aquaman',                issue: '1',     publisher: null,        aliases: [] },
  { title: 'Green Lantern',          issue: '1',     publisher: null,        aliases: [] },   // Silver Age
  { title: 'Silver Surfer',          issue: '1',     publisher: null,        aliases: ['The Silver Surfer'] },
  { title: 'Silver Surfer',          issue: '4',     publisher: null,        aliases: ['The Silver Surfer'] },
  { title: 'Marvel Super-Heroes',    issue: '18',    publisher: null,        aliases: [] },   // First Guardians of the Galaxy
  { title: 'Marvel Spotlight',       issue: '5',     publisher: null,        aliases: [] },   // First Ghost Rider
  { title: 'Detective Comics',       issue: '359',   publisher: null,        aliases: [] },   // First Batgirl (Barbara Gordon)
  { title: 'Batman',                 issue: '181',   publisher: null,        aliases: [] },   // First Poison Ivy
  { title: 'Batman',                 issue: '227',   publisher: null,        aliases: [] },   // Classic Neal Adams cover
  { title: 'Batman',                 issue: '251',   publisher: null,        aliases: [] },   // Neal Adams Joker
  { title: 'House of Secrets',       issue: '92',    publisher: null,        aliases: [] },   // First Swamp Thing

  // ── Bronze Age keys ─────────────────────────────────────────────────────
  { title: 'Green Lantern',          issue: '76',    publisher: null,        aliases: [] },   // O'Neil/Adams begins
  { title: 'Giant-Size X-Men',       issue: '1',     publisher: null,        aliases: [] },   // New team origin
  { title: 'Werewolf by Night',      issue: '32',    publisher: null,        aliases: [] },   // First Moon Knight
  { title: 'Iron Man',               issue: '55',    publisher: null,        aliases: [] },   // First Thanos / Drax
  { title: 'Tomb of Dracula',        issue: '10',    publisher: null,        aliases: [] },   // First Blade

  // ── Modern / cross-publisher ────────────────────────────────────────────
  { title: 'Star Wars',              issue: '1',     publisher: 'Marvel',    aliases: [] },   // Marvel 1977 (not the various reboots)
  { title: 'Star Trek',              issue: '1',     publisher: 'Gold Key',  aliases: [] },   // Gold Key 1967 (NOT Marvel/DC/IDW)
  { title: 'Teenage Mutant Ninja Turtles', issue: '1', publisher: 'Mirage', aliases: ['TMNT'] },
];

// ── Matching ─────────────────────────────────────────────────────────────
// O(n) lookup. With ~100 entries this is fast enough. If the list ever grows
// past a few hundred, switch to a Map keyed on normalized "title|issue".

function normalizeKeyTitle(s) {
  if (!s) return '';
  return s.toString()
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/^The\s+/i, '')
    .toLowerCase();
}

function normalizeIssue(s) {
  if (s == null) return '';
  return s.toString().trim().replace(/^#/, '').replace(/^0+(\d)/, '$1');
}

/**
 * Returns the matched value-key entry, or null.
 * @param {string} title       Comic title as returned by the model.
 * @param {string} issue       Issue number as returned by the model.
 * @param {string} publisher   Publisher as returned by the model (may be '').
 * @param {string} printing    Printing designation (must be empty/falsy for
 *                             a match — facsimiles and reprints never qualify).
 */
function matchValueKey(title, issue, publisher, printing) {
  // S15 May 30 (TESTING): printing exclusion DISABLED to allow reprints/
  // facsimiles of value-key books to qualify for Deep/Full Assessment (Matt's
  // request, mirrors the client change in index.html). TO REVERT, restore:
  //   if (printing && String(printing).trim() !== '') return null;

  const nt = normalizeKeyTitle(title);
  const ni = normalizeIssue(issue);
  if (!nt || !ni) return null;

  const np = (publisher || '').toString().trim().toLowerCase();

  for (const entry of VALUE_KEYS) {
    // Issue must match exactly (normalized).
    if (normalizeIssue(entry.issue) !== ni) continue;

    // Title match: canonical OR any alias.
    const canon = normalizeKeyTitle(entry.title);
    const titleHit = (canon === nt)
      || (entry.aliases || []).some(a => normalizeKeyTitle(a) === nt);
    if (!titleHit) continue;

    // Hard exclusion 2: when the entry specifies a publisher (cross-publisher
    // collision case — Star Trek, Star Wars, TMNT), the comic's publisher
    // must match. Allow case-insensitive substring match in either direction
    // to handle "Gold Key" vs "Gold Key Comics" or "Marvel" vs "Marvel Comics".
    if (entry.publisher) {
      const ep = entry.publisher.toLowerCase();
      if (!np || (!np.includes(ep) && !ep.includes(np))) continue;
    }

    return entry;
  }
  return null;
}

// ── Vercel function: GET /api/value_keys ────────────────────────────────
// Returns the full list as JSON, plus a version stamp so clients can
// invalidate cached copies when we publish a new list. The list is small
// (~3-5KB) and clients only hit this once per page load — caching at the
// edge via Cache-Control would buy maybe 50ms per launch. Not worth the
// complication today.

export default function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  // Lightweight cache header — let intermediaries cache for an hour but
  // require revalidation. The list is read-only and updates only happen
  // on redeploy, so stale-while-revalidate is essentially free safety.
  res.setHeader('Cache-Control', 'public, max-age=3600, stale-while-revalidate=86400');
  return res.status(200).json({
    version: '1.0.0',
    count:   VALUE_KEYS.length,
    keys:    VALUE_KEYS,
  });
}

// ES exports for server-side consumers (assess.js could hypothetically use
// this for census-style anchoring; not wired up today).
export { VALUE_KEYS, matchValueKey, normalizeKeyTitle, normalizeIssue };
