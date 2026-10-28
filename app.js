'use strict';

/* =========================================================================
   Habits — an offline, on-device habit tracker.
   All data lives in this phone's storage (localStorage). Nothing is sent
   anywhere. Use Settings → Backup to keep a copy of your data.
   ========================================================================= */

const STORE_KEY = 'habits.v1';
const APP_VERSION = '1.5.5'; // keep in step with sw.js and version.json
// True when running inside another page (e.g. the hosted claude.ai copy),
// where downloads, notifications and offline caching are unavailable.
const EMBEDDED = (() => { try { return window.self !== window.top; } catch (e) { return true; } })();
const DAY = 86400000;

const EMOJIS = ['💧','🏃','📖','🧘','💪','🥗','😴','🦷','💊','🙏','✍️','🎯','💰','🧹','📵','🚶','🎸','🧠','🌱','☀️','❤️','📞','🍎','🚭'];
const COLORS = ['#5b5bd6','#e5484d','#f76b15','#e2a336','#30a46c','#12a594','#0090ff','#8e4ec6','#d6409f','#6f6e77'];
const MOODS = ['😞','😕','😐','🙂','😄'];
const FREQ_LABEL = { daily: 'Daily', weekly: 'Weekly', monthly: 'Monthly' };
const DOW = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];

/* ----------------------------- dates ---------------------------------- */

const pad = n => String(n).padStart(2, '0');
const keyOf = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const parseKey = k => { const [y, m, d] = k.split('-').map(Number); return new Date(y, m - 1, d); };
const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
const addMonths = (d, n) => new Date(d.getFullYear(), d.getMonth() + n, 1);
const today = () => { const n = new Date(); return new Date(n.getFullYear(), n.getMonth(), n.getDate()); };
const todayKey = () => keyOf(today());
const startOfWeek = d => addDays(d, -((d.getDay() - state.settings.weekStart + 7) % 7));
const startOfMonth = d => new Date(d.getFullYear(), d.getMonth(), 1);
const endOfMonth = d => new Date(d.getFullYear(), d.getMonth() + 1, 0);
const daysBetween = (a, b) => Math.round((b - a) / DAY);
const fmtDay = d => d.toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' });
const fmtShort = d => d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });

/* ----------------------------- state ---------------------------------- */

function defaultState() {
  return {
    version: 1,
    habits: [],
    log: {},        // { habitId: { 'YYYY-MM-DD': 1 } }
    journal: {},    // { 'YYYY-MM-DD': { mood: 0-4, note: '' } }
    settings: {
      weekStart: 1, // Monday
      theme: 'auto',
      reminders: [ { time: '18:00', on: true }, { time: '20:00', on: true } ],
      lastFired: {},
      lastBackup: null,
    },
  };
}

function load() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return null;
    const s = JSON.parse(raw);
    const d = defaultState();
    return { ...d, ...s, settings: { ...d.settings, ...(s.settings || {}) } };
  } catch (e) {
    console.error(e);
    return null;
  }
}

let state = load() || seed(defaultState());

function save() {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(state)); }
  catch (e) { toast('Could not save — storage is full?'); }
}

function uid() { return Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4); }

function seed(s) {
  const created = todayKey();
  const mk = (name, emoji, freq, target, area, color) =>
    ({ id: uid(), name, emoji, freq, target, area, color, days: [0,1,2,3,4,5,6], created, archived: false });
  s.habits = [
    mk('Drink 8 glasses of water', '💧', 'daily', 1, 'Health', COLORS[6]),
    mk('Read 20 minutes', '📖', 'daily', 1, 'Growth', COLORS[7]),
    mk('Exercise', '🏃', 'weekly', 3, 'Health', COLORS[4]),
    mk('Review budget', '💰', 'monthly', 1, 'Finance', COLORS[3]),
  ];
  s.firstRun = true;
  return s;
}

/* --------------------------- habit logic ------------------------------ */

const active = () => state.habits.filter(h => !h.archived);
const byFreq = f => active().filter(h => h.freq === f);
const isDone = (h, k) => !!(state.log[h.id] && state.log[h.id][k]);
const targetOf = h => h.freq === 'daily' ? 1 : Math.max(1, h.target || 1);

function setDone(h, k, on) {
  const m = state.log[h.id] || (state.log[h.id] = {});
  if (on) m[k] = 1; else delete m[k];
  save();
}

function scheduledOn(h, d) {
  if (keyOf(d) < h.created) return false;
  if (h.freq !== 'daily') return true;
  return (h.days || [0,1,2,3,4,5,6]).includes(d.getDay());
}

function countBetween(h, from, to) {
  const m = state.log[h.id];
  if (!m) return 0;
  const a = keyOf(from), b = keyOf(to);
  let n = 0;
  for (const k in m) if (k >= a && k <= b) n++;
  return n;
}

/* A "period" is one day (daily), one week (weekly) or one month (monthly). */
function periodOf(h, d) {
  if (h.freq === 'daily') return { start: d, end: d };
  if (h.freq === 'weekly') { const s = startOfWeek(d); return { start: s, end: addDays(s, 6) }; }
  return { start: startOfMonth(d), end: endOfMonth(d) };
}
function prevPeriodStart(h, p) {
  if (h.freq === 'daily') return addDays(p.start, -1);
  if (h.freq === 'weekly') return addDays(p.start, -7);
  return addMonths(p.start, -1);
}

/* Walk periods backwards from `to` until `from` (or the habit's creation). */
function periods(h, from, to) {
  const out = [];
  const created = parseKey(h.created);
  const t = today();
  let p = periodOf(h, to);
  while (p.end >= from && p.end >= created) {
    if (h.freq !== 'daily' || scheduledOn(h, p.start)) {
      const count = h.freq === 'daily' ? +isDone(h, keyOf(p.start)) : countBetween(h, p.start, p.end);
      out.push({ ...p, count, met: count >= targetOf(h), current: p.end >= t && p.start <= t });
    }
    const s = prevPeriodStart(h, p);
    p = periodOf(h, s);
    if (out.length > 5000) break;
  }
  return out; // newest first
}

/* Completion rate over a window. The current, unfinished period only
   counts once it's met, so you aren't penalised for a day still in progress. */
function rate(h, from, to = today()) {
  const ps = periods(h, from, to).filter(p => !p.current || p.met);
  if (!ps.length) return null;
  return ps.filter(p => p.met).length / ps.length;
}

function streaks(h) {
  const ps = periods(h, parseKey(h.created), today());
  let current = 0, best = 0, run = 0;
  let counting = true;
  for (const p of ps) {
    if (p.current && !p.met) continue;
    if (p.met) { run++; if (counting) current = run; }
    else { counting = false; run = 0; }
    best = Math.max(best, run);
  }
  return { current, best };
}

const unitOf = h => ({ daily: 'day', weekly: 'week', monthly: 'month' })[h.freq];
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

/* ------------------------------ UI utils ------------------------------ */

const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const pct = r => r == null ? '—' : Math.round(r * 100) + '%';
const tone = r => r == null ? '' : r >= 0.8 ? 'good' : r >= 0.5 ? 'warn' : 'bad';

let toastTimer;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2200);
}

/* In-app confirmation sheet (window.confirm isn't available everywhere). */
function ask(msg, okLabel = 'OK', danger = false) {
  return new Promise(resolve => {
    const d = $('#confirm');
    d.innerHTML = `<div class="sheet"><p style="margin:0;font-size:17px">${esc(msg)}</p>
      <div class="sheet-actions"><button class="btn secondary" value="no">Cancel</button>
      <button class="btn ${danger ? 'danger' : ''}" value="yes">${esc(okLabel)}</button></div></div>`;
    d.onclick = e => {
      const b = e.target.closest('button');
      if (!b && e.target !== d) return;
      d.close();
      resolve(!!b && b.value === 'yes');
    };
    d.showModal();
  });
}

function haptic() { if (navigator.vibrate) navigator.vibrate(10); }

function ring(done, total) {
  const r = 36, c = 2 * Math.PI * r;
  const f = total ? done / total : 0;
  return `<svg class="ring" viewBox="0 0 84 84" aria-label="${done} of ${total} done">
    <circle class="bg" cx="42" cy="42" r="${r}"/>
    <circle class="fg" cx="42" cy="42" r="${r}" stroke-dasharray="${c}" stroke-dashoffset="${c * (1 - f)}" transform="rotate(-90 42 42)"/>
    <text x="42" y="49" text-anchor="middle">${total ? Math.round(f * 100) : 0}%</text></svg>`;
}

function emojiBox(h) {
  return `<div class="emoji" style="background:${h.color}22">${esc(h.emoji)}</div>`;
}

/* ------------------------------ router -------------------------------- */

const ui = { tab: 'today', date: todayKey(), weekOf: todayKey(), monthOf: todayKey(), range: 30 };

/* iPhone can keep the app in memory for days, so check the date often and
   move "today" (and this week / this month) forward after midnight.
   Returns true when the day changed. */
let lastDay = todayKey();
function rollover() {
  const t = todayKey();
  if (t === lastDay) return false;
  if (ui.date === lastDay) ui.date = t;
  if (ui.weekOf === lastDay) ui.weekOf = t;
  if (ui.monthOf === lastDay) ui.monthOf = t;
  lastDay = t;
  return true;
}
const TITLES = { today: 'Today', week: 'This Week', month: 'This Month', stats: 'Progress', settings: 'Settings' };

function go(tab) {
  ui.tab = tab;
  document.querySelectorAll('.tabbar button').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
  render();
  window.scrollTo(0, 0);
}

function render() {
  if (locked) return;
  rollover();
  $('#title').textContent = TITLES[ui.tab];
  $('#addBtn').style.visibility = ui.tab === 'settings' ? 'hidden' : 'visible';
  const v = $('#view');
  v.innerHTML = ({ today: viewToday, week: viewWeek, month: viewMonth, stats: viewStats, settings: viewSettings })[ui.tab]();
}

/* ------------------------------ Today --------------------------------- */

function pendingToday() {
  const d = today();
  return byFreq('daily').filter(h => scheduledOn(h, d) && !isDone(h, keyOf(d)));
}

