#!/usr/bin/env node
'use strict';

/* Executes the actual local-demo HTML and JS with DOM events and local disk
 * resources. This verifies behavior, not visual layout or browser rendering.
 * Install jsdom or set JSDOM_PATH to its package directory outside this repo.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
let jsdom;
try { jsdom = require('jsdom'); } catch {
  if (!process.env.JSDOM_PATH) throw new Error('Install jsdom or set JSDOM_PATH to its package directory.');
  jsdom = require(process.env.JSDOM_PATH);
}
const { JSDOM, ResourceLoader, VirtualConsole } = jsdom;
const T = require('./demo-ui.cjs');
const ROOT = path.resolve(process.env.VD_SITE_ROOT || path.join(__dirname, '..'));
const instances = new Set();

function sourceFile(url) {
  const parsed = new URL(url, T.BASE + '/');
  if (parsed.origin !== T.BASE_ORIGIN) return null;
  const basePath = new URL(T.BASE + '/').pathname;
  if (!parsed.pathname.startsWith(basePath)) return null;
  const filename = path.resolve(ROOT, parsed.pathname.slice(basePath.length) || 'index.html');
  return filename.startsWith(ROOT + path.sep) ? filename : null;
}
class LocalResources extends ResourceLoader {
  fetch(url, options) {
    // JSDOM does not implement iframe sandboxing. Only its declared boundary is
    // checked here; the browser suite separately covers the iframe element.
    if (options?.element?.localName === 'iframe') return null;
    const filename = sourceFile(url);
    return filename ? fs.readFile(filename).catch(() => null) : null;
  }
}

async function open(options = {}) {
  const state = { errors: [], requests: [], privateAPI: [], external: [], pending: new Set(), blockedStorage: !!options.blockedStorage };
  const console = new VirtualConsole();
  console.on('jsdomError', error => {
    if (/unhandled|Uncaught/.test(error.type + ' ' + error.message)) state.errors.push(error.cause?.stack || error.detail?.stack || error.message);
  });
  const dom = new JSDOM(await fs.readFile(path.join(ROOT, 'index.html'), 'utf8'), {
    url: T.BASE + '/' + (options.hash || ''), runScripts: 'dangerously',
    resources: new LocalResources(), pretendToBeVisual: true, virtualConsole: console,
    beforeParse(window) {
      if (state.blockedStorage) Object.defineProperty(window, 'localStorage', { configurable: true, get() { throw new window.DOMException('Demo storage disabled by test', 'SecurityError'); } });
      else for (const [key, value] of Object.entries(options.storage || {})) window.localStorage.setItem(key, value);
      window.AbortController = AbortController; window.Headers = Headers; window.Response = Response; window.Request = Request;
      window.matchMedia = () => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} });
      window.scrollTo = () => {}; window.HTMLElement.prototype.scrollIntoView = () => {};
      window.URL.createObjectURL = () => T.BASE + '/demo-test-blob'; window.URL.revokeObjectURL = () => {};
      window.fetch = (input, request = {}) => {
        const url = new URL(String(input), T.BASE + '/').href;
        state.requests.push(url);
        const operation = (async () => {
          if (request.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
          if (T.isPrivateAPI(url)) { state.privateAPI.push(url); throw new Error('Clinic API forbidden by demo test'); }
          const filename = sourceFile(url);
          if (!filename) { state.external.push(url); throw new Error('External network disabled in demo test'); }
          try { return new Response(await fs.readFile(filename), { status: 200, headers: { 'Content-Type': filename.endsWith('.json') ? 'application/json' : 'text/plain' } }); }
          catch { return new Response('', { status: 404 }); }
        })();
        state.pending.add(operation);
        operation.finally(() => state.pending.delete(operation)).catch(() => {});
        return operation;
      };
    }
  });
  const env = { dom, window: dom.window, document: dom.window.document, state };
  instances.add(env);
  await T.eventually(() => {
    if (state.errors.length) throw new Error(state.errors.join('\n'));
    return dom.window.VDCabinetReady === true && dom.window.document.readyState === 'complete';
  }, 'actual demo scripts initialize', 12000);
  await T.eventually(() => env.document.querySelector('[data-pc="demo-enter"]'), 'demo families appear');
  return env;
}
function q(env, selector) { const node = env.document.querySelector(selector); assert.ok(node, 'Missing element: ' + selector); return node; }
function text(env) { return q(env, '#app').textContent; }
function click(env, selector) { const node = q(env, selector); assert.ok(!node.disabled, 'Control disabled: ' + selector); node.click(); }
function input(env, selector, value, event = 'input') { const node = q(env, selector); node.value = value; node.dispatchEvent(new env.window.Event(event, { bubbles: true })); }
function submit(env, selector) { const form = q(env, selector); assert.ok(!form.querySelector('[type=submit]')?.disabled); form.dispatchEvent(new env.window.Event('submit', { bubbles: true, cancelable: true })); }
function nav(env, target) { click(env, `[data-nav="${target}"]`); }
function chooser(env) {
  q(env, '[data-pc-view="auth"]');
  assert.equal(env.document.querySelector('#pc-phone-form, #pc-code-form, #pc-phone, #pc-code'), null);
}
function findChild(env, name) { return [...env.document.querySelectorAll('[data-pc-child]')].find(node => node.textContent.includes(name))?.getAttribute('data-pc-child'); }
function familyId(env, name) { return [...env.document.querySelectorAll('[data-pc="demo-enter"]')].find(node => !name || node.textContent.includes(name))?.getAttribute('data-family-id'); }
function snapshot(env) { return { ...env.window.localStorage }; }
function rawStore(env) { return env.window.localStorage.getItem(T.STORAGE_KEY) || ''; }
async function close(env) {
  if (!instances.has(env)) return;
  env.window.dispatchEvent(new env.window.Event('pagehide'));
  await Promise.allSettled([...env.state.pending]);
  await new Promise(resolve => setImmediate(resolve));
  env.window.close(); instances.delete(env);
}
async function reload(env) { const saved = snapshot(env); const state = env.state; await close(env); const next = await open({ storage: saved }); next.priorState = state; return next; }
async function enter(env, id) {
  chooser(env);
  click(env, id ? `[data-pc="demo-enter"][data-family-id="${id}"]` : '[data-pc="demo-enter"]');
  await T.eventually(() => env.document.querySelector('.pc-account'), 'demo family entered');
}
function logout(env) { nav(env, 'family'); nav(env, 'profile'); click(env, '[data-pc="logout"]'); chooser(env); }
async function openDay(env, id) {
  nav(env, 'family'); click(env, `[data-pc-child="${id}"]`); nav(env, 'garden');
  await T.eventually(() => env.document.querySelector('[data-action="open-today"]'), 'garden loaded');
  click(env, '[data-action="open-today"]');
  await T.eventually(() => env.document.querySelector('#pc-day-form'), 'diary form');
}
async function saveNote(env, note, mark = 'done') {
  input(env, '#pc-day-note', note);
  click(env, `[data-pc-mark="meal"][data-pc-value="${mark}"]`);
  assert.equal(q(env, '#pc-day-note').value, note, 'Changing a mark must preserve the note draft');
  submit(env, '#pc-day-form');
  await T.eventually(() => !env.document.querySelector('#pc-day-form'), 'day saved');
}
function note(env, expected, mark) {
  assert.equal(q(env, '#pc-day-note').value, expected);
  if (mark) assert.equal(q(env, `[data-pc-mark="meal"][data-pc-value="${mark}"]`).getAttribute('aria-pressed'), 'true');
}

async function run() {
  let passed = 0;
  const pass = label => { passed++; console.log(`PASS ${passed}: ${label}`); };
  const audited = [];
  try {
    let env = await open(); audited.push(env.state);
    chooser(env);
    const familyA = familyId(env);
    assert.ok(familyA);
    q(env, '#topbar a[href="tel:+74842200540"]');
    pass('First screen is a usable demo family chooser; no phone/OTP forms; top call exists');

    await enter(env, familyA);
    const misha = findChild(env, 'Миша (демо)'), anya = findChild(env, 'Аня (демо)');
    assert.ok(misha && anya && misha !== anya);
    await openDay(env, misha); note(env, '');
    input(env, '#pc-day-note', T.NOTE_MISHA);
    click(env, '[data-pc-mark="meal"][data-pc-value="done"]');
    assert.equal(q(env, '#pc-day-note').value, T.NOTE_MISHA);
    assert.ok(!rawStore(env).includes(T.NOTE_MISHA), 'Unsaved draft leaked to persistent storage');
    submit(env, '#pc-day-form');
    await T.eventually(() => !env.document.querySelector('#pc-day-form'), 'first diary saved');
    assert.ok(rawStore(env).includes(T.NOTE_MISHA));
    pass('Note survives mark re-render and only explicit Save persists the day');

    await openDay(env, anya); note(env, '');
    assert.equal(q(env, '[data-pc-mark="meal"][data-pc-value="done"]').getAttribute('aria-pressed'), 'false');
    await saveNote(env, T.NOTE_ANYA, 'partial');
    await openDay(env, misha); note(env, T.NOTE_MISHA, 'done');
    input(env, '#pc-day-note', T.UNSAVED);
    click(env, '[data-pc-mark="water"][data-pc-value="done"]');
    assert.equal(q(env, '#pc-day-note').value, T.UNSAVED);
    assert.ok(!rawStore(env).includes(T.UNSAVED));
    env = await reload(env); audited.push(env.state);
    await enter(env, familyA);
    await openDay(env, misha); note(env, T.NOTE_MISHA, 'done');
    await openDay(env, anya); note(env, T.NOTE_ANYA, 'partial');
    pass('Reload preserves separate diaries for two children and discards an unsaved replacement draft');

    logout(env);
    click(env, '.pc-new-family summary');
    input(env, '#pc-demo-family-name', T.FAMILY_B);
    submit(env, '#pc-demo-family-form');
    await T.eventually(() => env.document.querySelector('.pc-account'), 'new family entered');
    assert.equal(env.document.querySelector('[data-pc-child]'), null);
    assert.ok(!text(env).includes('Миша (демо)') && !text(env).includes('Аня (демо)'));
    nav(env, 'add-child');
    input(env, '#pc-child-name', T.CHILD_B);
    submit(env, '#pc-child-form');
    await T.eventually(() => env.document.querySelector('[data-pc-child]'), 'new family child created');
    const childB = findChild(env, T.CHILD_B); assert.ok(childB);
    await openDay(env, childB); note(env, ''); await saveNote(env, T.NOTE_B);
    logout(env);
    const familyB = familyId(env, T.FAMILY_B); assert.ok(familyB && familyB !== familyA);
    await enter(env, familyA); await openDay(env, misha); note(env, T.NOTE_MISHA, 'done');
    logout(env); await enter(env, familyB); await openDay(env, childB); note(env, T.NOTE_B, 'done');
    pass('New family is empty; name-only child creation works and switching families keeps records isolated');

    nav(env, 'family'); nav(env, 'profile'); nav(env, 'documents');
    await T.eventually(() => /не подключ|демо|демонстрац/i.test(q(env, '#content').textContent), 'documents unconnected notice');
    assert.equal(env.document.querySelector('[data-pc-document]'), null);
    assert.doesNotMatch(q(env, '#content').textContent, /В норме|Без отклонений/);
    nav(env, 'family'); nav(env, 'chat');
    assert.match(q(env, '#content').textContent, /не подключ|демо|демонстрац|позвон/i);
    pass('Documents and operator chat stay explicitly unconnected without invented clinical records');

    nav(env, 'booking');
    const sandbox = q(env, '#vd-booking-frame').getAttribute('sandbox');
    assert.ok(sandbox?.split(/\s+/).includes('allow-scripts'));
    assert.ok(!sandbox.split(/\s+/).includes('allow-same-origin'));
    logout(env); click(env, '[data-pc="guest"]'); nav(env, 'doctors'); q(env, '#doctor-search');
    nav(env, 'family'); chooser(env);
    pass('Booking keeps its sandbox; guest doctor navigation works and family route opens chooser');

    click(env, '[data-pc="demo-doctor"]');
    await T.eventually(() => env.document.querySelector('select[data-vdd-child]'), 'doctor child selector');
    input(env, 'select[data-vdd-child]', misha, 'change');
    await T.eventually(() => env.document.querySelector('[data-vdd-month-percent]')?.textContent === '100%', 'Misha monthly percentage');
    assert.equal(q(env, `[data-vdd-date="${T.today()}"] .vdd-day-score`).textContent, '100%');
    assert.match(q(env, '[data-vdd-marked]').textContent, /^1\s*\//);
    input(env, 'select[data-vdd-child]', anya, 'change');
    await T.eventually(() => env.document.querySelector('[data-vdd-month-percent]')?.textContent === '50%', 'Anya own monthly percentage');
    input(env, 'input[data-vdd-month]', T.previousMonth(T.today().slice(0,7)), 'change');
    await T.eventually(() => env.document.querySelector('[data-vdd-month-percent]')?.textContent.includes('Нет отметок'), 'empty previous month');
    input(env, 'input[data-vdd-month]', T.today().slice(0,7), 'change');
    await T.eventually(() => env.document.querySelector('[data-vdd-month-percent]')?.textContent === '50%', 'Anya current month restored');
    input(env, 'select[data-vdd-child]', misha, 'change');
    await T.eventually(() => env.document.querySelector('[data-vdd-month-percent]')?.textContent === '100%', 'Misha selected again');
    input(env, '[data-vdd-recommendation="meal"]', T.RECOMM_MISHA);
    await new Promise(resolve => {
      env.window.addEventListener('hashchange', () => env.window.setTimeout(resolve, 0), { once: true });
      env.window.location.hash = '#auth';
    });
    assert.equal(q(env, '[data-vdd-recommendation="meal"]').value, T.RECOMM_MISHA, 'Auth/back navigation must retain doctor draft');
    assert.equal(q(env, '[data-vdd-save]').disabled, false);
    submit(env, 'form[data-vdd-recommendations]');
    await T.eventually(() => text(env).includes('Рекомендации сохранены'), 'Misha recommendation saved');
    input(env, 'select[data-vdd-child]', anya, 'change');
    await T.eventually(() => env.document.querySelector('[data-vdd-month-percent]')?.textContent === '50%', 'Anya selected for recommendation');
    assert.equal(q(env, '[data-vdd-recommendation="meal"]').value, '');
    input(env, '[data-vdd-recommendation="activity"]', T.RECOMM_ANYA);
    submit(env, 'form[data-vdd-recommendations]');
    await T.eventually(() => text(env).includes('Рекомендации сохранены'), 'Anya recommendation saved');
    click(env, '[data-vdd="exit"]');
    await enter(env, familyA); nav(env, 'garden');
    click(env, `[data-pc-child="${misha}"]`);
    await T.eventually(() => q(env, '#content').textContent.includes(T.RECOMM_MISHA), 'parent receives own child recommendation');
    assert.ok(!q(env, '#content').textContent.includes(T.RECOMM_ANYA));
    env = await reload(env); audited.push(env.state);
    click(env, '[data-pc="demo-doctor"]');
    await T.eventually(() => env.document.querySelector('select[data-vdd-child]'), 'doctor returns after reload');
    input(env, 'select[data-vdd-child]', anya, 'change');
    await T.eventually(() => env.document.querySelector('[data-vdd-recommendation="activity"]')?.value === T.RECOMM_ANYA, 'Anya recommendation persisted');
    assert.equal(q(env, '[data-vdd-recommendation="meal"]').value, '');
    pass('Doctor day/month statistics reflect actual marks; separate recommendations persist and appear for the correct child');

    let temporary = await open({ blockedStorage: true }); audited.push(temporary.state);
    chooser(temporary);
    assert.match(text(temporary), /сесси|до закрытия|недоступ|не сохраня/i, 'Storage failure must be disclosed visibly');
    await enter(temporary);
    const volatileId = findChild(temporary, 'Миша (демо)');
    await openDay(temporary, volatileId); await saveNote(temporary, T.NOTE_B);
    await openDay(temporary, volatileId); note(temporary, T.NOTE_B, 'done');
    await close(temporary);
    temporary = await open({ blockedStorage: true }); audited.push(temporary.state);
    await enter(temporary);
    await openDay(temporary, findChild(temporary, 'Миша (демо)')); note(temporary, '');
    pass('Storage-disabled demo works in memory with a truthful notice and loses records on reload');

    for (const state of audited) {
      await Promise.allSettled([...state.pending]);
      assert.deepEqual(state.privateAPI, [], 'Demo attempted clinic login/medical API');
      assert.deepEqual(state.errors, [], 'Actual demo scripts produced an unhandled error');
    }
    pass('Actual demo scripts run without uncaught errors and never request clinic login/medical APIs');
    console.log(JSON.stringify({ passed, verification: 'DOM behavior only; no visual layout claims', realNetwork: 0, clinicalAPIRequests: 0, realSMS: 0 }, null, 2));
  } finally { for (const env of [...instances]) await close(env); }
}
run().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
