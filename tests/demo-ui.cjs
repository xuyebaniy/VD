#!/usr/bin/env node
'use strict';

/* Browser checks for the local-only demo. All values entered here are synthetic.
 * No clinic API, SMS provider, or external mutation is used. Start a local static
 * server, then run VD_BASE_URL=http://127.0.0.1:8765 node tests/demo-ui.cjs.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const BASE = (process.env.VD_BASE_URL || 'http://127.0.0.1:8765').replace(/\/$/, '');
const BASE_ORIGIN = new URL(BASE).origin;
if (!/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(BASE_ORIGIN)) throw new Error('Use an HTTP local test server, never a production URL.');
const QA_DIR = process.env.VD_QA_DIR || path.resolve(__dirname, '../../qa-demo-ui');
const STORAGE_KEY = 'vd_cabinet_demo_v1';
const NOTE_MISHA = 'ДЕМО_МИША_ПРОГУЛКА_ТЕСТ';
const NOTE_ANYA = 'ДЕМО_АНЯ_ИГРЫ_ТЕСТ';
const NOTE_B = 'ДЕМО_ДРУГАЯ_СЕМЬЯ_ТЕСТ';
const UNSAVED = 'ДЕМО_НЕСОХРАНЕННЫЙ_ЧЕРНОВИК';
const FAMILY_B = 'Тестовая демосемья Б';
const CHILD_B = 'Тестовый ребёнок Б';
const RECOMM_MISHA = 'ДЕМО: отмечать питание в дневнике Миши';
const RECOMM_ANYA = 'ДЕМО: отмечать прогулки в дневнике Ани';

function today() {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Moscow', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date());
  const value = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return `${value.year}-${value.month}-${value.day}`;
}
function previousMonth(month) {
  const [year, number] = month.split('-').map(Number);
  return number === 1 ? `${year - 1}-12` : `${year}-${String(number - 1).padStart(2, '0')}`;
}

function isPrivateAPI(url) { return /\/local\/api\/|patient-cabinet\.php|vd-garden\/v1/i.test(new URL(url).pathname); }
async function eventually(check, label, timeout = 8000) {
  let last;
  const end = Date.now() + timeout;
  do {
    try { const value = await check(); if (value) return value; } catch (error) { last = error; }
    await new Promise(resolve => setTimeout(resolve, 30));
  } while (Date.now() < end);
  throw last || new Error('Timed out: ' + label);
}

async function blockExternal(context, log) {
  await context.route('**/*', route => {
    const url = route.request().url();
    log.requests.push(url);
    if (isPrivateAPI(url)) { log.privateAPI.push(url); return route.abort('blockedbyclient'); }
    if (new URL(url).origin === BASE_ORIGIN) return route.continue();
    log.external.push(url);
    return route.abort('blockedbyclient');
  });
}
async function nav(page, target) { await page.locator(`[data-nav="${target}"]`).first().click(); }
async function familyChooser(page) {
  await page.locator('[data-pc-view="auth"]').waitFor({ state: 'visible' });
  assert.equal(await page.locator('#pc-phone-form, #pc-code-form, #pc-phone, #pc-code').count(), 0, 'Demo must not offer phone/OTP forms');
}
async function enter(page, id) {
  await familyChooser(page);
  await page.locator(id ? `[data-pc="demo-enter"][data-family-id="${id}"]` : '[data-pc="demo-enter"]').first().click();
  await page.locator('.pc-account').waitFor({ state: 'visible' });
}
async function logout(page) { await nav(page, 'family'); await nav(page, 'profile'); await page.locator('[data-pc="logout"]').click(); await familyChooser(page); }
async function childId(page, name) { return page.locator('[data-pc-child]').filter({ hasText: name }).first().getAttribute('data-pc-child'); }
async function openDay(page, id) {
  await nav(page, 'family');
  await page.locator(`[data-pc-child="${id}"]`).first().click();
  await nav(page, 'garden');
  await page.locator('[data-action="open-today"]').waitFor({ state: 'visible' });
  await page.locator('[data-action="open-today"]').click();
  await page.locator('#pc-day-form').waitFor({ state: 'visible' });
}
async function saveNote(page, note, mark = 'done') {
  await page.locator('#pc-day-note').fill(note);
  await page.locator(`[data-pc-mark="meal"][data-pc-value="${mark}"]`).click();
  assert.equal(await page.locator('#pc-day-note').inputValue(), note, 'Mark re-render must retain the note draft');
  await page.locator('#pc-day-form button[type="submit"]').click();
  await page.locator('#pc-day-form').waitFor({ state: 'hidden' });
}
async function assertNote(page, note, mark) {
  assert.equal(await page.locator('#pc-day-note').inputValue(), note);
  if (mark) assert.equal(await page.locator(`[data-pc-mark="meal"][data-pc-value="${mark}"]`).getAttribute('aria-pressed'), 'true');
}
async function storage(page) { return page.evaluate(key => localStorage.getItem(key) || '', STORAGE_KEY); }

