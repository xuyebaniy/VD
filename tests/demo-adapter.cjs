#!/usr/bin/env node
'use strict';

// Repeatable tests of the local demo data adapter. Node built-ins only;
// no browser, network, backend or SMS provider is used.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {webcrypto} = require('node:crypto');

const source = fs.readFileSync(path.join(__dirname, '..', 'cabinet-demo.js'), 'utf8');
const KEY = 'vd_cabinet_demo_v1';
const FIXED_TIME = Date.parse('2026-11-22T10:00:00Z');
const plain = value => JSON.parse(JSON.stringify(value));
let passed = 0;
let networkCalls = 0;

function createContext({storage = new Map(), blocked = false, quota = false} = {}) {
  class FixedDate extends Date {
    constructor(...args) { super(...(args.length ? args : [FIXED_TIME])); }
    static now() { return FIXED_TIME; }
  }
  function rejectNetwork() {
    networkCalls += 1;
    throw new Error('The demo adapter must not access the network.');
  }
  const window = {
    crypto: webcrypto,
    localStorage: {
      getItem(key) {
        if (blocked) throw new Error('Storage access denied');
        return storage.has(key) ? storage.get(key) : null;
      },
      setItem(key, value) {
        if (blocked || quota) throw new Error('Storage write denied');
        storage.set(key, value);
      }
    },
    fetch: rejectNetwork,
    XMLHttpRequest: rejectNetwork,
    WebSocket: rejectNetwork,
    navigator: {sendBeacon: rejectNetwork}
  };
  vm.runInNewContext(source, {
    window, Date: FixedDate, Intl, fetch: rejectNetwork,
    XMLHttpRequest: rejectNetwork, WebSocket: rejectNetwork
  }, {filename: 'cabinet-demo.js', timeout: 2000});
  return {demo: window.VDDemo, storage};
}

function parentSession(demo) { return demo.enter(demo.listFamilies()[0].id); }

function garden(demo, token, childId, selectedMonth = '2026-11') {
  return demo.request('garden', {token, params: {childId, month: selectedMonth}});
}

function saveDay(demo, token, childId, date, entry) {
  return demo.request('garden', {token, method: 'PUT', params: {childId}, body: {date, entry}});
}

async function rejected(operation, expectedCode) {
  await assert.rejects(operation, failure => {
    assert.equal(failure.code, expectedCode);
    assert.equal(typeof failure.userMessage, 'string');
    assert.ok(failure.userMessage.length > 0);
    return true;
  });
}

async function test(name, operation) {
  await operation();
  passed += 1;
  console.log('PASS ' + name);
}

