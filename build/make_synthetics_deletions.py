#!/usr/bin/env python3
"""Builds DELETION truth-set pairs: known content cut out of a real capture,
so a judging change can be tested against a defect whose answer is known.

Both synthetics derive from the real 2026-08-05 incident capture
(new_<SLUG>.png, 1179x61875) and pair against the real baseline
(baseline_<SLUG>.png, 1179x63558). Set SLUG below to that capture pair:

  links_removed    — the four brand-column footer links (y 58779-59097) cut out:
                     a TRUE removal near the bottom. tailIdentity must NOT be
                     declared; the sweep must verify the claim (FAIL ships).
  insert_in_zone   — a 100px slice of footer link rows duplicated at y 59200,
                     INSIDE the bottom-K zone: row alignment keeps a seam AND
                     tailIdentity must refuse (the two mechanical evidences
                     must never contradict; review major, 2026-08-05).

Usage:  python3 build/make_synthetics_deletions.py
Writes to local_files/validate_tmp/ (gitignored, container-visible at
/files/validate_tmp/). Drive them through build/validate_ai_vision_scripted.js and
build/validate_ai_vision.js preai.
"""
from PIL import Image
from pathlib import Path

Image.MAX_IMAGE_PIXELS = None
ROOT = Path(__file__).resolve().parent.parent / 'local_files'
OUT = ROOT / 'validate_tmp'
OUT.mkdir(exist_ok=True)

SLUG = 'gridpage_mobile'  # the capture pair these coordinates were measured on
src = Image.open(ROOT / f'new_screenshots/new_{SLUG}.png').convert('RGB')
W, H = src.size

# TRUE removal: cut rows 58745-59104 (four-link block 58779-59097 + slack)
CUT0, CUT1 = 58745, 59105
out = Image.new('RGB', (W, H - (CUT1 - CUT0)))
out.paste(src.crop((0, 0, W, CUT0)), (0, 0))
out.paste(src.crop((0, CUT1, W, H)), (0, CUT0))
out.save(OUT / 'synthetic_links_removed_mobile.png')
print('links_removed:', out.size)

# Insertion inside the bottom-K zone: duplicate link rows 58870-58970 at 59200
INS_AT, SRC0, SRC1 = 59200, 58870, 58970
out = Image.new('RGB', (W, H + (SRC1 - SRC0)))
out.paste(src.crop((0, 0, W, INS_AT)), (0, 0))
out.paste(src.crop((0, SRC0, W, SRC1)), (0, INS_AT))
out.paste(src.crop((0, INS_AT, W, H)), (0, INS_AT + (SRC1 - SRC0)))
out.save(OUT / 'synthetic_insert_in_zone_mobile.png')
print('insert_in_zone:', out.size)
