#!/usr/bin/env node
'use strict';

/* Actual cabinet UI and transport with synthetic same-origin HTTP responses.
 * No email is sent, no external server is contacted, and no real data is used.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
let jsdom;
try { jsdom = require('jsdom'); } catch {
  if (!process.env.JSDOM_PATH) throw new Error('Install jsdom or set JSDOM_PATH.');
  jsdom = require(process.env.JSDOM_PATH);
}
const { JSDOM, ResourceLoader, VirtualConsole } = jsdom;
const T = require('./demo-ui.cjs');
const ROOT = path.resolve(process.env.VD_SITE_ROOT || path.join(__dirname, '..'));
const API = T.BASE_ORIGIN + '/local/api/patient-cabinet.php';
const CONFIG = { apiUrl: API, bookingWidgetUrl: 'https://public-booking.example.test/booking-widget.html' };
const PARENT = { fullName: 'Тестовая Родительница Проверочная', email: 'parent-auth@example.test', phone: '+79990001122' };
const TOKEN = 'TEST_ONLY_SECRET_BEARER_8a1b63189e';
const DAY_NOTE = 'TEST_ONLY_REMOTE_GARDEN_NOTE';
const instances = new Set();
const releases = new Set();
function delayed(register) { return new Promise(resolve => { const release = () => { releases.delete(release); resolve(); }; releases.add(release); register(release); }); }

function fileFor(url) {
  const parsed = new URL(url, T.BASE + '/');
  if (parsed.origin !== T.BASE_ORIGIN) return null;
  const base = new URL(T.BASE + '/').pathname;
  if (!parsed.pathname.startsWith(base)) return null;
  const filename = path.resolve(ROOT, parsed.pathname.slice(base.length) || 'index.html');
  return filename.startsWith(ROOT + path.sep) ? filename : null;
}
function json(body, status = 200) { return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } }); }
function health() { return json({ ready: true, service: 'patient-cabinet', apiVersion: 2, auth: { parent: 'email', doctor: 'unavailable' } }); }
function q(env, selector) { const element = env.document.querySelector(selector); assert.ok(element, 'Missing: ' + selector); return element; }
function text(env) { return q(env, '#app').textContent; }
function click(env, selector) { const element = q(env, selector); assert.ok(!element.matches(':disabled'), 'Disabled: ' + selector); element.click(); }
function input(env, selector, value, type = 'input') { const element = q(env, selector); assert.ok(!element.matches(':disabled')); element.value = value; element.dispatchEvent(new env.window.Event(type, { bubbles: true })); }
function submit(env, selector) { q(env, selector).dispatchEvent(new env.window.Event('submit', { bubbles: true, cancelable: true })); }
function nav(env, target) { click(env, `[data-nav="${target}"]`); }
function copies(env) { return JSON.stringify({ local: { ...env.window.localStorage }, session: { ...env.window.sessionStorage } }); }
function assertPrivateMemoryOnly(env) {
  const storage = copies(env);
  for (const privateValue of [...Object.values(PARENT), TOKEN, DAY_NOTE]) assert.ok(!storage.includes(privateValue), 'Private data must not enter localStorage/sessionStorage: ' + privateValue);
}

async function open(options = {}) {
  const state = { errors: [], requests: [], api: [], external: [], pending: new Set() };
  class Resources extends ResourceLoader {
    fetch(url, opts) {
      if (opts?.element?.localName === 'iframe') return null;
      const filename = fileFor(url);
      if (!filename) return null;
      if (path.basename(filename) === 'cabinet-config.js' && options.config !== undefined) return Promise.resolve(Buffer.from('window.VDCabinetConfig=Object.freeze(' + JSON.stringify(options.config) + ');'));
      return fs.readFile(filename).catch(() => null);
    }
  }
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', error => {
    if (/unhandled|Uncaught/.test(error.type + ' ' + error.message)) state.errors.push(error.cause?.stack || error.detail?.stack || error.message);
  });
  const dom = new JSDOM(await fs.readFile(path.join(ROOT, 'index.html'), 'utf8'), {
    url: T.BASE + '/', runScripts: 'dangerously', resources: new Resources(), pretendToBeVisual: true, virtualConsole,
    beforeParse(window) {
      window.AbortController = AbortController; window.Headers = Headers; window.Response = Response; window.Request = Request;
      window.matchMedia = () => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} });
      window.scrollTo = () => {}; window.HTMLElement.prototype.scrollIntoView = () => {};
      window.URL.createObjectURL = () => T.BASE + '/test-blob'; window.URL.revokeObjectURL = () => {};
      window.fetch = (value, init = {}) => {
        const url = new URL(String(value), T.BASE + '/');
        const request = { url: url.href, action: url.searchParams.get('action'), method: init.method || 'GET', body: init.body ? JSON.parse(init.body) : undefined, headers: init.headers || {}, init };
        state.requests.push(request);
        const operation = (async () => {
          if (T.isPrivateAPI(url.href)) {
            state.api.push(request);
            assert.equal(url.origin, T.BASE_ORIGIN, 'Private API must share the cabinet origin');
            assert.equal(init.cache, 'no-store');
            assert.equal(init.credentials, 'omit');
            assert.equal(init.redirect, 'error');
            assert.equal(init.referrerPolicy, 'no-referrer');
            assert.ok(!url.href.includes(TOKEN) && !url.href.includes(PARENT.email), 'Secrets must not enter URL');
            if (!options.api) throw new Error('No private API is available in this scenario');
            return options.api(request);
          }
          const filename = fileFor(url.href);
          if (!filename) { state.external.push(url.href); throw new Error('External network disabled'); }
          try { return new Response(await fs.readFile(filename), { status: 200, headers: { 'Content-Type': filename.endsWith('.json') ? 'application/json' : 'text/plain' } }); }
          catch { return new Response('', { status: 404 }); }
        })();
        state.pending.add(operation); operation.finally(() => state.pending.delete(operation)).catch(() => {});
        return operation;
      };
    }
  });
  const env = { dom, window: dom.window, document: dom.window.document, state };
  instances.add(env);
  await T.eventually(() => {
    if (state.errors.length) throw new Error(state.errors.join('\n'));
    return env.window.VDCabinetReady && env.document.readyState === 'complete' && env.document.querySelector('#pc-email-form, #pc-demo-auth-form');
  }, 'cabinet sign-in scripts initialize', 12000);
  return env;
}
async function close(env) {
  if (!instances.has(env)) return;
  env.window.dispatchEvent(new env.window.Event('pagehide'));
  await Promise.allSettled([...env.state.pending]);
  await new Promise(resolve => setImmediate(resolve));
  env.window.close(); instances.delete(env);
}
async function ready(env) { await T.eventually(() => env.document.querySelector('#pc-email-form fieldset')?.disabled === false, 'email service ready'); }
async function requestRegistration(env) {
  await ready(env); click(env, '[data-pc="email-intent"][data-intent="register"]');
  input(env, '#pc-parent-name', PARENT.fullName); input(env, '#pc-parent-email', PARENT.email); input(env, '#pc-parent-phone', PARENT.phone);
  submit(env, '#pc-email-form');
  await T.eventually(() => env.document.querySelector('#pc-email-code-form'), 'OTP challenge appears');
}
async function verify(env, code = '123456') { input(env, '#pc-email-code', code); submit(env, '#pc-email-code-form'); }
async function addChild(env, name) {
  nav(env, 'add-child'); input(env, '#pc-child-name', name); submit(env, '#pc-child-form');
  await T.eventually(() => env.document.querySelector('.pc-account') && text(env).includes(name), 'remote child created');
}
async function openDay(env, childId) {
  nav(env, 'family'); click(env, `[data-pc-child="${childId}"]`); nav(env, 'garden');
  await T.eventually(() => env.document.querySelector('[data-action="open-today"]'), 'remote garden loaded');
  click(env, '[data-action="open-today"]');
  await T.eventually(() => env.document.querySelector('#pc-day-form'), 'remote day form');
}

async function run() {
  let passed = 0; const pass = label => { passed++; console.log(`PASS ${passed}: ${label}`); };
  const audited = [];
  try {
    const demo = await open(); audited.push(demo);
    assert.equal(demo.document.querySelector('#pc-email-form, #pc-email-code-form'), null);
    click(demo, '[data-pc="demo-intent"][data-intent="register"]');
    for (const selector of ['#pc-demo-parent-name', '#pc-demo-parent-email', '#pc-demo-parent-phone']) assert.ok(!q(demo, selector).matches(':disabled'));
    assert.match(text(demo), /демо/i);
    assert.match(text(demo), /письм.*не отправ|без.*код|код.*не/i);
    input(demo, '#pc-demo-parent-name', T.FAMILY_B);
    input(demo, '#pc-demo-parent-email', T.DEMO_EMAIL_B);
    input(demo, '#pc-demo-parent-phone', T.DEMO_PHONE_B);
    submit(demo, '#pc-demo-auth-form');
    await T.eventually(() => demo.document.querySelector('.pc-account'), 'demo registration enters without a code');
    assert.equal(demo.document.querySelector('#pc-email-code-form'), null);
    assert.ok(q(demo, '.pc-demo-notice'));
    assert.equal(demo.state.api.length, 0, 'Local demo registration must not request health, email or auth');
    pass('Unconfigured demo registration works locally and never invents or sends an email code');

    for (const config of [
      { ...CONFIG, apiUrl: 'https://untrusted-api.example.test/local/api/patient-cabinet.php' },
      { ...CONFIG, bookingWidgetUrl: T.BASE + '/booking-widget.html' }
    ]) {
      const invalid = await open({ config }); audited.push(invalid);
      assert.equal(invalid.window.VDCabinetAPI.configured, false);
      assert.equal(q(invalid, '#pc-email-form fieldset').disabled, true);
      assert.equal(invalid.document.querySelector('#pc-demo-auth-form, [data-pc="demo-enter"], [data-pc="demo-doctor"]'), null, 'Invalid private configuration must not downgrade to demo access');
      assert.equal(invalid.state.api.length, 0);
      assert.equal(invalid.state.external.length, 0);
    }
    pass('Private sign-in refuses a cross-origin API or a booking widget sharing the private cabinet origin');

    let healthAvailable = false;
    const unavailable = await open({ config: CONFIG, api: req => {
      assert.equal(req.action, 'health');
      return healthAvailable ? health() : json({ ok: false, code: 'UNAVAILABLE' }, 503);
    } }); audited.push(unavailable);
    await T.eventually(() => unavailable.document.querySelector('[data-pc="email-health"]'), 'outage recovery control');
    assert.equal(q(unavailable, '#pc-email-form fieldset').disabled, true);
    assert.equal(unavailable.document.querySelector('[data-pc="demo-enter"], [data-pc="demo-doctor"]'), null, 'Configured private cabinet cannot fall back to an unauthenticated demo chooser');
    healthAvailable = true; click(unavailable, '[data-pc="email-health"]'); await ready(unavailable);
    pass('Configured service outage fails closed and recovers after an explicit retry');

    const children = [], entries = new Map(); let releaseSave, delayedSave = false, unauthorized = false;
    const parentAccount = { id: 'parent_test', role: 'parent', displayName: PARENT.fullName, emailMasked: 'p***@example.test', phoneMasked: '+7***1122' };
    const session = () => ({ token: TOKEN, expiresAt: new Date(Date.now() + 1800000).toISOString(), account: parentAccount, children: children.map(c => ({ ...c })) });
    const garden = id => ({ garden: { entries: { ...(entries.get(id) || {}) }, recommendations: {}, updatedAt: null } });
    const env = await open({ config: CONFIG, api: async req => {
      if (req.action === 'health') return health();
      if (req.action === 'request-code') return json({ challengeId: 'synthetic_challenge', emailMasked: 'p***@example.test', expiresIn: 600, retryAfter: 60 });
      if (req.action === 'verify-code') return req.body.code === '123456' ? json(session()) : json({ ok: false, code: 'INVALID_CODE' }, 422);
      assert.equal(req.headers.Authorization, 'Bearer ' + TOKEN, 'Private requests use the in-memory bearer');
      if (req.action === 'logout') return json({ ok: true });
      if (unauthorized) return json({ ok: false, code: 'UNAUTHORIZED' }, 401);
      if (req.action === 'children') {
        const child = { id: 'remote_child_' + (children.length + 1), name: req.body.name, birthDate: req.body.birthDate || '', relationship: req.body.relationship, doctorAssignment: { status: 'unassigned', doctors: [] } };
        children.push(child); return json({ child });
      }
      if (req.action === 'me') return json({ account: parentAccount, children });
      if (req.action === 'garden') {
        const id = new URL(req.url).searchParams.get('childId');
        assert.ok(children.some(c => c.id === id));
        if (req.method === 'PUT') {
          if (delayedSave) await delayed(release => { releaseSave = release; });
          const previous = entries.get(id) || {};
          entries.set(id, { ...previous, [req.body.date]: { ...(previous[req.body.date] || {}), ...req.body.entry } });
        }
        return json(garden(id));
      }
      throw new Error('Unexpected private route: ' + req.action);
    } }); audited.push(env);
    await requestRegistration(env);
    const request = env.state.api.find(req => req.action === 'request-code');
    assert.deepEqual(request.body, { email: PARENT.email, intent: 'register', fullName: PARENT.fullName, phone: PARENT.phone });
    assert.equal(request.method, 'POST'); assert.equal(request.headers.Authorization, undefined);
    assert.ok(q(env, '[data-pc="email-resend"]').disabled, 'A code cannot be immediately re-sent');
    assertPrivateMemoryOnly(env);
    await verify(env, 'abc');
    assert.equal(env.state.api.filter(req => req.action === 'verify-code').length, 0, 'Malformed OTP is rejected before transmission');
    await verify(env, '000000');
    await T.eventually(() => env.document.querySelector('#pc-email-code-form [role="alert"]'), 'invalid code error');
    assert.equal(env.window.VDCabinet.isActive(), false);
    assert.equal(env.document.querySelector('.pc-account'), null, 'Wrong OTP must not create a session');
    await verify(env);
    await T.eventually(() => env.document.querySelector('.pc-account'), 'verified parent opens private cabinet');
    assert.equal(env.window.VDCabinet.isActive(), true);
    assert.equal(env.document.querySelector('[data-pc-child]'), null, 'New verified parent starts without children');
    assert.equal(env.document.querySelector('.pc-demo-notice'), null, 'Real cabinet must not be described as local demo');
    assertPrivateMemoryOnly(env);
    pass('Registration sends FIO, phone and email to the clinic API; only a verified email code opens the parent cabinet');

    await addChild(env, 'Тестовый ребёнок Один'); await addChild(env, 'Тестовый ребёнок Два');
    await openDay(env, children[0].id);
    input(env, '#pc-day-note', DAY_NOTE); click(env, '[data-pc-mark="meal"][data-pc-value="done"]');
    delayedSave = true; submit(env, '#pc-day-form');
    await T.eventually(() => typeof releaseSave === 'function', 'remote save pending');
    const secondPicker = q(env, `[data-pc-child="${children[1].id}"]`);
    const canSwitch = !secondPicker.matches(':disabled');
    if (canSwitch) { secondPicker.click(); await T.eventually(() => env.document.querySelector('#pc-day-form') && text(env).includes(children[1].name), 'second child shown during first save'); }
    delayedSave = false; releaseSave();
    if (canSwitch) await T.eventually(() => env.document.querySelector('#pc-day-form button[type="submit"]')?.disabled === false, 'second child form re-enabled after another child save');
    else await T.eventually(() => !env.document.querySelector('#pc-day-form'), 'blocked switch completes first save');
    await openDay(env, children[1].id);
    assert.equal(q(env, '#pc-day-note').value, '');
    assert.equal(q(env, 'input[type="checkbox"][data-pc-mark="meal"]').checked, false);
    await openDay(env, children[0].id);
    assert.equal(q(env, '#pc-day-note').value, DAY_NOTE);
    assert.equal(q(env, 'input[type="checkbox"][data-pc-mark="meal"]').checked, true);
    assertPrivateMemoryOnly(env);
    pass('Remote diary saves the selected child/date and remains usable when switching children during a delayed save');

    unauthorized = true; nav(env, 'family'); nav(env, 'profile');
    nav(env, 'garden');
    const nextMonth = T.previousMonth(T.today().slice(0, 7));
    const currentGardenMonth = env.window.eval('S.gardenMonth');
    if (currentGardenMonth !== nextMonth) click(env, '[data-month="-1"]');
    await T.eventually(() => env.document.querySelector('#pc-email-form'), 'expired session returns to email sign-in');
    assert.equal(env.window.VDCabinet.isActive(), false);
    assert.ok(!text(env).includes(DAY_NOTE) && !text(env).includes(PARENT.fullName));
    assert.equal(env.document.querySelector('[data-pc="demo-enter"]'), null);
    assertPrivateMemoryOnly(env);
    pass('A rejected session clears the private view and returns to email sign-in without demo fallback');

    let releaseVerification;
    const stale = await open({ config: CONFIG, api: async req => {
      if (req.action === 'health') return health();
      if (req.action === 'request-code') return json({ challengeId: 'late_challenge', emailMasked: 'p***@example.test', expiresIn: 600, retryAfter: 60 });
      if (req.action === 'verify-code') { await delayed(release => { releaseVerification = release; }); return json(session()); }
      if (req.action === 'logout') return json({ ok: true });
      throw new Error('Unexpected action in stale response test');
    } }); audited.push(stale);
    await requestRegistration(stale); await verify(stale);
    await T.eventually(() => typeof releaseVerification === 'function', 'verification pending');
    click(stale, '[data-pc="guest"]');
    releaseVerification();
    await Promise.allSettled([...stale.state.pending]);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(stale.window.VDCabinet.isActive(), false, 'Leaving sign-in cancels the pending attempt');
    assert.equal(stale.document.querySelector('.pc-account'), null);
    await T.eventually(() => stale.state.api.some(req => req.action === 'logout' && req.headers.Authorization === 'Bearer ' + TOKEN), 'late unused session is revoked on the server');
    assertPrivateMemoryOnly(stale);
    pass('A late code-verification response cannot sign a user in after they leave the sign-in screen');

    for (const checked of audited) {
      await Promise.allSettled([...checked.state.pending]);
      assert.deepEqual(checked.state.errors, []);
      assert.deepEqual(checked.state.external, [], 'No real external network or email provider requests');
    }
    console.log(JSON.stringify({ passed, realEmail: 0, realSMS: 0, realNetwork: 0, verification: 'DOM behavior with synthetic API responses; not live SMTP delivery' }, null, 2));
  } finally { for (const release of [...releases]) release(); for (const env of [...instances]) await close(env); }
}
run().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
