/* Ваш Доктор: без изменения исходного дизайна — встроенное расписание,
   статус обновления каталога и подготовленная операторская связь. */
(function(){
'use strict';
if(typeof PAGES==='undefined'||typeof S==='undefined'||typeof render!=='function')return;
const CLINIC_PHONE='tel:+74842200540';
const CONTACT_API='https://vash-doc.ru/local/api/vd-pwa/v1/telegram-feedback.php';
let chatReady=false,chatProbed=false,chatLoading=false;
const widgetHtml=()=>{const d=typeof doc==='function'?doc(S.booking.doctorId):null;return (
  '<h1 class="page-title">Запись на приём</h1>'+
  '<p class="page-subtitle">Действующее расписание клиники «Ваш Доктор»</p>'+
  (d?'<div class="booking-doctor">'+imgPortrait(d,'p-1')+'<div style="min-width:0"><h3>'+escapeHTML(d.name)+'</h3><p>'+escapeHTML(d.specialty)+'</p><button class="linkmore" data-nav="doctors">Выбрать другого врача</button></div></div>':'')+
  '<div class="plain-card" style="margin-top:12px;padding:10px;border-radius:25px">'+
  '<div class="row" style="justify-content:space-between;padding:3px 7px 10px"><b style="font-size:13px">Онлайн-запись</b><small style="color:#66776b">Виджет Medihost клиники</small></div>'+
  '<iframe id="vd-booking-frame" title="Запись к врачу — расписание Ваш Доктор" src="./booking-widget.html" loading="eager" scrolling="auto" style="display:block;width:100%;height:900px;max-width:100%;border:0;border-radius:16px;background:#fffefb" referrerpolicy="strict-origin-when-cross-origin" allow="payment"></iframe>'+
  '</div>'+
  '<p class="micro" style="margin:12px 5px">Для просмотра времени и подтверждения записи нужен интернет. Запись обрабатывает сервис, используемый официальным сайтом клиники.</p>'+
  '<a class="btn btn-white btn-wide" style="text-decoration:none;margin-top:10px" href="https://vash-doc.ru/record.php" target="_blank" rel="noopener noreferrer">Если расписание не открылось</a>'
)};
PAGES.booking=widgetHtml;
window.addEventListener('message',function(event){
 if(event.origin!==location.origin||!event.data||event.data.type!=='vd-medihost-widget')return;
 const frame=document.getElementById('vd-booking-frame');
 if(!frame||frame.contentWindow!==event.source)return;
 if(Number.isFinite(Number(event.data.height)))frame.style.height=Math.max(620,Math.min(3000,Number(event.data.height)))+'px';
});
function chatPage(){
 return '<h1 class="page-title">Написать в клинику</h1><p class="page-subtitle">Связь с контакт-центром «Ваш Доктор»</p>'+
 '<section class="plain-card" style="margin-top:13px">'+
 (chatReady?'<h3>Сообщение оператору</h3><p>Отправляйте только организационные вопросы. Не указывайте диагнозы, результаты анализов, паспортные данные и сведения о здоровье.</p>'+
 '<form id="vd-chat-form"><label style="display:block;font-size:13px;font-weight:600;margin-top:14px" for="vd-chat-message">Текст обращения</label>'+
 '<textarea id="vd-chat-message" class="input-text" rows="5" maxlength="1000" required placeholder="Например, как изменить дату записи?"></textarea>'+
 '<label style="display:flex;gap:9px;font-size:12px;margin:10px 0;align-items:start"><input type="checkbox" id="vd-chat-consent" required style="margin-top:3px">Согласен на передачу сообщения операторской службе через подключённый канал связи. Не отправляю медицинские данные.</label>'+
 '<div id="vd-chat-result" role="status" style="font-size:12px;margin:9px 0"></div>'+
 '<button class="btn btn-green btn-wide" type="submit" id="vd-chat-send">Отправить сообщение</button></form>':
 '<h3>Написать оператору</h3><p>'+(chatLoading?'Проверяем подключение…':'Переписка из приложения пока не подключена к операторскому чату. Сообщение не отправляется — можно связаться по телефону.')+'</p>')+
 '<a class="btn btn-orange btn-wide" style="text-decoration:none;margin-top:14px" href="'+CLINIC_PHONE+'">Позвонить в клинику</a>'+
 '</section>';
}
PAGES.chat=chatPage;
function contactAction(){
 return '<section class="section"><button class="btn btn-tint btn-wide" style="min-height:52px" data-nav="chat">Написать в клинику</button></section>';
}
for(const name of ['family','profile']){
 const previous=PAGES[name];
 if(typeof previous==='function')PAGES[name]=function(){return previous.apply(this,arguments)+contactAction()};
}
async function probeChat(){
 if(chatLoading||chatProbed)return;
 chatProbed=true;chatLoading=true;
 try{
  const abort=new AbortController(),timer=setTimeout(()=>abort.abort(),6500);
  try{
   const response=await fetch(CONTACT_API+'?health=1',{cache:'no-store',credentials:'omit',signal:abort.signal});
   const data=await response.json();
   chatReady=response.ok&&data?.ready===true;
  }finally{clearTimeout(timer)}
 }catch(e){chatReady=false}
 finally{chatLoading=false;if(S.page==='chat')render({keepScroll:true})}
}
document.addEventListener('click',function(event){
 if(event.target.closest('[data-nav="chat"]')){chatProbed=false;setTimeout(probeChat,0)}
});
document.addEventListener('submit',async function(event){
 const form=event.target.closest('#vd-chat-form');if(!form)return;
 event.preventDefault();
 const body=document.getElementById('vd-chat-message'),consent=document.getElementById('vd-chat-consent');
 const button=document.getElementById('vd-chat-send'),result=document.getElementById('vd-chat-result');
 if(!body||!consent||!consent.checked)return;
 button.disabled=true;result.textContent='Отправляем…';
 try{
  const ctrl=new AbortController(),timer=setTimeout(()=>ctrl.abort(),12000);
  let response,data;
  try{
   response=await fetch(CONTACT_API,{method:'POST',credentials:'omit',headers:{'Content-Type':'application/json'},body:JSON.stringify({text:body.value,consent:true,homepage:''}),signal:ctrl.signal});
   data=await response.json();
  }finally{clearTimeout(timer)}
  if(!response.ok||data?.ok!==true)throw new Error('Сервис не подтвердил отправку.');
  body.value='';consent.checked=false;
  result.textContent='Сообщение передано операторской службе.';
 }catch(e){result.textContent='Не удалось отправить. Сообщение не принято. Позвоните в клинику.'}
 finally{button.disabled=false}
});
// Activating an updated service worker should refresh the installed Home Screen app.
if('serviceWorker' in navigator){
 let reload=false;
 navigator.serviceWorker.addEventListener('controllerchange',function(){
  if(reload||sessionStorage.getItem('vd-reload-updated')==='1')return;
  const input=document.activeElement;
  if(input&&/^(INPUT|TEXTAREA)$/i.test(input.tagName))return;
  reload=true;sessionStorage.setItem('vd-reload-updated','1');
  window.location.reload();
 });
}
if(S.page==='booking'||S.page==='chat')render({keepScroll:true});
})();