function reminderBanner() {
  if (ui.date !== todayKey()) return '';
  const now = new Date();
  const mins = now.getHours() * 60 + now.getMinutes();
  const due = state.settings.reminders.filter(r => r.on).some(r => {
    const [hh, mm] = r.time.split(':').map(Number);
    return mins >= hh * 60 + mm;
  });
  if (!due) return '';
  const left = pendingToday();
  if (!left.length) return `<div class="banner good">🎉<div><b>All daily habits done today.</b><br><span class="small">Nice work — see you tomorrow.</span></div></div>`;
  return `<div class="banner">🔔<div><b>Evening check-in</b><br><span class="small">${plural(left.length, 'habit')} still to tick or untick for today.</span></div></div>`;
}

function habitRow(h, d, opts = {}) {
  const k = keyOf(d);
  const on = isDone(h, k);
  let meta = h.area ? esc(h.area) : '';
  let bar = '';
  if (h.freq !== 'daily') {
    const p = periodOf(h, d);
    const c = countBetween(h, p.start, p.end), t = targetOf(h);
    meta = `${c}/${t} this ${unitOf(h)}${c >= t ? ' ✓' : ''}${h.area ? ' · ' + esc(h.area) : ''}`;
    bar = `<div class="bar" style="--hc:${h.color}"><i style="width:${Math.min(100, c / t * 100)}%"></i></div>`;
  } else {
    const s = streaks(h).current;
    if (s > 1) meta = `🔥 ${s}-day streak${h.area ? ' · ' + esc(h.area) : ''}`;
  }
  if (opts.offDay) {
    const order = [...Array(7)].map((_, i) => (i + state.settings.weekStart) % 7);
    meta = `Due ${order.filter(i => (h.days || []).includes(i)).map(i => DOW[i]).join(' · ')}`;
    return `<div class="habit offday">
    ${emojiBox(h)}
    <div class="grow"><div class="name">${esc(h.name)}</div><div class="meta">${meta}</div></div>
    <button class="more" data-act="edit" data-id="${h.id}" aria-label="Edit ${esc(h.name)}">⋯</button>
  </div>`;
  }
  const disabled = opts.future ? 'disabled' : '';
  return `<div class="habit ${on ? 'done' : ''}">
    ${emojiBox(h)}
    <div class="grow"><div class="name">${esc(h.name)}</div><div class="meta">${meta}</div>${bar}</div>
    <button class="more" data-act="edit" data-id="${h.id}" aria-label="Edit ${esc(h.name)}">⋯</button>
    <button class="check ${on ? 'on' : ''}" style="--hc:${h.color}" data-act="toggle" data-id="${h.id}" data-k="${k}" ${disabled}
      aria-pressed="${on}" aria-label="Mark ${esc(h.name)} ${on ? 'not done' : 'done'}">✓</button>
  </div>`;
}

function viewToday() {
  const d = parseKey(ui.date);
  const isToday = ui.date === todayKey();
  const future = d > today();
  const daily = byFreq('daily').filter(h => scheduledOn(h, d));
  const offDay = byFreq('daily').filter(h => keyOf(d) >= h.created && !scheduledOn(h, d));
  const weekly = byFreq('weekly').filter(h => keyOf(periodOf(h, d).end) >= h.created);
  const monthly = byFreq('monthly').filter(h => keyOf(periodOf(h, d).end) >= h.created);
  const done = daily.filter(h => isDone(h, ui.date)).length;
  const j = state.journal[ui.date] || {};

  let html = `<div class="datenav">
    <button data-act="day" data-n="-1" aria-label="Previous day">‹</button>
    <div class="label"><b>${isToday ? 'Today' : fmtDay(d)}</b>
      ${isToday ? `<span class="small muted">${fmtDay(d)}</span>` : `<button data-act="today">Jump to today</button>`}</div>
    <button data-act="day" data-n="1" aria-label="Next day" ${isToday ? 'style="visibility:hidden"' : ''}>›</button>
  </div>`;

  html += updateBanner();
  if (lockWasReset) {
    html += `<div class="banner update">🔓<div class="grow"><b>You’re back in</b><br><span class="small">App lock was switched off so you could get into your habits. You can turn it on again in Settings → App lock.</span>
      <br><button class="btn small secondary" data-act="dismissReset" style="margin-top:8px">OK</button></div></div>`;
  }
  html += reminderBanner();

  if (state.firstRun) {
    html += `<div class="banner good">👋<div><b>Welcome!</b> A few sample habits are here to get you started — tap ⋯ to edit or delete them, and ＋ to add your own. Then set up reminders in <a href="#" data-act="go" data-tab="settings">Settings</a>.
      <br><button class="btn small secondary" data-act="dismissWelcome" style="margin-top:8px">Got it</button></div></div>`;
  }

  html += `<div class="card hero">${ring(done, daily.length)}
    <div><div style="font-size:20px;font-weight:700">${done} of ${daily.length} daily habits</div>
    <div class="muted small">${daily.length && done === daily.length ? 'Everything done — great day!' : future ? 'This day hasn’t happened yet.' : 'Tap the circle to tick, tap again to untick.'}</div></div></div>`;

  const section = (title, list, hint, offDay = false) => {
    if (!list.length) return '';
    return `<div class="section-title"><span>${title}</span><span>${hint || ''}</span></div>
      <div class="card">${list.map(h => habitRow(h, d, { future, offDay })).join('')}</div>`;
  };

  if (!active().length) {
    html += `<div class="card empty">No habits yet.<br><button class="btn" data-act="add" style="margin-top:10px">Add your first habit</button></div>`;
  }
  html += section('Daily', daily);
  html += section(`Daily · not due ${isToday ? 'today' : 'this day'}`, offDay, '', true);
  html += section('Weekly goals', weekly, 'tick on days you do them');
  html += section('Monthly goals', monthly, 'tick on days you do them');

  html += `<div class="section-title"><span>How was the day?</span></div>
    <div class="card"><div class="mood">${MOODS.map((m, i) =>
      `<button class="${j.mood === i ? 'on' : ''}" data-act="mood" data-i="${i}" aria-label="Mood ${i + 1} of 5">${m}</button>`).join('')}</div>
    <textarea class="note" id="note" placeholder="Notes for the day (optional)">${esc(j.note || '')}</textarea></div>`;

  const archived = state.habits.filter(h => h.archived);
  if (archived.length) {
    html += `<details class="archived"><summary>Archived habits (${archived.length})</summary><div class="card">${archived.map(h =>
      `<div class="list-item"><span style="font-size:22px">${esc(h.emoji)}</span><span class="grow">${esc(h.name)}</span>
       <button class="btn small secondary" data-act="edit" data-id="${h.id}">Edit</button></div>`).join('')}</div></details>`;
  }
  return html;
}

/* ------------------------------- Week --------------------------------- */

function viewWeek() {
  const s = startOfWeek(parseKey(ui.weekOf));
  const days = [...Array(7)].map((_, i) => addDays(s, i));
  const t = today(), tk = keyOf(t);
  const isCurrent = s.getTime() === startOfWeek(t).getTime();
  const daily = byFreq('daily').filter(h => keyOf(days[6]) >= h.created);
  const weekly = byFreq('weekly').filter(h => keyOf(days[6]) >= h.created);

  // weekly score: ticks done vs. what was expected so far
  let got = 0, need = 0;
  for (const h of daily) for (const d of days) if (d <= t && scheduledOn(h, d)) { need++; if (isDone(h, keyOf(d))) got++; }
  for (const h of weekly) { need += targetOf(h); got += Math.min(targetOf(h), countBetween(h, days[0], days[6])); }

  let html = `<div class="datenav">
    <button data-act="week" data-n="-1" aria-label="Previous week">‹</button>
    <div class="label"><b>${fmtShort(days[0])} – ${fmtShort(days[6])}</b>
      ${isCurrent ? '<span class="small muted">This week</span>' : '<button data-act="thisweek">Jump to this week</button>'}</div>
    <button data-act="week" data-n="1" aria-label="Next week" ${isCurrent ? 'style="visibility:hidden"' : ''}>›</button>
  </div>`;

  html += `<div class="card hero">${ring(got, need)}<div><div style="font-size:20px;font-weight:700">Week score</div>
    <div class="muted small">${got} of ${need} check-ins${isCurrent ? ' expected so far' : ''}. Tap any square to fix a missed tick.</div></div></div>`;

  const head = `<colgroup><col class="first">${days.map(() => '<col>').join('')}</colgroup>
    <tr><th></th>${days.map(d => `<th class="${keyOf(d) === tk ? 'today' : ''}">${DOW[d.getDay()][0]}<br>${d.getDate()}</th>`).join('')}</tr>`;
  const rowFor = h => `<tr><td class="hname">${esc(h.emoji)} ${esc(h.name)}</td>${days.map(d => {
    const k = keyOf(d);
    if (!scheduledOn(h, d)) return `<td><button class="cell off" disabled aria-label="Not scheduled"></button></td>`;
    const on = isDone(h, k), fut = d > t;
    return `<td><button class="cell ${on ? 'on' : ''} ${fut ? 'future' : ''}" style="--hc:${h.color}" ${fut ? 'disabled' : ''}
      data-act="toggle" data-id="${h.id}" data-k="${k}" aria-label="${esc(h.name)} ${fmtShort(d)}">${on ? '✓' : ''}</button></td>`;
  }).join('')}</tr>`;

  if (daily.length) html += `<div class="section-title"><span>Daily habits</span></div><div class="card"><table class="grid">${head}${daily.map(rowFor).join('')}</table></div>`;

  if (weekly.length) {
    html += `<div class="section-title"><span>Weekly goals</span></div><div class="card"><table class="grid">${head}${weekly.map(rowFor).join('')}</table>`;
    html += weekly.map(h => {
      const c = countBetween(h, days[0], days[6]), tg = targetOf(h);
      return `<div style="margin-top:10px"><div class="row"><span class="grow">${esc(h.emoji)} ${esc(h.name)}</span>
        <span class="pill ${c >= tg ? 'good' : ''}">${c}/${tg}</span></div>
        <div class="bar" style="--hc:${h.color}"><i style="width:${Math.min(100, c / tg * 100)}%"></i></div></div>`;
    }).join('') + '</div>';
  }
  if (!daily.length && !weekly.length) html += `<div class="card empty">No daily or weekly habits yet.</div>`;
  return html;
}

/* ------------------------------- Month -------------------------------- */

function heat(f) {
  if (f == null) return 'var(--line)';
  if (f === 0) return 'color-mix(in srgb, var(--bad) 22%, var(--card))';
  return `color-mix(in srgb, var(--good) ${Math.round(25 + f * 75)}%, var(--card))`;
}

