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
    }
    const family = demo.createFamily('Вторая демосемья');
    assert.deepEqual(plain(demo.enter(family.id).children), []);
  });

  await test('child requires only a name; optional date is validated when supplied', async () => {
    const {demo} = createContext();
    const session = parentSession(demo);
    const added = await demo.request('children', {token: session.token, method: 'POST', body: {name: 'Андрей'}});
    assert.equal(added.child.name, 'Андрей');
    assert.equal(added.child.birthDate, '');
    assert.equal(added.child.relationship, 'parent');
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
    assert.equal(all.children.length, 3);
    assert.equal(all.children.find(value => value.id === extraChild.id).familyId, extraParent.account.id);
    await rejected(() => demo.request('doctor-children', {token: parent.token}), 'FORBIDDEN');
    await rejected(() => demo.request('doctor-recommendations', {token: parent.token, method: 'PUT', params: {childId: child}, body: {recommendations: {meal: 'Тест'}}}), 'FORBIDDEN');
    await rejected(() => demo.request('me', {token: doctor.token}), 'FORBIDDEN');
    await rejected(() => saveDay(demo, doctor.token, child, '2026-11-20', {meal: 'missed'}), 'FORBIDDEN');
    await rejected(() => demo.request('children', {token: doctor.token, method: 'POST', body: {name: 'Нельзя'}}), 'FORBIDDEN');
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
