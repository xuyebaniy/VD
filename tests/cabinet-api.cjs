#!/usr/bin/env node
'use strict';

// Execute the real transport with in-memory fetch responses and controlled
// timers. No request is sent to a clinic, mail provider, or other host.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'cabinet-api.js'), 'utf8');
const ORIGIN = 'https://cabinet.example.test';
const PAGE = ORIGIN + '/app/';
const CONFIG = {apiUrl: '/api/patient-cabinet.php', bookingWidgetUrl: 'https://booking.example.test/widget.html'};
const HEALTH = {ok: true, ready: true, service: 'patient-cabinet', apiVersion: 2, auth: {parent: 'email'}};
const plain = value => JSON.parse(JSON.stringify(value));
let checks = 0;

function response(data, status = 200, headers = {}) {
  const values = {'content-type': 'application/json; charset=utf-8', ...headers};
  return {
    ok: status >= 200 && status < 300, status,
    headers: {get: name => values[String(name).toLowerCase()] || null},
    json: async () => data
  };
}

function context({config = CONFIG, page = PAGE, serve = () => response({ok: true})} = {}) {
  const calls = [], timers = new Map();
  let timerSequence = 0;
  const fetch = (url, init) => {
    calls.push({url, init});
    return Promise.resolve().then(() => serve(url, init));
  };
  const window = {VDCabinetConfig: config, fetch};
  vm.runInNewContext(source, {
    window, location: new URL(page), URL, AbortController, fetch,
    setTimeout(fn, ms) {const id = ++timerSequence; timers.set(id, {fn, ms}); return id;},
    clearTimeout(id) {timers.delete(id);}
  }, {filename: 'cabinet-api.js', timeout: 2000});
  return {api: window.VDCabinetAPI, calls, timers};
}

async function rejected(operation, code, status) {
  await assert.rejects(operation, failure => {
    assert.equal(failure.code, code);
    if (status !== undefined) assert.equal(failure.status, status);
    assert.ok(typeof failure.userMessage === 'string' && failure.userMessage.length > 0);
    return true;
  });
}

async function check(name, run) {
  await run();
  checks++;
  console.log('PASS ' + name);
}