function viewMonth() {
  const m0 = startOfMonth(parseKey(ui.monthOf)), m1 = endOfMonth(m0);
  const t = today();
  const isCurrent = m0.getTime() === startOfMonth(t).getTime();
  const daily = byFreq('daily');
  const monthly = byFreq('monthly').filter(h => keyOf(m1) >= h.created);

  let html = `<div class="datenav">
    <button data-act="month" data-n="-1" aria-label="Previous month">‹</button>
    <div class="label"><b>${MONTHS[m0.getMonth()]} ${m0.getFullYear()}</b>
      ${isCurrent ? '<span class="small muted">This month</span>' : '<button data-act="thismonth">Jump to this month</button>'}</div>
    <button data-act="month" data-n="1" aria-label="Next month" ${isCurrent ? 'style="visibility:hidden"' : ''}>›</button>
  </div>`;

  // calendar heat map of daily-habit completion
  const lead = (m0.getDay() - state.settings.weekStart + 7) % 7;
  const dows = [...Array(7)].map((_, i) => DOW[(i + state.settings.weekStart) % 7][0]);
  let cells = dows.map(x => `<div class="dow">${x}</div>`).join('') + '<div class="blank"></div>'.repeat(lead);
  let mGot = 0, mNeed = 0;
  for (let d = m0; d <= m1; d = addDays(d, 1)) {
    const k = keyOf(d);
    const sched = daily.filter(h => scheduledOn(h, d));
    const got = sched.filter(h => isDone(h, k)).length;
    const fut = d > t;
    if (!fut) { mGot += got; mNeed += sched.length; }
    const f = fut || !sched.length ? null : got / sched.length;
    cells += `<button class="${k === keyOf(t) ? 'today' : ''} ${fut ? 'future' : ''}" style="background:${heat(f)}"
      data-act="openday" data-k="${k}" ${fut ? 'disabled' : ''} aria-label="${fmtShort(d)}: ${sched.length ? got + ' of ' + sched.length : 'nothing scheduled'}">${d.getDate()}</button>`;
  }
  html += `<div class="card hero">${ring(mGot, mNeed)}<div><div style="font-size:20px;font-weight:700">Daily habits this month</div>
    <div class="muted small">${mGot} of ${mNeed} daily check-ins done. Tap a day to review or edit it.</div></div></div>`;
  html += `<div class="card"><div class="cal">${cells}</div>
    <div class="legend">Less <i style="background:${heat(0)}"></i><i style="background:${heat(.33)}"></i><i style="background:${heat(.66)}"></i><i style="background:${heat(1)}"></i> More</div></div>`;

  if (monthly.length) {
    html += `<div class="section-title"><span>Monthly goals</span><span>tick them from Today</span></div><div class="card">`;
    html += monthly.map(h => {
      const c = countBetween(h, m0, m1), tg = targetOf(h);
      const dates = Object.keys(state.log[h.id] || {}).filter(k => k >= keyOf(m0) && k <= keyOf(m1)).sort()
        .map(k => parseKey(k).getDate()).join(', ');
      return `<div class="habit">${emojiBox(h)}<div class="grow"><div class="name">${esc(h.name)}</div>
        <div class="meta">${dates ? 'Done on: ' + dates : 'Not done yet this month'}</div>
        <div class="bar" style="--hc:${h.color}"><i style="width:${Math.min(100, c / tg * 100)}%"></i></div></div>
        <span class="pill ${c >= tg ? 'good' : ''}">${c}/${tg}</span></div>`;
    }).join('') + '</div>';
  }

  // per-habit tally for the month
  const all = active().filter(h => h.freq !== 'monthly' && keyOf(m1) >= h.created);
  if (all.length) {
    html += `<div class="section-title"><span>Habit tally</span></div><div class="card">`;
    html += all.map(h => {
      const end = isCurrent ? t : m1;
      const r = rate(h, m0 < parseKey(h.created) ? parseKey(h.created) : m0, end);
      return `<div class="list-item"><span class="grow">${esc(h.emoji)} ${esc(h.name)}</span>
        <span class="muted small">${countBetween(h, m0, m1)}×</span><span class="pill ${tone(r)}">${pct(r)}</span></div>`;
    }).join('') + '</div>';
  }
  return html;
}

/* ------------------------------- Stats -------------------------------- */

function weekScores(n) {
  const t = today();
  const out = [];
  let s = startOfWeek(t);
  for (let i = 0; i < n; i++) {
    let got = 0, need = 0;
    for (const h of active()) {
      if (h.freq === 'daily') {
        for (let j = 0; j < 7; j++) {
          const d = addDays(s, j);
          if (d > t || !scheduledOn(h, d)) continue;
          need++; if (isDone(h, keyOf(d))) got++;
        }
      } else if (h.freq === 'weekly' && keyOf(addDays(s, 6)) >= h.created) {
        need += targetOf(h); got += Math.min(targetOf(h), countBetween(h, s, addDays(s, 6)));
      }
    }
    out.unshift({ start: s, f: need ? got / need : null });
    s = addDays(s, -7);
  }
  return out;
}

