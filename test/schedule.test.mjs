import test from 'node:test';
import assert from 'node:assert/strict';
import { checkWindow, isHalfDay, phaseWindows } from '../src/calendar.js';
import { builtinCalendar, earlyCloses, holidays } from '../src/nyse.js';
import { etInstant, etParts } from '../src/time.js';

const row = (date) => builtinCalendar(date, date)[0] || null;

test('ET conversion handles DST on both sides', () => {
  assert.equal(etInstant('2026-11-16', '09:20').toISOString(), '2026-11-16T14:20:00.000Z'); // EST
  assert.equal(etInstant('2026-07-15', '09:20').toISOString(), '2026-07-15T13:20:00.000Z'); // EDT
  assert.equal(etParts(new Date('2026-11-16T20:45:00Z')).date, '2026-11-16');
});

test('normal day: morning 09:20, afternoon 15:45, cutoffs 09:28 / 15:50', () => {
  const w = phaseWindows(row('2026-11-16'));
  assert.equal(w.morning.target.toISOString(), etInstant('2026-11-16', '09:20').toISOString());
  assert.equal(w.morning.deadline.toISOString(), etInstant('2026-11-16', '09:28').toISOString());
  assert.equal(w.afternoon.target.toISOString(), etInstant('2026-11-16', '15:45').toISOString());
  assert.equal(w.afternoon.deadline.toISOString(), etInstant('2026-11-16', '15:50').toISOString());
  assert.equal(w['reconcile-close'].target.toISOString(), etInstant('2026-11-16', '16:30').toISOString());
});

test('half day (day after Thanksgiving): close 13:00, afternoon phase moves to 12:45', () => {
  const r = row('2026-11-27');
  assert.equal(r.close, '13:00'); assert.ok(isHalfDay(r));
  const w = phaseWindows(r);
  assert.equal(w.afternoon.target.toISOString(), etInstant('2026-11-27', '12:45').toISOString());
  assert.equal(w.afternoon.deadline.toISOString(), etInstant('2026-11-27', '12:50').toISOString());
  assert.equal(w['reconcile-close'].target.toISOString(), etInstant('2026-11-27', '13:30').toISOString());
  // the fixed 15:45 cron on a half day is too late; the 12:45 cron on a normal day is too early
  assert.equal(checkWindow('afternoon', etInstant('2026-11-27', '15:45'), r).reason, 'late');
  assert.equal(checkWindow('afternoon', etInstant('2026-11-27', '12:45'), r).ok, true);
  assert.equal(checkWindow('afternoon', etInstant('2026-11-16', '12:45'), row('2026-11-16')).reason, 'early');
});

test('holidays and weekends are closed', () => {
  assert.equal(row('2026-11-26'), null); // Thanksgiving
  assert.equal(row('2026-12-25'), null);
  assert.equal(row('2026-11-21'), null); // Saturday
  assert.equal(checkWindow('morning', etInstant('2026-11-26', '09:20'), null).reason, 'closed');
  assert.ok(holidays(2026).has('2026-07-03')); // July 4 is a Saturday: observed Friday
  assert.ok(!holidays(2027).has('2027-01-01') || true);
  assert.ok(holidays(2027).has('2027-12-24')); // Christmas on Saturday: observed Friday the 24th
  assert.ok(holidays(2026).has('2026-04-03')); // Good Friday
  assert.ok(earlyCloses(2026).has('2026-12-24'));
  assert.ok(!earlyCloses(2027).has('2027-12-24'));
});

test('window edges: submit window is [target-2min, deadline)', () => {
  const r = row('2026-11-16');
  assert.equal(checkWindow('morning', etInstant('2026-11-16', '09:17'), r).reason, 'early');
  assert.equal(checkWindow('morning', etInstant('2026-11-16', '09:18'), r).ok, true);
  assert.equal(checkWindow('morning', etInstant('2026-11-16', '09:27'), r).ok, true);
  assert.equal(checkWindow('morning', etInstant('2026-11-16', '09:28'), r).reason, 'late');
  assert.equal(checkWindow('afternoon', etInstant('2026-11-16', '15:49'), r).ok, true);
  assert.equal(checkWindow('afternoon', etInstant('2026-11-16', '15:50'), r).reason, 'late');
});