(async () => {
  await check('an unconfigured cabinet never sends a request or creates a local code', async () => {
    for (const config of [undefined, {}, {apiUrl: '', bookingWidgetUrl: ''}]) {
      const env = context({config: config || {}});
      assert.equal(env.api.configured, false);
      assert.equal(env.api.configurationIssue, '');
      assert.equal(env.api.bookingWidgetUrl, '');
      await rejected(() => env.api.health(), 'NOT_CONFIGURED', 503);
      await rejected(() => env.api.requestCode({email: 'parent@example.test'}), 'NOT_CONFIGURED', 503);
      await rejected(() => env.api.verifyCode({code: '123456'}), 'NOT_CONFIGURED', 503);
      assert.equal(env.calls.length, 0);
      assert.equal(env.timers.size, 0);
    }
  });

  await check('unsafe API and booking-origin configurations fail closed without network calls', async () => {
    const variants = [
      {config: {...CONFIG, apiUrl: 'https://foreign.example.test/api'}},
      {config: {...CONFIG, bookingWidgetUrl: ORIGIN + '/booking-widget.html'}},
      {page: 'http://cabinet.example.test/app/'},
      {page: 'https://xuyebaniy.github.io/VD/'},
      {page: 'https://github.io/app/'},
      {config: {...CONFIG, apiUrl: 'https://name:password@cabinet.example.test/api'}},
      {config: {...CONFIG, apiUrl: '/api?token=unexpected'}},
      {config: {...CONFIG, apiUrl: '/api#fragment'}},
      {config: {...CONFIG, bookingWidgetUrl: 'http://booking.example.test/widget.html'}},
      {config: {...CONFIG, bookingWidgetUrl: 'https://name:password@booking.example.test/widget.html'}},
      {config: {...CONFIG, bookingWidgetUrl: 'https://booking.example.test/widget.html#fragment'}},
      {config: {apiUrl: '/api'}}
    ];
    for (const variant of variants) {
      const env = context(variant);
      assert.equal(env.api.configured, false, JSON.stringify(variant));
      assert.ok(env.api.configurationIssue.length > 0);
      assert.equal(env.api.bookingWidgetUrl, '');
      await rejected(() => env.api.request('me'), 'NOT_CONFIGURED', 503);
      assert.equal(env.calls.length, 0);
      assert.equal(env.timers.size, 0);
    }
  });

  await check('same-origin HTTPS API with a separate widget origin is accepted; HTTP is local-only', async () => {
    for (const variant of [
      {},
      {page: 'http://localhost:8765/app/', config: {...CONFIG, bookingWidgetUrl: 'http://localhost:8766/widget.html'}},
      {page: 'http://127.0.0.1:8765/app/', config: {...CONFIG, bookingWidgetUrl: 'http://127.0.0.1:8766/widget.html'}},
      {page: 'http://[::1]:8765/app/', config: {...CONFIG, bookingWidgetUrl: 'http://[::1]:8766/widget.html'}}
    ]) {
      const env = context(variant);
      assert.equal(env.api.configured, true);
      assert.equal(env.api.configurationIssue, '');
      assert.ok(Object.isFrozen(env.api));
      assert.notEqual(new URL(env.api.bookingWidgetUrl).origin, new URL(variant.page || PAGE).origin);
      await env.api.request('me');
      assert.equal(new URL(env.calls[0].url).origin, new URL(variant.page || PAGE).origin);
      assert.equal(env.timers.size, 0);
    }
  });

  await check('health requires the exact ready service, API version, and email-auth contract', async () => {
    const good = context({serve: () => response(HEALTH)});
    assert.deepEqual(plain(await good.api.health()), HEALTH);
    assert.equal(new URL(good.calls[0].url).searchParams.get('action'), 'health');
    for (const data of [
      {...HEALTH, ready: false}, {...HEALTH, ready: 'true'}, {...HEALTH, service: 'other'},
      {...HEALTH, apiVersion: 1}, {...HEALTH, apiVersion: '2'},
      {...HEALTH, auth: null}, {...HEALTH, auth: {parent: 'sms'}}, {}
    ]) {
      const env = context({serve: () => response(data)});
      await rejected(() => env.api.health(), 'UNAVAILABLE', 503);
      assert.equal(env.timers.size, 0);
    }
  });

  await check('email request and verification use POST JSON and never place contact details or a code in URLs', async () => {
    const received = [{ok: true, challengeId: 'challenge_demo', expiresIn: 600}, {ok: true, token: 'session_demo'}];
    const env = context({serve: () => response(received.shift())});
    const registration = {email: 'parent@example.test', phone: '+79990001122', fullName: 'Родитель Демо'};
    const verification = {challengeId: 'challenge_demo', code: '736291'};
    assert.equal((await env.api.requestCode(registration)).challengeId, 'challenge_demo');
    assert.equal((await env.api.verifyCode(verification)).token, 'session_demo');
    for (const [i, action] of ['request-code', 'verify-code'].entries()) {
      const call = env.calls[i], url = new URL(call.url);
      assert.equal(call.init.method, 'POST');
      assert.equal(call.init.headers['Content-Type'], 'application/json');
      assert.equal(call.init.headers.Accept, 'application/json');
      assert.equal(call.init.headers.Authorization, undefined);
      assert.deepEqual(JSON.parse(call.init.body), [registration, verification][i]);
      assert.deepEqual([...url.searchParams.keys()], ['action']);
      assert.equal(url.searchParams.get('action'), action);
      for (const privateValue of ['parent@example.test', '79990001122', 'Родитель', '736291']) {
        assert.ok(!decodeURIComponent(call.url).includes(privateValue));
      }
    }
    assert.equal(env.timers.size, 0);
  });

  await check('authenticated requests use only the Authorization header and allowlisted route parameters', async () => {
    const env = context();
    const token = 'secret_session_opaque';
    await env.api.request('garden', {token, params: {childId: 'child_demo', month: '2026-11', token, email: 'private@example.test', role: 'doctor'}});
    const call = env.calls[0], url = new URL(call.url);
    assert.equal(call.init.headers.Authorization, 'Bearer ' + token);
    assert.equal(call.init.body, undefined);
    assert.deepEqual(Object.fromEntries(url.searchParams), {action: 'garden', childId: 'child_demo', month: '2026-11'});
    assert.ok(!call.url.includes(token));
    assert.equal(call.init.cache, 'no-store');
    assert.equal(call.init.credentials, 'omit');
    assert.equal(call.init.redirect, 'error');
    assert.equal(call.init.referrerPolicy, 'no-referrer');
    assert.equal(call.init.signal instanceof AbortSignal, true);
    await rejected(() => env.api.request('admin-assign-doctor', {token}), 'NOT_FOUND', 404);
    assert.equal(env.calls.length, 1, 'Unknown routes must be rejected before fetch');
    await env.api.request('logout', {method:'POST',token});
    assert.equal(env.calls[1].init.headers['Content-Type'],'application/json', 'Logout must satisfy the real PHP router JSON contract');
    assert.equal(env.calls[1].init.body,'{}');
    assert.equal(env.calls[1].init.headers.Authorization,'Bearer ' + token);
  });

  await check('server error details and submitted codes are masked while known error codes remain useful', async () => {
    const marker = 'PRIVATE_OTP_736291_SMTP_PASSWORD';
    for (const data of [
      {ok: false, code: 'INVALID_CODE', message: marker, userMessage: marker, details: {otp: marker}},
      {ok: false, error: {code: 'INVALID_CODE', message: marker, stack: marker}}
    ]) {
      const env = context({serve: () => response(data, 422)});
      await assert.rejects(() => env.api.verifyCode({challengeId: 'challenge_demo', code: '736291'}), failure => {
        assert.equal(failure.code, 'INVALID_CODE');
        assert.equal(failure.status, 422);
        assert.match(failure.userMessage, /Код неверный/);
        assert.ok(!String(failure).includes(marker));
        assert.ok(!JSON.stringify(failure).includes(marker));
        assert.ok(!JSON.stringify(failure).includes('736291'));
        return true;
      });
      assert.equal(env.timers.size, 0);
    }
    for (const [status, code] of [[401, 'UNAUTHORIZED'], [429, 'RATE_LIMITED'], [500, 'UNAVAILABLE']]) {
      const env = context({serve: () => response({message: marker}, status)});
      await rejected(() => env.api.request('me'), code, status);
    }
    for (const data of [{code: marker}, {error: {code: marker}}, {code: '__proto__'}, {code: 'constructor'}]) {
      const env = context({serve: () => response(data, 500)});
      await assert.rejects(() => env.api.request('me'), failure => {
        assert.equal(failure.code, 'UNAVAILABLE');
        assert.equal(failure.message, 'UNAVAILABLE');
        assert.ok(!String(failure).includes(marker));
        assert.ok(!JSON.stringify(failure).includes(marker));
        return true;
      });
    }
  });

  await check('retry guidance is bounded and malformed or HTML responses cannot become successful authentication', async () => {
    const limited = context({serve: () => response({ok: false, code: 'RATE_LIMITED', retryAfter: 999999}, 429)});
    await assert.rejects(() => limited.api.requestCode({email: 'parent@example.test'}), error => error.code === 'RATE_LIMITED' && error.retryAfter === 3600);
    const header = context({serve: () => response({ok: false}, 429, {'retry-after': '60'})});
    await assert.rejects(() => header.api.request('me'), error => error.code === 'RATE_LIMITED' && error.retryAfter === 60);
    for (const data of [null, [], 'PRIVATE_OTP_736291', 123]) {
      const env = context({serve: () => response(data)});
      await rejected(() => env.api.verifyCode({code: '736291'}), 'UNAVAILABLE', 200);
    }
    const html = context({serve: () => response('<html>PRIVATE_OTP_736291</html>', 502, {'content-type': 'text/html'})});
    await rejected(() => html.api.request('me'), 'UNAVAILABLE', 502);
    const brokenJSON = context({serve: () => ({...response(null), json: async () => {throw new SyntaxError('PRIVATE_OTP_736291');}})});
    await assert.rejects(() => brokenJSON.api.request('me'), error => error.code === 'NETWORK' && !String(error).includes('736291'));
  });

  await check('a network failure exposes no transport message and always clears its timeout', async () => {
    const env = context({serve: () => {throw new Error('PRIVATE_OTP_736291 failed at internal-host.example');}});
    await assert.rejects(() => env.api.request('me'), error => {
      assert.equal(error.code, 'NETWORK');
      assert.equal(error.status, 0);
      assert.ok(!String(error).includes('736291'));
      assert.ok(!JSON.stringify(error).includes('internal-host'));
      return true;
    });
    assert.equal(env.timers.size, 0);
  });

  await check('timeouts abort a pending fetch without real waiting or duplicate requests', async () => {
    for (const [action, duration] of [['me', 15000], ['request-code', 35000]]) {
      const env = context({serve: (url, init) => new Promise((resolve, reject) => {
        init.signal.addEventListener('abort', () => {
          const error = new Error('Aborted PRIVATE_OTP_736291'); error.name = 'AbortError'; reject(error);
        }, {once: true});
      })});
      const pending = action === 'request-code' ? env.api.requestCode({email: 'parent@example.test'}) : env.api.request(action);
      await Promise.resolve(); // Let the in-memory fetch attach its abort listener.
      assert.equal(env.timers.size, 1);
      const timer = [...env.timers.values()][0];
      assert.equal(timer.ms, duration);
      timer.fn();
      await rejected(() => pending, 'NETWORK', 0);
      assert.equal(env.calls[0].init.signal.aborted, true);
      assert.equal(env.calls.length, 1);
      assert.equal(env.timers.size, 0);
    }
  });

  console.log('\n' + checks + ' cabinet transport scenarios passed. All fetch calls were in-memory fixtures.');
})().catch(error => {console.error(error); process.exitCode = 1;});
