"""Prepare a separate private-cabinet static artifact; never deploy the Pages tree here.

This build configures public URLs only. It does not create a domain, install the
backend, activate SMTP, deploy files, or change the public demo's configuration.
"""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import re
import shutil
from urllib.parse import urlsplit, urlunsplit


ROOT = Path(__file__).resolve().parents[1]
FILES = (
    "index.html", "manifest.webmanifest", "pwa-updates.js", "cabinet-api.js", "cabinet-demo.js",
    "doctor-cabinet.js", "doctor-cabinet.css", "patient-cabinet.js", "patient-cabinet.css", "data/doctors.json",
    "icons/app-icon.svg", "icons/apple-touch-icon.png", "icons/icon-192.png", "icons/icon-512.png",
)
API_URL = "/local/api/patient-cabinet.php"


def https_url(value: str, origin_only: bool = False) -> tuple[str, str]:
    if not value or re.search(r"[\s\\\x00-\x1f\x7f]", value):
        raise ValueError("URLs must be absolute HTTPS URLs without whitespace or backslashes")
    parsed = urlsplit(value)
    if parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password or parsed.fragment:
        raise ValueError("URLs must use HTTPS without credentials or fragments")
    host = parsed.hostname.lower()
    if not re.fullmatch(r"[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?", host) or ".." in host:
        raise ValueError("Use an ordinary HTTPS hostname")
    try:
        port = parsed.port
    except ValueError as error:
        raise ValueError("Invalid HTTPS port") from error
    if port is not None and not 1 <= port <= 65535:
        raise ValueError("Invalid HTTPS port")
    authority = host + (f":{port}" if port not in (None, 443) else "")
    origin = "https://" + authority
    if origin_only and (parsed.path not in ("", "/") or parsed.query):
        raise ValueError("--origin is an origin only, with no path or query")
    normalized = origin if origin_only else urlunsplit(("https", authority, parsed.path or "/", parsed.query, ""))
    return normalized, origin


def build(root: Path, output: Path, origin: str, booking_widget: str) -> dict[str, str]:
    origin, _ = https_url(origin, True)
    booking_widget, booking_origin = https_url(booking_widget)
    if booking_origin == origin:
        raise ValueError("The booking widget must be served from a different origin")
    if urlsplit(origin).hostname == "github.io" or urlsplit(origin).hostname.endswith(".github.io"):
        raise ValueError("GitHub Pages must remain a public demo, not the private cabinet origin")
    if output.is_symlink() or (output.exists() and (not output.is_dir() or any(output.iterdir()))):
        raise ValueError("Choose a new or empty output directory; existing deployments are never overwritten")
    if output.resolve() == root.resolve():
        raise ValueError("Output cannot be the source repository")
    for name in (*FILES, "sw.js"):
        source = root / name
        if not source.is_file() or source.is_symlink():
            raise ValueError(f"Required built public input missing or unsafe: {name}")
    # No external executable provider code may be copied onto the private origin.
    for name in FILES:
        if not name.endswith((".html", ".js")):
            continue
        source = (root / name).read_text(encoding="utf-8")
        if "api.medihost.ru" in source or "ScheduleFrame/code" in source or re.search(r'<script\b[^>]*\bsrc\s*=\s*[\'\"]https?://', source, re.I):
            raise ValueError(f"External script/provider loader found in private-origin input: {name}")
    sw = (root / "sw.js").read_text(encoding="utf-8")
    sw, removed = re.subn(r"(['\"])booking-widget\.html\1\s*,\s*", "", sw)
    if removed != 1:
        raise ValueError("Expected exactly one public booking-wrapper entry in the source Service Worker")
    fingerprint = hashlib.sha256((origin + "|" + booking_widget).encode()).hexdigest()[:12]
    sw, versions = re.subn(r"const VERSION = '([^']+)';", lambda match: "const VERSION = '" + match[1].replace("-demo-", "-clinic-") + "-" + fingerprint + "';", sw, count=1)
    if versions != 1:
        raise ValueError("Cannot assign a separate private-cabinet cache version")
    photo_dir = root / "assets/doctors"
    if not photo_dir.is_dir() or photo_dir.is_symlink():
        raise ValueError("Build the verified public doctor photos before staging the clinic artifact")
    config = {"apiUrl": API_URL, "bookingWidgetUrl": booking_widget}
    output.mkdir(parents=True, exist_ok=True)
    for name in FILES:
        target = output / name
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(root / name, target)
    (output / "assets/doctors").mkdir(parents=True)
    for source in photo_dir.iterdir():
        if re.fullmatch(r"[a-f0-9]{18}\.webp", source.name) and source.is_file() and not source.is_symlink():
            shutil.copyfile(source, output / "assets/doctors" / source.name)
    (output / "cabinet-config.js").write_text(
        "/* Generated only for the dedicated private cabinet origin: " + origin + ". No secrets. */\n"
        "window.VDCabinetConfig = Object.freeze(" + json.dumps(config, ensure_ascii=True, indent=2) + ");\n", encoding="utf-8")
    (output / "sw.js").write_text(sw, encoding="utf-8")
    # Apache: deny even an accidentally reintroduced provider wrapper, including nested paths.
    # Nginx/other servers need the equivalent rule documented in INSTALL.md.
    (output / ".htaccess").write_text(
        "# Private cabinet only. Never install the Pages booking wrapper on this origin.\n"
        "<FilesMatch \"(?i)^booking-widget\\.html$\">\n  Require all denied\n</FilesMatch>\n"
        "<IfModule mod_headers.c>\n"
        "  Header always set X-Frame-Options \"DENY\"\n"
        "  Header always add Content-Security-Policy \"frame-ancestors 'none'\"\n"
        "</IfModule>\n", encoding="utf-8")
    if (output / "booking-widget.html").exists() or "'booking-widget.html'" in sw or '"booking-widget.html"' in sw:
        raise ValueError("Private artifact must never contain/cache the provider wrapper")
    return config


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--origin", required=True, help="Dedicated cabinet HTTPS origin (must be configured separately)")
    parser.add_argument("--booking-widget", required=True, help="Trusted public HTTPS wrapper on a different origin")
    parser.add_argument("--output", type=Path, required=True, help="New or empty local output directory")
    args = parser.parse_args()
    try:
        build(ROOT, args.output, args.origin, args.booking_widget)
    except (ValueError, OSError) as error:
        parser.exit(2, f"Clinic build refused: {error}\n")
    print("Private-cabinet static artifact prepared:", args.output.resolve())
    print("No domain, SMTP account, backend, or deployment was activated.")


if __name__ == "__main__":
    main()
