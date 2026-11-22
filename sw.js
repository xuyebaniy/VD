/* Vash Doctor PWA: same install/scope, offline app shell and fresh public clinic directory. */
const VERSION='vd-shell-2026-11-22-live-schedule-v13';
const DATA_CACHE='vd-public-directory-v5';
const PRECACHE=['./','./index.html','./manifest.webmanifest','./icons/app-icon.svg','./icons/apple-touch-icon.png','./icons/icon-192.png','./icons/icon-512.png','./data/doctors.json','./booking-widget.html','./pwa-updates.js'];
self.addEventListener('install',event=>{
  event.waitUntil(caches.open(VERSION).then(async cache=>{
    const results=await Promise.allSettled(PRECACHE.map(path=>cache.add(path)));
    if(!results.some(r=>r.status==='fulfilled'))throw new Error('Offline shell not cached');
    // Precache actual doctor portraits so every offline card retains its photo.
    try {
      const response=await fetch('./data/doctors.json',{cache:'no-store'});
      const catalog=await response.json();
      const photos=(catalog.doctors||[]).map(d=>d.photo).filter(p=>/^assets\/doctors\/[a-f0-9]{18}\.webp$/.test(p));
      await Promise.allSettled(photos.map(path=>cache.add('./'+path)));
    }catch(e){console.warn('Doctor portrait precache was incomplete',e)}
    await self.skipWaiting();
  }));
});
self.addEventListener('activate',event=>{
  event.waitUntil((async()=>{
    const keys=await caches.keys();
    await Promise.all(keys.filter(k=>(k.startsWith('vd-shell-')||k.startsWith('vd-original-')||k.startsWith('vd-public-directory-'))&&k!==VERSION&&k!==DATA_CACHE).map(k=>caches.delete(k)));
    await self.clients.claim();
  })());
});
async function networkFirst(request,cacheName,timeoutMs){
  const cache=await caches.open(cacheName);
  const ctl=new AbortController();
  const timer=setTimeout(()=>ctl.abort(),timeoutMs);
  try{
    const response=await fetch(request,{signal:ctl.signal,cache:'no-store'});
    if(!response.ok)throw new Error('HTTP '+response.status);
    cache.put(request,response.clone()).catch(()=>{});
    return response;
  }catch(error){
    const prior=await cache.match(request,{ignoreSearch:true});
    if(prior)return prior;
    throw error;
  }finally{clearTimeout(timer)}
}
self.addEventListener('fetch',event=>{
  const req=event.request;
  if(req.method!=='GET')return;
  const url=new URL(req.url);
  if(url.origin!==self.location.origin)return; // Do not cache credentials, external booking or patient data.
  if(url.pathname.includes('/data/')){
    event.respondWith(networkFirst(req,DATA_CACHE,5500).catch(async()=>{
      const prior=await caches.match(req,{ignoreSearch:true});
      return prior||new Response('{"ok":false,"doctors":[]}',{headers:{'Content-Type':'application/json; charset=utf-8'},status:503});
    }));
    return;
  }
  // The booking shell and update script must not be pinned to a stale version.
  if(url.pathname.endsWith('/pwa-updates.js')){
    event.respondWith(networkFirst(req,VERSION,5000).catch(()=>caches.match(req)));
    return;
  }
  if(req.mode==='navigate'){
    event.respondWith(networkFirst(req,VERSION,5000).catch(async()=>{
      const fallback=await caches.match('./index.html')||await caches.match('./');
      return fallback||new Response('Откройте приложение один раз с интернетом',{status:503,headers:{'Content-Type':'text/plain; charset=utf-8'}});
    }));
    return;
  }
  event.respondWith((async()=>{
    const cache=await caches.open(VERSION);
    const prior=await cache.match(req);
    if(prior)return prior;
    const response=await fetch(req);
    if(response.ok&&response.type==='basic')cache.put(req,response.clone()).catch(()=>{});
    return response;
  })());
});
