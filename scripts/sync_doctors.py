#!/usr/bin/env python3
"""Synchronize the public Vash Doctor staff directory and their actual portraits.

The clinic uses UIkit lazy-loaded DIVs: .spec_cat_content[data-src],
not ordinary <img> elements. Portraits are downloaded, validated,
scaled WITHOUT CROPPING and bundled with the PWA for reliable display.
No patient information or authentication is accessed.
"""
from __future__ import annotations

import concurrent.futures
import hashlib
import io
import json
import re
import statistics
import sys
import urllib.parse
from datetime import datetime, timezone
from pathlib import Path

import requests
from bs4 import BeautifulSoup
from PIL import Image, ImageOps, UnidentifiedImageError

ROOT = "https://vash-doc.ru"
CATALOG = ROOT + "/specialists/"
DEST = Path("data/doctors.json")
PHOTO_DIR = Path("assets/doctors")
HEADERS = {"User-Agent": "Mozilla/5.0 (compatible; VashDoctorPublicDirectoryPWA/2.0)",
           "Referer": ROOT + "/"}
TIMEOUT = 22


def text(node):
    return " ".join(node.stripped_strings) if node else ""


def url_for(href, image=False):
    if not href:
        return None
    value = str(href).strip().strip("'\"")
    if value.startswith("data:") or value.startswith("javascript:"):
        return None
    url = urllib.parse.urljoin(ROOT, value)
    parts = urllib.parse.urlsplit(url)
    if parts.scheme != "https" or parts.netloc not in ("vash-doc.ru", "www.vash-doc.ru"):
        return None
    if image and not parts.path.startswith("/upload/"):
        return None
    if not image and not parts.path.startswith("/specialists/"):
        return None
    return url


def page_soup(url):
    response = requests.get(url, headers=HEADERS, timeout=TIMEOUT)
    response.raise_for_status()
    return BeautifulSoup(response.content, "html.parser")


def find_photo(container):
    if container is None:
        return None
    # UIkit loads background-image URLs from data-src into a DIV.
    candidates = container.select(
        ".spec_cat_content[data-src], .c_photo[data-src], "
        "[uk-img][data-src], [data-src], img[src], img[data-original], "
        "source[srcset], meta[property='og:image']"
    )
    if getattr(container, "attrs", None):
        candidates = [container] + list(candidates)
    for element in candidates:
        for key in ("data-src", "data-original", "data-lazy", "data-bg", "src", "content", "srcset"):
            source = element.get(key)
            if not source:
                continue
            candidate = str(source).split(",")[0].strip().split(" ")[0]
            candidate = url_for(candidate, image=True)
            if candidate:
                return candidate
        style = element.get("style", "")
        found = re.search(r"url\(\s*['\"]?([^'\"\)]+)", style)
        if found:
            candidate = url_for(found.group(1), image=True)
            if candidate:
                return candidate
    return None


def collect_doctors():
    records = {}
    for n in range(1, 13):
        page = CATALOG if n == 1 else CATALOG + "?PAGEN_1=" + str(n)
        document = page_soup(page)
        cards = document.select(".spec_cat_elem")
        if n == 1 and not cards:
            raise RuntimeError("Clinic markup changed: .spec_cat_elem not found")
        new = 0
        for card in cards:
            name_tag = card.select_one(".spec_fio_link")
            if not name_tag:
                continue
            name = text(name_tag)
            url = url_for(name_tag.get("href"))
            if not url or not name or name in records:
                continue
            specialty = text(card.select_one(".spec_spec")) or "Специализация уточняется"
            source = find_photo(card.select_one(".spec_cat_content")) or find_photo(card)
            records[name] = {
                "id": int(hashlib.sha1(url.encode("utf-8")).hexdigest()[:8], 16),
                "name": name,
                "specialty": specialty,
                "photo": None,
                "url": url,
                "schedule": "",
                "_source_image": source,
            }
            new += 1
        print("Catalog page", n, "cards", len(cards), "new doctors", new, flush=True)
        if n > 1 and new == 0:
            break
    if len(records) < 10:
        raise RuntimeError("Only %d doctors found; not replacing verified roster" % len(records))
    return list(records.values())


