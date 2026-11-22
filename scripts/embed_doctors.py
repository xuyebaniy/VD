#!/usr/bin/env python3
"""Embed the verified public physician roster into the published PWA shell.

This is a BUILD step only. It does not overwrite the tracked original index.
The initial Home Screen render no longer depends on an asynchronous JSON
request that can fail on iOS home-screen apps or be served from an old cache.
"""
import json
import re
from pathlib import Path

index_path=Path("index.html")
json_path=Path("data/doctors.json")
html=index_path.read_text(encoding="utf-8")
catalog=json.loads(json_path.read_text(encoding="utf-8"))
items=catalog.get("doctors") or []
assert catalog.get("ok") is True
assert str(catalog.get("source","")).startswith("https://vash-doc.ru/specialists/")
assert len(items)>=10,"Refusing to publish an unverified/empty catalog"
for d in items:
    assert isinstance(d.get("id"),int) and d.get("name") and d.get("specialty")
    assert str(d.get("photo","")).startswith("assets/doctors/")
    assert Path(d["photo"]).is_file(), "Missing locally packaged physician image: "+d["photo"]
encoded=json.dumps(items,ensure_ascii=False,separators=(",",":"))
# Never allow untrusted website text to escape the inline JS script tag.
encoded=(encoded.replace("&",r"\u0026").replace("<",r"\u003c")
        .replace(">",r"\u003e").replace("\u2028",r"\u2028")
        .replace("\u2029",r"\u2029"))
stamp=json.dumps(catalog.get("updated") or "",ensure_ascii=False)
needle=re.compile(r"(?m)^const DOCTORS=\[[^\n]*\];$")
assert len(needle.findall(html))==1,"Expected a single doctor roster in original index"
# A checked-in or previously built shell already has this generated constant.
# Replace its declaration as well as the roster so repeated builds cannot create
# duplicate lexical declarations and prevent the entire inline script from running.
revision=re.compile(r"(?m)^const VD_VERIFIED_AT=[^\r\n]*;[ \t]*(?:\r?\n|$)")
html=revision.sub("",html)
html=needle.sub(lambda m:"const VD_VERIFIED_AT="+stamp+";\nconst DOCTORS="+encoded+";",html,count=1)
assert len(revision.findall(html))==1,"Expected exactly one catalog revision declaration"
assert len(html)>1000000, "Original artwork missing: refusing to replace the design"
index_path.write_text(html,encoding="utf-8")
print("Embedded",len(items),"physicians,",sum(bool(d.get("photo")) for d in items),
      "real photos into original PWA shell; catalog revision:",catalog.get("updated"),flush=True)