async function run() {
  const { chromium } = require('playwright');
  await fs.mkdir(QA_DIR, { recursive: true });
  const launch = { headless: true, args: ['--no-sandbox'] };
  if (process.env.CHROMIUM_PATH) launch.executablePath = process.env.CHROMIUM_PATH;
  else if (!process.env.CI) launch.executablePath = '/usr/bin/chromium';
  const browser = await chromium.launch(launch);
  const contexts = [];
  const errors = [];
  const workers = [];
  let passed = 0;
  const pass = value => { passed++; console.log(`PASS ${passed}: ${value}`); };
  try {
    const log = { requests: [], external: [], privateAPI: [] };
    // Playwright 1.62.1's serviceWorkers:'block' injects an unguarded
    // navigator.serviceWorker getter into every frame, including opaque sandbox
    // frames. This HTTP-only suite needs no such injection: the app registers its
    // service worker only on HTTPS. Keep both the sandbox and pageerror checks.
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    context.on('serviceworker', worker => workers.push(worker.url()));
    contexts.push(context);
    await blockExternal(context, log);
    const page = await context.newPage();
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
    await familyChooser(page);
    assert.equal(await page.locator('#topbar a[href="tel:+74842200540"]').count(), 1);
    const familyA = await page.locator('[data-pc="demo-enter"]').first().getAttribute('data-family-id');
    assert.ok(familyA);
    await page.screenshot({ path: path.join(QA_DIR, 'demo-family-chooser-mobile.png'), fullPage: true });
    pass('First screen chooses a demo family without phone, OTP or API; top call remains available');

    await enter(page, familyA);
    const misha = await childId(page, 'Миша (демо)');
    const anya = await childId(page, 'Аня (демо)');
    assert.ok(misha && anya && misha !== anya);
    await page.screenshot({ path: path.join(QA_DIR, 'demo-family-mobile.png'), fullPage: true });
    await openDay(page, misha);
    await assertNote(page, '');
    await page.locator('#pc-day-note').fill(NOTE_MISHA);
    await page.locator('[data-pc-mark="meal"][data-pc-value="done"]').click();
    assert.equal(await page.locator('#pc-day-note').inputValue(), NOTE_MISHA);
    assert.ok(!(await storage(page)).includes(NOTE_MISHA), 'Draft must not be persisted before Save');
    await page.locator('#pc-day-form button[type="submit"]').click();
    await page.locator('#pc-day-form').waitFor({ state: 'hidden' });
    assert.ok((await storage(page)).includes(NOTE_MISHA));
    pass('Day note survives mark changes and is stored only by explicit Save');

    await openDay(page, anya);
    await assertNote(page, '');
    assert.equal(await page.locator('[data-pc-mark="meal"][data-pc-value="done"]').getAttribute('aria-pressed'), 'false');
    await saveNote(page, NOTE_ANYA, 'partial');
    await openDay(page, misha);
    await assertNote(page, NOTE_MISHA, 'done');
    await page.locator('#pc-day-note').fill(UNSAVED);
    await page.locator('[data-pc-mark="water"][data-pc-value="done"]').click();
    assert.equal(await page.locator('#pc-day-note').inputValue(), UNSAVED);
    assert.ok(!(await storage(page)).includes(UNSAVED));
    await page.reload({ waitUntil: 'domcontentloaded' });
    await enter(page, familyA);
    await openDay(page, misha); await assertNote(page, NOTE_MISHA, 'done');
    await openDay(page, anya); await assertNote(page, NOTE_ANYA, 'partial');
    await page.locator('#content').evaluate(element => { element.scrollTop = 0; });
    await page.screenshot({ path: path.join(QA_DIR, 'demo-diary-mobile.png'), fullPage: true });
    pass('Two children retain separate saved diaries after reload; unsaved changes stay unsaved');

    await logout(page);
    await page.locator('.pc-new-family summary').click();
    await page.locator('#pc-demo-family-name').fill(FAMILY_B);
    await page.locator('#pc-demo-family-form button[type="submit"]').click();
    await page.locator('.pc-account').waitFor({ state: 'visible' });
    assert.equal(await page.locator('[data-pc-child]').count(), 0, 'New family must start empty');
    assert.ok(!(await page.locator('#app').innerText()).includes('Миша (демо)'));
    await nav(page, 'add-child');
    await page.locator('#pc-child-name').fill(CHILD_B);
    await page.locator('#pc-child-form button[type="submit"]').click();
    await page.locator('[data-pc-child]').waitFor({ state: 'visible' });
    const newChild = await childId(page, CHILD_B);
    await openDay(page, newChild);
    await assertNote(page, '');
    await saveNote(page, NOTE_B);
    await logout(page);
    const familyB = await page.locator('[data-pc="demo-enter"]').filter({ hasText: FAMILY_B }).first().getAttribute('data-family-id');
    assert.ok(familyB && familyB !== familyA);
    await enter(page, familyA); await openDay(page, misha); await assertNote(page, NOTE_MISHA, 'done');
    await logout(page); await enter(page, familyB); await openDay(page, newChild); await assertNote(page, NOTE_B, 'done');
    pass('A new family starts empty; name-only child creation works and family diaries stay isolated');

    await nav(page, 'family');
    await nav(page, 'profile'); await nav(page, 'documents');
    await eventually(async () => /не подключ|демо|демонстрац/i.test(await page.locator('#content').innerText()), 'unconnected documents note');
    assert.equal(await page.locator('[data-pc-document]').count(), 0);
    assert.doesNotMatch(await page.locator('#content').innerText(), /В норме|Без отклонений/);
    await nav(page, 'family');
    await nav(page, 'chat');
    assert.match(await page.locator('#content').innerText(), /не подключ|демо|демонстрац|позвон/i);
    pass('Documents and operator messaging remain honest unconnected demo sections');

    await nav(page, 'booking');
    const bookingFrame = page.locator('#vd-booking-frame');
    const bookingUrl = new URL(await bookingFrame.getAttribute('src'), BASE + '/');
    assert.equal(bookingUrl.href, new URL('booking-widget.html', BASE + '/').href);
    assert.equal(bookingUrl.origin, BASE_ORIGIN, 'Trusted Medihost demo embed runs on the app origin');
    const sandbox = (await bookingFrame.getAttribute('sandbox') || '').split(/\s+/);
    for (const permission of ['allow-scripts', 'allow-forms', 'allow-same-origin', 'allow-popups', 'allow-popups-to-escape-sandbox']) assert.ok(sandbox.includes(permission), permission);
    assert.ok(!sandbox.includes('allow-top-navigation'));
    await nav(page, 'family');
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.screenshot({ path: path.join(QA_DIR, 'demo-family-desktop.png'), fullPage: true });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
    await page.setViewportSize({ width: 320, height: 740 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
    pass('Booking uses the trusted Medihost demo frame on the app origin; family UI fits desktop and 320px screens');

    await logout(page); await page.locator('[data-pc="guest"]').click(); await nav(page, 'doctors');
    await page.locator('#doctor-search').waitFor({ state: 'visible' });
    await nav(page, 'family'); await familyChooser(page);
    assert.deepEqual(log.privateAPI, [], 'Demo must never call clinic login/medical APIs');
    pass('Guest doctors work and private routes return to demo chooser without clinic API calls');

    await page.locator('[data-pc="demo-doctor"]').click();
    await page.locator('select[data-vdd-child]').waitFor({ state: 'visible' });
    await page.locator('select[data-vdd-child]').selectOption(misha);
    await eventually(async () => (await page.locator('[data-vdd-month-percent]').innerText()) === '100%', 'Misha real diary percentage');
    assert.equal(await page.locator(`[data-vdd-date="${today()}"] .vdd-day-score`).innerText(), '100%');
    assert.match(await page.locator('[data-vdd-marked]').innerText(), /^1\s*\//);
    await page.locator('select[data-vdd-child]').selectOption(anya);
    await eventually(async () => (await page.locator('[data-vdd-month-percent]').innerText()) === '50%', 'Anya own diary percentage');
    await page.locator('input[data-vdd-month]').fill(previousMonth(today().slice(0, 7)));
    await page.locator('input[data-vdd-month]').dispatchEvent('change');
    await eventually(async () => (await page.locator('[data-vdd-month-percent]').innerText()).includes('Нет отметок'), 'empty previous month');
    await page.locator('input[data-vdd-month]').fill(today().slice(0, 7));
    await page.locator('input[data-vdd-month]').dispatchEvent('change');
    await eventually(async () => (await page.locator('[data-vdd-month-percent]').innerText()) === '50%', 'current month restored');
    await page.locator('select[data-vdd-child]').selectOption(misha);
    await eventually(async () => (await page.locator('[data-vdd-month-percent]').innerText()) === '100%', 'Misha selected again');
    await page.locator('[data-vdd-recommendation="meal"]').fill(RECOMM_MISHA);
    await page.evaluate(() => new Promise(resolve => {
      window.addEventListener('hashchange', () => setTimeout(resolve, 0), { once: true });
      location.hash = '#auth';
    }));
    assert.equal(await page.locator('[data-vdd-recommendation="meal"]').inputValue(), RECOMM_MISHA, 'Returning to auth hash must not destroy active doctor draft');
    assert.equal(await page.locator('[data-vdd-save]').isEnabled(), true);
    await page.locator('[data-vdd-save]').click();
    await eventually(async () => (await page.locator('#content').innerText()).includes('Рекомендации сохранены'), 'Misha recommendation saved');
    await page.locator('select[data-vdd-child]').selectOption(anya);
    await eventually(async () => (await page.locator('[data-vdd-month-percent]').innerText()) === '50%', 'Anya selected for recommendation');
    assert.equal(await page.locator('[data-vdd-recommendation="meal"]').inputValue(), '');
    await page.locator('[data-vdd-recommendation="activity"]').fill(RECOMM_ANYA);
    await page.locator('[data-vdd-save]').click();
    await eventually(async () => (await page.locator('#content').innerText()).includes('Рекомендации сохранены'), 'Anya recommendation saved');
    await page.setViewportSize({ width: 390, height: 844 });
    await page.locator('#content').evaluate(element => { element.scrollTop = 0; });
    await page.screenshot({ path: path.join(QA_DIR, 'demo-doctor-mobile.png'), fullPage: true });
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.locator('#content').evaluate(element => { element.scrollTop = 0; });
    await page.screenshot({ path: path.join(QA_DIR, 'demo-doctor-desktop.png'), fullPage: true });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
    await page.locator('.vdd-calendar-card').scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(QA_DIR, 'demo-doctor-days-desktop.png'), fullPage: true });
    await page.locator('#content').evaluate(element => { element.scrollTop = 0; });
    await page.locator('[data-vdd="exit"]').first().click();
    await enter(page, familyA); await nav(page, 'garden');
    await page.locator(`[data-pc-child="${misha}"]`).first().click();
    await eventually(async () => (await page.locator('#content').innerText()).includes(RECOMM_MISHA), 'parent sees Misha recommendation');
    assert.ok(!(await page.locator('#content').innerText()).includes(RECOMM_ANYA));
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.locator('[data-pc="demo-doctor"]').click();
    await page.locator('select[data-vdd-child]').waitFor({ state: 'visible' });
    await page.locator('select[data-vdd-child]').selectOption(anya);
    await eventually(async () => (await page.locator('[data-vdd-recommendation="activity"]').inputValue()) === RECOMM_ANYA, 'recommendation after reload');
    assert.equal(await page.locator('[data-vdd-recommendation="meal"]').inputValue(), '');
    pass('Doctor day/month dynamics match parent marks; per-child recommendations persist and reach the correct parent view');

    const blockedLog = { requests: [], external: [], privateAPI: [] };
    const blockedContext = await browser.newContext({ viewport: { width: 390, height: 844 } });
    blockedContext.on('serviceworker', worker => workers.push(worker.url()));
    contexts.push(blockedContext);
    await blockedContext.addInitScript(() => Object.defineProperty(window, 'localStorage', { configurable: true, get() { throw new DOMException('Storage disabled for demo test', 'SecurityError'); } }));
    await blockExternal(blockedContext, blockedLog);
    const blockedPage = await blockedContext.newPage();
    blockedPage.on('pageerror', error => errors.push(error.message));
    await blockedPage.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
    await familyChooser(blockedPage);
    assert.match(await blockedPage.locator('#app').innerText(), /сесси|до закрытия|недоступ|не сохраня/i, 'Blocked storage needs a visible truthful notice');
    await enter(blockedPage);
    const volatileChild = await childId(blockedPage, 'Миша (демо)');
    await openDay(blockedPage, volatileChild); await saveNote(blockedPage, NOTE_B);
    await openDay(blockedPage, volatileChild); await assertNote(blockedPage, NOTE_B, 'done');
    await blockedPage.reload({ waitUntil: 'domcontentloaded' }); await enter(blockedPage);
    await openDay(blockedPage, await childId(blockedPage, 'Миша (демо)')); await assertNote(blockedPage, '');
    assert.deepEqual(blockedLog.privateAPI, []);
    await blockedPage.screenshot({ path: path.join(QA_DIR, 'demo-storage-unavailable-mobile.png'), fullPage: true });
    pass('Unavailable storage uses temporary memory, says so visibly, and does not claim reload persistence');

    assert.deepEqual(workers, [], 'The HTTP test page must not register service workers');
    assert.deepEqual(errors, [], 'No uncaught browser errors');
    pass('No uncaught browser errors across the full demo flow');
    console.log(JSON.stringify({ passed, clinicalAPIRequests: 0, realSMS: 0, screenshots: QA_DIR }, null, 2));
  } finally { for (const context of contexts) await context.close(); await browser.close(); }
}

module.exports = { BASE, BASE_ORIGIN, STORAGE_KEY, NOTE_MISHA, NOTE_ANYA, NOTE_B, UNSAVED, FAMILY_B, CHILD_B, RECOMM_MISHA, RECOMM_ANYA, today, previousMonth, isPrivateAPI, eventually };
if (require.main === module) run().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
