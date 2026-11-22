/* Ваш Доктор — надстройка PWA: кнопка «Позвонить», карточка контактов, баннер установки, Service Worker, автообновление данных. */
(function () {
  'use strict';
  var PHONE = '+7 (484) 394-00-03', PHONE_HREF = 'tel:+74843940003';
  var DEFAULT_CLINIC = { phone: PHONE, phoneHref: '+74843940003', address: 'Калужская область, г. Обнинск, ул. Ленина, 188',
                         hours: ['Пн–Пт: 08:00–20:00', 'Сб–Вс: 09:00–18:00'] };
  var esc = function (x) { return typeof escapeHTML === 'function' ? escapeHTML(String(x == null ? '' : x)) : String(x == null ? '' : x).replace(/[&<>"']/g, function (c) { return '&#' + c.charCodeAt(0) + ';'; }); };
  function clinic() { var c = (typeof VD_LIVE !== 'undefined' && VD_LIVE.clinic) || {}; return Object.assign({}, DEFAULT_CLINIC, c, { phone: PHONE, phoneHref: '+74843940003' }); }  // номер клиники зафиксирован
  var PH_ICON = '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1 1 .4 1.9.7 2.8a2 2 0 0 1-.5 2.1L8.1 9.9a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.4c.9.3 1.8.6 2.8.7a2 2 0 0 1 1.7 2Z"/></svg>';

  /* ---------- стили ---------- */
  var css = document.createElement('style');
  css.textContent =
    '.vd-fab{position:absolute;right:14px;bottom:104px;z-index:14;width:56px;height:56px;border-radius:50%;display:grid;place-items:center;color:#fff;text-decoration:none;background:linear-gradient(180deg,#76bd2f,#3f9425);box-shadow:0 10px 24px rgba(40,100,30,.38),inset 0 1px 0 rgba(255,255,255,.4);transition:transform .15s,bottom .2s}' +
    '.vd-fab:active{transform:scale(.93)}.is-welcome .vd-fab{display:none}.vd-has-banner .vd-fab{bottom:190px}' +
    '.vd-contact{margin:18px 0 8px;padding:18px;border-radius:26px;background:linear-gradient(135deg,#effbd3,#fff9e7);box-shadow:var(--shadow);border:1.4px solid #fff}' +
    '.vd-contact h3{margin:0 0 6px;font-size:17px;color:var(--forest)}.vd-contact p{margin:4px 0;font-size:13.5px;color:var(--soft);line-height:1.45}' +
    '.vd-contact .vd-hours{color:var(--forest);font-weight:600}' +
    '.vd-call{display:flex;align-items:center;justify-content:center;gap:10px;margin-top:12px;min-height:52px;border-radius:18px;text-decoration:none;color:#fff;font-weight:700;font-size:17px;background:linear-gradient(180deg,#76bd2f,#3f9425);box-shadow:0 8px 18px rgba(63,148,37,.3)}' +
    '.vd-sched{margin:14px 0 0;padding:14px 16px;border-radius:20px;background:#fff;box-shadow:var(--shadow);font-size:13.5px;line-height:1.5;color:var(--forest)}.vd-sched b{display:block;margin-bottom:4px}' +
    '.vd-banner{position:absolute;left:12px;right:12px;bottom:98px;z-index:15;display:none;align-items:center;gap:12px;padding:12px 14px;border-radius:22px;background:#124c31;color:#fff;font-size:13px;line-height:1.35;box-shadow:0 14px 30px rgba(21,59,51,.35)}' +
    '.vd-banner.on{display:flex}.vd-banner img{width:42px;height:42px;border-radius:12px;flex:none;background:#fff}.vd-banner div{flex:1;min-width:0}.vd-banner strong{display:block;font-size:14px}' +
    '.vd-banner button{border:0;border-radius:14px;padding:10px 14px;font-weight:700;background:#a5db2b;color:#0f382b}.vd-banner .vd-x{background:transparent;color:#fff;padding:6px 8px;font-size:20px;line-height:1}';
  document.head.appendChild(css);

  /* ---------- карточка контактов в страницах ---------- */
  function contactCard() {
    var c = clinic();
    return '<section class="vd-contact"><h3>Позвонить в клинику</h3>' +
      '<p class="vd-hours">' + c.hours.map(esc).join(' · ') + '</p>' +
      '<p>' + esc(c.address) + '</p>' +
      '<a class="vd-call" href="' + PHONE_HREF + '">' + PH_ICON + esc(PHONE) + '</a>' +
      '<p style="margin-top:10px;font-size:12px">Часы работы могут отличаться в праздники — уточняйте по телефону.</p></section>';
  }
  function schedBlock() {
    try {
      var d = typeof doc === 'function' ? doc(S.doctorId) : null;
      if (d && d.schedule) return '<div class="vd-sched"><b>Приём врача</b>' + esc(d.schedule) + '</div>';
      return '<div class="vd-sched"><b>Расписание приёма</b>Дни и время приёма этого врача уточняйте по телефону или в онлайн-записи.</div>';
    } catch (e) { return ''; }
  }
  function wrap(name, extra) {
    try {
      var orig = PAGES[name]; if (typeof orig !== 'function') return;
      PAGES[name] = function () { return orig() + extra(); };
    } catch (e) { console.warn('vd wrap', name, e); }
  }
  wrap('home', contactCard); wrap('doctors', contactCard); wrap('booking', contactCard); wrap('profile', contactCard);
  wrap('doctor', function () { return schedBlock() + contactCard(); });

  /* ---------- плавающая кнопка звонка ---------- */
  var appEl = document.getElementById('app') || document.body;
  var fab = document.createElement('a');
  fab.className = 'vd-fab'; fab.href = PHONE_HREF; fab.setAttribute('aria-label', 'Позвонить в клинику ' + PHONE); fab.innerHTML = PH_ICON;
  appEl.appendChild(fab);

  /* ---------- баннер «Установить приложение» ---------- */
  var standalone = (window.matchMedia && matchMedia('(display-mode: standalone)').matches) || navigator.standalone === true;
  var KEY = 'vd_install_dismissed', deferred = null;
  function dismissed() { try { var t = +localStorage.getItem(KEY) || 0; return Date.now() - t < 7 * 864e5; } catch (e) { return false; } }
  var banner = document.createElement('div'); banner.className = 'vd-banner'; banner.setAttribute('role', 'dialog');
  appEl.appendChild(banner);
  function showBanner(html, withBtn) {
    if (standalone || dismissed()) return;
    banner.innerHTML = '<img src="icons/icon-192.png" alt=""><div>' + html + '</div>' + (withBtn ? '<button type="button" data-i="1">Установить</button>' : '') + '<button type="button" class="vd-x" data-x="1" aria-label="Закрыть">×</button>';
    banner.classList.add('on'); appEl.classList.add('vd-has-banner');
  }
  function hideBanner(remember) {
    banner.classList.remove('on'); appEl.classList.remove('vd-has-banner');
    if (remember) { try { localStorage.setItem(KEY, String(Date.now())); } catch (e) {} }
  }
  banner.addEventListener('click', function (e) {
    var t = e.target;
    if (t.getAttribute && t.getAttribute('data-x')) hideBanner(true);
    if (t.getAttribute && t.getAttribute('data-i') && deferred) { deferred.prompt(); deferred.userChoice.finally(function () { deferred = null; hideBanner(true); }); }
  });
  window.addEventListener('beforeinstallprompt', function (e) { e.preventDefault(); deferred = e; setTimeout(function () { showBanner('<strong>Установить «Ваш Доктор»</strong>Иконка на экране телефона, работает как приложение', true); }, 2500); });
  window.addEventListener('appinstalled', function () { hideBanner(true); });
  var ua = navigator.userAgent || '';
  if (/iphone|ipad|ipod/i.test(ua) && !standalone) {
    setTimeout(function () { showBanner('<strong>Добавьте на экран «Домой»</strong>Нажмите <b>«Поделиться»</b> ⎙ внизу экрана → <b>«На экран Домой»</b>', false); }, 3000);
  }

  /* ---------- Service Worker ---------- */
  if ('serviceWorker' in navigator && /^https?:$/.test(location.protocol)) {
    window.addEventListener('load', function () {
      var had = !!navigator.serviceWorker.controller;
      navigator.serviceWorker.register('sw.js').then(function (reg) { try { reg.update(); } catch (e) {} }).catch(function (e) { console.warn('SW', e); });
      var reloaded = false;
      navigator.serviceWorker.addEventListener('controllerchange', function () { if (had && !reloaded) { reloaded = true; /* новая версия — применится при следующем открытии */ } });
    });
  }

  /* ---------- автообновление врачей при возврате в приложение (не чаще раза в час) ---------- */
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState !== 'visible') return;
    try { if (typeof VD_LIVE !== 'undefined' && typeof vdStartSync === 'function' && (!VD_LIVE.syncedAt || Date.now() - VD_LIVE.syncedAt > 36e5)) vdStartSync(); } catch (e) {}
  });
})();
