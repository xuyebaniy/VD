/* Ваш Доктор: без изменения исходного дизайна — встроенное расписание,
   статус обновления каталога и подготовленная операторская связь. */
(function(){
'use strict';
if(typeof PAGES==='undefined'||typeof S==='undefined'||typeof render!=='function')return;
const CLINIC_PHONE='tel:+74842200540';
const widgetHtml=()=>{const d=typeof doc==='function'?doc(S.booking.doctorId):null;return (
  '<h1 class="page-title">Запись на приём</h1>'+
  '<p class="page-subtitle">Действующее расписание клиники «Ваш Доктор»</p>'+
  (d?'<div class="booking-doctor">'+imgPortrait(d,'p-1')+'<div style="min-width:0"><h3>'+escapeHTML(d.name)+'</h3><p>'+escapeHTML(d.specialty)+'</p><button class="linkmore" data-nav="doctors">Выбрать другого врача</button></div></div>':'')+
  '<div class="plain-card" style="margin-top:12px;padding:10px;border-radius:25px">'+
  '<div class="row" style="justify-content:space-between;padding:3px 7px 10px"><b style="font-size:13px">Онлайн-запись</b><small style="color:#66776b">Виджет Medihost клиники</small></div>'+
  '<iframe id="vd-booking-frame" title="Запись к врачу — расписание Ваш Доктор" src="./booking-widget.html" loading="eager" scrolling="auto" sandbox="allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox" style="display:block;width:100%;height:900px;max-width:100%;border:0;border-radius:16px;background:#fffefb" referrerpolicy="strict-origin-when-cross-origin" allow="payment"></iframe>'+
  '</div>'+
  '<p class="micro" style="margin:12px 5px">Для просмотра времени и подтверждения записи нужен интернет. Запись обрабатывает сервис, используемый официальным сайтом клиники.</p>'+
  '<a class="btn btn-white btn-wide" style="text-decoration:none;margin-top:10px" href="https://vash-doc.ru/record.php" target="_blank" rel="noopener noreferrer">Если расписание не открылось</a>'
)};
PAGES.booking=widgetHtml;
window.addEventListener('message',function(event){
 if(event.origin!=='null'||!event.data||event.data.type!=='vd-medihost-widget')return;
 const frame=document.getElementById('vd-booking-frame');
 if(!frame||frame.contentWindow!==event.source)return;
 if(Number.isFinite(Number(event.data.height)))frame.style.height=Math.max(620,Math.min(3000,Number(event.data.height)))+'px';
});
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
  if(window.VDCabinet?.isActive())return;
  if(reload)return;
  try{if(sessionStorage.getItem('vd-reload-demo-v16')==='1')return;}catch(_){}
  const input=document.activeElement;
  if(input&&/^(INPUT|TEXTAREA)$/i.test(input.tagName))return;
  reload=true;try{sessionStorage.setItem('vd-reload-demo-v16','1');}catch(_){}
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
if(S.page==='booking'||S.page==='chat')render({keepScroll:true});
})();
