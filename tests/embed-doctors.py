#!/usr/bin/env python3
"""Regression for the live duplicate-VD_VERIFIED_AT build failure.

Run from any working directory: python3 tests/embed-doctors.py
Only a temporary copy is changed; no network or third-party packages are used.
"""
import hashlib
import json
from pathlib import Path
import re
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[1]
EMBED = ROOT / "scripts" / "embed_doctors.py"
REVISION = re.compile(r"(?m)^const VD_VERIFIED_AT=[^\r\n]*;[ \t]*(?:\r?\n|$)")
ROSTER = re.compile(r"(?m)^const DOCTORS=(\[[^\n]*\]);$")


def unmanaged_html(html):
    """Everything except the two deliberately generated declarations."""
    return ROSTER.sub("", REVISION.sub("", html))


original = (ROOT / "index.html").read_text(encoding="utf-8")
assert len(ROSTER.findall(original)) == 1
# The checked-in JSON can precede the workflow's image download. Use the
# verified embedded roster from this exact input shell as the build fixture.
catalog = {
    "ok": True,
    "source": "https://vash-doc.ru/specialists/",
    "updated": "2026-11-22T12:34:56+00:00",
    "doctors": json.loads(ROSTER.search(original).group(1)),
}

with tempfile.TemporaryDirectory(prefix="vd-embed-regression-") as temporary:
    work = Path(temporary)
    index = work / "index.html"
    index.write_text(original, encoding="utf-8")
    (work / "data").mkdir()
    (work / "data" / "doctors.json").write_text(json.dumps(catalog, ensure_ascii=False), encoding="utf-8")
    # The embedding step only checks packaged-image existence. Small fixtures
    # keep this test independent of the network-only physician-image download.
    assets = {}
    for doctor in catalog["doctors"]:
        relative = doctor["photo"]
        assert re.fullmatch(r"assets/doctors/[a-f0-9]{18}\.webp", relative), relative
        destination = work / relative
        destination.parent.mkdir(parents=True, exist_ok=True)
        payload = ("packaged physician photo fixture: " + relative).encode()
        destination.write_bytes(payload)
        assets[relative] = hashlib.sha256(payload).hexdigest()

    outputs = []
    def run_embed():
        result = subprocess.run([sys.executable, str(EMBED)], cwd=work, capture_output=True, text=True)
        assert result.returncode == 0, result.stderr or result.stdout

    for _ in range(2):
        run_embed()
        html = index.read_text(encoding="utf-8")
        assert len(REVISION.findall(html)) == 1, "Repeated embed duplicated VD_VERIFIED_AT"
        assert len(ROSTER.findall(html)) == 1, "Repeated embed duplicated DOCTORS"
        assert json.loads(ROSTER.search(html).group(1)) == catalog["doctors"], "Catalog changed while embedding"
        assert unmanaged_html(html) == unmanaged_html(original), "Original artwork or application code changed"
        for relative, digest in assets.items():
            assert hashlib.sha256((work / relative).read_bytes()).hexdigest() == digest, "Packaged asset was modified"
        outputs.append(html)
    assert outputs[0] == outputs[1], "Embedding the same catalog twice must be byte-for-byte idempotent"

    # A formerly broken generated artifact must also be repairable.
    broken = outputs[0].replace("const DOCTORS=", 'const VD_VERIFIED_AT="old-build";\nconst DOCTORS=', 1)
    index.write_text(broken, encoding="utf-8")
    run_embed()
    assert index.read_text(encoding="utf-8") == outputs[0], "Old duplicate revisions were not removed"

    # Parse the generated inline scripts without executing browser code. This
    # catches the exact SyntaxError that the source-only UI tests missed.
    scripts = [body for attrs, body in re.findall(r"<script\b([^>]*)>([\s\S]*?)</script\s*>", outputs[1], re.I)
               if not re.search(r"\bsrc\s*=", attrs, re.I)]
    subprocess.run([
        "node", "-e",
        "const fs=require('node:fs'),vm=require('node:vm');"
        "JSON.parse(fs.readFileSync(0,'utf8')).forEach((s,i)=>new vm.Script(s,{filename:'built-inline-'+i}));"
    ], input=json.dumps(scripts), text=True, check=True, capture_output=True)

print("PASS: repeated embed is idempotent; duplicate revisions repaired; catalog, artwork and assets preserved; built inline JavaScript parses.")
