#!/usr/bin/env python3
"""Diagnostic: inspect public site image markup without storing or printing private data."""
import re, requests
from bs4 import BeautifulSoup
ROOT = 'https://vash-doc.ru'
headers = {'User-Agent':'Mozilla/5.0 (compatible; VashDoctorPWA/1.0)'}
def inspect(url, labels):
    r=requests.get(url,headers=headers,timeout=30)
    print('DIAG_PAGE',r.status_code,len(r.content),r.url,flush=True)
    d=BeautifulSoup(r.content,'html.parser')
    for label in labels:
        nodes=[a for a in d.select('a[href]') if label.lower() in ' '.join(a.stripped_strings).lower()]
        print('DIAG_PERSON',label,'matches',len(nodes),flush=True)
        for a in nodes[:2]:
            print('DIAG_ANCHOR',' '.join(a.stripped_strings)[:120],a.get('href'),flush=True)
            p=a
            for i in range(7):
                imgs=p.select('img')
                print('DIAG_PARENT',i,p.name,p.get('class'),'images',len(imgs),'style',str(p.get('style') or '')[:130],flush=True)
                for im in imgs[:3]:
                    print('DIAG_IMG',{k:str(v)[:200] for k,v in im.attrs.items() if k in ('src','alt','data-src','data-original','data-lazy','srcset','data-srcset','class','style','loading')},flush=True)
                if not p.parent:break
                p=p.parent
    print('DIAG_IMAGE_COUNT',len(d.select('img')))
    for im in d.select('img')[:22]:
        print('DIAG_TOPIMG',{k:str(v)[:170] for k,v in im.attrs.items() if k in ('src','alt','data-src','data-original','data-lazy','srcset','data-srcset','class','style','loading')},flush=True)
    for m in re.findall(r'[^"\\ ]+\.(?:jpg|jpeg|png|webp)(?:\?[^" ]*)?',r.text,re.I)[:25]:
        print('DIAG_IMGREF',m[:160],flush=True)
inspect(ROOT+'/specialists/', ['Комлева Анна Васильевна','Хашабаева Нина Владимировна','Дмитриева Галина Евгеньевна'])
inspect(ROOT+'/specialists/pediatriya/komleva-anna-vasilevna/', ['Комлева Анна Васильевна'])

def debug_markup(url):
 r=requests.get(url,headers=headers,timeout=30)
 t=r.text
 for term in ['Комлева','Хашабаева','Дмитриева','/upload/iblock/c88/','/upload/iblock/77a/','background-image','specialists__','specialists-item','doctor-card']:
  pos=t.find(term)
  print('DIAG_FRAGMENT',term,'pos',pos,'text',re.sub(r'\\s+',' ',t[max(0,pos-750):pos+900])[:1800] if pos>=0 else '',flush=True)
 d=BeautifulSoup(r.content,'html.parser')
 for a in d.select('a[href]'):
  if 'komleva' in a.get('href',''):
   print('DIAG_LINK_OUTER',str(a.parent.parent)[:5000],flush=True)
 print('DIAG_STYLE_ELEMENTS',[(x.name,str(x.get('style'))[:140]) for x in d.select('[style*=image]')][:20],flush=True)
debug_markup(ROOT+'/specialists/')
debug_markup(ROOT+'/specialists/pediatriya/komleva-anna-vasilevna/')
