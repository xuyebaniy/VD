#!/usr/bin/env node
'use strict';

/* Trusted Medihost demo embed on the app origin: no storage-isolation claim.
 * The loader and its two public read endpoints are controlled fixtures. Real
 * browser XHR uses credentials and ACAO derived from posted site, so opaque
 * Origin:null fails exactly as the earlier integration did. No live provider
 * request or appointment submission is made by this suite.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const T = require('./demo-ui.cjs');
const WIDGET_URL = new URL('booking-widget.html', T.BASE + '/').href;
const LOADER_URL = 'https://api.medihost.ru/v2/ScheduleFrame/code/48196';
const INDEX_URL = 'https://api.medihost.ru/v2/ScheduleFrame/index/48196?resource_id=&group_id=0&is_orders=0&one_group=0&info_table=0&info_table_days=0';
const RESOURCES_URL = 'https://api.medihost.ru/v2/clinic/get_schedule_resources_alternative/48196?frame=1';
const MARKER_KEY = 'vd_booking_profile_audit';
const MARKER = 'SYNTHETIC_PARENT_PROFILE_MUST_NOT_BE_SENT';
const BOOKING_DRAFT = 'SYNTHETIC_UNSUBMITTED_BOOKING_DRAFT';
const QA_DIR = process.env.VD_QA_DIR || path.resolve(__dirname, '../../qa-demo-ui');
const PUBLIC_CATALOG = { ok: true, source: 'https://vash-doc.ru/specialists/', updated: '2026-11-22T00:00:00Z', doctors: [{ id: 90001, name: 'Тестовый врач для проверки обновления', specialty: 'Тестовая специальность', photo: null, url: null, schedule: '' }] };
const INDEX_HTML = '<style>#scheduleframe{max-width:100%}input,button{max-width:100%}</style><div id="order" class="clinic-page"><div id="schedule-area"><div class="loading">Загрузка тестового расписания…</div></div></div>';
const READY_HTML = '<div class="schedule-group-alternative"><button type="button" class="schedule-group-name" data-group-id="90001">Тестовое направление</button><div class="schedule-group-resources"><label>Тестовый черновик <input id="fixture-booking-input" autocomplete="off"></label></div></div>';

// Reproduce the provider's public read contract with genuine browser XHR.
const LOADER_FIXTURE = `(function(){
  document.write('<div id="scheduleframe"></div>');
  function start(){
    document.documentElement.dataset.fixtureOrigin=window.origin;
    var holder=document.getElementById('scheduleframe');
    function failed(){var area=document.getElementById('schedule-area')||holder;area.innerHTML='<div class="schedule-error">Тестовый сервис расписания недоступен.</div>';}
    function read(url,fields,success){
      var xhr=new XMLHttpRequest();xhr.open('POST',url);xhr.withCredentials=true;
      xhr.setRequestHeader('Content-Type','application/x-www-form-urlencoded; charset=UTF-8');
      xhr.onload=function(){if(xhr.status>=200&&xhr.status<300)success(xhr.responseText);else failed();};xhr.onerror=failed;
      xhr.send(new URLSearchParams(fields).toString());
    }
    var site=location.protocol+'//'+location.host;
    read(${JSON.stringify(INDEX_URL)},{site:site,domain:location.hostname},function(html){
      holder.innerHTML=html;
      read(${JSON.stringify(RESOURCES_URL)},{site:site,week:'0',filter:'',olk:'',order_type:'',label:''},function(text){
        document.getElementById('schedule-area').innerHTML=JSON.parse(text).content;
      });
    });
  }
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',start,{once:true});else start();
})();`;

async function compactParent(page) {
  const content = page.locator('#content');
  assert.equal(await content.locator('h1').innerText(), 'Запись на приём');
  assert.equal(await content.locator('iframe').count(), 1);
  assert.equal(await content.locator('img, a:visible, button:visible, p:visible').count(), 0, 'Ready shell must contain only title and widget, without logos, duplicate instructions or recovery buttons');
  assert.equal(await content.locator('#vd-booking-fallback, #vd-booking-open, #vd-booking-call').count(), 0);
}
async function widgetFrame(page) {
  await page.locator('#vd-booking-frame').waitFor({ state: 'visible' });
  const handle = await page.locator('#vd-booking-frame').elementHandle();
  const frame = await handle.contentFrame();
  assert.ok(frame);
  await frame.locator('#vd-widget-status').waitFor({ state: 'attached' });
  return frame;
}
async function stateOf(frame) { return frame.locator('#vd-widget-status').getAttribute('data-state'); }
async function ready(frame) {
  await frame.locator('#schedule-area .schedule-group-name[data-group-id]').waitFor({ state: 'visible' });
  await T.eventually(async () => await stateOf(frame) === 'ready', 'actual schedule controls declare readiness');
  assert.equal(await frame.locator('#vd-widget-status').isVisible(), false);
  assert.equal(await frame.locator('#vd-widget-retry').isVisible(), false);
}
async function neutralFailure(frame, expectedState) {
  await T.eventually(async () => await stateOf(frame) === expectedState, expectedState + ' widget state');
  assert.equal(await frame.locator('#vd-widget-status').isVisible(), true);
  assert.equal(await frame.locator('#vd-widget-retry').isVisible(), true);
  assert.doesNotMatch(await frame.locator('#vd-widget-status').innerText(), /проверьте.{0,30}(интернет|соединен)|нет.{0,20}(интернет|соединен)|отсутствует.{0,20}(интернет|соединен)/i, 'Online provider failure must not be diagnosed as an internet failure');
}

async function run() {
  const { chromium } = require('playwright');
  await fs.mkdir(QA_DIR, { recursive: true });
  const launch = { headless: true, args: ['--no-sandbox'] };
  if (process.env.CHROMIUM_PATH) launch.executablePath = process.env.CHROMIUM_PATH;
  else if (!process.env.CI) launch.executablePath = '/usr/bin/chromium';
  const browser = await chromium.launch(launch);
  const runs = [], errors = [];
  let lastPage, passed = 0;
  const pass = text => console.log(`PASS ${++passed}: ${text}`);

  async function setup(mode = 'ready') {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    const state = { mode, documents: 0, loaders: 0, catalogs: 0, calls: [], requests: [], forbidden: [], held: [], inFlight: new Set(), workers: [] };
    runs.push({ context, state });
    context.on('serviceworker', worker => state.workers.push(worker.url()));
    await context.addInitScript(({ origin, key, marker }) => {
      if (window === window.top && location.origin === origin) {
        localStorage.setItem(key, marker);
        window.__vdWidgetMessages = [];
        window.addEventListener('message', event => { if (event.data?.type === 'vd-medihost-widget') window.__vdWidgetMessages.push(event.data); });
      }
    }, { origin: T.BASE_ORIGIN, key: MARKER_KEY, marker: MARKER });
    await context.route('**/*', route => {
      const operation = (async () => {
        const request = route.request(), url = new URL(request.url());
        const record = { method: request.method(), url: url.href, body: request.postData() || '' };
        state.requests.push(record);
        if (T.isPrivateAPI(url.href)) { state.forbidden.push(record); return route.abort('blockedbyclient'); }
        if (url.origin === T.BASE_ORIGIN && request.method() === 'GET') {
          if (url.href === WIDGET_URL) state.documents++;
          if (url.pathname === new URL('data/doctors.json', T.BASE + '/').pathname) {
            state.catalogs++;
            return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(PUBLIC_CATALOG) });
          }
          return route.continue();
        }
        if (url.href === LOADER_URL && request.method() === 'GET') {
          state.loaders++;
          return route.fulfill({ status: 200, contentType: 'application/javascript', body: LOADER_FIXTURE });
        }
        if ([INDEX_URL, RESOURCES_URL].includes(url.href) && request.method() === 'POST') {
          const fields = new URLSearchParams(record.body), headers = await request.allHeaders();
          const allowed = (url.href === INDEX_URL ? ['site', 'domain'] : ['site', 'week', 'filter', 'olk', 'order_type', 'label']).sort();
          assert.deepEqual([...fields.keys()].sort(), allowed, 'Only public schedule query fields may be sent');
          state.calls.push({ url: url.href, origin: headers.origin, site: fields.get('site'), domain: fields.get('domain') });
          const cors = { 'Access-Control-Allow-Origin': fields.get('site'), 'Access-Control-Allow-Credentials': 'true', 'Vary': 'Origin' };
          if (url.href === INDEX_URL) return route.fulfill({ status: 200, headers: cors, contentType: 'text/html; charset=utf-8', body: INDEX_HTML });
          let mode = state.mode;
          if (mode === 'hold') mode = await new Promise(resolve => state.held.push(resolve));
          if (mode === 'blocked') return route.abort('blockedbyclient');
          if (mode === 'http-error') return route.fulfill({ status: 503, headers: cors, contentType: 'text/plain', body: 'Controlled schedule error' });
          const content = mode === 'empty' ? '<div class="no-found-filter">Нет доступных специалистов в данной клинике. Попробуйте записаться по телефону.</div>' : READY_HTML;
          return route.fulfill({ status: 200, headers: cors, contentType: 'application/json', body: JSON.stringify({ content, max_week: true }) });
        }
        state.forbidden.push(record);
        return route.abort('blockedbyclient');
      })();
      state.inFlight.add(operation);
      return operation.finally(() => state.inFlight.delete(operation));
    });
    const page = await context.newPage();
    lastPage = page;
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(T.BASE + '/', { waitUntil: 'domcontentloaded' });
    await page.locator('[data-pc="guest"]').click();
    await page.locator('[data-nav="booking"]').first().click();
    return { context, page, state, frame: await widgetFrame(page) };
  }

  try {
    const normal = await setup();
    await ready(normal.frame);
    await T.eventually(async () => await normal.page.locator('#vd-booking-status').getAttribute('data-state') === 'ready', 'parent receives wrapper state');
    await compactParent(normal.page);
    assert.equal(new URL(await normal.page.locator('#vd-booking-frame').getAttribute('src'), T.BASE + '/').href, WIDGET_URL);
    const sandbox = (await normal.page.locator('#vd-booking-frame').getAttribute('sandbox') || '').split(/\s+/);
    for (const permission of ['allow-scripts', 'allow-forms', 'allow-same-origin', 'allow-popups', 'allow-popups-to-escape-sandbox']) assert.ok(sandbox.includes(permission), permission);
    assert.ok(!sandbox.includes('allow-top-navigation'));
    assert.equal(await normal.frame.evaluate(() => window.origin), T.BASE_ORIGIN, 'Actual widget origin must not be opaque null');
    assert.equal(await normal.frame.locator('html').getAttribute('data-fixture-origin'), T.BASE_ORIGIN);
    assert.ok(normal.state.calls.some(call => call.url === INDEX_URL));
    assert.ok(normal.state.calls.some(call => call.url === RESOURCES_URL));
    for (const call of normal.state.calls) {
      assert.equal(call.origin, T.BASE_ORIGIN, 'Browser-generated CORS Origin must not be null');
      assert.equal(call.site, call.origin, 'Posted site must match browser Origin and response ACAO');
    }
    pass('Compact trusted widget completes fixture CORS with Origin equal to site and becomes ready on actual schedule controls');

    const originalElement = await normal.page.locator('#vd-booking-frame').elementHandle();
    const documentCount = normal.state.documents, loaderCount = normal.state.loaders;
    let topNavigations = 0;
    const trackTopNavigation = frame => { if (frame === normal.page.mainFrame()) topNavigations++; };
    normal.page.on('framenavigated', trackTopNavigation);
    await normal.frame.locator('#fixture-booking-input').fill(BOOKING_DRAFT);
    assert.equal(await normal.page.evaluate(() => document.activeElement?.id), 'vd-booking-frame');
    const preserve = async label => {
      await normal.page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      assert.equal(await normal.page.evaluate(element => document.querySelector('#vd-booking-frame') === element, originalElement), true, label + ': iframe node preserved');
      assert.equal(await normal.frame.locator('#fixture-booking-input').inputValue(), BOOKING_DRAFT, label + ': entered draft preserved');
      assert.equal(normal.state.documents, documentCount, label + ': wrapper not reloaded');
      assert.equal(normal.state.loaders, loaderCount, label + ': provider not reloaded');
      assert.equal(topNavigations, 0, label + ': parent not reloaded');
    };
    await normal.page.evaluate(() => render({ keepScroll: true })); await preserve('Same-page render');
    const beforeSync = normal.state.catalogs;
    await normal.page.evaluate(() => vdStartSync());
    assert.ok(normal.state.catalogs > beforeSync);
    assert.equal(await normal.page.evaluate(() => VD_LIVE.catalogStatus), 'connected');
    await preserve('Public directory sync');
    await normal.page.clock.setFixedTime(new Date(Date.now() + 181000));
    assert.equal(await normal.page.evaluate(() => document.visibilityState), 'visible');
    const beforeForeground = normal.state.catalogs;
    await normal.page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    await T.eventually(() => normal.state.catalogs > beforeForeground, 'foreground public directory request');
    await T.eventually(async () => await normal.page.evaluate(() => VD_LIVE.catalogStatus) === 'connected', 'foreground sync completes');
    await preserve('Foreground sync');
    await normal.page.evaluate(async () => { navigator.serviceWorker.dispatchEvent(new Event('controllerchange')); await new Promise(resolve => setTimeout(resolve, 100)); });
    await preserve('Service-worker controllerchange with iframe focus');
    normal.page.off('framenavigated', trackTopNavigation);
    pass('Unsubmitted widget input survives render, directory/foreground updates and controllerchange');

    const messages = await normal.page.evaluate(() => {
      const frame = document.getElementById('vd-booking-frame');
      const snapshot = () => ({ height: frame.style.height, state: document.getElementById('vd-booking-status').dataset.state });
      const cases = [];
      const send = (origin, source, data) => { const before = snapshot(); window.dispatchEvent(new MessageEvent('message', { origin, source, data })); cases.push({ before, after: snapshot() }); };
      const valid = { type: 'vd-medihost-widget', state: 'ready', height: 777 };
      send('null', frame.contentWindow, valid);
      send('https://unrelated.invalid', frame.contentWindow, valid);
      send(location.origin, window, valid);
      send(location.origin, frame.contentWindow, { ...valid, form: { unexpected: true } });
      send(location.origin, frame.contentWindow, { ...valid, state: 'appointment-confirmed' });
      send(location.origin, frame.contentWindow, { ...valid, height: 777.5 });
      window.dispatchEvent(new MessageEvent('message', { origin: location.origin, source: frame.contentWindow, data: valid }));
      window.__vdOldWidgetWindow = frame.contentWindow;
      return { cases, validHeight: frame.style.height };
    });
    for (const result of messages.cases) assert.deepEqual(result.after, result.before, 'Wrong origin/source or unsupported message fields must be ignored');
    assert.equal(messages.validHeight, '777px', 'A narrow message from the current same-origin widget is accepted');
    await normal.page.locator('[data-nav="doctors"]').first().click();
    await normal.page.locator('#vd-booking-frame').waitFor({ state: 'detached' });
    await normal.page.locator('[data-nav="booking"]').first().click();
    const reopened = await widgetFrame(normal.page); await ready(reopened);
    assert.equal(await normal.page.evaluate(element => document.querySelector('#vd-booking-frame') === element, originalElement), false);
    assert.equal(await reopened.locator('#fixture-booking-input').inputValue(), '');
    const stale = await normal.page.evaluate(() => {
      const frame = document.getElementById('vd-booking-frame'), before = frame.style.height;
      window.dispatchEvent(new MessageEvent('message', { origin: location.origin, source: window.__vdOldWidgetWindow, data: { type: 'vd-medihost-widget', state: 'ready', height: 888 } }));
      return { before, after: frame.style.height };
    });
    assert.equal(stale.after, stale.before, 'A previous widget window cannot change the current frame');
    await T.eventually(async () => await normal.page.locator('#vd-booking-status').getAttribute('data-state') === 'ready', 'new wrapper reports ready');
    await compactParent(normal.page);
    await normal.page.locator('#content').evaluate(element => { element.scrollTop = 0; });
    await normal.page.screenshot({ path: path.join(QA_DIR, 'booking-fixture-compact.png'), fullPage: true });
    pass('Only exact origin, current window and narrow state/height messages are accepted; navigation opens a fresh widget');

    for (const mode of ['blocked', 'http-error']) {
      const scenario = await setup(mode); await neutralFailure(scenario.frame, 'error');
      assert.equal(await scenario.frame.locator('#schedule-area .schedule-group-name').count(), 0);
      const parentNode = await scenario.page.locator('#vd-booking-frame').elementHandle();
      const parentMount = await scenario.page.locator('#vd-booking-mount').elementHandle();
      const saved = await scenario.page.evaluate(key => localStorage.getItem(key), T.STORAGE_KEY);
      const beforeRetry = scenario.state.documents;
      scenario.state.mode = 'ready';
      await scenario.frame.locator('#vd-widget-retry').click();
      await T.eventually(() => scenario.state.documents > beforeRetry, 'retry reloads the wrapper only');
      await ready(await widgetFrame(scenario.page));
      assert.equal(await scenario.page.evaluate(element => document.querySelector('#vd-booking-frame') === element, parentNode), true, 'In-widget retry preserves the parent iframe node');
      assert.equal(await scenario.page.evaluate(element => document.querySelector('#vd-booking-mount') === element, parentMount), true);
      assert.equal(await scenario.page.evaluate(key => localStorage.getItem(key), T.STORAGE_KEY), saved);
      await T.eventually(async () => await scenario.page.locator('#vd-booking-status').getAttribute('data-state') === 'ready', 'retried wrapper reports ready');
      await compactParent(scenario.page);
      pass(mode + ': provider error shows retry only when needed; retry preserves the parent demo');
    }

    const slow = await setup('hold');
    await T.eventually(() => slow.state.held.length > 0, 'provider response held after initial HTML');
    assert.equal(await stateOf(slow.frame), 'loading');
    assert.equal(await slow.frame.locator('#vd-widget-retry').isVisible(), false);
    assert.ok(await slow.frame.locator('#scheduleframe style, #schedule-area .loading').count());
    // Wait for the production 18-second timer, without replacing its clock.
    await T.eventually(async () => await stateOf(slow.frame) === 'slow', 'bounded provider timeout', 22000);
    await neutralFailure(slow.frame, 'slow');
    slow.state.held.splice(0).forEach(resolve => resolve('ready')); await ready(slow.frame);
    pass('Initial styles and a loader never mean ready; a slow request gets a neutral timeout and can recover');

    const empty = await setup('empty');
    await T.eventually(async () => await stateOf(empty.frame) === 'empty', 'explicit no-availability response');
    assert.equal(await empty.frame.locator('#schedule-area .schedule-group-name').count(), 0);
    assert.equal(await empty.frame.locator('#vd-widget-retry').isVisible(), false);
    pass('A valid empty schedule is distinct from ready controls and provider failure');

    const offline = await setup('hold');
    await T.eventually(() => offline.state.held.length > 0, 'widget shell loaded before going offline');
    await offline.context.setOffline(true);
    offline.state.held.splice(0).forEach(resolve => resolve('blocked'));
    await T.eventually(async () => await stateOf(offline.frame) === 'offline', 'actual browser offline state');
    assert.equal(await offline.frame.evaluate(() => navigator.onLine), false);
    assert.match(await offline.frame.locator('#vd-widget-status').innerText(), /интернет|подключ|сети|офлайн/i);
    assert.equal(await offline.frame.locator('#vd-widget-retry').isVisible(), true);
    offline.state.mode = 'ready'; await offline.context.setOffline(false);
    const beforeReconnect = offline.state.documents;
    await offline.frame.locator('#vd-widget-retry').click();
    await T.eventually(() => offline.state.documents > beforeReconnect, 'explicit retry after reconnection');
    await ready(await widgetFrame(offline.page));
    await T.eventually(async () => await offline.page.locator('#vd-booking-status').getAttribute('data-state') === 'ready', 'reconnected wrapper reports ready');
    await compactParent(offline.page);
    pass('Offline is distinct from provider failure, and explicit retry recovers after reconnection');

    for (const { context, state } of runs) {
      assert.deepEqual(state.forbidden, [], 'Only local files and explicitly mocked public Medihost reads may be requested');
      assert.deepEqual(state.workers, [], 'HTTP shell must not register service workers');
      const sent = JSON.stringify(state.requests);
      assert.ok(!sent.includes(MARKER) && !sent.includes(BOOKING_DRAFT), 'Stored profile marker and unsent draft must not be transmitted');
      for (const page of context.pages()) {
        const messages = await page.evaluate(() => window.__vdWidgetMessages || []);
        assert.ok(!JSON.stringify(messages).includes(MARKER) && !JSON.stringify(messages).includes(BOOKING_DRAFT));
        assert.equal(await page.evaluate(key => localStorage.getItem(key), MARKER_KEY), MARKER);
      }
    }
    assert.deepEqual(errors, [], 'No uncaught page errors in any widget state');
    console.log(`Booking embed checks complete: ${passed} scenarios passed with local fixtures and no appointment requests.`);
  } catch (error) {
    if (lastPage && !lastPage.isClosed()) await lastPage.screenshot({ path: path.join(QA_DIR, 'booking-fixture-failure.png'), fullPage: true }).catch(() => {});
    throw error;
  } finally {
    for (const { context, state } of runs) {
      state.held.splice(0).forEach(resolve => resolve('blocked'));
      await Promise.allSettled([...state.inFlight]); await context.close();
    }
    await browser.close();
  }
}

if (require.main === module) run().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
