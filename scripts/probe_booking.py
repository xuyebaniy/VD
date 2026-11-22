#!/usr/bin/env python3
"""Read-only probe for the clinic's public appointment interface and frame policy."""
import re, requests
from bs4 import BeautifulSoup
urls=["https://vash-doc.ru/record.php","https://api.medihost.ru/v2/ScheduleFrame/code/48196","https://vash-doc.ru/","https://t.me/vashdoktr"]
for url in urls:
 try:
  r=requests.get(url,timeout=22,headers={'User-Agent':'Mozilla/5.0 VashDoctorApp/1.0'},allow_redirects=True)
  print("PROBE",r.status_code,r.url,"bytes",len(r.content),"type",r.headers.get("Content-Type"),"XFO",r.headers.get("X-Frame-Options"),"CSP",r.headers.get("Content-Security-Policy"),flush=True)
  doc=BeautifulSoup(r.text,"html.parser")
  title=doc.title.get_text(" ",strip=True) if doc.title else "(no title)"
  print("TITLE",title[:250],flush=True)
  if "medihost.ru" in url:print("SCRIPT_BODY",re.sub(r"\\s+"," ",r.text[:4000]),flush=True)
  for link in doc.select('a[href],iframe[src],script[src],form[action]'):
   target=link.get("href") or link.get("src") or link.get("action") or ""
   desc=' '.join(link.stripped_strings)
   if any(t in (target+" "+desc).lower() for t in ("запис","расписан","record","booking","medwork","widget","online","schedule","онлайн")):
    print("BOOKING_LINK",link.name,desc[:130],target[:280],flush=True)
  for match in list(re.finditer(r"(?i)запис[ьа]|widget|medwork|online",r.text))[:22]:
   snippet=re.sub(r'\s+',' ',r.text[max(0,match.start()-160):match.start()+290])
   print("BOOKING_FRAGMENT",snippet[:420],flush=True)
 except Exception as e:print("PROBE_ERROR",url,type(e).__name__,str(e)[:180],flush=True)

# Medihost public widget uses a cross-origin POST with credentials.
# Check allowed origin and whether the widget enforces the clinic domain.
endpoint="https://api.medihost.ru/v2/ScheduleFrame/index/48196?resource_id=&group_id=0&is_orders=0&one_group=0&info_table=0&info_table_days=0"
for host in ("xuyebaniy.github.io","vash-doc.ru"):
 try:
  origin="https://"+host
  r=requests.post(endpoint,data={"site":origin,"domain":host},headers={"Origin":origin,"Referer":origin+"/"},timeout=20)
  print("MEDIHOST_POST",host,r.status_code,len(r.content),"ACAO",r.headers.get("Access-Control-Allow-Origin"),"ACAC",r.headers.get("Access-Control-Allow-Credentials"),"HEAD",re.sub(r"\s+"," ",r.text[:260]),flush=True)
 except Exception as exc:print("MEDIHOST_ERROR",host,str(exc)[:120],flush=True)
