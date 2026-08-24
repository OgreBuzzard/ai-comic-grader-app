#!/usr/bin/env python3
"""optimize_images.py — idempotent image optimizer for Robograder.

Shrinks reference covers and app assets to sane caps so they don't bloat the
web deploy and native app bundles. Safe to re-run: a file already within its
cap (dimension AND size) is left untouched, so repeated runs never re-encode
(and never progressively degrade) an already-optimized image.

  python3 optimize_images.py            # optimize reference_covers/ + assets/
  python3 optimize_images.py reference_covers   # just that dir

NEW REFERENCE COVERS: drop full-size front/back JPGs into reference_covers/ and
run this (or just commit — the pre-commit hook runs it). Oversized ones are
resized to the 1400px cap; already-small ones are left as-is.
"""
import sys, os, glob
from PIL import Image

# (glob, longest-side cap, jpeg quality, size trigger KB, png?) — a file is
# rewritten only if longest_side > cap OR size > trigger.
RULES = [
    ("reference_covers/*.jpg",       1400, 85, 450, False),
    ("assets/ghosts/*.jpg",          1400, 82, 220, False),
    ("assets/products/*.png",         320,  0, 120, True),
    ("assets/*.jpg",                 1600, 82, 160, False),
    ("assets/*Charging.png",          800,  0, 150, True),
    ("assets/modal/progress_modal.PNG",800, 0, 150, True),
]

def process(path, cap, q, trig_kb, is_png):
    sz = os.path.getsize(path)
    im = Image.open(path); w, h = im.size; longest = max(w, h)
    # Idempotent by DIMENSION: once a file is within its pixel cap it is never
    # touched again (so re-runs never re-encode / progressively degrade). The
    # size trigger only applies to files still OVER the pixel cap.
    if longest <= cap:
        return None
    im = Image.open(path)
    if longest > cap:
        scale = cap / longest
        im = im.resize((round(w*scale), round(h*scale)), Image.LANCZOS)
    tmp = path + ".opt"
    if is_png:
        im.save(tmp, "PNG", optimize=True)
    else:
        im = im.convert("RGB")
        im.save(tmp, "JPEG", quality=q, optimize=True, progressive=True)
    new = os.path.getsize(tmp)
    if new < sz:
        os.replace(tmp, path); return (sz, new, im.size)
    # re-encode didn't help; keep original. Move the temp aside (some sandboxes
    # can't unlink, but can rename) so no .opt junk is left in the tree.
    os.makedirs("_to_delete", exist_ok=True)
    try: os.remove(tmp)
    except OSError: os.replace(tmp, os.path.join("_to_delete", path.replace("/", "_") + ".opt"))
    return None

targets = sys.argv[1:] or ["reference_covers", "assets"]
total_before = total_after = 0; changed = 0
for pat, cap, q, trig, png in RULES:
    top = pat.split("/")[0]
    if not any(pat.startswith(t) for t in targets): continue
    for f in sorted(glob.glob(pat)):
        if f.endswith("~"): continue
        r = process(f, cap, q, trig, png)
        if r:
            b, a, dim = r; total_before += b; total_after += a; changed += 1
            print(f"  {f:52s} {b//1024:>5}KB -> {a//1024:>4}KB  {dim[0]}x{dim[1]}")
print(f"\n{changed} file(s) optimized. Saved {(total_before-total_after)//1024} KB "
      f"({total_before//1024}KB -> {total_after//1024}KB).")
