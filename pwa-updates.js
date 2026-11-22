/* Ваш Доктор: без изменения исходного дизайна — встроенное расписание,
   статус обновления каталога и подготовленная операторская связь. */
(function(){
'use strict';
if(typeof PAGES==='undefined'||typeof S==='undefined'||typeof render!=='function')return;
const CLINIC_PHONE='tel:+74842200540';
// The clinic page has its own origin. Its scripts must never run with access to
// this app's local demo data; no form data or messages are proxied by the app.
const CLINIC_BOOKING_URL='https://vash-doc.ru/record.php#scheduleframe';
const widgetHtml=()=> (
  '<h1 class="page-title">Запись на приём</h1>'+
  '<p class="page-subtitle">Выберите направление и врача в расписании клиники</p>'+
  '<div class="plain-card" style="margin-top:12px;padding:10px;border-radius:25px">'+
  '<div class="row" style="justify-content:space-between;padding:3px 7px 10px"><b style="font-size:13px">Онлайн-запись</b><small style="color:#66776b">Официальный сайт клиники</small></div>'+
  '<div id="vd-booking-fallback" style="display:flex;flex-wrap:wrap;gap:8px;margin:0 3px 12px">'+
  '<a id="vd-booking-open" class="btn btn-white" style="flex:1;text-decoration:none" href="'+CLINIC_BOOKING_URL+'" target="_blank" rel="noopener noreferrer">Открыть отдельно</a>'+
  '<a id="vd-booking-call" class="btn btn-white" style="flex:1;text-decoration:none" href="'+CLINIC_PHONE+'">Позвонить в клинику</a></div>'+
  '<p id="vd-booking-status" class="micro" role="status" aria-live="polite" data-state="loading" style="margin:8px 5px">Загружаем окно записи клиники…</p>'+
  '<button class="linkmore" type="button" data-action="vd-booking-retry" style="margin:0 5px 12px">Загрузить окно заново</button>'+
  '<div id="vd-booking-mount"></div>'+
  '</div>'+
  '<p class="micro" style="margin:12px 5px">Запись оформляется в окне официального сайта клиники. Подтверждение записи выполняется в форме клиники.</p>'
);
PAGES.booking=widgetHtml;
let bookingView=null;
const bookingMessages={
 loading:'Загружаем окно записи клиники…',
 loaded:'Выберите направление и врача в окне клиники. Если расписание не появилось, откройте запись отдельно или позвоните в клинику.',
 slow:'Окно записи загружается дольше обычного. Можно открыть запись отдельно или позвонить в клинику.',
 offline:'Сейчас нет подключения к интернету. Когда связь появится, нажмите «Загрузить окно заново». Можно позвонить в клинику.',
 error:'Не удалось загрузить окно записи. Попробуйте ещё раз, откройте запись отдельно или позвоните в клинику.'
};
function updateBookingStatus(view){
 if(view!==bookingView||!view.mount.isConnected)return;
 const state=navigator.onLine===false?'offline':view.phase;
 view.status.dataset.state=state;
 view.status.textContent=bookingMessages[state];
}
function loadBookingFrame(view){
 clearTimeout(view.timer);
 view.phase='loading';
 updateBookingStatus(view);
 const frame=document.createElement('iframe');
 frame.id='vd-booking-frame';
 frame.title='Запись к врачу — расписание Ваш Доктор';
 frame.setAttribute('sandbox','allow-scripts allow-forms allow-same-origin allow-popups allow-popups-to-escape-sandbox');
 frame.setAttribute('referrerpolicy','strict-origin-when-cross-origin');
 frame.setAttribute('loading','eager');
 frame.setAttribute('scrolling','auto');
 frame.setAttribute('aria-describedby','vd-booking-status');
 frame.style.cssText='display:block;width:100%;height:900px;max-width:100%;border:0;border-radius:16px;background:#fffefb';
 const current=()=>view===bookingView&&view.frame===frame&&view.mount.isConnected;
 // A cross-origin load event says nothing about schedule availability or HTTP
 // success. Keep the independent fallback links and neutral instructions.
 frame.addEventListener('load',function(){
  if(!current())return;
  clearTimeout(view.timer);
  view.phase='loaded';
  updateBookingStatus(view);
 });
 frame.addEventListener('error',function(){
  if(!current())return;
  clearTimeout(view.timer);
  view.phase='error';
  updateBookingStatus(view);
 });
 view.frame=frame;
 view.timer=setTimeout(function(){
  if(!current())return;
  view.phase='slow';
  updateBookingStatus(view);
 },18000);
 // Install all parent-side observers before starting external navigation.
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
 if(!status)return;
 bookingView={mount,status,frame:null,timer:null,phase:'loading'};
 loadBookingFrame(bookingView);
}
// The existing renderer replaces #content; observe its mount without wrapping
// the iframe's contents or re-rendering the page on a manual retry.
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
  try{if(sessionStorage.getItem('vd-reload-demo-v17')==='1')return;}catch(_){}
  const input=document.activeElement;
  if(input&&/^(INPUT|TEXTAREA)$/i.test(input.tagName))return;
  reload=true;try{sessionStorage.setItem('vd-reload-demo-v17','1');}catch(_){}
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
