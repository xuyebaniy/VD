/* Ваш Доктор: без изменения исходного дизайна — встроенное расписание,
   статус обновления каталога и подготовленная операторская связь. */
(function(){
'use strict';
if(typeof PAGES==='undefined'||typeof S==='undefined'||typeof render!=='function')return;
const CLINIC_PHONE='tel:+74842200540';
// This local-only demo intentionally trusts the clinic's official Medihost
// scripts on its own origin. Sandbox is not a parent-storage boundary here.
const CLINIC_BOOKING_URL=new URL('./booking-widget.html',location.href).href;
const widgetHtml=()=> (
  '<h1 class="page-title">Запись на приём</h1>'+
  '<div id="vd-booking-notice" style="margin:8px 3px">'+
  '<p id="vd-booking-status" class="micro" role="status" aria-live="polite" data-state="loading" style="margin:0">Загрузка расписания…</p>'+
  '<button class="linkmore" type="button" data-action="vd-booking-retry" style="margin-top:8px" hidden>Повторить</button></div>'+
  '<div id="vd-booking-mount"></div>'
);
PAGES.booking=widgetHtml;
let bookingView=null;
const bookingMessages={loading:'Загрузка расписания…',slow:'Расписание загружается дольше обычного.',offline:'Нет подключения к интернету.',error:'Не удалось загрузить расписание.'};
const bookingStates=new Set(['loading','ready','slow','offline','error','empty']);
function updateBookingStatus(view){
 if(view!==bookingView||!view.mount.isConnected)return;
 const state=navigator.onLine===false?'offline':view.phase;
 view.status.dataset.state=state;
 view.status.textContent=bookingMessages[state]||'';
 // The wrapper owns its small notice once it has reported. This parent notice
 // is only a fallback if the local iframe itself cannot initialize.
 view.notice.hidden=view.reported;
 view.retry.hidden=!['slow','offline','error'].includes(state);
}
function loadBookingFrame(view){
 clearTimeout(view.timer);
 view.phase='loading';view.reported=false;
 updateBookingStatus(view);
 const frame=document.createElement('iframe');
 frame.id='vd-booking-frame';
 frame.title='Запись к врачу — расписание Ваш Доктор';
 frame.setAttribute('sandbox','allow-scripts allow-forms allow-same-origin allow-popups allow-popups-to-escape-sandbox');
 frame.setAttribute('referrerpolicy','strict-origin-when-cross-origin');
 frame.setAttribute('loading','eager');
 frame.setAttribute('scrolling','auto');
 frame.style.cssText='display:block;width:100%;height:120px;max-width:100%;border:0;background:#fffefb';
 const current=()=>view===bookingView&&view.frame===frame&&view.mount.isConnected;
 // An iframe load event is never treated as schedule readiness.
 frame.addEventListener('error',function(){
  if(!current())return;
  clearTimeout(view.timer);
  view.phase='error';view.reported=false;
  updateBookingStatus(view);
 });
 view.frame=frame;
 view.timer=setTimeout(function(){
  if(!current()||view.reported)return;
  view.phase='slow';
  updateBookingStatus(view);
 },18000);
 // Install parent-side observers before starting the local wrapper.
 frame.src=CLINIC_BOOKING_URL;
 view.mount.replaceChildren(frame);
}
function mountBookingFrame(){
 const mount=document.getElementById('vd-booking-mount');
 if(bookingView&&bookingView.mount===mount&&mount.isConnected)return;
 if(bookingView)clearTimeout(bookingView.timer);
 bookingView=null;
 if(!mount)return;
 const status=document.getElementById('vd-booking-status');
 const notice=document.getElementById('vd-booking-notice');
 const retry=document.querySelector('[data-action="vd-booking-retry"]');
 if(!status||!notice||!retry)return;
 bookingView={mount,status,notice,retry,frame:null,timer:null,phase:'loading',reported:false};
 loadBookingFrame(bookingView);
}
window.addEventListener('message',function(event){
 const view=bookingView,data=event.data;
 if(!view||!view.frame||!view.mount.isConnected||event.origin!==location.origin||event.source!==view.frame.contentWindow)return;
 if(!data||typeof data!=='object'||Array.isArray(data)||Object.keys(data).length!==3)return;
 if(data.type!=='vd-medihost-widget'||!bookingStates.has(data.state)||!Number.isInteger(data.height)||data.height<120||data.height>3000)return;
 if(!Object.keys(data).every(key=>['type','state','height'].includes(key)))return;
 clearTimeout(view.timer);
 view.reported=true;view.phase=data.state;
 const height=data.height+'px';
 if(view.frame.style.height!==height)view.frame.style.height=height;
 updateBookingStatus(view);
});
// Observe shell navigation; a retry changes only the iframe, never the page.
new MutationObserver(mountBookingFrame).observe(document.getElementById('content')||document.body,{childList:true,subtree:true});
mountBookingFrame();
document.addEventListener('click',function(event){
 const control=event.target.closest('[data-action="vd-booking-retry"]');
 if(!control||!bookingView||!bookingView.mount.isConnected)return;
 event.preventDefault();
 loadBookingFrame(bookingView);
});
window.addEventListener('offline',function(){if(bookingView)updateBookingStatus(bookingView)});
window.addEventListener('online',function(){if(bookingView)updateBookingStatus(bookingView)});
function bookingFrameIsLive(){
 return S.page==='booking'&&!!bookingView&&bookingView.mount.isConnected&&!!bookingView.frame&&bookingView.frame.isConnected;
}
function preserveBookingOnRefresh(){
 const previousRender=render;
 render=function(){
  if(bookingFrameIsLive())return;
  return previousRender.apply(this,arguments);
 };
}
// The deferred cabinet script also wraps render(). Install this guard after
// those wrappers so a catalog refresh cannot discard an external form draft.
if(document.readyState==='complete')preserveBookingOnRefresh();
else document.addEventListener('DOMContentLoaded',preserveBookingOnRefresh,{once:true});
const previousHomePage=PAGES.home;
if(typeof previousHomePage==='function')PAGES.home=function(){
 return previousHomePage.apply(this,arguments)
  .replace(/MedWork/g,'Medihost')
  .replace(/Расписание пока не подключено\./g,'Онлайн-запись на сайте клиники.');
};
function chatPage(){
 return '<h1 class="page-title">Связаться с клиникой</h1><p class="page-subtitle">Контакт-центр «Ваш Доктор»</p>'+
 '<section class="plain-card" style="margin-top:13px"><h3>Переписку подключим позже</h3>'+
 '<p>В демоверсии сообщения оператору не отправляются. Сейчас можно позвонить в клинику или открыть действующую онлайн-запись.</p>'+
 '<a class="btn btn-orange btn-wide" style="text-decoration:none;margin-top:14px" href="'+CLINIC_PHONE+'">Позвонить в клинику</a>'+
 '<button class="btn btn-white btn-wide" style="margin-top:10px" data-nav="booking">Записаться к врачу</button></section>';
}
PAGES.chat=chatPage;
// Activating an updated service worker should refresh the installed Home Screen app.
if('serviceWorker' in navigator){
 let reload=false;
 navigator.serviceWorker.addEventListener('controllerchange',function(){
  if(bookingFrameIsLive())return;
  if(window.VDCabinet?.isActive())return;
  if(reload)return;
  try{if(sessionStorage.getItem('vd-reload-demo-v18')==='1')return;}catch(_){}
  const input=document.activeElement;
  if(input&&/^(INPUT|TEXTAREA)$/i.test(input.tagName))return;
  reload=true;try{sessionStorage.setItem('vd-reload-demo-v18','1');}catch(_){}
  window.location.reload();
 });
}
// Small in-app refresh control without changing the approved card design.
const previousDoctorPage=PAGES.doctors;
if(typeof previousDoctorPage==='function')PAGES.doctors=function(){
 return previousDoctorPage.apply(this,arguments)+
 '<div style="display:flex;align-items:center;justify-content:space-between;gap:10px;margin:16px 4px">'+
 '<span class="micro">Список врачей синхронизируется с vash-doc.ru</span>'+
 '<button class="linkmore" type="button" data-action="vd-refresh-doctors">Обновить</button></div>';
};
document.addEventListener('click',async function(event){
 const control=event.target.closest('[data-action="vd-refresh-doctors"]');
 if(!control)return;
 control.disabled=true;
 try{
  if(typeof vdStartSync==='function')await vdStartSync();
  if(typeof snack==='function')snack(VD_LIVE.catalogStatus==='connected'?'Список врачей обновлён':'Показана сохранённая версия каталога');
 }finally{control.disabled=false}
});
let lastForegroundSync=Date.now();
function refreshOnForeground(){
 if(document.visibilityState!=='visible'||Date.now()-lastForegroundSync<3*60*1000)return;
 lastForegroundSync=Date.now();
 if(typeof vdStartSync==='function'&&navigator.onLine!==false)vdStartSync().catch(console.warn);
 if('serviceWorker' in navigator)navigator.serviceWorker.getRegistration().then(r=>r&&r.update()).catch(()=>{});
}
document.addEventListener('visibilitychange',refreshOnForeground);
window.addEventListener('pageshow',refreshOnForeground);
if(S.page==='booking'||S.page==='chat'||S.page==='home')render({keepScroll:true});
})();
