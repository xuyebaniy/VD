#!/usr/bin/env node
'use strict';

/* Deterministic browser checks for the booking boundary and recovery UI.
 * The official document URL is fulfilled by a synthetic fixture; every other
 * external request is blocked. This never contacts Medihost or books a visit.
 * Run with the same HTTP localhost server and Playwright runtime as demo-ui.cjs.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const T = require('./demo-ui.cjs');
const BOOKING_URL = 'https://vash-doc.ru/record.php#scheduleframe';
const BOOKING_ORIGIN = 'https://vash-doc.ru';
const MARKER_KEY = 'vd_booking_origin_probe';
const MARKER = 'SYNTHETIC_PARENT_ONLY_BOOKING_TEST';
const BOOKING_DRAFT = 'SYNTHETIC_UNSUBMITTED_BOOKING_DRAFT';
const PUBLIC_CATALOG = { ok: true, source: 'https://vash-doc.ru/specialists/', updated: '2026-11-22T00:00:00Z', doctors: [{ id: 90001, name: 'Тестовый врач для проверки обновления', specialty: 'Тестовая специальность', photo: null, url: null, schedule: '' }] };
const QA_DIR = process.env.VD_QA_DIR || path.resolve(__dirname, '../../qa-demo-ui');
const FIXTURE = `<!doctype html><html lang="ru"><meta charset="utf-8">
<title>Controlled booking fixture</title><h1>Тестовое окно внешнего сайта</h1>
<p>Эта страница не содержит расписания и не принимает заявки.</p>
<label>Тестовый черновик <input id="fixture-booking-input" autocomplete="off"></label>
<pre id="fixture-probe"></pre><script>
const result = { origin: window.origin };
for (const [key, read] of [
  ['parentDocument', () => parent.document.body.textContent],
  ['parentStorage', () => parent.localStorage.getItem('${MARKER_KEY}')],
  ['ownStorage', () => localStorage.getItem('${MARKER_KEY}')]
]) {
  try { result[key] = { allowed: true, value: read() }; }
  catch (error) { result[key] = { allowed: false, error: error.name }; }
}
document.getElementById('fixture-probe').textContent = JSON.stringify(result);
</script></html>`;

async function assertFallback(page) {
  const fallback = page.locator('#vd-booking-fallback');
  await fallback.waitFor({ state: 'visible' });
  assert.equal(await page.locator('#vd-booking-open').getAttribute('href'), BOOKING_URL);
  assert.equal(await page.locator('#vd-booking-call').getAttribute('href'), 'tel:+74842200540');
  assert.equal(await page.locator('#vd-booking-open').getAttribute('target'), '_blank');
  const rel = (await page.locator('#vd-booking-open').getAttribute('rel') || '').split(/\s+/);
  assert.ok(rel.includes('noopener') && rel.includes('noreferrer'));
  assert.equal(await page.locator('[data-action="vd-booking-retry"]').isEnabled(), true);
  const actionBox = await fallback.boundingBox();
  const frameBox = await page.locator('#vd-booking-frame').boundingBox();
  assert.ok(actionBox && frameBox && actionBox.y + actionBox.height <= frameBox.y + 2, 'Recovery actions must appear above the external frame');
}

async function assertNeutralOnlineStatus(page) {
  const text = await page.locator('#vd-booking-status').innerText();
  assert.doesNotMatch(text, /проверьте.{0,30}(интернет|соединен)|нет.{0,20}(интернет|соединен)|отсутствует.{0,20}(интернет|соединен)/i, 'An online integration failure must not be blamed on the connection');
  assert.doesNotMatch(text, /расписание\s+(?:успешно\s+)?(?:загружено|готово|доступно)|запись\s+подтверждена/i, 'An iframe load event cannot confirm schedule readiness or a booking');
}

async function run() {
  const { chromium } = require('playwright');
  await fs.mkdir(QA_DIR, { recursive: true });
  const launch = { headless: true, args: ['--no-sandbox'] };
  if (process.env.CHROMIUM_PATH) launch.executablePath = process.env.CHROMIUM_PATH;
  else if (!process.env.CI) launch.executablePath = '/usr/bin/chromium';
  const browser = await chromium.launch(launch);
  const runs = [], errors = [];
  let passed = 0, lastPage;
  const pass = message => console.log(`PASS ${++passed}: ${message}`);

  async function setup(mode = 'ok', openShell = true) {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    const state = { mode, documents: 0, catalogs: 0, external: [], forbidden: [], held: [], inFlight: new Set(), workers: [] };
    runs.push({ context, state });
    context.on('serviceworker', worker => state.workers.push(worker.url()));
    await context.addInitScript(({ origin, key, marker }) => {
      if (window === window.top && location.origin === origin) localStorage.setItem(key, marker);
    }, { origin: T.BASE_ORIGIN, key: MARKER_KEY, marker: MARKER });
    await context.route('**/*', route => {
      const operation = (async () => {
        const request = route.request(), url = new URL(request.url());
        if (T.isPrivateAPI(url.href) || request.method() !== 'GET') {
          state.forbidden.push(request.method() + ' ' + url.href);
          return route.abort('blockedbyclient');
        }
        if (url.origin === T.BASE_ORIGIN) {
          if (url.pathname === new URL('data/doctors.json', T.BASE + '/').pathname) {
            state.catalogs++;
            return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(PUBLIC_CATALOG) });
          }
          return route.continue();
        }
        state.external.push(url.href);
        if (url.origin !== BOOKING_ORIGIN || url.pathname !== '/record.php' || url.search || request.resourceType() !== 'document') return route.abort('blockedbyclient');
        state.documents++;
        let responseMode = state.mode;
        if (responseMode === 'hold') responseMode = await new Promise(resolve => state.held.push(resolve));
        if (responseMode === 'blocked' || responseMode === 'offline') return route.abort(responseMode === 'offline' ? 'internetdisconnected' : 'blockedbyclient');
        if (responseMode === 'http-error') return route.fulfill({ status: 503, contentType: 'text/html; charset=utf-8', body: '<!doctype html><meta charset="utf-8"><p id="fixture-http-error">Controlled service unavailable response</p>' });
        return route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: FIXTURE });
      })();
      state.inFlight.add(operation);
      return operation.finally(() => state.inFlight.delete(operation));
    });
    const page = await context.newPage();
    lastPage = page;
    page.on('pageerror', error => errors.push(error.message));
    if (openShell) {
      await page.goto(T.BASE + '/', { waitUntil: 'domcontentloaded' });
      await page.locator('[data-pc="guest"]').click();
    }
    return { context, page, state };
  }

  async function openBooking(page) {
    await page.locator('[data-nav="booking"]').first().click();
    await page.locator('#vd-booking-frame').waitFor({ state: 'visible' });
    await assertFallback(page);
  }
  async function fixtureFrame(page) {
    await page.frameLocator('#vd-booking-frame').locator('#fixture-probe').waitFor({ state: 'visible' });
    const frame = await page.locator('#vd-booking-frame').elementHandle().then(handle => handle.contentFrame());
    assert.ok(frame);
    return frame;
  }

  try {
    const normal = await setup();
    await openBooking(normal.page);
    const frame = await fixtureFrame(normal.page);
    const source = new URL(await normal.page.locator('#vd-booking-frame').getAttribute('src'), T.BASE);
    assert.equal(source.href, BOOKING_URL);
    assert.notEqual(source.origin, T.BASE_ORIGIN);
    const sandbox = (await normal.page.locator('#vd-booking-frame').getAttribute('sandbox') || '').split(/\s+/);
    for (const permission of ['allow-scripts', 'allow-forms', 'allow-same-origin', 'allow-popups', 'allow-popups-to-escape-sandbox']) assert.ok(sandbox.includes(permission), permission);
    assert.ok(!sandbox.includes('allow-top-navigation'));
    const probe = JSON.parse(await frame.locator('#fixture-probe').innerText());
    assert.equal(probe.origin, BOOKING_ORIGIN, 'The provider must receive its real origin, not opaque null');
    for (const key of ['parentDocument', 'parentStorage']) assert.deepEqual(probe[key], { allowed: false, error: 'SecurityError' });
    assert.notEqual(probe.ownStorage.value, MARKER, 'External storage must not expose the parent marker');
    await T.eventually(async () => await normal.page.locator('#vd-booking-status').getAttribute('data-state') === 'loaded', 'external document load observed');
    await assertNeutralOnlineStatus(normal.page);
    assert.match(await normal.page.locator('#vd-booking-status').innerText(), /если расписание не появилось/i);

    const snapshot = () => normal.page.evaluate(() => ({ height: document.querySelector('#vd-booking-frame').style.height, state: document.querySelector('#vd-booking-status').getAttribute('data-state'), text: document.querySelector('#vd-booking-status').textContent }));
    const beforeMessage = await snapshot();
    await frame.evaluate(() => parent.postMessage({ type: 'vd-medihost-widget', state: 'ready', height: 2999 }, '*'));
    await normal.page.evaluate(() => window.postMessage({ type: 'vd-medihost-widget', state: 'ready', height: 2999 }, '*'));
    await normal.page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert.deepEqual(await snapshot(), beforeMessage, 'Arbitrary messages must not promote the booking state or resize the iframe');

    const originalElement = await normal.page.locator('#vd-booking-frame').elementHandle();
    const documentCount = normal.state.documents;
    let topNavigations = 0;
    const trackTopNavigation = navigated => { if (navigated === normal.page.mainFrame()) topNavigations++; };
    normal.page.on('framenavigated', trackTopNavigation);
    await frame.locator('#fixture-booking-input').fill(BOOKING_DRAFT);
    assert.equal(await normal.page.evaluate(() => document.activeElement?.id), 'vd-booking-frame', 'Typing in the provider focuses the iframe in the parent document');
    const assertDraftPreserved = async label => {
      await normal.page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      assert.equal(await normal.page.evaluate(element => document.querySelector('#vd-booking-frame') === element, originalElement), true, label + ': preserve the actual iframe node');
      assert.equal(await frame.locator('#fixture-booking-input').inputValue(), BOOKING_DRAFT, label + ': preserve unsent external input');
      assert.equal(normal.state.documents, documentCount, label + ': do not reload the external document');
      assert.equal(topNavigations, 0, label + ': do not reload the app');
    };
    await normal.page.evaluate(() => render({ keepScroll: true }));
    await assertDraftPreserved('Same-page render');

    const beforeCatalogSync = normal.state.catalogs;
    await normal.page.evaluate(() => vdStartSync());
    assert.ok(normal.state.catalogs > beforeCatalogSync, 'The real catalog sync must request its public JSON fixture');
    assert.equal(await normal.page.evaluate(() => VD_LIVE.catalogStatus), 'connected');
    await assertDraftPreserved('Completed public catalog sync');

    await normal.page.clock.setFixedTime(new Date(Date.now() + 181000));
    assert.equal(await normal.page.evaluate(() => document.visibilityState), 'visible');
    const beforeForegroundSync = normal.state.catalogs;
    await normal.page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    await T.eventually(() => normal.state.catalogs > beforeForegroundSync, 'foreground refresh after three minutes');
    await T.eventually(async () => await normal.page.evaluate(() => VD_LIVE.catalogStatus) === 'connected', 'foreground catalog refresh completes');
    await assertDraftPreserved('Foreground catalog refresh');

    await normal.page.evaluate(async () => {
      if (!navigator.serviceWorker) throw new Error('The browser must expose ServiceWorkerContainer for the controllerchange test');
      navigator.serviceWorker.dispatchEvent(new Event('controllerchange'));
      await new Promise(resolve => setTimeout(resolve, 100));
    });
    await assertDraftPreserved('Service-worker controllerchange while entering a booking');
    normal.page.off('framenavigated', trackTopNavigation);

    await normal.page.locator('[data-nav="doctors"]').first().click();
    await normal.page.locator('#vd-booking-frame').waitFor({ state: 'detached' });
    await openBooking(normal.page);
    const reopenedFrame = await fixtureFrame(normal.page);
    assert.equal(await normal.page.evaluate(element => document.querySelector('#vd-booking-frame') === element, originalElement), false, 'Leaving and returning must mount a new booking document');
    assert.equal(await reopenedFrame.locator('#fixture-booking-input').inputValue(), '', 'A new booking view must not retain a detached external form');
    pass('Guest booking draft survives render, catalog/foreground updates and controllerchange; leaving and returning opens a fresh frame');

    const saved = await normal.page.evaluate(key => localStorage.getItem(key), T.STORAGE_KEY);
    const count = normal.state.documents;
    const beforeRetryFrame = await normal.page.locator('#vd-booking-frame').elementHandle();
    const beforeRetryStatus = await normal.page.locator('#vd-booking-status').elementHandle();
    const beforeRetryFallback = await normal.page.locator('#vd-booking-fallback').elementHandle();
    await normal.page.locator('[data-action="vd-booking-retry"]').click();
    await T.eventually(() => normal.state.documents > count, 'retry requests a new official frame document');
    await fixtureFrame(normal.page);
    assert.equal(await normal.page.evaluate(element => document.querySelector('#vd-booking-frame') === element, beforeRetryFrame), false, 'An explicit retry must replace the external iframe');
    assert.equal(await normal.page.evaluate(element => document.querySelector('#vd-booking-status') === element, beforeRetryStatus), true, 'Retry must preserve the parent status node');
    assert.equal(await normal.page.evaluate(element => document.querySelector('#vd-booking-fallback') === element, beforeRetryFallback), true, 'Retry must preserve parent recovery controls');
    assert.equal(await normal.page.evaluate(key => localStorage.getItem(key), T.STORAGE_KEY), saved, 'Retry must preserve the family demo data');
    assert.equal(await normal.page.evaluate(key => localStorage.getItem(key), MARKER_KEY), MARKER);
    await assertFallback(normal.page);
    await normal.page.screenshot({ path: path.join(QA_DIR, 'booking-fixture-online.png'), fullPage: true });
    pass('Official origin works in the sandbox, cannot access parent data, ignores arbitrary messages, and retries without losing the demo');

    for (const mode of ['blocked', 'http-error']) {
      const scenario = await setup(mode);
      await openBooking(scenario.page);
      await T.eventually(() => scenario.state.documents > 0, mode + ' document requested');
      if (mode === 'http-error') await scenario.page.frameLocator('#vd-booking-frame').locator('#fixture-http-error').waitFor();
      await T.eventually(async () => await scenario.page.locator('#vd-booking-status').getAttribute('data-state') !== 'loading', mode + ' reaches a bounded status', 22000);
      await assertFallback(scenario.page);
      await assertNeutralOnlineStatus(scenario.page);
      pass(mode + ': fallback stays above the frame, no false schedule success or internet diagnosis');
    }

    const slow = await setup('hold');
    await slow.page.clock.install();
    await openBooking(slow.page);
    await T.eventually(() => slow.state.held.length > 0, 'provider document held open');
    await slow.page.clock.fastForward(19000);
    await T.eventually(async () => await slow.page.locator('#vd-booking-status').getAttribute('data-state') === 'slow', 'bounded slow-provider status');
    await assertFallback(slow.page);
    await assertNeutralOnlineStatus(slow.page);
    assert.match(await slow.page.locator('#vd-booking-status').innerText(), /дольше|отдельно|позвон/i);
    slow.state.held.splice(0).forEach(resolve => resolve('ok'));
    await fixtureFrame(slow.page);
    pass('A provider that never finishes gets a bounded neutral timeout with recovery actions');

    const offline = await setup('offline');
    await offline.context.setOffline(true);
    assert.equal(await offline.page.evaluate(() => navigator.onLine), false);
    await openBooking(offline.page);
    await T.eventually(async () => await offline.page.locator('#vd-booking-status').getAttribute('data-state') === 'offline', 'offline status');
    assert.match(await offline.page.locator('#vd-booking-status').innerText(), /интернет|сети|подключ|офлайн/i);
    await assertFallback(offline.page);
    await offline.page.screenshot({ path: path.join(QA_DIR, 'booking-fixture-offline.png'), fullPage: true });
    offline.state.mode = 'ok';
    await offline.context.setOffline(false);
    const beforeRetry = offline.state.documents;
    await offline.page.locator('[data-action="vd-booking-retry"]').click();
    await T.eventually(() => offline.state.documents > beforeRetry, 'manual retry after connectivity returns');
    await fixtureFrame(offline.page);
    await T.eventually(async () => await offline.page.locator('#vd-booking-status').getAttribute('data-state') === 'loaded', 'retried frame loaded');
    await assertNeutralOnlineStatus(offline.page);
    pass('Actual browser offline state is distinguished, and a manual retry recovers after reconnecting');

    const legacy = await setup('ok', false);
    await legacy.page.goto(T.BASE + '/booking-widget.html', { waitUntil: 'domcontentloaded' });
    assert.equal(await legacy.page.locator('script, iframe').count(), 0, 'The legacy same-origin page must not execute third-party code');
    assert.ok(await legacy.page.locator('a[href^="https://vash-doc.ru/record.php"]').count());
    assert.ok(await legacy.page.locator('a[href="tel:+74842200540"]').count());
    assert.deepEqual(legacy.state.external, [], 'Opening the legacy fallback must make no external requests');
    assert.doesNotMatch(await legacy.page.locator('body').innerText(), /проверьте соединение с интернетом/i);
    pass('Legacy wrapper is a safe static link page with no provider scripts or external requests');

    for (const { state } of runs) {
      assert.deepEqual(state.forbidden, [], 'No clinic private API or non-GET request may be attempted');
      assert.deepEqual(state.workers, [], 'The HTTP test shell must not register service workers');
    }
    assert.deepEqual(errors, [], 'No uncaught page errors in any tested booking state');
    console.log(`Booking embed checks complete: ${passed} scenarios passed; all provider responses were local fixtures.`);
  } catch (error) {
    if (lastPage && !lastPage.isClosed()) await lastPage.screenshot({ path: path.join(QA_DIR, 'booking-fixture-failure.png'), fullPage: true }).catch(() => {});
    throw error;
  } finally {
    for (const { context, state } of runs) {
      state.held.splice(0).forEach(resolve => resolve('blocked'));
      await Promise.allSettled([...state.inFlight]);
      await context.close();
    }
    await browser.close();
  }
}

if (require.main === module) run().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