def enrich(record):
    if not record["_source_image"]:
        try:
            document = page_soup(record["url"])
            record["_source_image"] = find_photo(document.select_one(".photo_c_block")) or find_photo(document.select_one(".c_photo"))
        except requests.RequestException as exc:
            print("Profile image unavailable:", record["name"], str(exc)[:100], flush=True)
    # Optional published clinic reception hours only; never invent appointment slots.
    try:
        document = page_soup(record["url"])
        for tag in document.find_all(string=re.compile(r"Расписание при[её]ма|График при[её]ма|Часы при[её]ма", re.I)):
            node = tag.parent.parent if tag.parent and tag.parent.parent else tag.parent
            line = text(node)
            if 15 < len(line) < 200 and re.search(r"\b(пн|вт|ср|чт|пт|сб|вс)\b|\d{1,2}:\d{2}", line, re.I):
                record["schedule"] = line
                break
    except requests.RequestException:
        pass
    return record


def image_bg(im):
    rgb = im.convert("RGB")
    w, h = rgb.size
    samples = []
    for x in (max(0, w // 80), max(0, w - 1 - w // 80)):
        for y in (max(0, h // 80), max(0, h - 1 - h // 80)):
            samples.append(rgb.getpixel((x, y)))
    return tuple(int(statistics.median(color)) for color in zip(*samples))


def bundle_photo(record, old_photo=None):
    source = record.pop("_source_image")
    if not source:
        if old_photo and str(old_photo).startswith("assets/doctors/") and Path(old_photo).is_file():
            record["photo"] = old_photo
        return record
    try:
        response = requests.get(source, headers=HEADERS, timeout=TIMEOUT)
        response.raise_for_status()
        if len(response.content) > 12 * 1024 * 1024:
            raise ValueError("File larger than 12 MB")
        im = Image.open(io.BytesIO(response.content))
        im.load()
        im = ImageOps.exif_transpose(im)
        if min(im.size) < 100:
            raise ValueError("Source image too small")
        im = im.convert("RGB")
        # Keep the entire original photo (including its yellow/background color).
        # Scaling to fit rather than center-cropping prevents clipped eyes or heads.
        canvas = Image.new("RGB", (540, 660), image_bg(im))
        contained = ImageOps.contain(im, (524, 644), Image.Resampling.LANCZOS)
        x = (540 - contained.width) // 2
        y = 660 - contained.height  # align portrait with card bottom
        canvas.paste(contained, (x, y))
        filename = hashlib.sha256(response.content + b"vd-photo-contain-2026-v3").hexdigest()[:18] + ".webp"
        output = PHOTO_DIR / filename
        if not output.exists():
            canvas.save(output, format="WEBP", quality=88, method=5)
        record["photo"] = output.as_posix()
    except (requests.RequestException, UnidentifiedImageError, OSError, ValueError) as err:
        print("PHOTO_ERROR", record["name"], str(err)[:180], flush=True)
        if old_photo and str(old_photo).startswith("assets/doctors/") and Path(old_photo).is_file():
            record["photo"] = old_photo
    return record


def main():
    previous = {}
    try:
        previous = {row["name"]: row for row in json.loads(DEST.read_text(encoding="utf-8")).get("doctors", [])}
    except (KeyError, ValueError, OSError):
        pass

    doctors = collect_doctors()
    PHOTO_DIR.mkdir(parents=True, exist_ok=True)
    # Process site requests concurrently but preserve site order in the catalog.
    with concurrent.futures.ThreadPoolExecutor(max_workers=6) as pool:
        doctors = list(pool.map(enrich, doctors))
        doctors = list(pool.map(lambda row: bundle_photo(row, previous.get(row["name"], {}).get("photo")), doctors))

    with_photos = sum(bool(row["photo"] and Path(row["photo"]).is_file()) for row in doctors)
    print("PHOTO_RESULT", with_photos, "of", len(doctors), "doctor portraits downloaded", flush=True)
    for row in doctors:
        print("PHOTO_DOCTOR", row["name"], "OK" if row["photo"] else "MISSING",
              row["photo"] or "-", flush=True)
    # Refuse to publish a broken image extractor and destroy the previous good set.
    if with_photos < max(8, int(len(doctors) * .70)):
        raise RuntimeError("Too few doctor photos: %d/%d; keep previous catalog" %
                           (with_photos, len(doctors)))
    data = {
        "ok": True,
        "updated": datetime.now(timezone.utc).isoformat(),
        "source": CATALOG,
        "clinic": {
            "phone": "+7 (484) 220-05-40",
            "phoneHref": "+74842200540",
            "address": "Калужская область, г. Обнинск, ул. Ленина, 188",
        },
        "doctors": doctors,
    }
    DEST.parent.mkdir(parents=True, exist_ok=True)
    DEST.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    print("Saved verified public catalog:", len(doctors), "doctors,", with_photos, "photos",
          sum(bool(row["schedule"]) for row in doctors), "published schedules", flush=True)


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print("Sync failed: keeping existing catalog:", repr(exc), file=sys.stderr, flush=True)
        sys.exit(1)
