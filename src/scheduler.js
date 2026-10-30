'use strict';
// When the next automatic backup is due. Pure date maths, so it is easy to test.

const EVERY = {
  hourly: { label: 'Every hour', hours: 1 },
  every6h: { label: 'Every 6 hours', hours: 6 },
  every12h: { label: 'Every 12 hours', hours: 12 },
  daily: { label: 'Every day' },
  weekly: { label: 'Every week' },
};

function parseTime(t) {
  const m = String(t || '03:00').match(/^(\d{1,2}):(\d{2})$/);
  const h = m ? Math.min(23, Number(m[1])) : 3;
  const min = m ? Math.min(59, Number(m[2])) : 0;
  return { h, min };
}

// First scheduled moment strictly after `from` (local time).
function nextRunAfter(schedule, from) {
  const f = new Date(from);
  const every = schedule.every || 'daily';
  if (EVERY[every] && EVERY[every].hours) {
    const n = EVERY[every].hours;
    const d = new Date(f);
    d.setMinutes(0, 0, 0);
    do d.setHours(d.getHours() + 1); while (d.getHours() % n !== 0);
    return d;
  }
  const { h, min } = parseTime(schedule.time);
  const d = new Date(f);
  d.setHours(h, min, 0, 0);
  if (every === 'weekly') {
    const wd = Number.isInteger(schedule.weekday) ? schedule.weekday : 1;
    let add = (wd - d.getDay() + 7) % 7;
    if (add === 0 && d <= f) add = 7;
    d.setDate(d.getDate() + add);
    return d;
  }
  if (d <= f) d.setDate(d.getDate() + 1);
  return d;
}

// The last run (or the moment the schedule was turned on) decides the next one.
// A run missed while the PC was off happens as soon as the app is running again.
function nextRun(server) {
  const s = server.schedule;
  if (!s || !s.enabled) return null;
  const last = server.lastRun && server.lastRun.at ? new Date(server.lastRun.at) : null;
  const since = s.since ? new Date(s.since) : new Date();
  const base = last && last > since ? last : since;
  return nextRunAfter(s, base);
}

function isDue(server, now = new Date()) {
  const n = nextRun(server);
  return !!n && n <= now;
}

module.exports = { EVERY, nextRunAfter, nextRun, isDue, parseTime };
