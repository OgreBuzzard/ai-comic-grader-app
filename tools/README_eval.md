# Robograder eval tools

## resolution_eval.mjs — 1400 vs 1200 image-resolution A/B
Calls the real `/api/assess` (production prompt + Opus). Stateless: no credit
charge, no item write. Vary ONLY the Main-image long edge; measure grade +
defect-detection deltas.

**Setup:** `npm i sharp` (once). Node 18+.

**Auth token:** sign in as the admin account in the app, then grab a Firebase ID
token (browser console, your app's auth object → `getIdToken()`). Tokens last ~1h.

**Pilot (~20 raw books, ~$5):**
```
ID_TOKEN="<token>" node tools/resolution_eval.mjs \
  --export ~/…/shared/robograder-export-2026-08-28.json \
  --set tools/resolution_test_set.csv \
  --tiers raw-drift --limit 20 --suppressRef \
  --out tools/resolution_eval_pilot.csv
```
Check `tools/_sample_response.json` after the first call to confirm the grade/
defect field names match the extractor. Then run the full set (drop `--limit`,
add other tiers). `--repeats 2` on a small subset estimates the model's own
run-to-run noise so you can tell a real resolution effect from noise.

**Read the result:** the aggregate block prints the mean signed grade delta and
— the one that matters — the **mean defect-count delta**. Negative there means
1200 is finding FEWER defects than 1400; that's the signal to stay at 1400.

## catalogue/ — by-book assessment browser (Phase 1 scaffold)
Open `tools/catalogue/index.html` in a browser. Reads `catalogue_data.json`
(generated from the export, opt-in only, PII stripped). Filter to any book, see
every assessment's images + grade + subscores + write-up side by side. Regenerate
the data with `tools/catalogue/build_catalogue.mjs` after a new export.
