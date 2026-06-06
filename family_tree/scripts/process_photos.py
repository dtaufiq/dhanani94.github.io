#!/usr/bin/env python3
"""
process_photos.py — localize + age-proof family-tree photos.

For every person in data/family.json whose `photo` is a remote URL or an inline
base64 data: URI, this:
  1. downloads (or decodes) the image,
  2. detects the largest face (frontal, with profile / mirrored fallback),
  3. crops a square headshot (~2.2x the face box, eyes biased to the upper third;
     center-crops if no face is found),
  4. resizes to SIZE x SIZE and saves it as a compact WebP in data/photos/<id>.webp,
  5. rewrites the person's `photo` to that local path.

Photos that are ALREADY local ("data/photos/...") are skipped, so it's safe to
re-run after adding new people / new image URLs.

Usage:
    # one-time setup (isolated env so it doesn't touch system Python):
    python3 -m venv .venv && . .venv/bin/activate
    pip install opencv-python-headless pillow numpy
    # then:
    python3 scripts/process_photos.py            # process new photos
    python3 scripts/process_photos.py --force     # also re-crop existing locals
                                                  #   (only if the source URL is
                                                  #    still in family.json)

Requires `curl` on PATH. Writes a QA contact sheet of the photos it (re)made to
/tmp/contact_sheet.png.
"""
import argparse
import base64
import json
import os
import subprocess
import sys

import cv2
import numpy as np
from PIL import Image, ImageDraw, ImageFont

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, "data", "family.json")
OUT_DIR = os.path.join(ROOT, "data", "photos")
LOCAL_PREFIX = "data/photos/"

SIZE = 400        # output square, px
QUALITY = 80      # WebP quality (0-100)
FACE_SCALE = 2.2  # crop side as a multiple of the detected face box

_cd = cv2.data.haarcascades
FRONTAL = [cv2.CascadeClassifier(_cd + f) for f in
           ("haarcascade_frontalface_default.xml", "haarcascade_frontalface_alt2.xml")]
PROFILE = cv2.CascadeClassifier(_cd + "haarcascade_profileface.xml")


def fetch(url):
    """Return raw image bytes for a remote URL or data: URI, or None on failure."""
    if url.startswith("data:"):
        try:
            return base64.b64decode(url.split(",", 1)[1])
        except Exception:
            return None
    r = subprocess.run(
        ["curl", "-sL", "--connect-timeout", "15", "--max-time", "40",
         "--retry", "2", "-A", "Mozilla/5.0", url],
        capture_output=True,
    )
    return r.stdout if r.returncode == 0 and r.stdout else None


def _largest(boxes):
    best = None
    for (x, y, w, h) in boxes:
        if best is None or w * h > best[2] * best[3]:
            best = (x, y, w, h)
    return best


def detect_face(gray):
    """Return (box, kind) where box is (x,y,w,h) or None; kind in frontal/profile/none."""
    found = []
    for c in FRONTAL:
        for f in c.detectMultiScale(gray, 1.1, 6, minSize=(40, 40)):
            found.append(tuple(int(v) for v in f))
    if found:
        return _largest(found), "frontal"
    for f in PROFILE.detectMultiScale(gray, 1.1, 6, minSize=(40, 40)):
        found.append(tuple(int(v) for v in f))
    if found:
        return _largest(found), "profile"
    w_img = gray.shape[1]
    mirrored = [(w_img - x - w, y, w, h)
                for (x, y, w, h) in PROFILE.detectMultiScale(cv2.flip(gray, 1), 1.1, 6, minSize=(40, 40))]
    if mirrored:
        return _largest(mirrored), "profile"
    return None, "none"


