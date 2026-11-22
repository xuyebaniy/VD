'use strict';

// Execute the real worker against an in-memory browser/cache simulation.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '..', 'sw.js'), 'utf8');
const scope = 'https://vash-doc.ru/app/';
const keyOf = input => typeof input === 'string' ? input : input.url || input.href;

function harness() {
  const handlers = new Map(), stores = new Map(), cacheCalls = [], fetches = [];
  const lifecycle = {claimed: 0, waiting: 0};
  let network = async input => new Response(keyOf(input).endsWith('data/doctors.json') ?
    JSON.stringify({doctors: [{photo: 'assets/doctors/0123456789abcdef01.webp'}, {photo: 'documents/private.pdf'}]}) :
    'PUBLIC SHELL', {headers: {'Cache-Control': 'public, max-age=60'}});
  function store(name) { if (!stores.has(name)) stores.set(name, new Map()); return stores.get(name); }
  const caches = {
    async open(name) {
      cacheCalls.push(['open', name]);
      const entries = store(name);
      return {
        async put(input, response) { const key = keyOf(input); cacheCalls.push(['put', name, key]); entries.set(key, response.clone()); },
        async match(input) { const key = keyOf(input); cacheCalls.push(['match', name, key]); return entries.get(key)?.clone(); },
        async keys() { cacheCalls.push(['keys', name]); return [...entries.keys()].map(url => ({url})); },
        async delete(input) { const key = keyOf(input); cacheCalls.push(['delete-entry', name, key]); return entries.delete(key); }
      };
    },
    async keys() { cacheCalls.push(['keys-all']); return [...stores.keys()]; },
    async delete(name) { cacheCalls.push(['delete-cache', name]); return stores.delete(name); },
    async match(input) {
      const key = keyOf(input); cacheCalls.push(['match-all', key]);
      for (const entries of stores.values()) if (entries.has(key)) return entries.get(key).clone();
    }
  };
  const context = {
    self: {location: new URL(scope), registration: {scope}, addEventListener: (name, handler) => handlers.set(name, handler),
      skipWaiting: async () => { lifecycle.waiting++; }, clients: {claim: async () => { lifecycle.claimed++; }}},
    caches, fetch: async (input, options) => { fetches.push(keyOf(input)); return network(input, options); },
    URL, Response, AbortController, setTimeout, clearTimeout
  };
  vm.runInNewContext(source, context, {filename: 'sw.js'});
  return {
    stores, cacheCalls, fetches, lifecycle,
    network(handler) { network = handler; },
    async fetch(url, options = {}) {
      let response, intercepted = 0;
      const request = {url: new URL(url, scope).href, method: options.method || 'GET',
        mode: options.mode || 'cors', headers: new Headers(options.headers)};
      handlers.get('fetch')({request, respondWith(value) { intercepted++; response = value; }});
      return {intercepted, response: response ? await response : undefined};
    },
    async lifecycleEvent(name) {
      let work; handlers.get(name)({waitUntil(value) { work = value; }}); await work;
    }
  };
}

async function privateRequestsBypassWorker() {
  const h = harness();
  const cases = [
    ['/local/api/vd-pwa/v1/patient-cabinet.php?action=me', {headers: {Authorization: 'Bearer synthetic-token'}}],
    ['/local/api/vd-pwa/v1/patient-cabinet.php?action=me', {}],
    ['patient-cabinet.php?action=documents', {headers: {Authorization: 'Bearer synthetic-token'}}],
    ['patient-cabinet.php?action=documents', {}],
    ['data/patients.json', {}], ['/data/patients.json', {}],
    ['documents/private.pdf', {}],
    ['/local/api/vd-pwa/v1/patient-cabinet.php?action=document&id=synthetic', {}],
    ['assets/patients/private.webp', {}], ['unlisted-private.js', {}],
    ['data/doctors.json', {headers: {Authorization: 'Bearer synthetic-token'}}],
    ['data/doctors.json', {method: 'POST'}],
    ['https://other.example/patient-cabinet.php', {}]
  ];
  for (const [url, options] of cases) assert.equal((await h.fetch(url, options)).intercepted, 0, url);
  assert.equal(h.cacheCalls.length, 0, 'Private/unlisted requests must not even consult cached data');
  assert.equal(h.fetches.length, 0, 'The worker must leave those requests to the browser');
  console.log('PASS: 13 private, credentialed, unlisted or non-GET requests bypass the worker and caches');
}

