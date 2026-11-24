/*
 * «Ваш Доктор» — local demonstration data adapter, version 1.
 * No backend, SMS, OTP, medical documents, analytics or network calls.
 * Email login and the family selector are demo conveniences, NOT secure authentication.
 * Use fictional information only: localStorage is readable on this device.
 */
(function (global) {
  'use strict';
  if (global.VDDemo) return;

  const STORAGE_KEY = 'vd_cabinet_demo_v1';
  const VERSION = 1;
  const MAX_FAMILIES = 8;
  const MAX_CHILDREN = 12;
  const MAX_DAYS = 800;
  const MAX_CHARS = 750000;
  const FAMILY_NAME_MAX = 60;
  const PARENT_NAME_MAX = 150;
  const CHILD_NAME_MAX = 100;
  const NOTE_MAX = 1200;
  const RECOMMENDATION_MAX = 1200;
  const DEMO_DOCTOR_ID = 'doctor_demo';
  const DEMO_DOCTOR_NAME = 'Врач (демо)';
  const MARKS = ['meal', 'water', 'activity', 'sleep', 'screen', 'mood'];
  const RELATIONS = ['parent', 'mother', 'father', 'grandmother', 'grandfather', 'guardian'];
  const SESSION_MS = 24 * 60 * 60 * 1000;
  const sessions = new Map();
  const owns = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
  let state;
  let persistent = true;
  let warning = '';
  let sequence = 0;

  function error(code, message, status) {
    const result = new Error(message);
    result.code = code;
    result.userMessage = message;
    result.status = status || 422;
    return result;
  }

  function object(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
  }

  function copy(value) { return JSON.parse(JSON.stringify(value)); }
  function nowISO() { return new Date().toISOString(); }

  function today() {
    try {
      const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Europe/Moscow', year: 'numeric', month: '2-digit', day: '2-digit'
      }).formatToParts(new Date());
      const part = type => parts.find(value => value.type === type).value;
      return part('year') + '-' + part('month') + '-' + part('day');
    } catch (_) {
      return new Date(Date.now() + 3 * 60 * 60 * 1000).toISOString().slice(0, 10);
    }
  }

  function validId(value) { return typeof value === 'string' && /^[a-zA-Z0-9_-]{1,64}$/.test(value); }

  function randomId(prefix) {
    let suffix;
    try {
      const bytes = new Uint8Array(16);
      global.crypto.getRandomValues(bytes);
      suffix = Array.from(bytes, value => value.toString(16).padStart(2, '0')).join('');
    } catch (_) {
      // Only a local demo identifier. This fallback is deliberately not used as real authentication.
      suffix = Date.now().toString(36) + (++sequence).toString(36) + Math.random().toString(36).slice(2);
    }
    return prefix + '_' + suffix;
  }

  function text(value, max, empty, multiline) {
    if (typeof value !== 'string') throw error('INVALID_FIELD', 'Проверьте введённые данные.');
    const control = multiline ? /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/ : /[\u0000-\u001f\u007f]/;
    const result = value.trim();
    if (control.test(value) || (!empty && !result) || Array.from(result).length > max) {
      throw error('INVALID_FIELD', 'Проверьте длину и содержание введённых данных.');
    }
    return result;
  }

  function parentEmail(value) {
    if (typeof value !== 'string' || value.length > 254 || /[\u0000-\u001f\u007f<>]/.test(value)) {
      throw error('INVALID_EMAIL', 'Укажите адрес электронной почты для демовхода.');
    }
    const result = value.trim().toLowerCase();
    const parts = result.split('@');
    const local = parts[0], domain = parts[1];
    if (parts.length !== 2 || !local || local.length > 64 || !/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+$/.test(local) ||
        local.startsWith('.') || local.endsWith('.') || local.includes('..') || !domain ||
        domain.split('.').length < 2 || domain.split('.').some(label => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) {
      throw error('INVALID_EMAIL', 'Укажите адрес электронной почты для демовхода.');
    }
    return result;
  }

  function parentProfile(value) {
    if (!object(value)) throw error('INVALID_FIELD', 'Заполните данные демокабинета родителя.');
    let fullName;
    try { fullName = text(value.fullName, PARENT_NAME_MAX, false, false); }
    catch (_) { throw error('INVALID_NAME', 'Укажите ФИО родителя — до ' + PARENT_NAME_MAX + ' символов.'); }
    const email = parentEmail(value.email);
    if (typeof value.phone !== 'string' || value.phone.length > 32 || /[^0-9+() \t-]/.test(value.phone)) {
      throw error('INVALID_PHONE', 'Укажите российский мобильный номер +7 9XX XXX-XX-XX.');
    }
    let phone = value.phone.replace(/\D/g, '');
    if (phone.length === 11 && phone.startsWith('8')) phone = '7' + phone.slice(1);
    if (!/^79\d{9}$/.test(phone)) throw error('INVALID_PHONE', 'Укажите российский мобильный номер +7 9XX XXX-XX-XX.');
    return {fullName: fullName, email: email, phone: phone};
  }

  function familyName(family) { return family.parent ? family.parent.fullName : family.name; }

  function date(value) {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || value < '1900-01-01' || value > today()) {
      throw error('INVALID_DATE', 'Укажите существующую дату не позже сегодняшнего дня.');
    }
    const [year, month, day] = value.split('-').map(Number);
    const parsed = new Date(Date.UTC(year, month - 1, day));
    if (parsed.toISOString().slice(0, 10) !== value) throw error('INVALID_DATE', 'Укажите существующую дату.');
    return value;
  }

  function month(value) {
    if (value === undefined || value === null || value === '') return today().slice(0, 7);
    if (typeof value !== 'string' || !/^(19|20|21)\d{2}-(0[1-9]|1[0-2])$/.test(value)) {
      throw error('INVALID_MONTH', 'Выберите месяц календаря.');
    }
    return value;
  }

  function optionalBirthDate(value) {
    return value === undefined || value === null || value === '' ? '' : date(value);
  }

  function relationship(value) {
    if (value === undefined || value === null || value === '') return 'parent';
    if (!RELATIONS.includes(value)) throw error('INVALID_RELATIONSHIP', 'Выберите вашу связь с ребёнком.');
    return value;
  }

  function entry(value, allowDeletion) {
    if (!object(value)) throw error('INVALID_ENTRY', 'Проверьте отметки дневника.');
    const clean = {};
    for (const key of Object.keys(value)) {
      if (key === 'note') {
        const note = text(value[key], NOTE_MAX, true, true);
        if (note || allowDeletion) clean.note = note;
      } else if (MARKS.includes(key)) {
        if (allowDeletion && value[key] === null) clean[key] = null;
        else if (['done', 'partial', 'missed'].includes(value[key])) clean[key] = value[key];
        else throw error('INVALID_ENTRY', 'Проверьте отметки дневника.');
      } else {
        throw error('INVALID_ENTRY', 'Неизвестное поле дневника.');
      }
    }
    return clean;
  }

  function timestamp(value) {
    if (value === null || value === undefined) return null;
    if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) throw error('INVALID_STORAGE', 'Не удалось прочитать демоданные.');
    return value;
  }

  function recommendations(value) {
    if (!object(value)) throw error('INVALID_RECOMMENDATION', 'Проверьте индивидуальные рекомендации.');
    const result = {};
    for (const key of Object.keys(value)) {
      if (!MARKS.includes(key)) throw error('INVALID_RECOMMENDATION', 'Неизвестный раздел рекомендаций.');
      const content = text(value[key], RECOMMENDATION_MAX, true, true);
      if (content) result[key] = content;
    }
    return result;
  }

  function recommendationsView(child) {
    const result = {};
    for (const key of MARKS) result[key] = (child.recommendations && child.recommendations[key]) || '';
    return result;
  }

  function doctorIds(value, familyId, childId) {
    if (value === undefined) {
      // Preserve the original two demo patients when upgrading v1 storage.
      // Other existing and all newly created profiles start without a doctor.
      return familyId === 'family_demo' && ['child_misha_demo', 'child_anya_demo'].includes(childId) ? [DEMO_DOCTOR_ID] : [];
    }
    if (!Array.isArray(value) || value.length > 16 || value.some(id => !validId(id)) || new Set(value).size !== value.length) {
      throw error('INVALID_STORAGE', 'Не удалось прочитать прикрепление к врачу.');
    }
    return value.slice();
  }

  function validate(saved) {
    if (!object(saved) || saved.version !== VERSION || !Array.isArray(saved.families) || saved.families.length < 1 || saved.families.length > MAX_FAMILIES) {
      throw error('INVALID_STORAGE', 'Не удалось прочитать сохранённые демоданные.');
    }
    const ids = new Set();
    const emails = new Set();
    const uniqueId = id => {
      if (!validId(id) || ids.has(id)) throw error('INVALID_STORAGE', 'Не удалось прочитать сохранённые демоданные.');
      ids.add(id);
      return id;
    };
    const result = {version: VERSION, families: []};
    for (const family of saved.families) {
      if (!object(family) || !Array.isArray(family.children) || family.children.length > MAX_CHILDREN) throw error('INVALID_STORAGE', 'Не удалось прочитать демосемью.');
      const cleaned = {id: uniqueId(family.id), name: text(family.name, FAMILY_NAME_MAX, false, false), children: []};
      if (family.parent !== undefined) {
        cleaned.parent = parentProfile(family.parent);
        if (emails.has(cleaned.parent.email)) throw error('INVALID_STORAGE', 'Не удалось прочитать демокабинеты.');
        emails.add(cleaned.parent.email);
      }
      for (const child of family.children) {
        if (!object(child) || !object(child.garden) || !object(child.garden.entries) || Object.keys(child.garden.entries).length > MAX_DAYS) {
          throw error('INVALID_STORAGE', 'Не удалось прочитать демопрофиль ребёнка.');
        }
        const cleanChild = {id: uniqueId(child.id), name: text(child.name, CHILD_NAME_MAX, false, false), birthDate: optionalBirthDate(child.birthDate),
          relationship: relationship(child.relationship), garden: {entries: {}, updatedAt: timestamp(child.garden.updatedAt)},
          doctorIds: doctorIds(child.doctorIds, family.id, child.id),
          recommendations: child.recommendations === undefined ? {} : recommendations(child.recommendations),
          recommendationsUpdatedAt: timestamp(child.recommendationsUpdatedAt)};
        for (const day of Object.keys(child.garden.entries)) {
          const value = entry(child.garden.entries[day], false);
          if (Object.keys(value).length) cleanChild.garden.entries[date(day)] = value;
          else date(day);
        }
        cleaned.children.push(cleanChild);
      }
      result.families.push(cleaned);
    }
    return result;
  }

  function seed() {
    return {version: VERSION, families: [{id: 'family_demo', name: 'Демосемья', children: [
      {id: 'child_misha_demo', name: 'Миша (демо)', birthDate: '2020-06-15', relationship: 'mother', doctorIds: [DEMO_DOCTOR_ID], garden: {entries: {}, updatedAt: null}},
      {id: 'child_anya_demo', name: 'Аня (демо)', birthDate: '2023-02-09', relationship: 'mother', doctorIds: [DEMO_DOCTOR_ID], garden: {entries: {}, updatedAt: null}}
    ]}]};
  }

  function fallback(reason) {
    persistent = false;
    warning = reason || 'Браузер не разрешил сохранить демоданные. Изменения доступны только до закрытия этой страницы.';
  }

  function persist(next) {
    const serialized = JSON.stringify(next);
    if (serialized.length > MAX_CHARS) throw error('DEMO_CAPACITY', 'Достигнут предел объёма демоданных на этом устройстве.');
    if (persistent) {
      try { global.localStorage.setItem(STORAGE_KEY, serialized); }
      catch (_) { fallback(); }
    }
    state = next;
  }

  function initialize() {
    let raw;
    try { raw = global.localStorage.getItem(STORAGE_KEY); }
    catch (_) { fallback(); state = seed(); return; }
    if (raw === null) { persist(seed()); return; }
    try {
      if (raw.length > MAX_CHARS) throw new Error('Size limit');
      state = validate(JSON.parse(raw));
      // Confirm writes are available as well as reads. Existing valid information is preserved.
      persist(state);
    } catch (_) {
      fallback('Сохранённые демоданные не удалось прочитать. Открыта временная демосемья; прежняя запись в браузере не изменена.');
      state = seed();
    }
  }

  function refresh() {
    if (!persistent) return;
    try {
      const raw = global.localStorage.getItem(STORAGE_KEY);
      if (raw === null) {
        // Another tab or the user removed storage. Preserve this open session's data in memory.
        fallback('Хранилище браузера было очищено. Текущие демоданные доступны только до закрытия страницы.');
        return;
      }
      if (raw.length > MAX_CHARS) throw new Error('Size limit');
      state = validate(JSON.parse(raw));
    } catch (_) {
      fallback('Хранилище демоданных недоступно. Текущие изменения сохраняются только до закрытия страницы.');
    }
  }

  function familyById(id, source) {
    if (!validId(id)) throw error('FAMILY_NOT_FOUND', 'Выберите демосемью.', 404);
    const family = (source || state).families.find(value => value.id === id);
    if (!family) throw error('FAMILY_NOT_FOUND', 'Демосемья не найдена на этом устройстве.', 404);
    return family;
  }

  function sessionForToken(token) {
    const session = typeof token === 'string' ? sessions.get(token) : null;
    if (!session || Date.now() >= session.expiresAt) {
      if (session) sessions.delete(token);
      throw error('UNAUTHORIZED', 'Выберите демосемью, чтобы продолжить.', 401);
    }
    return session;
  }

  function familyForToken(token, source) {
    const session = sessionForToken(token);
    if (session.role !== 'parent') throw error('FORBIDDEN', 'Это действие доступно в демокабинете родителя.', 403);
    return familyById(session.familyId, source);
  }

  function childForFamily(family, id) {
    if (!validId(id)) throw error('NOT_FOUND', 'Профиль ребёнка не найден в этой демосемье.', 404);
    const child = family.children.find(value => value.id === id);
    if (!child) throw error('NOT_FOUND', 'Профиль ребёнка не найден в этой демосемье.', 404);
    return child;
  }

  function childView(child) {
    const ids = (child.doctorIds || []).slice();
    return {id: child.id, name: child.name, birthDate: child.birthDate, relationship: child.relationship, linkStatus: 'demo',
      doctorIds: ids,
      doctorAssignment: {status: ids.length ? 'assigned' : 'unassigned',
        doctors: ids.map(id => ({id: id, displayName: id === DEMO_DOCTOR_ID ? DEMO_DOCTOR_NAME : 'Лечащий врач'}))}};
  }

  function familyView(family) {
    const account = {id: family.id, displayName: familyName(family), demo: true, role: 'parent'};
    if (family.parent) {
      const parts = family.parent.email.split('@');
      account.emailMasked = parts[0].slice(0, 1) + '•••@' + parts[1];
      account.phoneMasked = '+7 ••• •••-' + family.parent.phone.slice(-4, -2) + '-' + family.parent.phone.slice(-2);
      account.emailVerified = false;
      account.phoneVerified = false;
    }
    return {account: account, children: family.children.map(childView)};
  }

  function gardenView(child, selectedMonth) {
    const entries = {};
    for (const day of Object.keys(child.garden.entries).sort()) {
      if (day.slice(0, 7) === selectedMonth) entries[day] = copy(child.garden.entries[day]);
    }
    return {garden: {entries: entries, goals: [], updatedAt: child.garden.updatedAt || null,
      recommendations: recommendationsView(child), recommendationsUpdatedAt: child.recommendationsUpdatedAt || null}};
  }

  function listFamilies() {
    refresh();
    return state.families.map(family => ({id: family.id, name: familyName(family)}));
  }

  function createFamily(name) {
    refresh();
    const cleanName = text(name, FAMILY_NAME_MAX, false, false);
    if (state.families.length >= MAX_FAMILIES) throw error('FAMILY_LIMIT', 'В демоверсии можно создать до ' + MAX_FAMILIES + ' семей на устройстве.');
    if (state.families.some(value => value.name.toLocaleLowerCase('ru') === cleanName.toLocaleLowerCase('ru'))) {
      throw error('FAMILY_EXISTS', 'Демосемья с таким названием уже есть. Выберите её в списке.');
    }
    const next = copy(state);
    const family = {id: randomId('family'), name: cleanName, children: []};
    next.families.push(family);
    persist(next);
    return {id: family.id, name: family.name};
  }

  function registerParent(input) {
    refresh();
    const parent = parentProfile(input);
    if (state.families.some(family => family.parent && family.parent.email === parent.email)) {
      throw error('EMAIL_EXISTS', 'Демокабинет с этой почтой уже есть на устройстве. Перейдите во «Вход».', 409);
    }
    if (state.families.length >= MAX_FAMILIES) throw error('FAMILY_LIMIT', 'В демоверсии можно создать до ' + MAX_FAMILIES + ' семей на устройстве.');
    const family = {id: randomId('family'), name: Array.from(parent.fullName).slice(0, FAMILY_NAME_MAX).join(''), parent: parent, children: []};
    const next = copy(state);
    next.families.push(family);
    persist(next);
    return Object.assign(startSession('parent', family.id), familyView(family));
  }

  function loginParent(email) {
    refresh();
    const normalized = parentEmail(email);
    const family = state.families.find(value => value.parent && value.parent.email === normalized);
    if (!family) throw error('DEMO_ACCOUNT_NOT_FOUND', 'Демокабинет с этой почтой не найден в этом браузере. Откройте «Регистрация».', 404);
    return Object.assign(startSession('parent', family.id), familyView(family));
  }

  function startSession(role, familyId, doctorId) {
    for (const [token, session] of sessions) if (session.expiresAt <= Date.now()) sessions.delete(token);
    // Sessions exist only in this JavaScript runtime, never in browser persistence.
    const token = randomId('demo_session');
    const expiresAt = Date.now() + SESSION_MS;
    sessions.set(token, {role: role, familyId: familyId || null, doctorId: doctorId || null, expiresAt: expiresAt});
    while (sessions.size > 16) sessions.delete(sessions.keys().next().value);
    return {token: token, expiresAt: new Date(expiresAt).toISOString()};
  }

  function enter(familyId) {
    refresh();
    const family = familyById(familyId);
    return Object.assign(startSession('parent', family.id), familyView(family));
  }

  function enterDoctor() {
    refresh();
    return Object.assign(startSession('doctor', null, DEMO_DOCTOR_ID), {
      account: {id: DEMO_DOCTOR_ID, displayName: DEMO_DOCTOR_NAME, demo: true, role: 'doctor'}, children: []
    });
  }

  function assignedDemoChild(childId, doctorId, source) {
    if (!validId(childId)) throw error('NOT_FOUND', 'Демопрофиль ребёнка не найден.', 404);
    for (const family of (source || state).families) {
      const child = family.children.find(value => value.id === childId);
      if (child && child.doctorIds && child.doctorIds.includes(doctorId)) return child;
    }
    throw error('NOT_FOUND', 'Демопрофиль ребёнка не найден.', 404);
  }

  async function request(action, options) {
    const opts = options || {};
    const params = opts.params || {};
    const method = String(opts.method || 'GET').toUpperCase();
    refresh();
    const session = sessionForToken(opts.token);
    if (action === 'logout' && method === 'POST') {
      sessions.delete(opts.token);
      return {ok: true, demo: true};
    }
    if (typeof action === 'string' && action.startsWith('doctor-')) {
      if (session.role !== 'doctor') throw error('FORBIDDEN', 'Это действие доступно в демокабинете врача.', 403);
      if (action === 'doctor-children' && method === 'GET') {
        const children = [];
        for (const family of state.families) for (const child of family.children) {
          if (child.doctorIds && child.doctorIds.includes(session.doctorId)) {
            children.push(Object.assign(childView(child), {familyId: family.id, familyName: familyName(family)}));
          }
        }
        return {children: children};
      }
      if (action === 'doctor-garden' && method === 'GET') return gardenView(assignedDemoChild(params.childId, session.doctorId), month(params.month));
      if (action === 'doctor-recommendations' && method === 'PUT') {
        assignedDemoChild(params.childId, session.doctorId);
        const body = opts.body;
        if (!object(body) || !object(body.recommendations)) throw error('INVALID_RECOMMENDATION', 'Заполните индивидуальные рекомендации.');
        // Validate the whole change before applying any field; diary entries are not writable through this route.
        const supplied = body.recommendations;
        const clean = recommendations(supplied);
        const next = copy(state);
        const child = assignedDemoChild(params.childId, session.doctorId, next);
        const updated = Object.assign({}, child.recommendations || {});
        for (const key of Object.keys(supplied)) {
          if (owns(clean, key)) updated[key] = clean[key];
          else delete updated[key];
        }
        child.recommendations = updated;
        child.recommendationsUpdatedAt = nowISO();
        persist(next);
        return {recommendations: recommendationsView(child), updatedAt: child.recommendationsUpdatedAt};
      }
      throw error('DEMO_UNAVAILABLE', 'Это действие не входит в демокабинет врача.', 404);
    }
    const family = familyForToken(opts.token);
    if (action === 'me' && method === 'GET') return familyView(family);
    if (action === 'children' && method === 'POST') {
      const body = opts.body;
      if (!object(body)) throw error('INVALID_CHILD', 'Заполните демопрофиль ребёнка.');
      if (family.children.length >= MAX_CHILDREN) throw error('CHILD_LIMIT', 'В одной демосемье можно создать до ' + MAX_CHILDREN + ' профилей.');
      const child = {id: randomId('child'), name: text(body.name, CHILD_NAME_MAX, false, false), birthDate: optionalBirthDate(body.birthDate),
        relationship: relationship(body.relationship), doctorIds: [], garden: {entries: {}, updatedAt: null}};
      const next = copy(state);
      familyForToken(opts.token, next).children.push(child);
      persist(next);
      return {child: childView(child)};
    }
    if (action === 'garden' && method === 'GET') {
      return gardenView(childForFamily(family, params.childId), month(params.month));
    }
    if (action === 'garden' && method === 'PUT') {
      const body = opts.body;
      if (!object(body)) throw error('INVALID_ENTRY', 'Проверьте отметки дневника.');
      const day = date(body.date);
      const changes = entry(body.entry, true);
      const ownedChild = childForFamily(family, params.childId);
      if (ownedChild.birthDate && day < ownedChild.birthDate) {
        throw error('INVALID_DATE', 'День дневника не может быть раньше даты рождения ребёнка.');
      }
      const next = copy(state);
      const child = childForFamily(familyForToken(opts.token, next), params.childId);
      const existing = owns(child.garden.entries, day) ? child.garden.entries[day] : {};
      const current = copy(existing);
      for (const key of Object.keys(changes)) {
        if (changes[key] === null || (key === 'note' && changes[key] === '')) delete current[key];
        else current[key] = changes[key];
      }
      if (Object.keys(current).length) {
        if (!owns(child.garden.entries, day) && Object.keys(child.garden.entries).length >= MAX_DAYS) {
          throw error('DAY_LIMIT', 'В демоверсии можно сохранить до ' + MAX_DAYS + ' дней для одного ребёнка.');
        }
        child.garden.entries[day] = current;
      } else delete child.garden.entries[day];
      child.garden.updatedAt = nowISO();
      persist(next);
      return gardenView(child, day.slice(0, 7));
    }
    if (action === 'documents' && method === 'GET') {
      childForFamily(family, params.childId);
      return {documents: [], linkStatus: 'demo'};
    }
    throw error('DEMO_UNAVAILABLE', 'Эта функция не входит в локальную демоверсию.', 404);
  }

  initialize();
  const api = {
    listFamilies: listFamilies,
    createFamily: createFamily,
    registerParent: registerParent,
    loginParent: loginParent,
    enter: enter,
    enterDoctor: enterDoctor,
    request: request,
    isPersistent: () => persistent,
    status: () => ({persistent: persistent, warning: warning}),
    get persistenceAvailable() { return persistent; },
    limits: Object.freeze({familyName: FAMILY_NAME_MAX, parentName: PARENT_NAME_MAX, childName: CHILD_NAME_MAX, note: NOTE_MAX, recommendation: RECOMMENDATION_MAX, families: MAX_FAMILIES, children: MAX_CHILDREN})
  };
  Object.defineProperty(global, 'VDDemo', {value: Object.freeze(api), writable: false, configurable: false, enumerable: true});
})(window);
