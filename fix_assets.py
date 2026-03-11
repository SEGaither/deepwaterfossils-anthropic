#!/usr/bin/env python3
"""
Fix script for deepwaterfossils-anthropic assets.
Issue 1: Strip background from dwf.png (tol=45)
Issue 2: Apply 12px corner radius to brand-photo.png
"""
from PIL import Image, ImageDraw
import numpy as np
import os

BASE = os.path.dirname(os.path.abspath(__file__))


def rm_bg(img: Image.Image, tol: int = 45) -> Image.Image:
    img = img.convert("RGBA")
    arr = np.array(img, dtype=np.int32)
    bg = arr[0, 0, :3].copy()
    dist = np.abs(arr[:, :, :3] - bg).sum(axis=2)
    out = np.array(img.copy())
    out[:, :, 3] = np.where(dist < tol, 0, out[:, :, 3])
    return Image.fromarray(out.astype(np.uint8), "RGBA")


def round_corners(img: Image.Image, radius: int) -> Image.Image:
    img = img.convert("RGBA")
    w, h = img.size
    mask = Image.new("L", (w, h), 0)
    draw = ImageDraw.Draw(mask)
    draw.rounded_rectangle([(0, 0), (w - 1, h - 1)], radius=radius, fill=255)
    out = img.copy()
    out.putalpha(mask)
    return out


# ── ISSUE 1: strip dwf.png background ─────────────────────────────────────
dwf_path = os.path.join(BASE, "assets", "dwf.png")
dwf = Image.open(dwf_path).convert("RGBA")
bg_pixel = np.array(dwf)[0, 0, :3]
print(f"dwf.png top-left pixel RGB: {bg_pixel}")

dwf_fixed = rm_bg(dwf, tol=45)
dwf_fixed.save(dwf_path, "PNG")
print(f"ISSUE 1 FIXED: background stripped from dwf.png")

# ── ISSUE 2: round corners on brand-photo.png ─────────────────────────────
photo_path = os.path.join(BASE, "assets", "brand-photo.png")
photo = Image.open(photo_path)
photo_fixed = round_corners(photo, radius=12)
photo_fixed.save(photo_path, "PNG")
print(f"ISSUE 2 FIXED: 12px corner radius applied to brand-photo.png")

print("Done.")
