/* Local demonstration doctor view. Data access is supplied by the parent adapter. */
(function (global) {
  'use strict';

  const HABITS = [
    {id:'meal', label:'Питание', short:'П'}, {id:'water', label:'Вода', short:'В'},
    {id:'activity', label:'Движение', short:'Д'}, {id:'sleep', label:'Сон', short:'С'},
    {id:'screen', label:'Экранное время', short:'Э'}, {id:'mood', label:'Самочувствие', short:'См'}
  ];
  const VALUES = Object.freeze({done:100, partial:50, missed:0});
  const LABELS = Object.freeze({done:'Выполнено', partial:'Частично', missed:'Не выполнено'});
  const SYMBOLS = Object.freeze({done:'✓', partial:'½', missed:'×'});
  const owns = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
  const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
  const escape = value => String(value == null ? '' : value).replace(/[&<>"']/g,
    character => ({'&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;'}[character]));
  const percent = (score, marked) => marked ? Math.round(score / marked) : null;

  function today() {
    const parts = new Intl.DateTimeFormat('en-CA', {timeZone:'Europe/Moscow', year:'numeric', month:'2-digit', day:'2-digit'}).formatToParts(new Date());
    const get = type => parts.find(part => part.type === type).value;
    return get('year') + '-' + get('month') + '-' + get('day');
  }
  function validDate(value) {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const [year, month, day] = value.split('-').map(Number);
    return year >= 1900 && year <= 2199 && new Date(Date.UTC(year, month - 1, day)).toISOString().slice(0,10) === value;
  }
  function dateLabel(value, withYear) {
    if (!validDate(value)) return '';
    const parts = value.split('-');
    return parts[2] + '.' + parts[1] + (withYear ? '.' + parts[0] : '');
  }
  function monthLabel(month) {
    const [year, number] = month.split('-').map(Number);
    return new Intl.DateTimeFormat('ru-RU', {month:'long', year:'numeric', timeZone:'UTC'}).format(new Date(Date.UTC(year, number - 1, 1)));
  }

  /**
   * A mark is done=100, partial=50 or missed=0; absent/invalid marks are missing.
   * All percentages use only valid marks, including an explicitly marked zero.
   * asOfDate is optional (Moscow today); passing it makes the calculation deterministic.
   * Future days stay in days[] for the calendar but never enter totals/denominators.
   */
  function computeStats(garden, month, asOfDate) {
    if (typeof month !== 'string' || !/^(19|20|21)\d{2}-(0[1-9]|1[0-2])$/.test(month)) throw new RangeError('Invalid month');
    const cutoff = asOfDate === undefined ? today() : asOfDate;
    if (!validDate(cutoff)) throw new RangeError('Invalid calculation date');
    const [year, number] = month.split('-').map(Number);
    const calendarDays = new Date(Date.UTC(year, number, 0)).getUTCDate();
    const entries = object(garden) && object(garden.entries) ? garden.entries : {};
    const result = {month, percent:null, daysWithEntries:0, daysPossible:0, marked:0, possible:0,
      done:0, partial:0, missed:0, missing:0, lastMarkedDate:null, calendarDays, byHabit:{}, days:[]};
    HABITS.forEach(habit => { result.byHabit[habit.id] = {percent:null, marked:0, done:0, partial:0, missed:0, missing:0}; });
    for (let day = 1; day <= calendarDays; day++) {
      const date = month + '-' + String(day).padStart(2,'0');
      const future = date > cutoff;
      const entry = !future && owns(entries,date) && object(entries[date]) ? entries[date] : {};
      const row = {date, percent:null, marked:0, possible:future ? 0 : HABITS.length,
        done:0, partial:0, missed:0, missing:0, future, marks:{}, note:typeof entry.note === 'string' ? entry.note : ''};
      if (!future) result.daysPossible++;
      HABITS.forEach(habit => {
        const mark = owns(entry,habit.id) && typeof entry[habit.id] === 'string' && owns(VALUES,entry[habit.id]) ? entry[habit.id] : null;
        row.marks[habit.id] = mark;
        if (mark === null) return;
        row.marked++; row[mark]++;
        result.marked++; result[mark]++;
        result.byHabit[habit.id].marked++; result.byHabit[habit.id][mark]++;
      });
      row.percent = percent(row.done * 100 + row.partial * 50, row.marked);
      row.missing = row.possible - row.marked;
      if (row.marked) { result.daysWithEntries++; result.lastMarkedDate = date; }
      result.days.push(row);
    }
    result.possible = result.daysPossible * HABITS.length;
    result.missing = result.possible - result.marked;
    result.percent = percent(result.done * 100 + result.partial * 50, result.marked);
    HABITS.forEach(habit => {
      const data = result.byHabit[habit.id];
      data.percent = percent(data.done * 100 + data.partial * 50, data.marked);
      data.missing = result.daysPossible - data.marked;
    });
    return result;
  }

  function recommendations(value) {
    return Object.fromEntries(HABITS.map(habit => [habit.id,object(value) && typeof value[habit.id] === 'string' ? value[habit.id].slice(0,1200) : '']));
  }
  function scoreLabel(value) { return value === null ? 'Нет отметок' : value + '%'; }
  function message(text, kind) {
    return text ? '<div class="vdd-message ' + (kind || '') + '" role="' + (kind === 'error' ? 'alert' : 'status') + '">' + escape(text) + '</div>' : '';
  }
  const arrows = {
    left:'<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m14 6-6 6 6 6"/></svg>',
    right:'<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m10 6 6 6-6 6"/></svg>'
  };

  function mount(host, options) {
    if (!host || typeof host.addEventListener !== 'function' || !options || typeof options.api !== 'function') throw new TypeError('Doctor view requires a host and an API adapter');
    let disposed = false, version = 0;
    const drafts = new Map();
    const state = {children:[], selectedChildId:null, month:today().slice(0,7), garden:null,
      loading:true, saving:false, error:'', notice:''};
    const selected = () => state.children.find(child => child.id === state.selectedChildId) || null;
    function storageWarning() {
      try {
        const value = typeof options.storageWarning === 'function' ? options.storageWarning() : options.storageWarning;
        return typeof value === 'string' ? value.slice(0,600) : '';
      } catch (_) { return ''; }
    }
    function report(error, fallback) {
      state.error = error && typeof error.userMessage === 'string' ? error.userMessage.slice(0,400) : fallback;
      if (typeof options.onError === 'function') options.onError(error);
    }
    function draftFor(childId, value) {
      const fresh = recommendations(value);
      if (!drafts.has(childId)) drafts.set(childId,{values:{...fresh}, base:{...fresh}, dirty:new Set()});
      else if (value !== undefined) {
        const draft = drafts.get(childId);
        for (const habit of HABITS) {
          if (!draft.dirty.has(habit.id)) draft.values[habit.id] = fresh[habit.id];
          draft.base[habit.id] = fresh[habit.id];
          if (draft.values[habit.id] === fresh[habit.id]) draft.dirty.delete(habit.id);
        }
      }
      return drafts.get(childId);
    }
    function heading() {
      return '<header class="vdd-hero"><div class="vdd-hero-top"><span class="vdd-badge">Демонстрация</span>' +
        '<button type="button" class="vdd-text-button" data-vdd="exit">Выйти</button></div>' +
        '<h1>Кабинет врача</h1><p>Отметки семей и индивидуальный план для каждого ребёнка.</p>' +
        '<div class="vdd-local">На этом устройстве · семьи из этого браузера</div></header>';
    }
    function selection() {
      const families = new Set(state.children.map(child => child.familyId || child.familyName || '')).size;
      return '<section class="vdd-card vdd-select-card"><div class="vdd-section-line"><h2>Выберите ребёнка</h2>' +
        '<button type="button" class="vdd-text-button" data-vdd="refresh"' + (state.loading || state.saving ? ' disabled' : '') + '>Обновить</button></div>' +
        '<label class="vdd-sr-only" for="vdd-child">Ребёнок и семья</label><select id="vdd-child" data-vdd-child' + (state.saving ? ' disabled' : '') + '>' +
        state.children.map(child => '<option value="' + escape(child.id) + '"' + (child.id === state.selectedChildId ? ' selected' : '') + '>' +
          escape(child.name) + ' · ' + escape(child.familyName || 'Семья') + '</option>').join('') + '</select>' +
        '<p class="vdd-help">Профилей детей: ' + state.children.length + ' · Семей: ' + families + '</p></section>';
    }
    function monthNavigation() {
      const blocked = state.saving;
      return '<div class="vdd-month-nav"><button type="button" class="vdd-arrow" data-vdd="prev-month" aria-label="Предыдущий месяц"' +
        (blocked || state.month <= '1900-01' ? ' disabled' : '') + '>' + arrows.left + '</button>' +
        '<label><span class="vdd-sr-only">Месяц дневника</span><input type="month" data-vdd-month value="' + state.month + '" min="1900-01" max="' + today().slice(0,7) + '"' + (blocked ? ' disabled' : '') + '></label>' +
        '<button type="button" class="vdd-arrow" data-vdd="next-month" aria-label="Следующий месяц"' +
        (blocked || state.month >= today().slice(0,7) ? ' disabled' : '') + '>' + arrows.right + '</button></div>';
    }
    function summary(stats) {
      return '<div class="vdd-summary"><section class="vdd-metric vdd-metric-green"><small>По заполненным отметкам</small><strong data-vdd-month-percent class="' +
        (stats.percent === null ? 'vdd-no-score' : '') + '">' + scoreLabel(stats.percent) + '</strong><span>Приверженность за месяц</span></section>' +
        '<section class="vdd-metric vdd-metric-pink"><small>Заполненность дневника</small><strong data-vdd-marked>' + stats.marked + '<em> / ' + stats.possible + '</em></strong>' +
        '<span>' + stats.daysWithEntries + ' дн. с отметками из ' + stats.daysPossible + '</span></section></div>' +
        '<p class="vdd-help vdd-summary-note">Возможные отметки: ' + stats.daysPossible + ' дн. × 6 привычек. Будущие дни не учитываются.</p>' +
        '<p class="vdd-last-mark">Последняя отметка в месяце: <strong>' + (stats.lastMarkedDate ? dateLabel(stats.lastMarkedDate,true) : 'пока нет') + '</strong></p>';
    }
    function habitSummary(stats) {
      return '<section class="vdd-card"><h2>По привычкам</h2><div class="vdd-habits">' + HABITS.map((habit,index) => {
        const data = stats.byHabit[habit.id];
        return '<article class="vdd-habit" data-vdd-habit="' + habit.id + '"><div class="vdd-habit-top"><span class="vdd-habit-number">' + (index + 1) + '</span><h3>' + habit.label + '</h3></div>' +
          '<strong class="vdd-habit-score' + (data.percent === null ? ' empty' : '') + '">' + scoreLabel(data.percent) + '</strong>' +
          '<div class="vdd-bar" aria-hidden="true"><span style="width:' + (data.percent === null ? 0 : data.percent) + '%"></span></div>' +
          '<p>' + data.marked + ' из ' + stats.daysPossible + ' дн. заполнено</p><div class="vdd-habit-counts"><span title="Выполнено">✓ ' + data.done + '</span>' +
          '<span title="Частично">½ ' + data.partial + '</span><span title="Не выполнено">× ' + data.missed + '</span></div></article>';
      }).join('') + '</div></section>';
    }
    function dayTable(stats) {
      const weekdays = ['вс','пн','вт','ср','чт','пт','сб'];
      return '<section class="vdd-card vdd-calendar-card"><div class="vdd-section-line"><h2>Дневник по дням</h2><span class="vdd-month-label">' + escape(monthLabel(state.month)) + '</span></div>' +
        '<div class="vdd-table-wrap"><table class="vdd-day-table"><caption class="vdd-sr-only">Отметки ребёнка за ' + escape(monthLabel(state.month)) + '</caption>' +
        '<thead><tr><th scope="col">День</th><th scope="col">По отметкам</th><th scope="col"><span class="vdd-habit-letters">' +
        HABITS.map(habit => '<abbr title="' + habit.label + '">' + habit.short + '</abbr>').join('') + '</span></th></tr></thead><tbody>' +
        stats.days.map(day => {
          const weekday = weekdays[new Date(day.date + 'T12:00:00Z').getUTCDay()];
          const row = '<tr data-vdd-date="' + day.date + '" class="' + (day.future ? 'vdd-future' : day.marked ? 'vdd-recorded' : 'vdd-unmarked') + '"><th scope="row"><strong>' +
            Number(day.date.slice(-2)) + '</strong><small>' + weekday + '</small></th><td><strong class="vdd-day-score">' +
            (day.future ? '—' : day.percent === null ? '—' : day.percent + '%') + '</strong><small>' +
            (day.future ? 'Будущий день' : day.marked + ' из 6') + '</small></td><td><div class="vdd-day-marks">' +
            HABITS.map(habit => {
              const mark = day.marks[habit.id];
              const label = habit.label + ': ' + (day.future ? 'будущий день' : mark === null ? 'нет отметки' : LABELS[mark] + ', ' + VALUES[mark] + '%');
              return '<span class="vdd-mark ' + (mark || 'missing') + '" title="' + label + '" aria-label="' + label + '">' + (mark === null ? '—' : SYMBOLS[mark]) + '</span>';
            }).join('') + '</div></td></tr>';
          return row + (day.note ? '<tr class="vdd-note-row"><td colspan="3"><details><summary>Заметка за ' + dateLabel(day.date) + '</summary><p>' + escape(day.note.slice(0,1200)) + '</p></details></td></tr>' : '');
        }).join('') + '</tbody></table></div>' +
        '<div class="vdd-legend"><span><i class="vdd-mark done">✓</i> Выполнено</span><span><i class="vdd-mark partial">½</i> Частично</span>' +
        '<span><i class="vdd-mark missed">×</i> Не выполнено</span><span><i class="vdd-mark missing">—</i> Нет отметки</span></div>' +
        '<p class="vdd-help">П — питание · В — вода · Д — движение · С — сон · Э — экранное время · См — самочувствие.</p></section>';
    }
    function recommendationForm() {
      const child = selected(), draft = draftFor(child.id);
      return '<section class="vdd-card vdd-plan-card"><h2>Индивидуальные рекомендации</h2><p class="vdd-help">Для ' + escape(child.name) +
        '. Сохранённый текст появится в саду этого ребёнка. Пустое поле означает, что рекомендация не задана.</p>' +
        '<form data-vdd-recommendations><div class="vdd-plan-fields">' + HABITS.map(habit =>
          '<label class="vdd-plan-field"><span>' + habit.label + '</span><textarea data-vdd-recommendation="' + habit.id + '" name="' + habit.id +
          '" maxlength="1200" rows="3" placeholder="Добавьте текст рекомендации"' + (state.saving ? ' disabled' : '') + '>' + escape(draft.values[habit.id]) +
          '</textarea><small data-vdd-count="' + habit.id + '">' + draft.values[habit.id].length + ' / 1200</small></label>').join('') + '</div>' +
        '<div class="vdd-save-area"><p class="vdd-help" data-vdd-dirty role="status">' + (draft.dirty.size ? 'Есть несохранённые изменения' : 'Рекомендации редактируются отдельно для каждого ребёнка') +
        '</p><button type="submit" class="vdd-primary" data-vdd-save' + (state.saving || !draft.dirty.size ? ' disabled' : '') + '>' +
        (state.saving ? 'Сохраняем…' : 'Сохранить рекомендации') + '</button></div></form></section>';
    }
    function render() {
      if (disposed) return;
      let html = '<div class="vdd-root">' + heading() + message(storageWarning(),'storage') + message(state.error,'error') + message(state.notice,'success');
      if (!state.children.length) {
        html += state.loading ? '<div class="vdd-loading" role="status">Загружаем семьи…</div>' :
          '<section class="vdd-card vdd-empty"><div class="vdd-empty-symbol" aria-hidden="true">＋</div><h2>Пока нет профилей детей</h2>' +
          '<p>Создайте ребёнка через вход для родителей, отметьте привычки в его саду и вернитесь в кабинет врача.</p>' +
          '<button type="button" class="vdd-primary" data-vdd="exit">К выбору входа</button>' +
          '<button type="button" class="vdd-text-button" data-vdd="refresh">Обновить список</button></section>';
      } else {
        html += selection() + monthNavigation();
        if (state.loading) html += '<div class="vdd-loading" role="status">Загружаем дневник ребёнка…</div>';
        else if (state.garden) {
          const stats = computeStats(state.garden,state.month);
          html += '<p class="vdd-child-caption">' + escape(selected().name) + (validDate(selected().birthDate) ? ' · ' + dateLabel(selected().birthDate,true) : '') + '</p>' +
            summary(stats) + '<details class="vdd-method"><summary>Как считаются показатели</summary><p>Выполнено — 100%, частично — 50%, не выполнено — 0%. ' +
            'Среднее считается только по заполненным отметкам. Пустая отметка не означает «не выполнено». Общий показатель учитывает каждую отметку с одинаковым весом.</p>' +
            '<p>Это обзор дневника семьи, а не оценка здоровья ребёнка.</p></details>' + habitSummary(stats) + dayTable(stats) + recommendationForm();
        } else html += '<button type="button" class="vdd-primary" data-vdd="retry">Повторить загрузку</button>';
      }
      host.innerHTML = html + '</div>';
    }
    async function loadGarden(childId, month) {
      const ticket = ++version;
      state.selectedChildId = childId; state.month = month; state.garden = null;
      state.loading = true; state.error = ''; state.notice = ''; render();
      try {
        const result = await options.api('doctor-garden',{method:'GET',params:{childId,month}});
        if (disposed || ticket !== version) return;
        if (!result || !object(result.garden) || !object(result.garden.entries)) throw new Error('Invalid diary response');
        state.garden = result.garden; draftFor(childId,result.garden.recommendations);
      } catch (error) { if (!disposed && ticket === version) report(error,'Не удалось загрузить дневник. Попробуйте ещё раз.'); }
      finally { if (!disposed && ticket === version) { state.loading = false; render(); } }
    }
    async function refresh() {
      if (state.saving) return;
      const ticket = ++version;
      state.loading = true; state.error = ''; state.notice = ''; render();
      try {
        const result = await options.api('doctor-children',{method:'GET'});
        if (disposed || ticket !== version) return;
        if (!result || !Array.isArray(result.children)) throw new Error('Invalid children response');
        state.children = result.children.filter(child => child && typeof child.id === 'string' && typeof child.name === 'string');
        for (const id of drafts.keys()) if (!state.children.some(child => child.id === id)) drafts.delete(id);
        if (!state.children.some(child => child.id === state.selectedChildId)) state.selectedChildId = state.children[0] && state.children[0].id || null;
        if (state.selectedChildId) { await loadGarden(state.selectedChildId,state.month); return; }
        state.garden = null;
      } catch (error) { if (!disposed && ticket === version) report(error,'Не удалось загрузить список детей. Попробуйте ещё раз.'); }
      finally { if (!disposed && ticket === version) { state.loading = false; render(); } }
    }
    async function save() {
      const child = selected();
      if (!child || state.saving || state.loading) return;
      const draft = draftFor(child.id), patch = {};
      for (const key of draft.dirty) patch[key] = draft.values[key];
      if (!Object.keys(patch).length) return;
      const ticket = version;
      state.saving = true; state.error = ''; state.notice = ''; render();
      try {
        const result = await options.api('doctor-recommendations',{method:'PUT',params:{childId:child.id},body:{recommendations:patch}});
        if (disposed || ticket !== version) return;
        if (!result || !object(result.recommendations)) throw new Error('Invalid recommendations response');
        const saved = recommendations(result.recommendations);
        draft.values = {...saved}; draft.base = {...saved}; draft.dirty.clear();
        if (state.garden) { state.garden.recommendations = saved; state.garden.recommendationsUpdatedAt = result.updatedAt || null; }
        state.notice = 'Рекомендации сохранены для ' + child.name + '. Их можно посмотреть во входе для родителей.';
      } catch (error) { if (!disposed && ticket === version) report(error,'Не удалось сохранить рекомендации. Текст остался в форме.'); }
      finally { if (!disposed && ticket === version) { state.saving = false; render(); } }
    }
    function onClick(event) {
      const button = event.target.closest('button[data-vdd]');
      if (!button || !host.contains(button) || button.disabled) return;
      event.preventDefault(); event.stopPropagation();
      const action = button.dataset.vdd;
      if (action === 'exit') { if (typeof options.onExit === 'function') options.onExit(); return; }
      if (state.saving) return;
      if (action === 'refresh') { refresh(); return; }
      if (action === 'retry' && selected()) { loadGarden(state.selectedChildId,state.month); return; }
      if ((action === 'prev-month' || action === 'next-month') && selected()) {
        const [year, month] = state.month.split('-').map(Number);
        const next = new Date(Date.UTC(year,month - 1 + (action === 'prev-month' ? -1 : 1),1)).toISOString().slice(0,7);
        if (next >= '1900-01' && next <= today().slice(0,7)) loadGarden(state.selectedChildId,next);
      }
    }
    function onChange(event) {
      if (state.saving) return;
      if (event.target.matches('[data-vdd-child]')) {
        const id = event.target.value;
        if (state.children.some(child => child.id === id)) loadGarden(id,state.month);
      }
      if (event.target.matches('[data-vdd-month]')) {
        const month = event.target.value;
        if (/^(19|20|21)\d{2}-(0[1-9]|1[0-2])$/.test(month) && month <= today().slice(0,7) && selected()) loadGarden(state.selectedChildId,month);
        else render();
      }
    }
    function onInput(event) {
      if (state.saving || !selected()) return;
      const key = event.target.dataset.vddRecommendation;
      if (!HABITS.some(habit => habit.id === key)) return;
      const draft = draftFor(state.selectedChildId), value = event.target.value.slice(0,1200);
      draft.values[key] = value;
      if (value === draft.base[key]) draft.dirty.delete(key); else draft.dirty.add(key);
      const counter = host.querySelector('[data-vdd-count="' + key + '"]');
      if (counter) counter.textContent = value.length + ' / 1200';
      const button = host.querySelector('[data-vdd-save]'), status = host.querySelector('[data-vdd-dirty]');
      if (button) button.disabled = !draft.dirty.size;
      if (status) status.textContent = draft.dirty.size ? 'Есть несохранённые изменения' : 'Рекомендации редактируются отдельно для каждого ребёнка';
    }
    function onSubmit(event) {
      if (!event.target.matches('[data-vdd-recommendations]')) return;
      event.preventDefault(); event.stopPropagation(); save();
    }
    host.addEventListener('click',onClick);
    host.addEventListener('change',onChange);
    host.addEventListener('input',onInput);
    host.addEventListener('submit',onSubmit);
    refresh();
    return Object.freeze({destroy() {
      if (disposed) return;
      disposed = true; version++; drafts.clear(); state.children = []; state.garden = null;
      host.removeEventListener('click',onClick); host.removeEventListener('change',onChange);
      host.removeEventListener('input',onInput); host.removeEventListener('submit',onSubmit);
      host.textContent = '';
    }});
  }

  global.VDDoctor = Object.freeze({mount,computeStats});
})(window);