(async () => {
  await test('demo seed and adult-owned family profiles', async () => {
    const {demo} = createContext();
    assert.ok(Object.isFrozen(demo));
    assert.equal(demo.listFamilies()[0].name, 'Демосемья');
    const session = parentSession(demo);
    assert.equal(session.account.role, 'parent');
    assert.equal(session.account.demo, true);
    assert.deepEqual(session.children.map(child => child.name).sort().join('|'), 'Аня (демо)|Миша (демо)');
    for (const child of session.children) {
      assert.deepEqual(plain((await garden(demo, session.token, child.id)).garden.entries), {});
      assert.deepEqual(plain(child.doctorIds), ['doctor_demo']);
      assert.deepEqual(plain(child.doctorAssignment), {
        status: 'assigned', doctors: [{id: 'doctor_demo', displayName: 'Врач (демо)'}]
      });
    }
    const family = demo.createFamily('Вторая демосемья');
    assert.deepEqual(plain(demo.enter(family.id).children), []);
  });

  await test('demo registration opens a parent cabinet and email login restores its children and diary after reload', async () => {
    const {demo, storage} = createContext();
    const legacy = demo.createFamily('Семья до регистрации');
    const original = parentSession(demo);
    await saveDay(demo, original.token, original.children[0].id, '2026-11-20', {sleep: 'partial'});
    const profile = {fullName: '  Анна Демонстрационная Проверочная  ', email: '  ANNA@example.test  ', phone: '8 (900) 000-11-22'};
    const registered = demo.registerParent(profile);
    assert.equal(registered.account.displayName, 'Анна Демонстрационная Проверочная');
    assert.equal(registered.account.role, 'parent');
    assert.equal(registered.account.demo, true);
    assert.equal(registered.account.emailVerified, false);
    assert.equal(registered.account.phoneVerified, false);
    assert.deepEqual(plain(registered.children), []);
    const child = (await demo.request('children', {token: registered.token, method: 'POST', body: {name: 'Ребёнок демо'}})).child;
    await saveDay(demo, registered.token, child.id, '2026-11-20', {water: 'done', note: 'Вымышленная запись'});
    const saved = JSON.parse(storage.get(KEY));
    assert.deepEqual(saved.families.find(value => value.id === registered.account.id).parent, {
      fullName: 'Анна Демонстрационная Проверочная', email: 'anna@example.test', phone: '79000001122'
    });
    assert.ok(!storage.get(KEY).includes(registered.token));
    const reloaded = createContext({storage}).demo;
    await rejected(() => reloaded.request('me', {token: registered.token}), 'UNAUTHORIZED');
    const restored = reloaded.loginParent(' ANNA@EXAMPLE.TEST ');
    assert.equal(restored.account.id, registered.account.id);
    assert.equal(restored.children[0].id, child.id);
    assert.deepEqual(plain((await garden(reloaded, restored.token, child.id)).garden.entries['2026-11-20']), {water: 'done', note: 'Вымышленная запись'});
    assert.equal(reloaded.enter(legacy.id).account.displayName, 'Семья до регистрации');
    const seed = reloaded.enter(original.account.id);
    assert.equal((await garden(reloaded, seed.token, seed.children[0].id)).garden.entries['2026-11-20'].sleep, 'partial');
    assert.deepEqual(plain(seed.children[0].doctorIds), ['doctor_demo']);
  });

  await test('duplicate email, invalid registration and unknown login do not replace an existing family', async () => {
    const {demo, storage} = createContext();
    const profile = {fullName: 'Анна Демо', email: 'anna@example.test', phone: '+79000001122'};
    const registered = demo.registerParent(profile);
    const child = (await demo.request('children', {token: registered.token, method: 'POST', body: {name: 'Демо'}})).child;
    await saveDay(demo, registered.token, child.id, '2026-11-20', {meal: 'done'});
    const before = storage.get(KEY);
    assert.throws(() => demo.registerParent({...profile, fullName: 'Другое имя', email: ' ANNA@EXAMPLE.TEST ', phone: '+79001112233'}), failure => failure.code === 'EMAIL_EXISTS');
    assert.throws(() => demo.loginParent('missing@example.test'), failure => failure.code === 'DEMO_ACCOUNT_NOT_FOUND');
    for (const [patch, code] of [
      [{fullName: ''}, 'INVALID_NAME'], [{fullName: 'А'.repeat(151)}, 'INVALID_NAME'],
      [{email: 'bad\n@example.test'}, 'INVALID_EMAIL'], [{email: 'no-email'}, 'INVALID_EMAIL'],
      [{email: 'a..b@example.test'}, 'INVALID_EMAIL'], [{phone: '123'}, 'INVALID_PHONE'],
      [{phone: '+79000001122\n'}, 'INVALID_PHONE']
    ]) assert.throws(() => demo.registerParent({...profile, email: 'new@example.test', ...patch}), failure => failure.code === code);
    assert.equal(storage.get(KEY), before);
    assert.equal(demo.loginParent(profile.email).account.displayName, profile.fullName);
  });

  await test('registered demo parents retain family isolation and cannot acquire doctor privileges', async () => {
    const {demo} = createContext();
    const first = demo.registerParent({fullName: 'Первый демородитель', email: 'first@example.test', phone: '+79000001122', role: 'doctor', doctorIds: ['doctor_demo']});
    const second = demo.registerParent({fullName: 'Второй демородитель', email: 'second@example.test', phone: '+79000002233'});
    const child = (await demo.request('children', {token: first.token, method: 'POST', body: {name: 'Деморебёнок', doctorIds: ['doctor_demo']}})).child;
    assert.equal(first.account.role, 'parent');
    assert.deepEqual(plain(child.doctorIds), []);
    await saveDay(demo, first.token, child.id, '2026-11-20', {water: 'done'});
    await rejected(() => garden(demo, second.token, child.id), 'NOT_FOUND');
    await rejected(() => demo.request('doctor-children', {token: first.token}), 'FORBIDDEN');
    const doctor = demo.enterDoctor();
    assert.equal((await demo.request('doctor-children', {token: doctor.token})).children.length, 2);
    await rejected(() => demo.request('doctor-garden', {token: doctor.token, params: {childId: child.id}}), 'NOT_FOUND');
  });

  await test('malformed or duplicated stored parent profiles preserve the original browser data', async () => {
    for (const mode of ['invalid', 'duplicate']) {
      const {demo, storage} = createContext();
      demo.registerParent({fullName: 'Анна Демо', email: 'anna@example.test', phone: '+79000001122'});
      const saved = JSON.parse(storage.get(KEY));
      if (mode === 'invalid') saved.families[1].parent.email = 'not-an-email';
      else saved.families[0].parent = {...saved.families[1].parent};
      const raw = JSON.stringify(saved);
      storage.set(KEY, raw);
      const reloaded = createContext({storage}).demo;
      assert.equal(reloaded.isPersistent(), false);
      assert.ok(reloaded.status().warning);
      reloaded.createFamily('Временная семья');
      assert.equal(storage.get(KEY), raw);
    }
  });

  await test('child requires only a name; optional date is validated when supplied', async () => {
    const {demo} = createContext();
    const session = parentSession(demo);
    const added = await demo.request('children', {token: session.token, method: 'POST', body: {name: 'Андрей'}});
    assert.equal(added.child.name, 'Андрей');
    assert.equal(added.child.birthDate, '');
    assert.equal(added.child.relationship, 'parent');
    assert.deepEqual(plain(added.child.doctorIds), []);
    assert.deepEqual(plain(added.child.doctorAssignment), {status: 'unassigned', doctors: []});
    await rejected(() => demo.request('children', {token: session.token, method: 'POST', body: {
      name: 'Тест', birthDate: '2026-11-23'
    }}), 'INVALID_DATE');
    await rejected(() => demo.request('children', {token: session.token, method: 'POST', body: {
      name: 'Тест', birthDate: '2026-02-30'
    }}), 'INVALID_DATE');
  });

  await test('family and child isolation for diary reads and writes', async () => {
    const {demo} = createContext();
    const first = parentSession(demo);
    const second = demo.enter(demo.createFamily('Изолированная семья').id);
    const firstChild = first.children[0].id;
    await saveDay(demo, first.token, firstChild, '2026-11-20', {meal: 'done'});
    await rejected(() => garden(demo, second.token, firstChild), 'NOT_FOUND');
    await rejected(() => saveDay(demo, second.token, firstChild, '2026-11-20', {meal: 'missed'}), 'NOT_FOUND');
    assert.equal((await garden(demo, first.token, firstChild)).garden.entries['2026-11-20'].meal, 'done');
    assert.deepEqual(plain((await garden(demo, first.token, first.children[1].id)).garden.entries), {});
  });

  await test('partial day changes preserve other fields and dates; explicit removal is narrow', async () => {
    const {demo} = createContext();
    const parent = parentSession(demo);
    const child = parent.children[0].id;
    await saveDay(demo, parent.token, child, '2026-11-20', {meal: 'done', note: 'Вымышленная демозапись'});
    await saveDay(demo, parent.token, child, '2026-11-21', {sleep: 'partial'});
    let response = await saveDay(demo, parent.token, child, '2026-11-20', {water: 'done'});
    assert.deepEqual(plain(response.garden.entries), {
      '2026-11-20': {meal: 'done', note: 'Вымышленная демозапись', water: 'done'},
      '2026-11-21': {sleep: 'partial'}
    });
    response = await saveDay(demo, parent.token, child, '2026-11-20', {water: null, note: ''});
    assert.deepEqual(plain(response.garden.entries['2026-11-20']), {meal: 'done'});
    assert.deepEqual(plain(response.garden.entries['2026-11-21']), {sleep: 'partial'});
    await rejected(() => saveDay(demo, parent.token, child, '2026-11-23', {meal: 'done'}), 'INVALID_DATE');
    await rejected(() => saveDay(demo, parent.token, child, '2019-01-01', {meal: 'done'}), 'INVALID_DATE');
    assert.deepEqual(plain((await garden(demo, parent.token, child, '2019-01')).garden.entries), {});
  });

  await test('persisted family and diary survive reload while sessions do not', async () => {
    const {demo, storage} = createContext();
    const parent = parentSession(demo);
    const child = (await demo.request('children', {token: parent.token, method: 'POST', body: {name: 'Андрей'}})).child;
    await saveDay(demo, parent.token, child.id, '2026-11-20', {activity: 'partial'});
    assert.ok(!storage.get(KEY).includes(parent.token));
    const reloaded = createContext({storage}).demo;
    await rejected(() => reloaded.request('me', {token: parent.token}), 'UNAUTHORIZED');
    const restored = reloaded.enter(parent.account.id);
    assert.equal(restored.children.find(value => value.id === child.id).birthDate, '');
    assert.equal((await garden(reloaded, restored.token, child.id)).garden.entries['2026-11-20'].activity, 'partial');
    await reloaded.request('logout', {token: restored.token, method: 'POST'});
    await rejected(() => reloaded.request('me', {token: restored.token}), 'UNAUTHORIZED');
  });

  await test('blocked and full storage use observable memory fallback', async () => {
    for (const mode of [{blocked: true}, {quota: true}]) {
      const {demo, storage} = createContext(mode);
      assert.equal(demo.isPersistent(), false);
      assert.equal(demo.persistenceAvailable, false);
      assert.ok(demo.status().warning.length > 0);
      const parent = demo.enter(demo.createFamily('Временная демосемья').id);
      const child = (await demo.request('children', {token: parent.token, method: 'POST', body: {name: 'Демо'}})).child;
      await saveDay(demo, parent.token, child.id, '2026-11-20', {mood: 'done'});
      assert.equal((await garden(demo, parent.token, child.id)).garden.entries['2026-11-20'].mood, 'done');
      assert.equal(storage.has(KEY), false);
    }
  });

  await test('corrupt or unknown saved state is preserved without overwrite', async () => {
    for (const invalid of ['{broken-json', JSON.stringify({version: 42, families: []})]) {
      const storage = new Map([[KEY, invalid]]);
      const {demo} = createContext({storage});
      assert.equal(demo.isPersistent(), false);
      assert.equal(demo.listFamilies()[0].name, 'Демосемья');
      demo.createFamily('Только в памяти');
      assert.equal(storage.get(KEY), invalid);
    }
  });

  await test('parent and doctor routes enforce their distinct roles', async () => {
    const {demo} = createContext();
    const parent = parentSession(demo);
    const child = parent.children[0].id;
    const extraParent = demo.enter(demo.createFamily('Другая демосемья').id);
    const extraChild = (await demo.request('children', {token: extraParent.token, method: 'POST', body: {name: 'Ещё ребёнок'}})).child;
    const doctor = demo.enterDoctor();
    assert.equal(doctor.account.role, 'doctor');
    const all = await demo.request('doctor-children', {token: doctor.token});
    assert.equal(all.children.length, 2);
    assert.equal(all.children.some(value => value.id === extraChild.id), false);
    assert.equal(all.children.find(value => value.id === child).familyId, parent.account.id);
    await rejected(() => demo.request('doctor-children', {token: parent.token}), 'FORBIDDEN');
    await rejected(() => demo.request('doctor-recommendations', {token: parent.token, method: 'PUT', params: {childId: child}, body: {recommendations: {meal: 'Тест'}}}), 'FORBIDDEN');
    await rejected(() => demo.request('me', {token: doctor.token}), 'FORBIDDEN');
    await rejected(() => saveDay(demo, doctor.token, child, '2026-11-20', {meal: 'missed'}), 'FORBIDDEN');
    await rejected(() => demo.request('children', {token: doctor.token, method: 'POST', body: {name: 'Нельзя'}}), 'FORBIDDEN');
  });

  await test('doctor cannot list, read or change unassigned children, including another child in an assigned family', async () => {
    const {demo, storage} = createContext();
    const parent = parentSession(demo), doctor = demo.enterDoctor();
    const extraParent = demo.enter(demo.createFamily('Ещё одна семья').id);
    const children = [];
    for (const owner of [parent, extraParent]) {
      const result = await demo.request('children', {token: owner.token, method: 'POST', body: {
        name: 'Без прикрепления', doctorIds: ['doctor_demo'], doctorAssignment: {status: 'assigned'}
      }});
      assert.deepEqual(plain(result.child.doctorIds), [], 'A parent cannot assign a doctor through child creation');
      children.push(result.child.id);
      await saveDay(demo, owner.token, result.child.id, '2026-11-20', {water: 'partial'});
    }
    const before = storage.get(KEY);
    for (const childId of [...children, 'unknown_child']) {
      await rejected(() => demo.request('doctor-garden', {token: doctor.token, params: {childId, month: '2026-11'}}), 'NOT_FOUND');
      await rejected(() => demo.request('doctor-recommendations', {token: doctor.token, method: 'PUT', params: {childId},
        body: {recommendations: {water: 'Недопустимое изменение'}}}), 'NOT_FOUND');
    }
    assert.equal(storage.get(KEY), before, 'Denied access must not alter entries or recommendations');
    const visible = await demo.request('doctor-children', {token: doctor.token});
    assert.deepEqual(visible.children.map(value => value.id).sort().join('|'), 'child_anya_demo|child_misha_demo');
  });

  await test('v1 migration preserves diary and recommendations and assigns only the original seed profiles', async () => {
    const {demo, storage} = createContext();
    const parent = parentSession(demo), childId = parent.children[0].id, doctor = demo.enterDoctor();
    await saveDay(demo, parent.token, childId, '2026-11-20', {water: 'done', note: 'Сохранить при обновлении'});
    await demo.request('doctor-recommendations', {token: doctor.token, method: 'PUT', params: {childId},
      body: {recommendations: {water: 'Ранее сохранённая рекомендация'}}});
    const added = await demo.request('children', {token: parent.token, method: 'POST', body: {name: 'Новый ребёнок'}});
    const legacy = JSON.parse(storage.get(KEY));
    for (const family of legacy.families) for (const child of family.children) delete child.doctorIds;
    storage.set(KEY, JSON.stringify(legacy));
    const reloaded = createContext({storage}).demo;
    const restored = parentSession(reloaded), restoredDoctor = reloaded.enterDoctor();
    const data = await garden(reloaded, restored.token, childId);
    assert.deepEqual(plain(data.garden.entries['2026-11-20']), {water: 'done', note: 'Сохранить при обновлении'});
    assert.equal(data.garden.recommendations.water, 'Ранее сохранённая рекомендация');
    assert.deepEqual(plain(restored.children.find(child => child.id === added.child.id).doctorIds), []);
    assert.equal((await reloaded.request('doctor-children', {token: restoredDoctor.token})).children.length, 2);
    const migrated = JSON.parse(storage.get(KEY));
    assert.deepEqual(migrated.families[0].children.find(child => child.id === childId).doctorIds, ['doctor_demo']);
    assert.deepEqual(migrated.families[0].children.find(child => child.id === added.child.id).doctorIds, []);
  });

  await test('assignment removal and another doctor are enforced for an already open session', async () => {
    const {demo, storage} = createContext();
    const parent = parentSession(demo), doctor = demo.enterDoctor();
    const stored = JSON.parse(storage.get(KEY));
    stored.families[0].children[0].doctorIds = [];
    stored.families[0].children[1].doctorIds = ['doctor_other'];
    storage.set(KEY, JSON.stringify(stored));
    assert.equal((await demo.request('doctor-children', {token: doctor.token})).children.length, 0);
    const before = storage.get(KEY);
    for (const child of parent.children) {
      await rejected(() => demo.request('doctor-garden', {token: doctor.token, doctorId: 'doctor_other',
        params: {childId: child.id, month: '2026-11', doctorId: 'doctor_other'}}), 'NOT_FOUND');
      await rejected(() => demo.request('doctor-recommendations', {token: doctor.token, method: 'PUT',
        params: {childId: child.id, doctorId: 'doctor_other'}, body: {doctorId: 'doctor_other', recommendations: {water: 'Нельзя'}}}), 'NOT_FOUND');
    }
    assert.equal(storage.get(KEY), before);
    const reloaded = createContext({storage}).demo;
    assert.equal((await reloaded.request('doctor-children', {token: reloaded.enterDoctor().token})).children.length, 0,
      'An explicit empty assignment must never be reattached by migration');
    assert.equal((await demo.request('me', {token: parent.token})).children.length, 2, 'Parents still see their own children');
  });

  await test('individual recommendations persist and never mutate the parental diary', async () => {
    const {demo, storage} = createContext();
    const parent = parentSession(demo);
    const doctor = demo.enterDoctor();
    const child = parent.children[0].id;
    const day = {meal: 'done', note: 'Запись родителя в демоверсии'};
    await saveDay(demo, parent.token, child, '2026-11-20', day);
    let response = await demo.request('doctor-garden', {token: doctor.token, params: {childId: child, month: '2026-11'}});
    assert.ok(Object.values(response.garden.recommendations).every(value => value === ''));
    await demo.request('doctor-recommendations', {token: doctor.token, method: 'PUT', params: {childId: child}, body: {
      recommendations: {meal: 'Индивидуальная демозаметка', water: 'Обсудить на приёме'}
    }});
    await demo.request('doctor-recommendations', {token: doctor.token, method: 'PUT', params: {childId: child}, body: {
      recommendations: {meal: 'Изменённая демозаметка'}
    }});
    response = await garden(demo, parent.token, child);
    assert.deepEqual(plain(response.garden.entries['2026-11-20']), day);
    assert.equal(response.garden.recommendations.meal, 'Изменённая демозаметка');
    assert.equal(response.garden.recommendations.water, 'Обсудить на приёме');
    assert.ok(Object.values((await garden(demo, parent.token, parent.children[1].id)).garden.recommendations).every(value => value === ''));
    const reloaded = createContext({storage}).demo;
    const restored = reloaded.enter(parent.account.id);
    response = await garden(reloaded, restored.token, child);
    assert.equal(response.garden.recommendations.meal, 'Изменённая демозаметка');
    assert.deepEqual(plain(response.garden.entries['2026-11-20']), day);
  });

  assert.equal(networkCalls, 0, 'No network API may be called by the adapter.');
  console.log(`\n${passed} adapter scenarios passed. No external dependencies or network calls.`);
})().catch(failure => {
  console.error(failure);
  process.exitCode = 1;
});