async function publicOfflineShell() {
  const h = harness();
  for (const [url, options] of [['data/doctors.json', {}], ['index.html', {mode: 'navigate'}], ['patient-cabinet.js', {}]]) {
    const online = await h.fetch(url, options);
    assert.equal(online.intercepted, 1, 'Public content should be available to the worker: ' + url);
    assert.equal(online.response.status, 200);
  }
  h.network(async () => { throw new Error('offline'); });
  assert.equal((await h.fetch('data/doctors.json')).response.status, 200);
  assert.equal(await (await h.fetch('index.html', {mode: 'navigate'})).response.text(), 'PUBLIC SHELL');
  assert.equal(await (await h.fetch('patient-cabinet.js')).response.text(), 'PUBLIC SHELL');
  console.log('PASS: the public doctor directory and application shell remain available offline');
}

async function sensitiveResponsesAreNotCached() {
  for (const directive of ['no-store', 'private, max-age=300']) {
    const h = harness();
    h.network(async () => new Response('SYNTHETIC PRIVATE RESPONSE', {headers: {'Cache-Control': directive}}));
    for (const [url, options] of [['data/doctors.json', {}], ['index.html', {mode: 'navigate'}], ['icons/icon-192.png', {}]]) {
      assert.equal((await h.fetch(url, options)).response.status, 200);
    }
    assert.equal(h.cacheCalls.filter(call => call[0] === 'put').length, 0, directive + ' must prevent all cache writes');
    h.network(async () => { throw new Error('offline'); });
    assert.equal((await h.fetch('data/doctors.json')).response.status, 503, 'Sensitive response must not reappear offline');
  }
  console.log('PASS: no-store and private responses are never cached or replayed offline');
}

async function activationRemovesLegacyPatientData() {
  const h = harness();
  await h.lifecycleEvent('install');
  const activeShell = [...h.stores.keys()].find(name => name.startsWith('vd-shell-'));
  assert.ok(activeShell, 'Install must prepare a public offline shell');
  assert.equal(h.lifecycle.waiting, 1);
  assert.ok(h.stores.get(activeShell).has(scope + 'index.html'));
  assert.ok(h.stores.get(activeShell).has(scope + 'patient-cabinet.js'));
  assert.ok(!h.fetches.includes(scope + 'documents/private.pdf'), 'Catalog photo fields must not fetch patient files');
  for (const name of ['vd-shell-legacy', 'vd-original-legacy', 'vd-public-directory-old', 'unrelated-app-cache']) {
    h.stores.set(name, new Map([[scope + 'data/patients.json', new Response('LEGACY PRIVATE DATA')]]));
  }
  h.stores.set('vd-public-directory-v5', new Map([
    [scope + 'data/doctors.json', new Response('{"doctors":[]}')],
    [scope + 'data/patients.json', new Response('LEGACY PRIVATE DATA')]
  ]));
  await h.lifecycleEvent('activate');
  for (const name of ['vd-shell-legacy', 'vd-original-legacy', 'vd-public-directory-old']) assert.equal(h.stores.has(name), false, name);
  assert.ok(h.stores.has(activeShell), 'The newly installed public shell must survive activation');
  assert.ok(h.stores.has('unrelated-app-cache'), 'Another application cache must remain untouched');
  assert.equal(h.stores.get('vd-public-directory-v5').has(scope + 'data/patients.json'), false);
  assert.ok(h.stores.get('vd-public-directory-v5').has(scope + 'data/doctors.json'));
  assert.equal(h.lifecycle.claimed, 1);
  console.log('PASS: activation removes legacy app caches and private directory entries while keeping the public shell');
}

(async () => {
  await privateRequestsBypassWorker();
  await publicOfflineShell();
  await sensitiveResponsesAreNotCached();
  await activationRemovesLegacyPatientData();
})().catch(error => { console.error(error); process.exitCode = 1; });
