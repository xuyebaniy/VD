#!/usr/bin/env python3
"""Best-effort synchronization of public doctor profiles, never fabricate appointments."""
import json,re,urllib.parse,sys,hashlib
from datetime import datetime,timezone
from pathlib import Path
import requests
from bs4 import BeautifulSoup

ROOT='https://vash-doc.ru'
DEST=Path('data/doctors.json')
session=requests.Session()
session.headers.update({'User-Agent':'VashDoctorDirectoryPWA/1.0'})
def soup(url):
 r=session.get(url,timeout=25);r.raise_for_status();return BeautifulSoup(r.content,'html.parser')
def normal(t):return ' '.join(str(t or '').split())
def local(href):
 u=urllib.parse.urljoin(ROOT,href or '')
 p=urllib.parse.urlparse(u)
 return u if p.scheme=='https' and p.netloc in ('vash-doc.ru','www.vash-doc.ru') else None
def main():
 found={}
 for page in range(1,8):
  url=ROOT+'/specialists/'+(('?PAGEN_1='+str(page)) if page>1 else '')
  try:doc=soup(url)
  except requests.RequestException as ex:
   print('Page skipped',url,str(ex));continue
  added=0
  for a in doc.select('a[href]'):
   target=local(a.get('href'))
   if not target or '/specialists/' not in target or target.rstrip('/')==ROOT+'/specialists':continue
   name=normal(a.get_text(' ',strip=True))
   if not re.fullmatch(r'[А-ЯЁ][а-яё-]+\s+[А-ЯЁ][а-яё-]+(?:\s+[А-ЯЁ][а-яё-]+)?',name):continue
   if name in found:continue
   parent=a
   for i in range(2):
    if parent.parent:parent=parent.parent
   combined=normal(parent.get_text(' ',strip=True))
   specialty=normal(combined.replace(name,'',1))
   if not specialty or len(specialty)>90:specialty='Специализация уточняется'
   img=a.select_one('img') or parent.select_one('img')
   photo=local(img.get('data-src') or img.get('src')) if img else None
   found[name]={'name':name,'specialty':specialty,'photo':photo,'url':target,'schedule':''}
   added+=1
  print('Page',page,'new doctors',added)
  if page>1 and added==0:break
 if len(found)<9:raise ValueError('Too few doctors extracted; retain offline snapshot')
 for d in found.values():
  try:
   detail=soup(d['url'])
   for txt in detail.find_all(string=re.compile('Расписание при[её]ма|График при[её]ма|Часы при[её]ма',re.I)):
    parent=txt.parent.parent if txt.parent and txt.parent.parent else txt.parent
    line=normal(parent.get_text(' ',strip=True))
    if 15<len(line)<220 and re.search(r'\b(?:пн|вт|ср|чт|пт|сб|вс)\b|\d{1,2}:\d{2}',line,re.I):
     d['schedule']=line;break
  except requests.RequestException:pass
 previous={}
 try:previous={d['name']:d for d in json.loads(DEST.read_text()).get('doctors',[])}
 except (OSError,ValueError):pass
 doctors=[]
 for i,d in enumerate(found.values(),1):
  old=previous.get(d['name'],{})
  if not d['photo'] and str(old.get('photo') or '').startswith('assets/'):d['photo']=old['photo']
  d['id']=int(hashlib.sha1(d['url'].encode('utf-8')).hexdigest()[:8],16);doctors.append(d)
 DEST.parent.mkdir(exist_ok=True)
 DEST.write_text(json.dumps({'ok':True,'updated':datetime.now(timezone.utc).isoformat(),'source':ROOT+'/specialists/','clinic':{'phone':'+7 (484) 220-05-40','phoneHref':'+74842200540','address':'Обнинск, Ленина, 188'},'doctors':doctors},ensure_ascii=False,indent=2))
 print('Saved',len(doctors),'public doctor cards. Schedule fields published:',sum(bool(d['schedule']) for d in doctors))
 for d in doctors[:12]:print('Doctor:',d['name'],'Specialty:',d['specialty'],'Photo:',bool(d['photo']),'Schedule:',d['schedule'][:100])
if __name__=='__main__':
 try:main()
 except Exception as e:
  print('Sync failed, keeping last saved catalog:',repr(e),file=sys.stderr)
  sys.exit(1)
