/* Clinic API transport. No local OTP, persistent token, or private response cache. */
(function (global) {
  'use strict';
  const config = global.VDCabinetConfig || {};
  let endpoint = null, booking = null, configurationIssue = '';
  const local = value => ['localhost', '127.0.0.1', '[::1]'].includes(value.hostname);
  const secure = value => value.protocol === 'https:' || value.protocol === 'http:' && local(value);
  try {
    if (config.apiUrl) {
      endpoint = new URL(config.apiUrl, location.href);
      booking = new URL(config.bookingWidgetUrl);
      if (!secure(endpoint) || endpoint.origin !== location.origin || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) throw new Error('API must share the secure cabinet origin');
      if (!secure(booking) || booking.origin === location.origin || booking.username || booking.password || booking.hash) throw new Error('The public booking widget requires a separate origin');
      // The Pages build is public demo infrastructure, not the private cabinet host.
      if (/(^|\.)github\.io$/i.test(location.hostname)) throw new Error('Private cabinet must be installed on the clinic host');
    }
  } catch (_) {
    endpoint = null; booking = null;
    configurationIssue = 'Вход по почте временно недоступен. Обратитесь в клинику.';
  }
  const messages = {
    NOT_CONFIGURED:'Вход по почте ещё не подключён. Пока доступна демоверсия.',
    INVALID_EMAIL:'Проверьте адрес электронной почты.',
    INVALID_PHONE:'Проверьте номер телефона.',
    INVALID_NAME:'Укажите ФИО родителя.',
    INVALID_FIELD:'Проверьте введённые данные.',
    INVALID_CODE:'Код неверный или срок его действия истёк. Запросите новый код.',
    CODE_EXPIRED:'Срок действия кода истёк. Запросите новый код.',
    RATE_LIMITED:'Слишком много попыток. Попробуйте позже.',
    RATE_LIMIT:'Слишком много попыток. Попробуйте позже.',
    RETRY_LATER:'Подождите немного перед повторной отправкой кода.',
    SERVICE_UNAVAILABLE:'Кабинет временно недоступен. Повторите попытку позже.',
    MAIL_UNAVAILABLE:'Письмо не удалось отправить. Повторите попытку позже.',
    EMAIL_UNAVAILABLE:'Письмо не удалось отправить. Повторите попытку позже.',
    UNAUTHORIZED:'Войдите заново с кодом из письма.',
    FORBIDDEN:'У вас нет доступа к этим данным.',
    NOT_FOUND:'Запись не найдена или недоступна.',
    INVALID_DATE:'Выберите дату от рождения ребёнка до сегодняшнего дня.',
    DOCTOR_AUTH_UNAVAILABLE:'Вход врача подключим отдельно по СМС.',
    REGISTRATION_REQUIRED:'Заполните данные родителя для регистрации.',
    UNAVAILABLE:'Сервис временно недоступен. Повторите попытку позже.',
    NETWORK:'Не удалось связаться с кабинетом. Проверьте подключение и повторите.'
  };
  function failure(code, status, retryAfter) {
    if (!Object.prototype.hasOwnProperty.call(messages,code)) code = 'UNAVAILABLE';
    const error = new Error(code);
    error.code = code; error.status = status || 0;
    error.userMessage = messages[code] || 'Не удалось выполнить действие. Повторите попытку позже.';
    if (Number.isFinite(retryAfter)) error.retryAfter = Math.max(0, Math.min(3600, retryAfter));
    return error;
  }
  const routes = new Set(['health','request-code','verify-code','me','children','garden','logout','doctor-children','doctor-garden','doctor-recommendations']);
  async function request(action, options) {
    if (!endpoint) throw failure('NOT_CONFIGURED',503);
    if (!routes.has(action)) throw failure('NOT_FOUND',404);
    const opts = options || {}, url = new URL(endpoint.href);
    url.searchParams.set('action',action);
    for (const key of ['childId','month']) {
      if (opts.params && typeof opts.params[key] === 'string') url.searchParams.set(key,opts.params[key]);
    }
    const headers = {'Accept':'application/json'};
    if (opts.token) headers.Authorization = 'Bearer ' + opts.token;
    const method = String(opts.method || 'GET').toUpperCase();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(),action === 'request-code' ? 35000 : 15000);
    try {
      const init = {method,headers,signal:controller.signal,credentials:'omit',cache:'no-store',redirect:'error',referrerPolicy:'no-referrer'};
      if (method === 'POST' || method === 'PUT') {headers['Content-Type']='application/json';init.body=JSON.stringify(opts.body === undefined ? {} : opts.body);}
      const response = await fetch(url.href,init);
      if (!/application\/json/i.test(response.headers.get('content-type') || '')) throw failure('UNAVAILABLE',response.status);
      const data = await response.json();
      if (!data || typeof data !== 'object' || Array.isArray(data)) throw failure('UNAVAILABLE',response.status);
      if (!response.ok || data.ok === false) {
        const code = typeof data.code === 'string' ? data.code : data.error && data.error.code || (response.status === 401 ? 'UNAUTHORIZED' : response.status === 429 ? 'RATE_LIMITED' : 'UNAVAILABLE');
        throw failure(code,response.status,Number(data.retryAfter || response.headers.get('Retry-After') || 0));
      }
      return data;
    } catch (error) {
      if (error.userMessage) throw error;
      throw failure('NETWORK',0);
    } finally {clearTimeout(timeout);}
  }
  async function health() {
    const result = await request('health');
    if (result.ready !== true || result.service !== 'patient-cabinet' || result.apiVersion !== 2 || !result.auth || result.auth.parent !== 'email') throw failure('UNAVAILABLE',503);
    return result;
  }
  Object.defineProperty(global,'VDCabinetAPI',{value:Object.freeze({
    configured:!!endpoint,configurationIssue,bookingWidgetUrl:booking ? booking.href : '',request,health,
    requestCode:body => request('request-code',{method:'POST',body}),
    verifyCode:body => request('verify-code',{method:'POST',body})
  }),writable:false,configurable:false});
})(window);