function trendChart(data) {
  const W = 320, H = 130, pad = 18, bw = (W - pad) / data.length;
  const bars = data.map((w, i) => {
    const h = w.f == null ? 0 : Math.max(2, w.f * (H - 40));
    const x = pad + i * bw + 3, y = H - 18 - h;
    const col = w.f == null ? 'var(--line)' : w.f >= .8 ? 'var(--good)' : w.f >= .5 ? 'var(--warn)' : 'var(--bad)';
    return `<rect x="${x}" y="${y}" width="${bw - 6}" height="${h}" rx="3" fill="${col}"/>
      ${w.f != null ? `<text class="val" x="${x + (bw - 6) / 2}" y="${y - 4}" text-anchor="middle">${Math.round(w.f * 100)}</text>` : ''}
      <text x="${x + (bw - 6) / 2}" y="${H - 4}" text-anchor="middle">${w.start.getDate()}/${w.start.getMonth() + 1}</text>`;
  }).join('');
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Weekly score trend">
    <line x1="${pad}" x2="${W}" y1="${H - 18 - .8 * (H - 40)}" y2="${H - 18 - .8 * (H - 40)}" stroke="var(--line)" stroke-dasharray="3 3"/>
    <text x="0" y="${H - 15 - .8 * (H - 40)}">80</text>${bars}</svg>`;
}

function weekdayRates(from) {
  const t = today();
  const got = Array(7).fill(0), need = Array(7).fill(0);
  for (const h of byFreq('daily')) {
    for (let d = from < parseKey(h.created) ? parseKey(h.created) : from; d <= t; d = addDays(d, 1)) {
      if (!scheduledOn(h, d)) continue;
      if (keyOf(d) === keyOf(t) && !isDone(h, keyOf(d))) continue;
      need[d.getDay()]++; if (isDone(h, keyOf(d))) got[d.getDay()]++;
    }
  }
  return got.map((g, i) => need[i] ? g / need[i] : null);
}

function viewStats() {
  const t = today();
  const range = ui.range;
  const from = range === 0 ? new Date(2000, 0, 1) : addDays(t, -(range - 1));
  const habits = active();

  let html = `<div class="seg">${[[30, '30 days'], [90, '90 days'], [365, 'Year'], [0, 'All time']].map(([v, l]) =>
    `<button class="${range === v ? 'on' : ''}" data-act="range" data-v="${v}">${l}</button>`).join('')}</div>`;

  if (!habits.length) return html + `<div class="card empty">Add some habits and check in for a few days to see your progress here.</div>`;

  const rows = habits.map(h => {
    const lookback = h.freq === 'daily' ? 14 : h.freq === 'weekly' ? 28 : 92;
    const recent = rate(h, addDays(t, -(lookback - 1)));
    const before = rate(h, addDays(t, -(2 * lookback - 1)), addDays(t, -lookback));
    return { h, r: rate(h, from), s: streaks(h), recent, before };
  });
  const rated = rows.filter(x => x.r != null);
  const overall = rated.length ? rated.reduce((a, x) => a + x.r, 0) / rated.length : null;
  const bestStreak = Math.max(0, ...rows.filter(x => x.h.freq === 'daily').map(x => x.s.current));
  const totalTicks = habits.reduce((a, h) => a + countBetween(h, from, t), 0);

  html += `<div class="kpis">
    <div class="kpi"><b style="color:var(--${tone(overall) || 'text'})">${pct(overall)}</b><span>Overall</span></div>
    <div class="kpi"><b>🔥 ${bestStreak}</b><span>Top day streak</span></div>
    <div class="kpi"><b>${totalTicks}</b><span>Check-ins</span></div></div>`;

  // insights: doing well / needs work
  const good = rated.filter(x => x.r >= 0.8).sort((a, b) => b.r - a.r);
  const weak = rated.filter(x => x.r < 0.5).sort((a, b) => a.r - b.r);
  const slipping = rows.filter(x => x.recent != null && x.before != null && x.before - x.recent >= 0.25);
  const rising = rows.filter(x => x.recent != null && x.before != null && x.recent - x.before >= 0.25);

  const insights = [];
  for (const x of good) insights.push(['✅', `<b>${esc(x.h.name)}</b> — strong at ${pct(x.r)}. Keep it up.`]);
  for (const x of rising) insights.push(['📈', `<b>${esc(x.h.name)}</b> is improving: ${pct(x.recent)} recently vs ${pct(x.before)} before.`]);
  for (const x of weak) insights.push(['⚠️', `<b>${esc(x.h.name)}</b> needs work — only ${pct(x.r)}. ${tipFor(x.h)}`]);
  for (const x of slipping) insights.push(['📉', `<b>${esc(x.h.name)}</b> is slipping: ${pct(x.recent)} recently vs ${pct(x.before)} before.`]);
  const wd = weekdayRates(from);
  const wdr = wd.map((r, i) => ({ r, i })).filter(x => x.r != null);
  if (wdr.length >= 5) {
    const lo = wdr.reduce((a, b) => b.r < a.r ? b : a), hi = wdr.reduce((a, b) => b.r > a.r ? b : a);
    if (hi.r - lo.r >= 0.2) insights.push(['🗓️', `Your strongest day is <b>${DOW[hi.i]}</b> (${pct(hi.r)}); your weakest is <b>${DOW[lo.i]}</b> (${pct(lo.r)}). Plan ahead for ${DOW[lo.i]}s.`]);
  }
  if (!insights.length) insights.push(['🌱', rated.length ? 'Steady middle ground — no habit is below 50% or above 80% yet. Pick one to push to 80%.' : 'Check in for a few days and insights will show up here.']);

  html += `<div class="section-title"><span>Doing well & to improve</span></div>
    <div class="card">${insights.map(([i, txt]) => `<div class="insight"><span>${i}</span><span>${txt}</span></div>`).join('')}</div>`;

  html += `<div class="section-title"><span>Weekly score — last 12 weeks</span></div>
    <div class="card">${trendChart(weekScores(12))}<div class="small muted">Daily + weekly habits. Dashed line = 80% target.</div></div>`;

  // areas
  const areas = {};
  for (const x of rated) (areas[x.h.area || 'Other'] ||= []).push(x.r);
  const areaList = Object.entries(areas).map(([a, rs]) => [a, rs.reduce((p, c) => p + c, 0) / rs.length]).sort((a, b) => b[1] - a[1]);
  if (areaList.length) {
    html += `<div class="section-title"><span>By life area</span></div><div class="card">${areaList.map(([a, r]) =>
      `<div class="arearow"><div class="row"><span>${esc(a)}</span><span class="pill ${tone(r)}">${pct(r)}</span></div>
       <div class="bar" style="--hc:var(--${tone(r)})"><i style="width:${r * 100}%"></i></div></div>`).join('')}</div>`;
  }

  // weekday breakdown
  if (wdr.length) {
    const order = [...Array(7)].map((_, i) => (i + state.settings.weekStart) % 7);
    html += `<div class="section-title"><span>Daily habits by weekday</span></div><div class="card"><div class="cal">${order.map(i =>
      `<div class="dow">${DOW[i]}</div>`).join('')}${order.map(i =>
      `<button disabled style="background:${heat(wd[i])};opacity:1;font-size:12px">${wd[i] == null ? '' : Math.round(wd[i] * 100)}</button>`).join('')}</div></div>`;
  }

  // per habit
  html += `<div class="section-title"><span>Every habit</span></div><div class="card">`;
  html += rows.sort((a, b) => (b.r ?? -1) - (a.r ?? -1)).map(({ h, r, s }) => `<div class="habit">${emojiBox(h)}
    <div class="grow"><div class="name">${esc(h.name)}</div>
    <div class="meta">${FREQ_LABEL[h.freq]}${h.freq !== 'daily' ? ` · ${targetOf(h)}×` : ''} · streak ${plural(s.current, unitOf(h))} · best ${s.best}</div>
    <div class="bar" style="--hc:${h.color}"><i style="width:${(r || 0) * 100}%"></i></div></div>
    <span class="pill ${tone(r)}">${pct(r)}</span></div>`).join('') + '</div>';

  return html;
}

function tipFor(h) {
  const tips = {
    daily: ['Try linking it to something you already do every day.', 'Make it smaller — 2 minutes counts.', 'Set it up the night before so it’s easy to start.'],
    weekly: ['Pick the exact days you’ll do it and block the time.', 'Consider lowering the weekly target until it sticks.'],
    monthly: ['Put a date in your calendar for it now.', 'Do it early in the month so it’s not left to the end.'],
  }[h.freq];
  return tips[h.name.length % tips.length];
}

/* ----------------------------- Settings ------------------------------- */

function viewSettings() {
  const s = state.settings;
  const notifState = EMBEDDED || !('Notification' in window) ? 'unsupported' : Notification.permission;
  const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone;

  let html = updateBanner();
  if (EMBEDDED) {
    html += `<div class="banner">ℹ️<div><b>You’re using the hosted copy</b><br><span class="small">Your habits are saved in this browser on this phone. For the best experience, add this page to your Home Screen (Share → Add to Home Screen), always open it from there, and copy a backup every week or so (Settings → Your data).</span></div></div>`;
  } else if (!standalone) {
    html += `<div class="banner">📲<div><b>Install it on your Home Screen</b><br><span class="small">In Safari tap the Share button → <b>Add to Home Screen</b>. It then opens full-screen, works offline and keeps its data on this phone.</span></div></div>`;
  }


  html += `<div class="section-title"><span>Evening reminders</span></div><div class="card">`;
  html += s.reminders.map((r, i) => `<div class="list-item"><span>🔔</span>
    <input type="time" value="${r.time}" data-act="remtime" data-i="${i}" class="grow">
    <label class="switch"><input type="checkbox" ${r.on ? 'checked' : ''} data-act="remon" data-i="${i}"><i></i></label>
    <button class="more" data-act="remdel" data-i="${i}" aria-label="Remove reminder">✕</button></div>`).join('');
  html += `<button class="btn secondary block" data-act="remadd">＋ Add reminder time</button>
    <p class="small muted">iPhones pause web apps in the background, so to get a reminder <b>even when the app is closed</b>, set up ${EMBEDDED ? 'the Shortcuts automation below once. It' : 'one of the two options below once. Both'} run${EMBEDDED ? 's' : ''} entirely on your phone.</p>
    ${EMBEDDED ? '' : `<button class="btn block" data-act="ics">📅 Add reminders to Calendar</button>
    <details class="guide"><summary>How the Calendar option works</summary>
      <ol><li>Tap the button above. A calendar file with a daily repeating event (with an alert) for each reminder time is created.</li>
      <li>Choose <b>Add All</b> to put them into your iPhone Calendar.</li>
      <li>Every day at those times your phone will alert you: “Habit check-in”.</li>
      <li>If the button doesn’t open Calendar, open this app’s website in Safari and tap one of these ready-made files:
        <a href="reminders/6pm-and-8pm.ics">6 PM + 8 PM</a> · <a href="reminders/6pm.ics">6 PM</a> · <a href="reminders/8pm.ics">8 PM</a>.</li></ol></details>`}
    <details class="guide" ${EMBEDDED ? 'open' : ''}><summary>${EMBEDDED ? 'Set up reminders with the Shortcuts app' : 'Or: use the Shortcuts app (most reliable)'}</summary>
      <ol><li>Open the <b>Shortcuts</b> app → <b>Automation</b> tab → <b>＋</b> → <b>Time of Day</b>.</li>
      <li>Set <b>6:00 PM</b>, <b>Daily</b>, and choose <b>Run Immediately</b>. Tap Next.</li>
      <li>Add the action <b>Show Notification</b> with text such as “Time to tick your habits ✅”. Done.</li>
      <li>Repeat for <b>8:00 PM</b> if you want a second nudge.</li></ol></details>
    <div class="list-item" style="margin-top:6px"><span class="grow">In-app alerts while the app is open<br>
      <span class="small muted">${notifState === 'granted' ? 'Allowed' : notifState === 'denied' ? 'Blocked in iOS Settings' : notifState === 'unsupported' ? (EMBEDDED ? 'Shown as a banner on the Today screen' : 'Install to Home Screen first') : 'Not enabled yet'}</span></span>
      ${notifState === 'default' ? '<button class="btn small" data-act="notify">Enable</button>' : notifState === 'granted' ? '<button class="btn small secondary" data-act="testnotify">Test</button>' : ''}</div>
  </div>`;

  if (!EMBEDDED) {
    const afterOpts = [[0, 'Immediately'], [1, 'After 1 minute'], [5, 'After 5 minutes'], [15, 'After 15 minutes']];
    html += `<div class="section-title"><span>App lock</span></div><div class="card">
      <div class="list-item"><span class="grow">Lock with Face ID / Touch ID<br><span class="small muted">${
        !lock ? 'Off' : lock.credId ? 'On · backup PIN set' : 'On · PIN only'}</span></span>
        <label class="switch"><input type="checkbox" data-act="locktoggle" ${lock ? 'checked' : ''} aria-label="App lock"><i></i></label></div>
      ${lock ? `<div class="list-item"><span class="grow">Lock when I leave the app</span>
        <select data-act="lockafter">${afterOpts.map(([v, l]) => `<option value="${v}" ${(lock.after || 0) === v ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
        <div class="list-item"><span class="grow">Lock the app now</span><button class="btn small secondary" data-act="locknow">Lock now</button></div>
        <div class="list-item"><span class="grow">${lock.credId ? 'Face ID not working?' : 'Unlock with Face ID'}<br>
          <span class="small muted">${lock.credId ? 'Use this if you deleted the Habits passkey' : 'Currently PIN only'}</span></span>
          <button class="btn small secondary" data-act="refaceid">${lock.credId ? 'Set up again' : 'Add Face ID'}</button></div>
        <div class="list-item"><span class="grow">Backup PIN</span><button class="btn small secondary" data-act="changepin">Change</button></div>` : ''}
      <p class="small muted">${lock
        ? 'Habits asks for Face ID each time you open it. Face ID works through a passkey saved in your iPhone’s Passwords app (listed under sam202301.github.io), so please keep it. If that isn’t available, use your backup PIN.'
        : 'Ask for Face ID or Touch ID whenever Habits is opened, so nobody else can see your habits.'}</p></div>`;
  }

  html += `<div class="section-title"><span>Preferences</span></div><div class="card">
    <div class="list-item"><span class="grow">Week starts on</span>
      <select data-act="weekstart"><option value="1" ${s.weekStart === 1 ? 'selected' : ''}>Monday</option><option value="0" ${s.weekStart === 0 ? 'selected' : ''}>Sunday</option><option value="6" ${s.weekStart === 6 ? 'selected' : ''}>Saturday</option></select></div>
    <div class="list-item"><span class="grow">Appearance</span>
      <select data-act="theme"><option value="auto" ${s.theme === 'auto' ? 'selected' : ''}>Match phone</option><option value="light" ${s.theme === 'light' ? 'selected' : ''}>Light</option><option value="dark" ${s.theme === 'dark' ? 'selected' : ''}>Dark</option></select></div>
  </div>`;

  const lb = s.lastBackup ? `Last backup: ${fmtShort(new Date(s.lastBackup))}` : 'No backup yet';
  html += `<div class="section-title"><span>Your data</span></div><div class="card">
    <p class="small muted" style="margin-top:0">Your habits are stored only on this phone. ${EMBEDDED
      ? 'Copy a backup now and then and paste it into a note, so you can restore it if this browser’s data is ever cleared.'
      : 'Save a backup now and then (e.g. to the Files app) so you can restore it if you ever delete the app or change phones.'} ${lb}.</p>
    <button class="btn block" data-act="export">💾 ${EMBEDDED ? 'Copy backup' : 'Save backup'}</button>
    ${EMBEDDED
      ? '<button class="btn secondary block" data-act="paste">📋 Restore by pasting a backup</button>'
      : '<button class="btn secondary block" data-act="import">📂 Restore from backup</button><button class="btn secondary block" data-act="paste">📋 Restore by pasting backup text</button>'}
    <button class="btn danger block" data-act="reset">Erase all data</button>
  </div>
  ${EMBEDDED ? '' : `<div class="section-title"><span>App version</span></div><div class="card">
    <div class="list-item"><span class="grow">Version ${APP_VERSION}<br><span class="small muted">${
      upd.ready ? 'A new version is ready to install' : 'Updates are checked each time you open the app'}</span></span>
      ${upd.ready ? '<button class="btn small" data-act="update">Install update</button>'
        : '<button class="btn small secondary" data-act="checkupdate">Check for updates</button>'}</div></div>`}
  <p class="center small muted">Habits · works offline · v${APP_VERSION}</p>`;
  return html;
}

function daysLabel(h) {
  const d = h.days || [];
  if (d.length === 7) return '';
  if (d.length === 5 && ![0, 6].some(x => d.includes(x))) return ' · weekdays';
  if (d.length === 2 && d.includes(0) && d.includes(6)) return ' · weekends';
  return ' · ' + d.slice().sort().map(i => DOW[i]).join(' ');
}

/* --------------------------- habit editor ----------------------------- */

function openEditor(id) {
  const existing = state.habits.find(h => h.id === id);
  const h = existing ? { ...existing, days: [...(existing.days || [0,1,2,3,4,5,6])] }
    : { name: '', emoji: EMOJIS[0], freq: ui.tab === 'week' ? 'weekly' : ui.tab === 'month' ? 'monthly' : 'daily',
        target: 1, area: '', color: COLORS[Math.floor(Math.random() * COLORS.length)], days: [0,1,2,3,4,5,6] };
  const areas = [...new Set(['Health', 'Fitness', 'Mind', 'Growth', 'Work', 'Finance', 'Relationships', 'Home', ...state.habits.map(x => x.area).filter(Boolean)])];
  const m = $('#modal');

  const draw = () => {
    const unit = { weekly: 'week', monthly: 'month' }[h.freq];
    m.innerHTML = `<form class="sheet" method="dialog">
      <h2>${existing ? 'Edit habit' : 'New habit'}</h2>
      <div class="field"><label for="hname">Name</label><input type="text" id="hname" value="${esc(h.name)}" placeholder="e.g. Walk 10,000 steps" maxlength="60" required></div>
      <div class="field"><label>How often?</label><div class="choices" id="freq">${['daily', 'weekly', 'monthly'].map(f =>
        `<button type="button" data-v="${f}" class="${h.freq === f ? 'on' : ''}">${FREQ_LABEL[f]}</button>`).join('')}</div></div>
      ${h.freq === 'daily'
        ? `<div class="field"><label>On which days?</label><div class="choices" id="days">${[1,2,3,4,5,6,0].map(i =>
            `<button type="button" data-v="${i}" class="${h.days.includes(i) ? 'on' : ''}">${DOW[i]}</button>`).join('')}</div></div>`
        : `<div class="field"><label for="htarget">Times per ${unit}</label><input type="number" id="htarget" min="1" max="${h.freq === 'weekly' ? 7 : 31}" value="${targetOf(h)}" inputmode="numeric" style="width:90px"></div>`}
      <div class="field"><label>Life area (used in Progress)</label><div class="choices" id="area">${areas.map(a =>
        `<button type="button" data-v="${esc(a)}" class="${h.area === a ? 'on' : ''}">${esc(a)}</button>`).join('')}
        <input type="text" id="newarea" placeholder="Other…" maxlength="20" style="width:110px"></div></div>
      <div class="field"><label>Icon</label><div class="choices emoji" id="emoji">${EMOJIS.map(e =>
        `<button type="button" data-v="${e}" class="${h.emoji === e ? 'on' : ''}">${e}</button>`).join('')}</div></div>
      <div class="field"><label>Colour</label><div class="choices color" id="color">${COLORS.map(c =>
        `<button type="button" data-v="${c}" class="${h.color === c ? 'on' : ''}" style="background:${c}" aria-label="Colour ${c}"></button>`).join('')}</div></div>
      <div class="sheet-actions"><button type="button" class="btn secondary" data-x="cancel">Cancel</button><button type="submit" class="btn">Save</button></div>
      ${existing ? `<div class="sheet-actions"><button type="button" class="btn secondary" data-x="archive">${h.archived ? 'Unarchive' : 'Archive'}</button><button type="button" class="btn danger" data-x="delete">Delete</button></div>
        <p class="small muted">Archive hides a habit but keeps its history. Delete removes it and its history.</p>` : ''}
    </form>`;
  };
  const sync = () => {
    const n = m.querySelector('#hname'); if (n) h.name = n.value;
    const t = m.querySelector('#htarget'); if (t) h.target = Math.max(1, parseInt(t.value, 10) || 1);
    const a = m.querySelector('#newarea'); if (a && a.value.trim()) h.area = a.value.trim();
  };
  draw();

  m.onclick = e => {
    if (e.target === m) { m.close(); return; }
    const b = e.target.closest('button');
    if (!b) return;
    const group = b.parentElement.id;
    if (group === 'freq') {
      sync();
      if (h.freq !== b.dataset.v) h.target = { daily: 1, weekly: 3, monthly: 1 }[b.dataset.v];
      h.freq = b.dataset.v;
      draw();
    }
    else if (group === 'days') { const v = +b.dataset.v; h.days = h.days.includes(v) ? h.days.filter(x => x !== v) : [...h.days, v]; b.classList.toggle('on'); }
    else if (['area', 'emoji', 'color'].includes(group)) {
      h[group] = group === 'area' && h.area === b.dataset.v ? '' : b.dataset.v;
      b.parentElement.querySelectorAll('button').forEach(x => x.classList.toggle('on', x === b && h[group] === b.dataset.v));
    }
    else if (b.dataset.x === 'cancel') m.close();
    else if (b.dataset.x === 'archive') { existing.archived = !existing.archived; save(); m.close(); render(); toast(existing.archived ? 'Archived' : 'Restored'); }
    else if (b.dataset.x === 'delete') {
      ask(`Delete “${existing.name}” and all its history?`, 'Delete', true).then(ok => {
        if (!ok) return;
        state.habits = state.habits.filter(x => x.id !== existing.id);
        delete state.log[existing.id]; save(); m.close(); render(); toast('Deleted');
      });
    }
  };
  m.onsubmit = e => {
    e.preventDefault();
    sync();
    if (!h.name.trim()) { m.querySelector('#hname').focus(); return; }
    if (h.freq === 'daily' && !h.days.length) { toast('Pick at least one day'); return; }
    const clean = { name: h.name.trim(), emoji: h.emoji, freq: h.freq, target: h.freq === 'daily' ? 1 : h.target, area: h.area, color: h.color, days: h.days };
    if (existing) Object.assign(existing, clean);
    else state.habits.push({ id: uid(), created: todayKey(), archived: false, ...clean });
    save(); m.close(); render(); toast(existing ? 'Saved' : 'Habit added');
  };
  m.showModal();
}

/* ----------------------------- events --------------------------------- */

document.querySelector('.tabbar').addEventListener('click', e => {
  const b = e.target.closest('button[data-tab]');
  if (b) go(b.dataset.tab);
});
$('#addBtn').addEventListener('click', () => openEditor());

$('#view').addEventListener('click', e => {
  const el = e.target.closest('[data-act]');
  if (!el || el.tagName === 'INPUT' || el.tagName === 'SELECT') return;
  // The screen may still show yesterday: switch to today instead of acting on
  // the tap, so a tick meant for today never changes yesterday's record.
  if (rollover()) { render(); toast('It’s a new day — showing today'); return; }
  const a = el.dataset.act;
  const h = el.dataset.id && state.habits.find(x => x.id === el.dataset.id);
  switch (a) {
    case 'toggle': {
      const k = el.dataset.k, on = !isDone(h, k);
      const r = el.getBoundingClientRect();
      setDone(h, k, on); haptic(); render();
      if (on) cheer(h, k, r.left + r.width / 2, r.top + r.height / 2);
      break;
    }
    case 'edit': openEditor(h.id); break;
    case 'add': openEditor(); break;
    case 'day': ui.date = keyOf(addDays(parseKey(ui.date), +el.dataset.n)); render(); break;
    case 'today': ui.date = todayKey(); render(); break;
    case 'week': ui.weekOf = keyOf(addDays(parseKey(ui.weekOf), 7 * el.dataset.n)); render(); break;
    case 'thisweek': ui.weekOf = todayKey(); render(); break;
    case 'month': ui.monthOf = keyOf(addMonths(parseKey(ui.monthOf), +el.dataset.n)); render(); break;
    case 'thismonth': ui.monthOf = todayKey(); render(); break;
    case 'openday': ui.date = el.dataset.k; go('today'); break;
    case 'go': e.preventDefault(); go(el.dataset.tab); break;
    case 'dismissWelcome': delete state.firstRun; save(); render(); break;
    case 'mood': {
      const j = state.journal[ui.date] ||= {};
      j.mood = j.mood === +el.dataset.i ? undefined : +el.dataset.i; save(); render(); break;
    }
    case 'range': ui.range = +el.dataset.v; render(); break;
    case 'remadd': state.settings.reminders.push({ time: '21:00', on: true }); save(); render(); break;
    case 'remdel': state.settings.reminders.splice(+el.dataset.i, 1); save(); render(); break;
    case 'notify': enableNotifications(); break;
    case 'testnotify': notify('Habit check-in', 'This is how your reminder will look.'); break;
    case 'ics': downloadICS(); break;
    case 'export': exportData(); break;
    case 'import': pauseLock(300000); $('#importFile').click(); break;
    case 'paste': openPasteRestore(); break;
    case 'update': installUpdate(); break;
    case 'locknow': showLock(); break;
    case 'dismissReset': lockWasReset = false; render(); break;
    case 'refaceid': setupFaceIdAgain(); break;
    case 'changepin': openPinChange(); break;
    case 'checkupdate': checkForUpdate(true); break;
    case 'reset':
      ask('Erase ALL habits and history from this phone? This cannot be undone.', 'Erase everything', true).then(ok => {
        if (!ok) return;
        state = defaultState(); save(); render(); toast('All data erased');
      });
      break;
  }
});

$('#view').addEventListener('change', e => {
  const el = e.target;
  const s = state.settings;
  switch (el.dataset.act) {
    case 'remtime': if (el.value) { s.reminders[+el.dataset.i].time = el.value; save(); } break;
    case 'remon': s.reminders[+el.dataset.i].on = el.checked; save(); break;
    case 'weekstart': s.weekStart = +el.value; save(); break;
    case 'theme': s.theme = el.value; save(); applyTheme(); break;
    case 'locktoggle':
      el.checked = !!lock; // the switch only moves once setup or unlock succeeds
      if (lock) unlockThen(disableLock);
      else openLockSetup();
      break;
    case 'lockafter': lock.after = +el.value; saveLock(); break;
  }
});

$('#view').addEventListener('input', e => {
  if (e.target.id !== 'note') return;
  const j = state.journal[ui.date] ||= {};
  j.note = e.target.value;
  clearTimeout(e.target._t);
  e.target._t = setTimeout(save, 400);
});

$('#importFile').addEventListener('change', async e => {
  const f = e.target.files[0];
  e.target.value = '';
  pauseLock(3000);
  if (!f) return;
  restoreFrom(await f.text());
});

async function restoreFrom(text) {
  let data;
  try {
    data = JSON.parse(text);
    if (!data || !Array.isArray(data.habits) || typeof data.log !== 'object') throw new Error();
  } catch (err) {
    toast('That isn’t a Habits backup');
    return false;
  }
  if (!await ask(`Restore backup with ${plural(data.habits.length, 'habit')}? This replaces what’s on this phone now.`, 'Restore')) return false;
  const d = defaultState();
  state = { ...d, ...data, settings: { ...d.settings, ...(data.settings || {}) } };
  save(); render(); toast('Backup restored');
  return true;
}

function openPasteRestore() {
  const m = $('#modal');
  m.innerHTML = `<form class="sheet"><h2>Restore from backup</h2>
    <p class="small muted">Paste the backup text you copied earlier.</p>
    <textarea id="pasteBackup" class="note" style="min-height:140px" placeholder='{"version":1, ...}'></textarea>
    <div class="sheet-actions"><button type="button" class="btn secondary" data-x="cancel">Cancel</button><button type="submit" class="btn">Restore</button></div></form>`;
  m.onclick = e => { if (e.target === m || e.target.dataset.x === 'cancel') m.close(); };
  m.onsubmit = async e => {
    e.preventDefault();
    if (await restoreFrom(m.querySelector('#pasteBackup').value)) m.close();
  };
  m.showModal();
}

/* --------------------------- celebration ------------------------------ */

const PRAISE = ['Nice one!', 'Well done!', 'Great job!', 'Keep it up!', 'You did it!', 'Way to go!', 'Another one done!', 'Proud of you!'];
const pick = a => a[Math.floor(Math.random() * a.length)];
const reduceMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

/* Congratulate after a habit is ticked: pop the check, burst confetti, say something nice. */
function cheer(h, k, x, y) {
  const d = parseKey(k);
  const daily = byFreq('daily').filter(x => scheduledOn(x, d));
  const allDone = h.freq === 'daily' && daily.length > 1 && daily.every(x => isDone(x, k));
  let msg = `✅ ${pick(PRAISE)}`;
  let big = false;
  if (h.freq !== 'daily') {
    const p = periodOf(h, d);
    if (countBetween(h, p.start, p.end) === targetOf(h)) {
      msg = `🎯 ${h.freq === 'weekly' ? 'Weekly' : 'Monthly'} goal reached!`;
      big = true;
    }
  } else if (k === todayKey()) {
    const s = streaks(h).current;
    if (s > 1) msg = `🔥 ${s}-day streak! ${pick(PRAISE)}`;
  }
  if (allDone) msg = k === todayKey() ? '🎉 All daily habits done today!' : '🎉 Every daily habit done that day!';

  const btn = document.querySelector(`[data-act="toggle"][data-id="${h.id}"][data-k="${k}"]`);
  if (btn) btn.classList.add('pop');
  toast(msg);
  if (navigator.vibrate) navigator.vibrate(allDone ? [20, 60, 20, 60, 40] : 15);
  if (reduceMotion()) return;
  confetti(x, y, big ? 70 : 32, [h.color, '#ffd166', '#06d6a0', '#ef476f', '#118ab2']);
  if (allDone) setTimeout(() => rainConfetti(), 150);
}

let fx = null, parts = [], fxRunning = false;

function fxCanvas() {
  if (!fx) {
    fx = document.createElement('canvas');
    fx.className = 'fx';
    document.body.appendChild(fx);
  }
  const dpr = window.devicePixelRatio || 1;
  if (fx.width !== innerWidth * dpr || fx.height !== innerHeight * dpr) {
    fx.width = innerWidth * dpr; fx.height = innerHeight * dpr;
  }
  return fx;
}

function confetti(x, y, n, colors) {
  fxCanvas();
  for (let i = 0; i < n; i++) {
    const a = -Math.PI / 2 + (Math.random() - 0.5) * Math.PI * 1.4;
    const v = 4 + Math.random() * 7;
    parts.push({ x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v, g: 0.28, life: 0, max: 60 + Math.random() * 30,
      w: 5 + Math.random() * 5, h: 3 + Math.random() * 4, r: Math.random() * 6, vr: (Math.random() - 0.5) * 0.4,
      c: pick(colors), round: Math.random() < 0.3 });
  }
  runFx();
}

function rainConfetti() {
  fxCanvas();
  const colors = COLORS.concat(['#ffd166', '#06d6a0']);
  for (let i = 0; i < 140; i++) {
    parts.push({ x: Math.random() * innerWidth, y: -20 - Math.random() * innerHeight * 0.5,
      vx: (Math.random() - 0.5) * 2, vy: 2 + Math.random() * 3, g: 0.05, life: 0, max: 200,
      w: 6 + Math.random() * 6, h: 4 + Math.random() * 4, r: Math.random() * 6, vr: (Math.random() - 0.5) * 0.3,
      c: pick(colors), round: Math.random() < 0.3, sway: Math.random() * 6 });
  }
  runFx();
}

function runFx() {
  if (fxRunning) return;
  fxRunning = true;
  const ctx = fx.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  const step = () => {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, innerWidth, innerHeight);
    parts = parts.filter(p => p.life < p.max && p.y < innerHeight + 30);
    for (const p of parts) {
      p.life++; p.vy += p.g; p.vx *= 0.99; p.x += p.vx + (p.sway ? Math.sin(p.life / 12) * 0.6 : 0); p.y += p.vy; p.r += p.vr;
      ctx.globalAlpha = Math.min(1, (p.max - p.life) / 20);
      ctx.fillStyle = p.c;
      ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.r);
      if (p.round) { ctx.beginPath(); ctx.arc(0, 0, p.h / 1.5, 0, Math.PI * 2); ctx.fill(); }
      else ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
      ctx.restore();
    }
    if (parts.length) requestAnimationFrame(step);
    else { ctx.clearRect(0, 0, innerWidth, innerHeight); fxRunning = false; }
  };
  requestAnimationFrame(step);
}

