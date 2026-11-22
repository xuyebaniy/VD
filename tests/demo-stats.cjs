'use strict';

// Test the public calculator from the real doctor module with deterministic dates.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const context = {window: {}, Intl, Date};
vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'doctor-cabinet.js'), 'utf8'), context,
  {filename: 'doctor-cabinet.js'});
const stats = context.window.VDDoctor.computeStats;
let checks = 0;
function check(label, run) { run(); checks++; console.log('PASS: ' + label); }

check('empty month has no invented percentage; future dates are excluded from possible marks', () => {
  const result = stats({entries: {}}, '2026-11', '2026-11-22');
  assert.equal(result.percent, null);
  assert.equal(result.marked, 0);
  assert.equal(result.possible, 132);
  assert.equal(result.daysPossible, 22);
  assert.equal(result.calendarDays, 30);
  assert.equal(result.days[22].future, true);
});

check('done/partial/missed receive 100/50/0; only marked habits enter the average', () => {
  const result = stats({entries: {'2026-11-01': {meal: 'done', water: 'partial', activity: 'missed'}}},
    '2026-11', '2026-11-22');
  assert.equal(result.percent, 50);
  assert.equal(result.days[0].percent, 50);
  assert.equal(result.days[0].marked, 3);
  assert.equal(result.byHabit.water.percent, 50);
  assert.equal(result.byHabit.sleep.percent, null);
});

check('an explicit not-completed mark produces zero; an absent mark produces null', () => {
  const result = stats({entries: {'2026-11-01': {meal: 'missed'}}}, '2026-11', '2026-11-22');
  assert.equal(result.percent, 0);
  assert.equal(result.byHabit.meal.percent, 0);
  assert.equal(result.byHabit.water.percent, null);
  assert.equal(result.days[1].percent, null);
  assert.equal(result.days[1].marked, 0);
});

check('the month weights every mark equally instead of averaging daily percentages', () => {
  const result = stats({entries: {
    '2026-11-01': {meal: 'done', water: 'missed', activity: 'missed', sleep: 'missed', screen: 'missed', mood: 'missed'},
    '2026-11-02': {meal: 'done'}
  }}, '2026-11', '2026-11-22');
  assert.equal(result.percent, 29);
  assert.equal(result.marked, 7);
  assert.equal(result.days[0].percent, 17);
  assert.equal(result.days[1].percent, 100);
  assert.equal(result.byHabit.meal.percent, 100);
  assert.equal(result.daysWithEntries, 2);
});

check('note-only days do not fabricate adherence or the last marked date', () => {
  const result = stats({entries: {'2026-11-01': {note: 'Синтетическая заметка'}}}, '2026-11', '2026-11-22');
  assert.equal(result.percent, null);
  assert.equal(result.daysWithEntries, 0);
  assert.equal(result.lastMarkedDate, null);
  assert.equal(result.days[0].note, 'Синтетическая заметка');
});

check('future, other-month, invalid calendar dates and invalid mark values are excluded', () => {
  const result = stats({entries: {
    '2026-11-22': {meal: 'done', water: 'unknown'},
    '2026-11-23': {meal: 'done'},
    '2026-11-31': {meal: 'done'},
    '2026-10-31': {meal: 'done'}
  }}, '2026-11', '2026-11-22');
  assert.equal(result.marked, 1);
  assert.equal(result.percent, 100);
  assert.equal(result.lastMarkedDate, '2026-11-22');
  assert.equal(result.days[22].marked, 0);
  assert.equal(result.days[22].possible, 0);
});

check('a leap-year month includes February 29', () => {
  const result = stats({entries: {'2024-02-29': {meal: 'partial'}}}, '2024-02', '2024-03-01');
  assert.equal(result.calendarDays, 29);
  assert.equal(result.possible, 174);
  assert.equal(result.percent, 50);
  assert.equal(result.lastMarkedDate, '2024-02-29');
});

check('a future month stays empty with zero possible days', () => {
  const result = stats({entries: {'2026-12-01': {meal: 'done'}}}, '2026-12', '2026-11-22');
  assert.equal(result.percent, null);
  assert.equal(result.daysPossible, 0);
  assert.equal(result.possible, 0);
  assert.equal(result.marked, 0);
});

check('calculation does not mutate its source entries', () => {
  const garden = {entries: {'2026-11-01': {meal: 'done', note: 'demo'}}};
  const before = JSON.stringify(garden);
  stats(garden, '2026-11', '2026-11-22');
  assert.equal(JSON.stringify(garden), before);
});

check('an invalid month or cutoff date fails explicitly', () => {
  assert.throws(() => stats({}, '2026-13', '2026-11-22'), /Invalid month/);
  assert.throws(() => stats({}, '2026-11', '2026-02-30'), /Invalid calculation date/);
});

console.log('Doctor statistics: ' + checks + ' checks passed.');
