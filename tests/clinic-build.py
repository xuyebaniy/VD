"""Verify private-origin packaging against real built inputs; never deploy anything.

Run after the public doctor/photo/icon build, alongside stage_public.py.
"""
from __future__ import annotations

import hashlib
import importlib.util
import json
from pathlib import Path
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("vd_clinic_build", ROOT / "scripts/stage_clinic.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
ORIGIN = "https://cabinet.example.test"
BOOKING = "https://booking.example.test/booking-widget.html"
checks = 0


def check(condition, label):
    global checks
    if not condition:
        raise AssertionError(label)
    checks += 1
    print("PASS", label)


def rejected(function, label):
    try:
        function()
    except ValueError:
        check(True, label)
        return
    raise AssertionError("Not rejected: " + label)


original_config = (ROOT / "cabinet-config.js").read_bytes()
original_sw = (ROOT / "sw.js").read_bytes()
with tempfile.TemporaryDirectory(prefix="vd-clinic-build-") as temp:
    out = Path(temp) / "clinic"
    settings = module.build(ROOT, out, ORIGIN, BOOKING)
    files = {path.relative_to(out).as_posix() for path in out.rglob("*") if path.is_file()}
    check("booking-widget.html" not in files and not list(out.rglob("*booking-widget*")), "provider wrapper excluded from entire private artifact")
    check(not any(name.endswith((".php", ".sqlite", ".py", ".cjs")) or name.startswith(("integration/", "tests/", "scripts/")) for name in files), "server, data stores and test/admin sources excluded")
    sw = (out / "sw.js").read_text()
    check("booking-widget.html" not in sw, "private Service Worker cannot cache or serve public wrapper")
    check("-clinic-" in sw and sw.encode() != original_sw, "private cache version differs from public demo")
    check(settings == {"apiUrl": "/local/api/patient-cabinet.php", "bookingWidgetUrl": BOOKING}, "API stays same-origin and booking stays separate")
    script = "const fs=require('fs'),vm=require('vm');const context={window:{}};vm.runInNewContext(fs.readFileSync(process.argv[1],'utf8'),context);process.stdout.write(JSON.stringify(context.window.VDCabinetConfig));"
    actual = json.loads(subprocess.check_output(["node", "-e", script, str(out / "cabinet-config.js")], text=True))
    check(actual == settings, "generated public configuration executes as valid JavaScript")
    subprocess.run(["node", "--check", str(out / "sw.js")], check=True)
    check(True, "generated private Service Worker passes syntax check")
    rule = (out / ".htaccess").read_text()
    check('booking-widget\\.html' in rule and 'Require all denied' in rule and "frame-ancestors 'none'" in rule, "Apache output denies local wrapper and framing private pages")
    check((ROOT / "cabinet-config.js").read_bytes() == original_config and (ROOT / "sw.js").read_bytes() == original_sw, "public demo config and worker remain byte-identical")
    before = hashlib.sha256((out / "index.html").read_bytes()).hexdigest()
    rejected(lambda: module.build(ROOT, out, ORIGIN, BOOKING), "nonempty destination is never overwritten")
    check(hashlib.sha256((out / "index.html").read_bytes()).hexdigest() == before, "refused rebuild preserves existing destination")
    for index, (origin, booking) in enumerate([
        (ORIGIN, ORIGIN + "/booking-widget.html"),
        (ORIGIN + ":443", ORIGIN + "/booking-widget.html"),
        ("http://cabinet.example.test", BOOKING),
        (ORIGIN, "http://booking.example.test/widget.html"),
        (ORIGIN, "https://name:password@booking.example.test/widget.html"),
        (ORIGIN + "/app/", BOOKING),
        ("https://xuyebaniy.github.io", BOOKING),
    ]):
        rejected(lambda: module.build(ROOT, Path(temp) / f"invalid-{index}", origin, booking), f"unsafe origin/configuration {index + 1} rejected")
    # Even if another provider wrapper is dropped into an asset folder, only expected photo files copy.
    check(all(not name.endswith(".html") or name == "index.html" for name in files), "index is the only HTML document on the private origin")
print(f"\n{checks} private-cabinet packaging checks passed; no deployment or services changed.")