/* ------------------------------ backup -------------------------------- */

async function exportData() {
  state.settings.lastBackup = Date.now();
  save();
  if (EMBEDDED) {
    try {
      await navigator.clipboard.writeText(JSON.stringify(state));
      toast('Backup copied — paste it into Notes to keep it safe');
    } catch (e) {
      toast('Couldn’t copy the backup on this device');
    }
    render();
    return;
  }
  const name = `habits-backup-${todayKey()}.json`;
  const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
  const file = new File([blob], name, { type: 'application/json' });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    pauseLock(300000);
    try { await navigator.share({ files: [file], title: 'Habits backup' }); pauseLock(3000); render(); return; }
    catch (e) { pauseLock(3000); if (e.name === 'AbortError') return; }
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  render();
}

/* ---------------------------- reminders ------------------------------- */

function buildICS() {
  const now = new Date();
  const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\.\d+/, '');
  const d = keyOf(today()).replace(/-/g, '');
  const events = state.settings.reminders.filter(r => r.on).map(r => {
    const [hh, mm] = r.time.split(':');
    return ['BEGIN:VEVENT',
      `UID:habits-${hh}${mm}@habits.local`,
      `DTSTAMP:${stamp}`,
      `DTSTART:${d}T${hh}${mm}00`,
      'DURATION:PT10M',
      'RRULE:FREQ=DAILY',
      'SUMMARY:✅ Habit check-in',
      'DESCRIPTION:Open Habits and tick or untick today’s habits.',
      'BEGIN:VALARM', 'ACTION:DISPLAY', 'DESCRIPTION:Habit check-in', 'TRIGGER:PT0M', 'END:VALARM',
      'END:VEVENT'].join('\r\n');
  });
  return ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Habits//Local//EN', 'CALSCALE:GREGORIAN', ...events, 'END:VCALENDAR'].join('\r\n');
}

