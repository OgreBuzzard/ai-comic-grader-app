# Card_Reference Folder

Reference image library and grading standards for PSA card grading in
Robograder.

This folder serves the same role for cards that `Grade_Reference/` serves
for comics: it provides visual references the grading prompt can compare
user cards against, and it stores the canonical grading standards document
for the cards module to reference.

---

## Folder structure

```
Card_Reference/
├── README.md                        ← this file
├── PSA_Grading_Standards.md         ← canonical PSA grading standards
└── {Set_Slug}_{Card_ID}/            ← per-card reference folder
    ├── psa_1.jpg
    ├── psa_1_5.jpg
    ├── psa_2.jpg
    ├── psa_3.jpg
    ├── psa_4.jpg
    ├── psa_5.jpg
    ├── psa_6.jpg
    ├── psa_7.jpg
    ├── psa_8.jpg
    ├── psa_8_5.jpg
    ├── psa_9.jpg
    ├── psa_10.jpg
    ├── psa_authentic.jpg            ← optional, for known-authentic example
    └── psa_authentic_altered.jpg    ← optional, for known-altered example
```

### Naming conventions

- **Set slugs use underscores**: `1952_Topps_Mantle_311`, not
  `1952 Topps Mantle 311` or `1952-topps-mantle-311`. Underscores are
  GitHub-Contents-API-friendly.
- **Decimals in filenames also use underscores**: `psa_8_5.jpg`, not
  `psa_8.5.jpg`. Same reasoning.
- **Per-card folders are flat**, not nested by year or set. The slug
  uniquely identifies the reference and the assessment code looks it up
  by exact match.

### Image specifications

Reference images should:
- Show ONLY the card itself (no slab, no PSA label, no holder)
- Be cropped tightly to the card edges
- Be lit evenly and shot square-on (no perspective distortion)
- Be in JPG format, ~1200-1500px on the long edge
- Be roughly the same orientation/aspect across all references for a
  given card so corner-by-corner comparison is straightforward

---

## How grading_cards.js uses this folder

The flow when a card is being assessed:

1. The user's card is identified by name, set, and card number (either
   from user input or from AI-driven identification of the front photo).
2. The assess.js handler computes a slug from the card identification:
   `{Set_Name_With_Underscores}_{Card_Number}`.
3. The handler attempts to fetch reference images from this folder via the
   GitHub Contents API at runtime (same mechanism as the comics
   `Grade_Reference/` folder).
4. If references exist for this card, the most-likely-grade reference is
   passed to the model alongside the user's photos. The prompt module
   instructs the model to use the reference as a baseline.
5. If references don't exist for this card (which will be the case for
   the vast majority of cards initially), the grading proceeds without a
   per-card reference, relying on the model's general knowledge plus the
   pokemontcg.io API for a clean factory reference scan.

---

## Reference sources, by priority

1. **pokemontcg.io API** — primary source for clean factory reference
   scans of Pokémon cards. Free API, comprehensive coverage, lookup by
   set + card number. Returns the original published card art at high
   resolution. This is the single highest-leverage reference source for
   Pokémon and is fetched at assessment time.

2. **Card_Reference/{slug}/ folders in this repo** — secondary source
   for graded reference samples (PSA 1 through PSA 10 examples of
   specific cards). Used when known-graded examples can be sourced for
   a particular card. The 1952 Topps Mantle set is the seed example.

3. **Organic accumulation from user submissions** — long-term, when
   users submit cards that come back with confirmed PSA grades, the
   cleanest examples can be added to Card_Reference for future use.

---

## What's currently in this folder

As of the initial commit:

- `PSA_Grading_Standards.md` — the canonical PSA grading rubric, source
  of truth for the cards module
- `1952_Topps_Mantle_311/` — 14 graded reference images covering PSA 1
  through PSA 10 plus Authentic and Authentic-Altered designations,
  cropped to remove the slab labels (used for human reference, can also
  be passed to the model when the user is grading another 1952 Topps
  Mantle #311)

This is enough to start with. The library will expand over time as
calibration accumulates.

---

## Sports cards note

Sports card support is currently deferred indefinitely. Pokémon is the
priority. MTG and other modern TCGs are likely follow-ons after Pokémon
ships.

If sports card support is ever revisited, this folder will accommodate
sports references with no structural change — the slug naming pattern
works equally well for `1952_Topps_Mantle_311` (sports) as
`Legendary_Treasures_RC24_RC25` (Pokémon).