def headshot(img, face):
    """Crop a square headshot around `face` (or a center square if face is None)."""
    H, W = img.shape[:2]
    if face is None:
        s = min(H, W)
        return img[(H - s) // 2:(H - s) // 2 + s, (W - s) // 2:(W - s) // 2 + s]
    x, y, w, h = face
    cx = x + w / 2
    cy = (y + h / 2) - h * 0.15            # bias up so eyes sit ~upper third
    side = min(int(max(w, h) * FACE_SCALE), H, W)
    x0 = max(0, min(int(cx - side / 2), W - side))
    y0 = max(0, min(int(cy - side / 2), H - side))
    return img[y0:y0 + side, x0:x0 + side]


def process_one(url, out_path):
    """Returns kind ('frontal'/'profile'/'none') on success, or an ERROR string."""
    raw = fetch(url)
    if raw is None:
        return "DOWNLOAD_FAIL"
    img = cv2.imdecode(np.frombuffer(raw, np.uint8), cv2.IMREAD_COLOR)
    if img is None:
        return "DECODE_FAIL"
    face, kind = detect_face(cv2.cvtColor(img, cv2.COLOR_BGR2GRAY))
    crop = cv2.resize(headshot(img, face), (SIZE, SIZE), interpolation=cv2.INTER_AREA)
    rgb = cv2.cvtColor(crop, cv2.COLOR_BGR2RGB)
    Image.fromarray(rgb).save(out_path, "WEBP", quality=QUALITY, method=6)
    return kind


def contact_sheet(ids, names, path="/tmp/contact_sheet.png"):
    if not ids:
        return None
    cols, thumb, lh, pad = 8, 150, 26, 6
    rows = (len(ids) + cols - 1) // cols
    cw, ch = thumb + pad * 2, thumb + lh + pad
    sheet = Image.new("RGB", (cols * cw, rows * ch), (24, 30, 23))
    draw = ImageDraw.Draw(sheet)
    try:
        font = ImageFont.truetype("/System/Library/Fonts/Supplemental/Arial.ttf", 12)
    except Exception:
        font = ImageFont.load_default()
    for i, pid in enumerate(ids):
        r, c = divmod(i, cols)
        im = Image.open(os.path.join(OUT_DIR, pid + ".webp")).resize((thumb, thumb))
        x, y = c * cw + pad, r * ch + pad
        sheet.paste(im, (x, y))
        draw.text((x, y + thumb + 4), names.get(pid, "?")[:20], fill=(205, 191, 143), font=font)
    sheet.save(path)
    return path


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--force", action="store_true",
                    help="also re-crop photos already pointing at data/photos/ "
                         "(no-op unless the original URL is still present elsewhere)")
    args = ap.parse_args()

    os.makedirs(OUT_DIR, exist_ok=True)
    data = json.load(open(DATA))
    names = {p["id"]: p.get("name", "?") for p in data["people"]}

    done, report = [], []
    for p in data["people"]:
        url = p.get("photo")
        if not url:
            continue
        if url.startswith(LOCAL_PREFIX) and not args.force:
            continue  # already localized
        pid = p["id"]
        out = os.path.join(OUT_DIR, pid + ".webp")
        result = process_one(url, out)
        if result in ("frontal", "profile", "none"):
            p["photo"] = LOCAL_PREFIX + pid + ".webp"
            done.append(pid)
            report.append((pid, result, os.path.getsize(out)))
        else:
            report.append((pid, result, url[:55]))  # leave p["photo"] untouched

    if done:
        json.dump(data, open(DATA, "w"), ensure_ascii=False, indent=2)
        open(DATA, "a").write("\n")  # match the app's trailing newline

    faces = sum(1 for r in report if r[1] in ("frontal", "profile"))
    noface = sum(1 for r in report if r[1] == "none")
    fails = [r for r in report if str(r[1]).endswith("FAIL")]
    sizes = [r[2] for r in report if isinstance(r[2], int)]
    print(f"processed={len(done)}  face={faces}  no-face(center)={noface}  fail={len(fails)}")
    if sizes:
        print(f"sizes: total={sum(sizes)//1024}KB avg={sum(sizes)//len(sizes)//1024}KB max={max(sizes)//1024}KB")
    for pid, kind, _ in [r for r in report if r[1] == "none"]:
        print(f"  no-face (center-cropped): {pid}  {names.get(pid)}")
    for pid, kind, info in fails:
        print(f"  {kind}: {pid}  {names.get(pid)}  {info}")
    sheet = contact_sheet(done, names)
    if sheet:
        print(f"contact sheet: {sheet}")


if __name__ == "__main__":
    sys.exit(main())