function downloadICS() {
  if (!state.settings.reminders.some(r => r.on)) { toast('Turn on at least one reminder time first'); return; }
  const url = 'data:text/calendar;charset=utf-8,' + encodeURIComponent(buildICS());
  const a = document.createElement('a');
  a.href = url;
  a.download = 'habit-reminders.ics';
  document.body.appendChild(a); a.click(); a.remove();
}

async function enableNotifications() {
  if (!('Notification' in window)) { toast('Add the app to your Home Screen first (iOS 16.4+)'); return; }
  const p = await Notification.requestPermission();
  toast(p === 'granted' ? 'Notifications enabled' : 'Notifications not allowed');
  render();
}

async function notify(title, body) {
  if (!('Notification' in window) || Notification.permission !== 'granted') return false;
  try {
    const reg = navigator.serviceWorker && await navigator.serviceWorker.ready;
    if (reg && reg.showNotification) await reg.showNotification(title, { body, icon: 'icons/icon-192.png', badge: 'icons/icon-192.png', tag: 'habit-checkin' });
    else new Notification(title, { body });
    return true;
  } catch (e) { console.warn(e); return false; }
}

/* While the app is open (or just reopened), fire any reminder that's due. */
function checkReminders() {
  const now = new Date();
  const tk = todayKey();
  const mins = now.getHours() * 60 + now.getMinutes();
  let fired = false;
  for (const r of state.settings.reminders) {
    if (!r.on) continue;
    const [hh, mm] = r.time.split(':').map(Number);
    const at = hh * 60 + mm;
    if (mins >= at && mins - at < 120 && state.settings.lastFired[r.time] !== tk) {
      state.settings.lastFired[r.time] = tk;
      fired = true;
    }
  }
  if (!fired) return;
  save();
  const left = pendingToday();
  if (left.length) {
    notify('Habit check-in', lock
      ? `${plural(left.length, 'habit')} left to tick today.` // keep habit names private when the app is locked
      : `${plural(left.length, 'habit')} left today: ${left.slice(0, 3).map(h => h.name).join(', ')}${left.length > 3 ? '…' : ''}`);
    toast('🔔 Time for your habit check-in');
  }
  if (ui.tab === 'today') render();
}

