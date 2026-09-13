#!/usr/bin/env python3
"""
Downscale reference-cover scans for the repo.

WHY: reference_covers/ ships to Vercel and is fetched by the Deep pass to
separate printed art from damage. Full-res scans (2000px+) bloat the deploy
with no grading benefit, so each cover is capped at 1400px on its long side.
Files already <=1400 are left untouched (never upscaled -> no quality loss).

RULES:
  - Cap: long side <= 1400px, aspect preserved, JPEG quality 85.
  - Naming: <title-slug>_<issue>_<year>_front.jpg  and  _back.jpg
  - IN-PLACE, NO BACKUP. (An earlier pass renamed originals to "<name>.jpg~"
    before writing the small version; those ~ files were byproducts, not
    keepers, and were removed. This script does not create them. Keep the
    higher-res originals archived OUTSIDE the repo if you want them.)

USAGE:
    python3 tools/downscale_reference_covers.py            # process folder
    python3 tools/downscale_reference_covers.py FILE ...   # process specific files
"""
import sys, glob, os
from PIL import Image

MAX_LONG = 1400
QUALITY = 85

def process(path):
    try:
        im = Image.open(path)
    except Exception as e:
        print(f"  SKIP (unreadable): {path} ({e})"); return
    w, h = im.size
    if max(w, h) <= MAX_LONG:
        print(f"  ok (already {w}x{h}): {os.path.basename(path)}"); return
    scale = MAX_LONG / max(w, h)
    nw, nh = round(w*scale), round(h*scale)
    im = im.convert("RGB").resize((nw, nh), Image.LANCZOS)
    im.save(path, "JPEG", quality=QUALITY, optimize=True)
    print(f"  resized {w}x{h} -> {nw}x{nh}: {os.path.basename(path)}")

def main():
    args = sys.argv[1:]
    root = os.path.join(os.path.dirname(__file__), "..", "reference_covers")
    files = args if args else sorted(glob.glob(os.path.join(root, "*.jpg")))
    print(f"Processing {len(files)} file(s), cap {MAX_LONG}px long side:")
    for f in files:
        process(f)

if __name__ == "__main__":
    main()
