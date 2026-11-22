/* «Ваш Доктор» — parent-owned demo cabinet. All sample data stays in this
   browser through VDDemo; switching roles is not real authentication. */
(function () {
  'use strict';
  if (typeof PAGES === 'undefined' || typeof S === 'undefined' || typeof render !== 'function') return;

  const Demo = window.VDDemo;
  const PHONE = 'tel:+74842200540';
  const PRIVATE = new Set(['family', 'profile', 'garden', 'garden-day', 'documents', 'bookings', 'add-child', 'doctor-cabinet']);
  const RELATIONS = {mother:'Мама', father:'Папа', grandmother:'Бабушка', grandfather:'Дедушка', guardian:'Законный представитель'};
  const HABITS = [
    ['meal','Питание','n-i-meal.webp'], ['water','Вода','n-i-water.webp'],
    ['activity','Движение','n-i-move.webp'], ['sleep','Сон','n-i-sleep.webp'],
    ['screen','Экранное время','n-i-screen.webp'], ['mood','Самочувствие','n-i-mood.webp']
  ];
  const MARKS = [['done','Выполнено'], ['partial','Частично'], ['missed','Не выполнено']];
  const esc = escapeHTML;
  const app = document.getElementById('app');
  const state = {
    token:null, expiresAt:0, generation:0, account:null,
    children:[], selected:null, months:new Map(), drafts:new Map(), saving:false,
    busy:false, authError:'', authNotice:'', childError:'', meBusy:false
  };
  let doctorView = null;

  function clinicToday() {
    const parts = new Intl.DateTimeFormat('en-CA', {timeZone:'Europe/Moscow', year:'numeric', month:'2-digit', day:'2-digit'}).formatToParts(new Date());
    const v = Object.fromEntries(parts.map(p => [p.type, p.value]));
    return v.year + '-' + v.month + '-' + v.day;
  }
  S.gardenDate = clinicToday(); S.gardenMonth = S.gardenDate.slice(0,7);
  S.members = []; S.entries = {}; S.bookings = []; S.patientId = null;

  function active() { return !!state.token && Date.now() < state.expiresAt; }
  function isDoctor() { return active() && state.account && state.account.role === 'doctor'; }
  function selected() { return state.children.find(c => c.id === state.selected) || null; }
  function monthKey() { return String(state.selected) + '|' + S.gardenMonth; }
  function draftKey() { return String(state.selected) + '|' + S.gardenDate; }
  function expiresMillis(value) {
    if (typeof value === 'number') return value < 1e12 ? value * 1000 : value;
    return Date.parse(value);
  }
  function errorMessage(error, fallback) {
    if (error && error.name === 'StaleResponse') return '';
    return error && error.userMessage || fallback;
  }
  function stale() { const error = new Error('Stale response'); error.name = 'StaleResponse'; return error; }
  async function api(action, options) {
    const generation = state.generation;
    if (!active()) { endSession('Выберите кабинет, чтобы продолжить демонстрацию.'); throw stale(); }
    try {
      const result = await Demo.request(action, Object.assign({},options || {},{token:state.token}));
      if (generation !== state.generation) throw stale();
      return result;
    } catch (error) {
      if (generation !== state.generation) throw stale();
      if (error.status === 401) {endSession('Выберите кабинет, чтобы продолжить демонстрацию.');throw stale();}
      throw error;
    }
  }
  function cleanPrivateState() {
    state.generation++;
    if (doctorView) {doctorView.destroy();doctorView = null;}
    state.token = null; state.expiresAt = 0; state.account = null;
    state.children = []; state.selected = null; state.months.clear(); state.drafts.clear();
    state.saving = false; state.meBusy = false; state.childError = ''; state.busy = false;
    S.members = []; S.entries = {}; S.bookings = []; S.patientId = null; S.booking.patientId = null;
    S.noteDraft = ''; S.confirmModal = null;
    closeModal(); toastNode.textContent = ''; toastNode.classList.remove('active');
  }
  function endSession(message) {
    const token = state.token;
    cleanPrivateState();
    state.authError = ''; state.authNotice = message || '';
    S.page = 'auth';
    try {history.replaceState({}, '', '#auth');} catch (_) {}
    if (token && Demo) Demo.request('logout',{method:'POST',token:token}).catch(function () {});
    render();
  }
  function useChildren(children) {
    state.children = Array.isArray(children) ? children.filter(c => c && typeof c.id === 'string' && typeof c.name === 'string') : [];
    if (!state.children.some(c => c.id === state.selected)) state.selected = state.children[0] && state.children[0].id || null;
    S.members = state.children.map(c => ({id:c.id, name:c.name, role:'Ребёнок', icon:'baby'}));
    S.patientId = state.selected; S.booking.patientId = state.selected;
  }
  function pickChild(id) {
    if (!active() || isDoctor() || !state.children.some(c => c.id === id)) return;
    state.selected = id;
    const child = selected();
    if (child && child.birthDate && S.gardenDate < child.birthDate) {S.gardenDate = clinicToday();S.gardenMonth = S.gardenDate.slice(0,7);}
    S.patientId = id; S.booking.patientId = id; S.entries = {};
    render({keepScroll:true});
  }
  function status(text, kind) {
    return text ? '<div class="pc-status ' + (kind || '') + '" role="' + (kind === 'error' ? 'alert' : 'status') + '">' + esc(text) + '</div>' : '';
  }
  function storageWarning() { return Demo && Demo.status().warning || ''; }
  function demoNotice() {
    return '<aside class="pc-demo-notice"><strong>Демоверсия · данные на этом устройстве</strong><span>' +
      esc(storageWarning() || 'Для проверки используйте вымышленные данные. Доступ к демосемьям есть у любого, кто откроет этот браузер.') + '</span></aside>';
  }
  function loading(text) { return '<div class="pc-loading" role="status">' + esc(text) + '</div>'; }
  function publicAccess() { return '<button type="button" class="pc-guest" data-pc="guest">Врачи и запись без входа</button>'; }

  function renderAuth() {
    const families = Demo ? Demo.listFamilies() : [];
    return '<section class="pc-auth" data-pc-view="auth">' +
      '<div class="pc-auth-intro"><div><span class="eyebrow">Ваш Доктор · Демоверсия</span>' +
      '<h1>Забота о детях<br>начинается с семьи</h1><p>Кабинет родителя и отдельный сад здоровья для каждого ребёнка.</p></div>' +
      '<img src="' + asset('family-hero.webp') + '" alt=""></div>' +
      '<section class="plain-card pc-auth-form"><span class="pc-demo-label">Кабинет родителя</span><h2>Выберите демосемью</h2>' +
      '<p class="pc-help">Родитель добавляет детей и ведёт их дневники. Отдельная регистрация ребёнку не нужна.</p>' +
      families.map(f => '<button type="button" class="btn btn-green btn-wide pc-family-enter" data-pc="demo-enter" data-family-id="' + esc(f.id) + '">' + icon('users','ic-sm') + 'Открыть: ' + esc(f.name) + '</button>').join('') +
      '<details class="pc-new-family"><summary>Создать свою демосемью</summary><form id="pc-demo-family-form">' +
      '<label class="pc-label" for="pc-demo-family-name">Название семьи</label><input class="pc-input" id="pc-demo-family-name" name="name" type="text" maxlength="60" autocomplete="off" placeholder="Например, Семья Андрея" required>' +
      '<button class="btn btn-white btn-wide" type="submit">Создать демосемью</button></form></details>' +
      status(state.authError,'error') + status(state.authNotice) + '</section>' +
      '<section class="plain-card pc-doctor-entry"><div><span class="pc-demo-label">Кабинет врача</span><h2>Динамика сада здоровья</h2><p>Посмотрите отметки детей по дням и месяцам и задайте индивидуальные рекомендации.</p></div>' +
      '<button type="button" class="btn btn-tint btn-wide" data-pc="demo-doctor">Открыть демокабинет врача ' + icon('arrow','ic-sm') + '</button></section>' +
      demoNotice() + (Demo ? '' : status('Модуль демоверсии не загрузился. Откройте приложение с интернетом ещё раз.','error')) + publicAccess() + '</section>';
  }
  function enterDemo(familyId, doctor) {
    if (state.busy || !Demo) return;
    try {
      const result = doctor ? Demo.enterDoctor() : Demo.enter(familyId);
      cleanPrivateState();
      state.token = result.token; state.expiresAt = expiresMillis(result.expiresAt); state.account = result.account;
      useChildren(result.children);
      state.authError = ''; state.authNotice = '';
      go(doctor ? 'doctor-cabinet' : 'family');
    } catch (error) {
      state.authError = errorMessage(error,'Не удалось открыть демоверсию.');
      render({keepScroll:true});
    }
  }
  function createDemoFamily(form) {
    if (!Demo) return;
    const input = form.querySelector('#pc-demo-family-name');
    try {const family = Demo.createFamily(String(input.value || '').trim());enterDemo(family.id,false);}
    catch (error) {state.authError = errorMessage(error,'Не удалось создать демосемью.');render({keepScroll:true});}
  }
  function childPicker() {
    if (state.children.length < 2) return '';
    return '<div class="pc-picker" aria-label="Выбрать ребёнка">' + state.children.map(c =>
      '<button type="button" data-pc-child="' + esc(c.id) + '" aria-pressed="' + (c.id === state.selected) + '">' + esc(c.name) + '</button>').join('') + '</div>';
  }
  function emptyChildren(title) {
    return '<h1 class="page-title">' + esc(title) + '</h1><div class="plain-card pc-empty"><img src="' + asset('n-g-sprout.webp') + '" alt="">' +
      '<h2>Начните с профиля ребёнка</h2><p>Родитель добавляет ребёнка в свою семью. У каждого ребёнка будет отдельный сад здоровья и история отметок.</p>' +
      '<button class="btn btn-green" data-nav="add-child">Добавить ребёнка ' + icon('plus','ic-sm') + '</button></div>';
  }
  function birthLabel(date) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '')) return '';
    return date.split('-').reverse().join('.');
  }
  function familyPage() {
    return '<h1 class="page-title">Кабинет родителя</h1><p class="page-subtitle">Каждому ребёнку — свой сад здоровья.</p>' + demoNotice() +
      '<div class="pc-account pc-row pc-between"><div><small>Ваша демосемья</small><strong>' + esc(state.account && state.account.displayName || 'Демосемья') +
      '</strong></div><button class="circle-btn" type="button" data-nav="profile" aria-label="Настройки кабинета">' + icon('user') + '</button></div>' +
      rbanner('fam') +
      '<div class="pc-section-title"><h2>Мои дети</h2><button class="linkmore" type="button" data-nav="add-child">Добавить ' + icon('plus','ic-sm') + '</button></div>' +
      (state.children.length ? state.children.map(c =>
        '<section class="pc-kid ' + (c.id === state.selected ? 'selected' : '') + '">' +
        '<button class="pc-kid-main" type="button" data-pc-child="' + esc(c.id) + '" aria-pressed="' + (c.id === state.selected) + '">' +
        '<span class="pc-kid-avatar">' + icon('baby') + '</span><span><strong>' + esc(c.name) + '</strong><small>' +
        esc(c.birthDate ? birthLabel(c.birthDate) + ' · ' : '') + esc(RELATIONS[c.relationship] || 'Родитель') + '</small></span></button>' +
        '<span class="pc-pill">Личный сад ребёнка · под контролем родителя</span>' +
        '<div class="pc-row"><button class="btn btn-green" type="button" data-pc="child-garden" data-child-id="' + esc(c.id) + '">' + icon('sprout','ic-sm') + 'Сад здоровья</button></div></section>'
      ).join('') : emptyChildren('Мои дети')) +
      '<div class="pc-link-panel"><button data-nav="booking">' + icon('calendar') + 'Записаться к врачу</button><button data-nav="chat">' + icon('message') + 'Связаться с клиникой</button></div>' +
      '<button class="btn btn-white btn-wide" data-nav="profile">Настройки и смена кабинета</button>';
  }
  function addChildPage() {
    return '<h1 class="page-title">Добавить ребёнка</h1><p class="page-subtitle">Профиль под вашим контролем, без отдельного входа</p>' +
      '<form class="plain-card" id="pc-child-form"><label class="pc-label" for="pc-child-name">Имя ребёнка</label>' +
      '<input class="pc-input" id="pc-child-name" name="name" type="text" maxlength="100" autocomplete="off" required>' +
      '<label class="pc-label" for="pc-child-birth">Дата рождения (необязательно)</label><input class="pc-input" id="pc-child-birth" name="birthDate" type="date" min="1900-01-01" max="' + clinicToday() + '">' +
      '<label class="pc-label" for="pc-child-relation">Кем вы приходитесь ребёнку</label><select class="pc-input" id="pc-child-relation" name="relationship" required>' +
      Object.entries(RELATIONS).map(([value,label]) => '<option value="' + value + '">' + label + '</option>').join('') + '</select>' +
      '<p class="pc-help">Для демоверсии достаточно вымышленного имени. Профиль и отдельный сад появятся сразу; медицинские документы не подключены.</p>' +
      status(state.childError, 'error') + '<div class="pc-form-actions"><button class="btn btn-white" type="button" data-nav="family">Назад</button><button class="btn btn-green" type="submit"' + (state.saving ? ' disabled' : '') + '>' + (state.saving ? 'Сохраняем…' : 'Добавить ребёнка') + '</button></div></form>';
  }
  async function addChild(form) {
    if (state.saving || !active()) return;
    const generation = state.generation;
    const fields = new FormData(form);
    const body = {name:String(fields.get('name') || '').trim(), birthDate:String(fields.get('birthDate') || ''), relationship:String(fields.get('relationship') || '')};
    const button = form.querySelector('[type=submit]');
    state.saving = true; state.childError = ''; button.disabled = true; button.textContent = 'Сохраняем…';
    try {
      const result = await api('children', {method:'POST', body:body});
      if (generation !== state.generation) return;
      if (!result.child || typeof result.child.id !== 'string') throw new Error('Invalid child');
      state.selected = result.child.id;
      useChildren(state.children.concat([result.child]));
      go('family');
      snack('Профиль ребёнка создан');
    } catch (error) {
      if (generation !== state.generation) return;
      state.childError = errorMessage(error, 'Не удалось сохранить демопрофиль. Проверьте введённые данные.');
      if (S.page === 'add-child') {
        let message = form.querySelector('[role=alert]');
        if (!message) { message = document.createElement('div'); message.className = 'pc-status error'; message.setAttribute('role','alert'); form.appendChild(message); }
        message.textContent = state.childError;
      }
    } finally { if (generation === state.generation) {state.saving = false; if (button.isConnected) {button.disabled = false; button.textContent = 'Добавить ребёнка';}} }
  }
  async function refreshMe() {
    if (state.meBusy) return;
    const generation = state.generation;
    state.meBusy = true;
    try {
      const result = await api('me');
      if (generation !== state.generation) return;
      state.account = result.account; useChildren(result.children);
      state.months.clear();
      if (S.page === 'family' || S.page === 'profile') render({keepScroll:true});
      snack('Сведения обновлены');
    } catch (error) { if (generation !== state.generation) return; const message = errorMessage(error, 'Не удалось обновить сведения.'); if (message) snack(message); }
    finally { if (generation === state.generation) {state.meBusy = false; if (S.page === 'family') render({keepScroll:true});} }
  }
  async function loadMonth(key, childId, month) {
    if (state.months.has(key)) return;
    const generation = state.generation;
    state.months.set(key,{status:'loading'});
    try {
      const result = await api('garden', {params:{childId:childId, month:month}});
      if (generation !== state.generation) return;
      state.months.set(key,{status:'ready', garden:result.garden || {entries:{}}});
    } catch (error) {
      if (error.name === 'StaleResponse' || !active()) return;
      state.months.set(key,{status:'error', message:errorMessage(error, 'Не удалось загрузить дневник. Попробуйте ещё раз.')});
    }
    if (active() && monthKey() === key && ['garden','garden-day'].includes(S.page)) render({keepScroll:true});
  }
  function monthState() {
    const key = monthKey();
    if (!state.months.has(key)) loadMonth(key, state.selected, S.gardenMonth);
    return state.months.get(key);
  }
  function monthUnavailable(data, title) {
    return '<h1 class="page-title">' + title + '</h1>' + childPicker() +
      (data.status === 'loading' ? loading('Загружаем личный дневник…') : status(data.message,'error') +
        '<button class="btn btn-white btn-wide" type="button" data-pc="retry-month">Повторить загрузку</button>');
  }
  function recommendationsCard(garden) {
    const recommendations = garden && garden.recommendations || {};
    const items = HABITS.filter(h => recommendations[h[0]]).map(([id,title]) => '<div class="pc-plan-item"><strong>' + title + '</strong><p>' + esc(recommendations[id]) + '</p></div>').join('');
    return '<details class="plain-card pc-plan"' + (items ? ' open' : '') + '><summary>Индивидуальные рекомендации</summary>' +
      (items || '<p class="pc-help">План пока не заполнен. В демонстрации его можно задать в кабинете врача для этого ребёнка.</p>') + '</details>';
  }
  function gardenPage() {
    if (!selected()) return emptyChildren('Мой сад здоровья');
    const data = monthState();
    if (!data || data.status !== 'ready') return monthUnavailable(data || {status:'loading'}, 'Мой сад здоровья');
    S.entries = {[state.selected]:data.garden.entries || {}};
    return demoNotice() + childPicker() + renderGarden() + recommendationsCard(data.garden) +
      '<p class="pc-help">Процент рассчитан по заполненным отметкам: выполнено — 100%, частично — 50%, не выполнено — 0%. Пустые дни и пункты показаны отдельно и не входят в процент. Это дневник выполнения рекомендаций, а не оценка здоровья.</p>';
  }
  function currentDraft() {
    const key = draftKey();
    if (!state.drafts.has(key)) {
      const month = state.months.get(monthKey());
      const entry = month && month.garden && month.garden.entries && month.garden.entries[S.gardenDate] || {};
      state.drafts.set(key,Object.assign({},entry,{_dirty:new Set(),_noteDirty:false}));
    }
    return state.drafts.get(key);
  }
  function gardenDayPage() {
    const child = selected();
    if (!child) return emptyChildren('Дневник ребёнка');
    const data = monthState();
    if (!data || data.status !== 'ready') return monthUnavailable(data || {status:'loading'}, 'Дневник ребёнка');
    const draft = currentDraft();
    return '<h1 class="page-title">Дневник ребёнка</h1><p class="page-subtitle">' + esc(child.name) + ' · ' + esc(birthLabel(S.gardenDate)) + '</p>' + demoNotice() + childPicker() +
      '<form id="pc-day-form"><label class="pc-label" for="pc-day-date">День дневника</label><input class="pc-diary-date" id="pc-day-date" type="date" value="' + S.gardenDate + '" min="' + esc(child.birthDate || '1900-01-01') + '" max="' + clinicToday() + '" required>' +
      '<p class="pc-help">Отмечайте привычки по индивидуальному плану ребёнка. Повторное нажатие снимает отметку.</p>' +
      HABITS.map(([id,title,img]) =>
        '<section class="pc-diary-row"><div class="pc-diary-name"><img src="' + asset(img) + '" alt="">' + title + '</div>' + (data.garden.recommendations && data.garden.recommendations[id] ? '<p class="pc-diary-recommendation">' + esc(data.garden.recommendations[id]) + '</p>' : '') + '<div class="pc-marks" role="group" aria-label="' + title + '">' +
        MARKS.map(([value,label]) => '<button type="button" data-pc-mark="' + id + '" data-pc-value="' + value + '" aria-pressed="' + (draft[id] === value) + '">' + label + '</button>').join('') + '</div></section>'
      ).join('') +
      '<label class="pc-label" for="pc-day-note">Заметка за день</label><textarea class="pc-input" id="pc-day-note" rows="3" maxlength="1200" placeholder="Что хочется отметить">' + esc(draft.note || '') + '</textarea>' +
      '<div id="pc-day-status" role="status">' + status(draft._error || '', 'error') + '</div>' +
      '<div class="pc-save-bar"><button class="btn btn-green" type="submit"' + (state.saving ? ' disabled' : '') + '>' + (state.saving ? 'Сохраняем дневник…' : 'Сохранить день') + '</button></div></form>';
  }
  async function saveDayPrivate(form) {
    if (state.saving || !active() || !selected()) return;
    const generation = state.generation;
    const childId = state.selected, date = S.gardenDate, key = draftKey(), mk = monthKey();
    const draft = currentDraft(), entry = {};
    for (const id of draft._dirty) entry[id] = ['done','partial','missed'].includes(draft[id]) ? draft[id] : null;
    if (draft._noteDirty) entry.note = String(draft.note || '').slice(0,1200);
    if (!Object.keys(entry).length) {snack('Новых изменений нет');return;}
    const button = form.querySelector('[type=submit]');
    state.saving = true; draft._error = ''; button.disabled = true; button.textContent = 'Сохраняем дневник…';
    form.querySelectorAll('input,textarea,button').forEach(control => {control.disabled = true;});
    try {
      const result = await api('garden', {method:'PUT', params:{childId:childId}, body:{date:date, entry:entry}});
      if (generation !== state.generation) return;
      if (!result.garden || !result.garden.entries) throw new Error('Missing saved data');
      state.months.set(mk,{status:'ready', garden:result.garden});
      state.drafts.delete(key);
      if (state.selected === childId && S.gardenDate === date && S.page === 'garden-day') go('garden');
      snack(Demo.isPersistent() ? 'Дневник сохранён на этом устройстве' : 'Дневник сохранён только до закрытия страницы');
    } catch (error) {
      if (generation !== state.generation) return;
      const message = errorMessage(error, 'День не сохранён. Проверьте отметки и повторите.');
      if (active()) {
        draft._error = message;
        const region = document.getElementById('pc-day-status');
        if (region) {region.textContent = message; region.className = 'pc-status error'; region.setAttribute('role','alert');}
      }
    } finally { if (generation === state.generation) {state.saving = false; if (button.isConnected) {form.querySelectorAll('input,textarea,button').forEach(control => {control.disabled = false;}); button.textContent = 'Сохранить день';}} }
  }
  function documentsPage() {
    return '<h1 class="page-title">Медицинские документы</h1><section class="plain-card pc-empty">' + icon('file') +
      '<h2>Подключим позже</h2><p>Медицинские документы в демоверсии не подключены. Здесь нет результатов анализов, заключений или связи с медицинской системой.</p>' +
      '<button class="btn btn-green" data-nav="family">В кабинет родителя</button></section>';
  }
  function profilePage() {
    return '<h1 class="page-title">Мой кабинет</h1><p class="page-subtitle">Демокабинет родителя</p>' + demoNotice() +
      '<section class="plain-card"><h3>' + esc(state.account && state.account.displayName || 'Демосемья') + '</h3>' +
      '<p class="pc-help">' + esc(storageWarning() || 'Дети, дневники и рекомендации сохраняются в этом браузере. Очистка данных браузера удалит демоданные. На других устройствах они не появятся.') + '</p>' +
      '<p class="pc-help">Для просмотра динамики выйдите и откройте демокабинет врача на стартовом экране. Он увидит детей из всех демосемей в этом браузере.</p></section>' +
      '<div class="pc-link-panel"><button data-nav="family">' + icon('users') + 'Мои дети</button><button data-nav="documents">' + icon('file') + 'Документы · позже</button></div>' +
      '<section class="plain-card pc-future"><h3>Уведомления</h3><p class="pc-help">Пуш-напоминания подключим на следующем этапе вместе с сервером. В этой демоверсии уведомления не отправляются.</p></section>' +
      '<button class="btn btn-white btn-wide" type="button" data-pc="logout">Выйти и сменить кабинет</button>' +
      '<a class="btn btn-green btn-wide" style="margin-top:12px;text-decoration:none" href="' + PHONE + '">Позвонить в клинику</a>';
  }
  function bookingsPage() {
    return '<h1 class="page-title">Мои записи</h1><div class="plain-card pc-empty">' + icon('calendar') +
      '<h2>Запись через расписание клиники</h2><p>История ваших посещений пока не подключена к кабинету. Выберите время в действующей системе онлайн-записи.</p><button class="btn btn-green" data-nav="booking">Записаться к врачу</button></div>';
  }

  PAGES.auth = renderAuth; PAGES.welcome = renderAuth;
  PAGES.family = familyPage; PAGES.profile = profilePage; PAGES['add-child'] = addChildPage;
  PAGES.garden = gardenPage; PAGES['garden-day'] = gardenDayPage;
  PAGES.documents = documentsPage; PAGES.bookings = bookingsPage;
  PAGES['doctor-cabinet'] = function () {return '<div id="vd-doctor-host"></div>';};
  const originalRender = render;
  render = function (options) {
    if (state.token && !active()) {endSession('Выберите кабинет, чтобы продолжить демонстрацию.');return;}
    const requestedPage = S.page;
    if (S.page === 'welcome') S.page = 'auth';
    if (PRIVATE.has(S.page) && !active()) S.page = 'auth';
    if (active() && (S.page === 'auth' || PRIVATE.has(S.page) && isDoctor() && S.page !== 'doctor-cabinet')) S.page = isDoctor() ? 'doctor-cabinet' : 'family';
    if (S.page === 'doctor-cabinet' && !isDoctor()) S.page = active() ? 'family' : 'auth';
    if (S.page !== requestedPage) {try {history.replaceState({},'', '#'+S.page);} catch (_) {}}
    // A same-page shell refresh must not discard the physician's in-progress plan.
    if (S.page === 'doctor-cabinet' && doctorView && document.getElementById('vd-doctor-host')?.isConnected) return;
    if (doctorView) {doctorView.destroy();doctorView = null;}
    originalRender(options || {});
    app.classList.toggle('pc-auth-mode', S.page === 'auth' || S.page === 'doctor-cabinet');
    if (isDoctor() && S.page !== 'doctor-cabinet') {
      const shortcut = document.createElement('button'); shortcut.className = 'pc-doctor-return'; shortcut.dataset.nav = 'doctor-cabinet';
      shortcut.textContent = 'Вернуться в кабинет врача'; el.prepend(shortcut);
    }
    if (S.page === 'doctor-cabinet') {
      const host = document.getElementById('vd-doctor-host');
      if (window.VDDoctor) doctorView = window.VDDoctor.mount(host,{api:api,onExit:function () {endSession('Выберите кабинет для демонстрации.');},onError:function (error) {const message = errorMessage(error,'Не удалось открыть динамику.');if (message) snack(message);},storageWarning:storageWarning});
      else host.innerHTML = status('Модуль кабинета врача не загрузился. Откройте приложение с интернетом ещё раз.','error') + '<button class="btn btn-white btn-wide" data-pc="logout">На стартовый экран</button>';
    }
    const child = selected();
    if (S.page === 'garden') {
      for (const day of el.querySelectorAll('[data-garden-date]')) {
        const unavailable = day.dataset.gardenDate > clinicToday() || child && child.birthDate && day.dataset.gardenDate < child.birthDate;
        day.disabled = !!unavailable; day.classList.toggle('pc-date-future',!!unavailable);
      }
      for (const button of el.querySelectorAll('[data-month]')) {
        const [y,m] = S.gardenMonth.split('-').map(Number);
        const next = dateISO(new Date(y,m-1+Number(button.dataset.month),1,12)).slice(0,7);
        button.disabled = next > clinicToday().slice(0,7) || !!(child && child.birthDate && next < child.birthDate.slice(0,7));
      }
    }
  };
  window.VDCabinetReady = true;
  window.VDCabinet = Object.freeze({isActive:active});

  document.addEventListener('input', function (event) {
    if (event.target.id === 'pc-day-note' && active() && !isDoctor()) {const draft = currentDraft();draft.note = event.target.value.slice(0,1200);draft._noteDirty = true;}
  });
  document.addEventListener('submit', function (event) {
    const id = event.target.id;
    if (!['pc-demo-family-form','pc-child-form','pc-day-form'].includes(id)) return;
    event.preventDefault(); event.stopImmediatePropagation();
    if (id === 'pc-demo-family-form') createDemoFamily(event.target);
    if (id === 'pc-child-form' && !isDoctor()) addChild(event.target);
    if (id === 'pc-day-form' && !isDoctor()) saveDayPrivate(event.target);
  },true);
  document.addEventListener('change', function (event) {
    if (event.target.id !== 'pc-day-date' || !active() || isDoctor()) return;
    const date = event.target.value, child = selected();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || date > clinicToday() || child && child.birthDate && date < child.birthDate) return;
    S.gardenDate = date; S.gardenMonth = date.slice(0,7); render({keepScroll:true});
  });
  document.addEventListener('click', function (event) {
    const button = event.target.closest('button');
    if (!button || button.disabled) return;
    const d = button.dataset;
    const legacyGarden = ['open-today','stickers','save-day','login','add-member'].includes(d.action) || d.month != null || d.gardenDate != null || d.cycleMember != null;
    if (!d.pc && d.pcChild == null && d.pcMark == null && !legacyGarden) return;
    event.preventDefault(); event.stopImmediatePropagation();
    if (d.pc === 'guest') {state.authError = '';state.authNotice = '';go('home');return;}
    if (d.pc === 'demo-enter') {enterDemo(d.familyId,false);return;}
    if (d.pc === 'demo-doctor') {enterDemo(null,true);return;}
    if (d.action === 'login') {go('auth');return;}
    if (!active()) {go('auth');return;}
    if (d.pc === 'logout') {endSession('Выберите кабинет для демонстрации.');return;}
    if (isDoctor()) {go('doctor-cabinet');return;}
    if (d.pc === 'refresh-me') {refreshMe();return;}
    if (d.pcChild != null) {pickChild(d.pcChild);return;}
    if (d.pc === 'child-garden') {pickChild(d.childId);go('garden');return;}
    if (d.action === 'add-member') {go('add-child');return;}
    if (d.pc === 'retry-month') {state.months.delete(monthKey());render({keepScroll:true});return;}
    if (d.pcMark != null && HABITS.some(h => h[0] === d.pcMark)) {
      const draft = currentDraft();
      draft[d.pcMark] = draft[d.pcMark] === d.pcValue ? null : d.pcValue;
      draft._dirty.add(d.pcMark); render({keepScroll:true});return;
    }
    if (d.month != null) {
      const [year,month] = S.gardenMonth.split('-').map(Number);
      const date = new Date(year,month-1+Number(d.month),1,12), next = dateISO(date).slice(0,7);
      if (next > clinicToday().slice(0,7) || selected() && selected().birthDate && next < selected().birthDate.slice(0,7)) return;
      S.gardenMonth = next; S.gardenDate = next+'-01';render({keepScroll:true});return;
    }
    if (d.cycleMember != null) {
      const index = state.children.findIndex(c => c.id === state.selected), child = state.children[(index+1)%state.children.length];
      if (child) pickChild(child.id);return;
    }
    if (d.action === 'open-today') {S.gardenDate = clinicToday();S.gardenMonth = S.gardenDate.slice(0,7);go('garden-day');return;}
    if (d.gardenDate != null) {
      if (d.gardenDate > clinicToday() || selected() && selected().birthDate && d.gardenDate < selected().birthDate) return;
      S.gardenDate = d.gardenDate;S.gardenMonth = d.gardenDate.slice(0,7);go('garden-day');return;
    }
    if (d.action === 'stickers') {modal('Наградные стикеры','<p>Стикер появляется, когда в этом месяце вы хотя бы раз отмечаете выполнение соответствующей привычки. Он поддерживает ведение дневника и не оценивает состояние здоровья.</p>');return;}
  },true);

  window.addEventListener('pagehide', function () {if (state.token) endSession('Выберите кабинет для демонстрации.');});
  S.page = 'auth'; render();
})();