/* ----------------------------- updates -------------------------------- */

const upd = { reg: null, ready: false, info: null, lastCheck: 0 };

function updateBanner() {
  if (!upd.ready) return '';
  const notes = upd.info && upd.info.notes ? `<br><span class="small">${esc(upd.info.notes)}</span>` : '';
  return `<div class="banner update">⬆️<div class="grow"><b>Update available${upd.info ? ' · v' + esc(upd.info.version) : ''}</b>${notes}
    <br><button class="btn small" data-act="update" style="margin-top:8px">Install update</button></div></div>`;
}

function markUpdateReady(info) {
  if (info) upd.info = info;
  if (upd.ready) return;
  upd.ready = true;
  if (ui.tab === 'today' || ui.tab === 'settings') render();
}

async function setupUpdates() {
  if (EMBEDDED || !('serviceWorker' in navigator) || location.protocol === 'file:') return;
  const hadController = !!navigator.serviceWorker.controller;
  try { upd.reg = await navigator.serviceWorker.register('sw.js'); }
  catch (e) { console.warn('SW failed', e); return; }

  // A new version has finished downloading in the background.
  const watch = w => {
    if (!w) return;
    const check = () => { if (w.state === 'installed' && navigator.serviceWorker.controller) markUpdateReady(); };
    check();
    w.addEventListener('statechange', check);
  };
  if (upd.reg.waiting && hadController) markUpdateReady();
  watch(upd.reg.installing);
  upd.reg.addEventListener('updatefound', () => watch(upd.reg.installing));

  // Once the new version takes over, reload into it.
  let reloading = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!hadController || reloading) return;
    reloading = true;
    location.reload();
  });
  checkForUpdate();
}

async function checkForUpdate(manual = false) {
  upd.lastCheck = Date.now();
  try {
    const res = await fetch(`version.json?t=${Date.now()}`, { cache: 'no-store' });
    const info = await res.json();
    if (info.version !== APP_VERSION) {
      markUpdateReady(info);
      if (upd.reg) upd.reg.update().catch(() => {});
    } else if (manual) {
      toast('You’re on the latest version');
    }
  } catch (e) {
    if (manual) toast('Couldn’t check for updates — are you online?');
  }
}

async function installUpdate() {
  toast('Installing update…');
  const reg = upd.reg;
  setTimeout(() => location.reload(), 8000); // safety net
  if (!reg) { location.reload(); return; }
  try { await reg.update(); } catch (e) { /* offline or already up to date */ }
  let w = reg.waiting;
  if (!w && reg.installing) {
    const i = reg.installing;
    w = await new Promise(resolve => i.addEventListener('statechange', () => {
      if (i.state === 'installed') resolve(i);
      else if (i.state === 'redundant') resolve(null);
    }));
  }
  if (w) w.postMessage('skipWaiting'); // controllerchange → reload
  else location.reload();
}

/* ----------------------------- app lock ------------------------------- */
/* Face ID / Touch ID through a passkey kept on this phone, plus a backup PIN.
   Stored apart from the habit data so backups never carry it. */

const LOCK_KEY = 'habits.lock';

/* One-time rescue (v1.5.4), done at the owner's request: they were locked out
   with no working way back in, so the lock is switched off once per install.
   The flag is set on first run, so a lock turned on later is never touched. */
const LOCK_RESET_FLAG = 'habits.lockReset1';
let lockWasReset = false;
try {
  if (!EMBEDDED && !localStorage.getItem(LOCK_RESET_FLAG)) {
    if (localStorage.getItem(LOCK_KEY)) { localStorage.removeItem(LOCK_KEY); lockWasReset = true; }
    localStorage.setItem(LOCK_RESET_FLAG, '1');
  }
} catch (e) { /* storage unavailable: nothing to reset */ }

let lock = (() => { try { return EMBEDDED ? null : JSON.parse(localStorage.getItem(LOCK_KEY)); } catch (e) { return null; } })();
let locked = !!lock;
let afterUnlock = null; // something to do once the person proves it's them (e.g. turn the lock off)
let hiddenAt = 0;
let lockPausedUntil = 0; // system sheets (Face ID setup, share, file picker) briefly hide the app
const pauseLock = ms => { lockPausedUntil = Date.now() + ms; };

function saveLock() {
  try {
    if (lock) localStorage.setItem(LOCK_KEY, JSON.stringify(lock));
    else localStorage.removeItem(LOCK_KEY);
  } catch (e) { toast('Could not save the lock setting'); }
}

const b64u = buf => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64u = str => Uint8Array.from(atob(str.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((str.length + 3) % 4)), c => c.charCodeAt(0));
const randomBytes = n => crypto.getRandomValues(new Uint8Array(n));

async function hashPin(pin, salt) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(pin), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt: unb64u(salt), iterations: 150000, hash: 'SHA-256' }, key, 256);
  return b64u(bits);
}

async function biometricAvailable() {
  try {
    return !!(window.PublicKeyCredential && await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable());
  } catch (e) { return false; }
}

/* The same user id each time, so setting Face ID up again replaces the
   passkey in the Passwords app instead of adding another one. */
function createPasskey(userId) {
  return navigator.credentials.create({ publicKey: {
    rp: { name: 'Habits', id: location.hostname },
    user: { id: unb64u(userId), name: 'Habits app lock', displayName: 'Habits app lock' },
    challenge: randomBytes(32),
    pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }],
    authenticatorSelection: { authenticatorAttachment: 'platform', userVerification: 'required', residentKey: 'preferred' },
    attestation: 'none',
    timeout: 60000,
  } });
}

/* Byte 32 of a passkey's authenticator data holds its flags; 0x04 means the
   iPhone checked Face ID, Touch ID or the phone's passcode. */
function userVerified(response) {
  let data = null;
  if (response.authenticatorData) data = response.authenticatorData;
  else if (response.getAuthenticatorData) data = response.getAuthenticatorData();
  else {
    // Older iOS: dig authData out of the CBOR attestation object.
    const a = new Uint8Array(response.attestationObject);
    const key = [0x68, ...new TextEncoder().encode('authData')];
    for (let i = 0; i + key.length < a.length && !data; i++) {
      if (!key.every((byte, j) => a[i + j] === byte)) continue;
      let k = i + key.length, len;
      if (a[k] === 0x58) { len = a[k + 1]; k += 2; }
      else if (a[k] === 0x59) { len = (a[k + 1] << 8) | a[k + 2]; k += 3; }
      else break;
      data = a.slice(k, k + len);
    }
  }
  return !!data && (new Uint8Array(data)[32] & 0x04) !== 0;
}

async function openLockSetup() {
  const bio = await biometricAvailable();
  const m = $('#modal');
  const pinInput = (id, label) => `<div class="field"><label for="${id}">${label}</label>
    <input type="password" id="${id}" inputmode="numeric" pattern="[0-9]*" maxlength="8" autocomplete="new-password" class="pin-input"></div>`;
  m.innerHTML = `<form class="sheet"><h2>Turn on app lock</h2>
    <p class="small muted">${bio
      ? 'You’ll unlock Habits with Face ID or Touch ID. Choose a backup PIN too, for when Face ID can’t be used. Your iPhone will then ask to save a passkey — that’s what lets Face ID unlock the app.'
      : 'Face ID / Touch ID isn’t available to this app on this device, so Habits will lock with a PIN instead.'}</p>
    ${pinInput('pin1', 'Backup PIN (4–8 digits)')}${pinInput('pin2', 'Type the PIN again')}
    <p class="small muted">If you forget the PIN and Face ID stops working, you can’t get back in, so keep a backup of your data (Settings → Your data).</p>
    <p class="small" id="lockSetupMsg" style="color:var(--bad)"></p>
    <div class="sheet-actions"><button type="button" class="btn secondary" data-x="cancel">Cancel</button><button type="submit" class="btn">Turn on</button></div></form>`;
  const msg = t => { m.querySelector('#lockSetupMsg').textContent = t; };
  m.onclick = e => { if (e.target === m || e.target.dataset.x === 'cancel') m.close(); };
  m.onsubmit = async e => {
    e.preventDefault();
    const p1 = m.querySelector('#pin1').value, p2 = m.querySelector('#pin2').value;
    if (!/^\d{4,8}$/.test(p1)) { msg('The PIN must be 4 to 8 digits.'); return; }
    if (p1 !== p2) { msg('The two PINs don’t match.'); return; }
    let credId = null;
    const userId = b64u(randomBytes(16));
    if (bio) {
      // Called straight from the tap, as iOS requires for Face ID.
      pauseLock(120000);
      try { credId = b64u((await createPasskey(userId)).rawId); }
      catch (err) { msg(err.name === 'NotAllowedError' ? 'Face ID setup was cancelled. Tap Turn on to try again.' : 'Face ID couldn’t be set up: ' + err.message); return; }
      finally { pauseLock(3000); }
    }
    const salt = b64u(randomBytes(16));
    lock = { credId, userId, salt, pinHash: await hashPin(p1, salt), after: 0, fails: 0, until: 0 };
    saveLock();
    m.close(); render(); toast('App lock is on');
  };
  m.showModal();
}

/* Replace a deleted or broken passkey. Runs straight from the tap, as iOS requires. */
async function setupFaceIdAgain() {
  pauseLock(120000);
  try {
    lock.userId ||= b64u(randomBytes(16));
    lock.credId = b64u((await createPasskey(lock.userId)).rawId);
    saveLock();
    render();
    toast('Face ID is set up again');
  } catch (err) {
    toast(err.name === 'NotAllowedError' ? 'Face ID setup was cancelled' : 'Face ID couldn’t be set up on this device');
  } finally {
    pauseLock(3000);
  }
}

