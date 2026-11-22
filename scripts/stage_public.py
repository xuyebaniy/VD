"""Build an allowlisted Pages artifact without backend/admin/test sources."""
from pathlib import Path
import shutil

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "_site"
FILES = [
    "index.html", "manifest.webmanifest", "sw.js", "booking-widget.html",
    "pwa-updates.js", "cabinet-demo.js", "doctor-cabinet.js", "doctor-cabinet.css",
    "patient-cabinet.js", "patient-cabinet.css", ".nojekyll",
    "data/doctors.json",
]
if OUT.exists():
    shutil.rmtree(OUT)
OUT.mkdir()
for relative in FILES:
    source = ROOT / relative
    if not source.is_file():
        raise SystemExit(f"Required public file missing: {relative}")
    target = OUT / relative
    target.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(source, target)
for relative in ("icons", "assets/doctors"):
    source = ROOT / relative
    if not source.is_dir():
        raise SystemExit(f"Required public assets missing: {relative}")
    shutil.copytree(source, OUT / relative)
if any(OUT.rglob("*.php")):
    raise SystemExit("Server source must never be deployed to Pages")
print("Public Pages artifact prepared:", OUT)