/* Locked out (passkey deleted, PIN forgotten): the iPhone itself confirms it's
   you with Face ID or its passcode while making a new passkey. Anyone who can
   do that already has full use of the phone, so this keeps the lock as strong. */
async function recoverWithIphone() {
  if (!window.PublicKeyCredential) { lockMsg('This iPhone can’t confirm it’s you here. Use your PIN.'); return; }
  pauseLock(120000);
  try {
    lock.userId ||= b64u(randomBytes(16));
    const cred = await createPasskey(lock.userId);
    if (!userVerified(cred.response)) throw new Error('not verified');
    lock.credId = b64u(cred.rawId);
    lock.fails = 0; lock.until = 0;
    saveLock();
    unlockDone();
    toast('Unlocked — Face ID is set up again');
  } catch (err) {
    // Show what the iPhone actually said, so a failure can be diagnosed.
    const detail = `${err.name}${err.message ? ': ' + err.message : ''}`;
    lockMsg(err.name === 'NotAllowedError'
      ? `Your iPhone didn’t finish saving the passkey (${detail}). If you didn’t cancel, check iCloud Keychain is on: Settings → your name → iCloud → Passwords.`
      : `Your iPhone couldn’t confirm it’s you (${detail}).`);
  } finally {
    pauseLock(3000);
  }
}

function openPinChange() {
  const m = $('#modal');
  const pinInput = (id, label) => `<div class="field"><label for="${id}">${label}</label>
    <input type="password" id="${id}" inputmode="numeric" pattern="[0-9]*" maxlength="8" autocomplete="new-password" class="pin-input"></div>`;
  m.innerHTML = `<form class="sheet"><h2>Change backup PIN</h2>
    ${pinInput('pin1', 'New PIN (4–8 digits)')}${pinInput('pin2', 'Type the new PIN again')}
    <p class="small" id="lockSetupMsg" style="color:var(--bad)"></p>
    <div class="sheet-actions"><button type="button" class="btn secondary" data-x="cancel">Cancel</button><button type="submit" class="btn">Save PIN</button></div></form>`;
  const msg = t => { m.querySelector('#lockSetupMsg').textContent = t; };
  m.onclick = e => { if (e.target === m || e.target.dataset.x === 'cancel') m.close(); };
  m.onsubmit = async e => {
    e.preventDefault();
    const p1 = m.querySelector('#pin1').value, p2 = m.querySelector('#pin2').value;
    if (!/^\d{4,8}$/.test(p1)) { msg('The PIN must be 4 to 8 digits.'); return; }
    if (p1 !== p2) { msg('The two PINs don’t match.'); return; }
    lock.salt = b64u(randomBytes(16));
    lock.pinHash = await hashPin(p1, lock.salt);
    saveLock();
    m.close(); toast('Backup PIN changed');
  };
  m.showModal();
}

function disableLock() {
  lock = null; saveLock();
  toast('App lock is off');
}

/* Ask for Face ID / PIN, then run `fn` (used to turn the lock off). */
function unlockThen(fn) {
  afterUnlock = fn;
  showLock(true);
}

function showLock(tryBiometric = false) {
  if (!lock) return;
  locked = true;
  for (const d of document.querySelectorAll('dialog[open]')) d.close();
  $('#view').innerHTML = ''; // nothing private stays on screen
  const el = $('#lock');
  el.hidden = false;
  el.innerHTML = `<div class="lock-inner">
    <img src="icons/icon-192.png" class="lock-icon" alt="">
    <h2>${afterUnlock ? 'Confirm it’s you' : 'Habits is locked'}</h2>
    ${lock.credId ? `<button class="btn block bio-btn" data-lock="bio">${FACE_ID_ICON}Unlock with Face ID</button>
      <p class="small muted" id="tapHint">or tap anywhere</p>` : ''}
    <form id="pinForm" ${lock.credId ? 'hidden' : ''}><input type="password" id="lockPin" inputmode="numeric" pattern="[0-9]*" maxlength="8"
      autocomplete="off" placeholder="Enter your PIN" aria-label="PIN" class="pin-input">
      <button class="btn ${lock.credId ? 'secondary' : ''} block" type="submit">Unlock with PIN</button></form>
    <p class="small" id="lockMsg" role="alert"></p>
    ${lock.credId ? '<button class="linkbtn" data-lock="usepin">Use PIN instead</button>' : ''}
    ${afterUnlock ? '' : '<button class="linkbtn small" data-lock="recover">Can’t unlock? Use your iPhone</button>'}
    ${afterUnlock ? '<button class="btn secondary block" data-lock="cancel">Cancel</button>' : ''}
  </div>`;
  if (tryBiometric && lock.credId) unlockBiometric(true);
}

const FACE_ID_ICON = `<svg class="faceid" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round">
  <path d="M3 8V5.5A2.5 2.5 0 0 1 5.5 3H8M16 3h2.5A2.5 2.5 0 0 1 21 5.5V8M21 16v2.5a2.5 2.5 0 0 1-2.5 2.5H16M8 21H5.5A2.5 2.5 0 0 1 3 18.5V16"/>
  <path d="M8.5 9v1.5M15.5 9v1.5M12 9v4.5h-1M9 16.2c1.8 1.4 4.2 1.4 6 0"/></svg>`;

/* Reveal the backup PIN box (Face ID stays the main way in). */
function showPinEntry(focus) {
  const f = $('#pinForm');
  if (!f || !f.hidden) return;
  f.hidden = false;
  const link = document.querySelector('[data-lock="usepin"]'), hint = $('#tapHint');
  if (link) link.hidden = true;
  if (hint) hint.hidden = true;
  if (focus) $('#lockPin').focus();
}

function lockMsg(text, shake) {
  const m = $('#lockMsg');
  if (!m) return;
  m.textContent = text;
  if (shake) { const f = $('#pinForm'); f.classList.remove('shake'); void f.offsetWidth; f.classList.add('shake'); }
}

function unlockDone() {
  locked = false;
  $('#lock').hidden = true;
  $('#lock').innerHTML = '';
  const fn = afterUnlock;
  afterUnlock = null;
  if (fn) fn();
  render();
  checkReminders();
}

let bioBusy = false;
async function unlockBiometric(quiet = false) {
  if (bioBusy) return;
  bioBusy = true;
  try {
    const cred = await navigator.credentials.get({ publicKey: {
      challenge: randomBytes(32),
      rpId: location.hostname,
      allowCredentials: [{ type: 'public-key', id: unb64u(lock.credId) }],
      userVerification: 'required',
      timeout: 60000,
    } });
    // Byte 32 of the authenticator data holds the flags; 0x04 = Face ID / Touch ID / passcode was checked.
    if (!(new Uint8Array(cred.response.authenticatorData)[32] & 0x04)) throw new Error('not verified');
    lock.fails = 0; lock.until = 0; saveLock();
    unlockDone();
  } catch (e) {
    // NotAllowedError = cancelled, or iOS wants a tap first; the button is right there.
    if (!quiet && e.name !== 'NotAllowedError') { lockMsg('Face ID didn’t work. Try again or use your PIN.'); showPinEntry(false); }
  } finally {
    bioBusy = false;
  }
}

async function unlockPin(pin) {
  const now = Date.now();
  if (lock.until && now < lock.until) { lockMsg(`Too many wrong PINs. Try again in ${Math.ceil((lock.until - now) / 1000)} seconds.`, true); return; }
  if (await hashPin(pin, lock.salt) === lock.pinHash) {
    lock.fails = 0; lock.until = 0; saveLock();
    unlockDone();
    return;
  }
  lock.fails = (lock.fails || 0) + 1;
  if (lock.fails >= 5) lock.until = now + Math.min(15 * 60000, 30000 * 2 ** (lock.fails - 5));
  saveLock();
  $('#lockPin').value = '';
  lockMsg(lock.fails >= 5 ? 'Wrong PIN. Too many tries — wait a moment before trying again.' : 'Wrong PIN.', true);
}

$('#lock').addEventListener('click', e => {
  const b = e.target.closest('[data-lock]');
  if (!b) {
    // Tapping anywhere else starts Face ID, unless the PIN box is in use.
    const pinOpen = $('#pinForm') && !$('#pinForm').hidden;
    if (lock && lock.credId && !pinOpen && !e.target.closest('form')) unlockBiometric();
    return;
  }
  if (b.dataset.lock === 'bio') unlockBiometric();
  else if (b.dataset.lock === 'usepin') showPinEntry(true);
  else if (b.dataset.lock === 'recover') recoverWithIphone();
  else if (b.dataset.lock === 'cancel') { afterUnlock = null; unlockDone(); }
});
$('#lock').addEventListener('submit', e => {
  e.preventDefault();
  const pin = $('#lockPin').value;
  if (pin) unlockPin(pin);
});

function onVisibility() {
  if (document.hidden) {
    hiddenAt = Date.now();
    if (lock && !locked) document.body.classList.add('privacy'); // keep habits out of the app switcher
    return;
  }
  document.body.classList.remove('privacy');
  const away = Date.now() - hiddenAt;
  // "Immediately" still allows a few seconds, so a Face ID or share sheet doesn't lock you out mid-task.
  if (lock && !locked && Date.now() > lockPausedUntil && away >= Math.max(3000, (lock.after || 0) * 60000)) showLock(true);
  if (!locked) onWake();
}

/* ------------------------------- boot --------------------------------- */

function applyTheme() {
  const t = state.settings.theme;
  if (t === 'auto') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', t);
}

function onWake() {
  if (rollover()) render();
  checkReminders();
  if (Date.now() - upd.lastCheck > 10 * 60000) checkForUpdate();
}

applyTheme();
if (state.firstRun) save();
if (locked) showLock(true);
else { render(); checkReminders(); }
setInterval(() => { if (!locked) onWake(); }, 30000);
document.addEventListener('visibilitychange', onVisibility);
// iPhone doesn't always send visibilitychange to Home Screen apps, so also
// check when the app regains focus or is shown again.
for (const ev of ['focus', 'pageshow']) window.addEventListener(ev, () => { if (!locked && !document.hidden) onWake(); });

setupUpdates();
if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
