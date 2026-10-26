// Pick Me Up: when to leave for school, planned for a bad-traffic day, with the
// San Francisco events that could slow the drive.
//
// Settings (the two places, school times, extra minutes) live only in this
// browser's localStorage. The route is matched to events here, on the phone, so
// the server that lists events never learns where anyone lives.
import { decodePolyline } from './lib/geo.js';
import { sfDate, sfWeekday, sfTime, addDays, clock, dayLabel } from './lib/time.js';
import { assess, verdict } from './lib/impact.js';

const KEY = 'pickmeup.v1';
const PLAN_KEY = 'pickmeup.plan.v1';
const app = document.getElementById('app');
const $ = (sel, root = document) => root.querySelector(sel);
const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; };
const MIN = 60e3;

// ---- storage (private windows can refuse it, so every access is guarded) ----
const store = {
  get(k) { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch { return false; } },
};
let settings = store.get(KEY);

// ---- the trips ahead ----
/** The next n school trips from now: [{ day, trip, arriveBy: Date }]. */
function upcoming(s, n, now = new Date()) {
  const out = [];
  const today = sfDate(now);
  for (let d = 0; d < 21; d++) {
    const day = addDays(today, d);
    const wd = sfWeekday(new Date(day + 'T12:00:00-08:00'));
    if (!s.days.includes(wd)) continue;
    for (const trip of s.trips.filter((t) => t.on).sort((a, b) => a.time.localeCompare(b.time))) {
      const arriveBy = sfTime(day, trip.time);
      if (arriveBy > now) out.push({ day, trip, arriveBy, skipped: s.skip.includes(day) });
    }
  }
  // One-off trips (a weekend school event, an early pick-up) on their own day.
  for (const x of s.extras ?? []) {
    const arriveBy = sfTime(x.day, x.time);
    if (arriveBy > now && x.day <= addDays(today, 21)) out.push({ day: x.day, trip: { id: x.id, label: x.label, time: x.time, extra: true }, arriveBy, skipped: false });
  }
  return out.sort((a, b) => a.arriveBy - b.arriveBy).slice(0, n);
}

// ---- server calls ----
async function api(path, body) {
  const res = await fetch(path, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {});
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Something went wrong (${res.status}).`);
  return data;
}

const eventCache = new Map();
function eventsFor(day) {
  const hit = eventCache.get(day);
  if (hit && Date.now() - hit.at < 10 * MIN) return hit.p;
  const p = api(`/api/events?date=${day}`).catch((e) => { eventCache.delete(day); throw e; });
  eventCache.set(day, { at: Date.now(), p });
  return p;
}

/** The leave-by plan for one trip, reused for 5 minutes so reopening the app doesn't cost a lookup. */
async function planFor(t, force) {
  const id = [t.day, t.trip.time, settings.from.at, settings.to.at, settings.buffer].join('|');
  const saved = store.get(PLAN_KEY);
  if (!force && saved?.id === id && Date.now() - saved.at < 5 * MIN) {
    settings.lastRoute ??= saved.plan.polyline; settings.lastBadDayMin ??= saved.plan.badDayMin;
    return saved.plan;
  }
  const plan = await api('/api/plan', { from: settings.from.at, to: settings.to.at, arriveBy: t.arriveBy.toISOString(), bufferMin: settings.buffer });
  store.set(PLAN_KEY, { id, at: Date.now(), plan });
  // Remember the route and a typical bad-day time for the days ahead.
  settings.lastRoute = plan.polyline; settings.lastBadDayMin = plan.badDayMin;
  store.set(KEY, settings);
  return plan;
}

// ---- setup ----
function renderSetup(existing) {
  document.getElementById('open-settings').hidden = true;
  app.replaceChildren(document.getElementById('tpl-setup').content.cloneNode(true));
  const form = $('#setup-form');
  const chosen = { from: existing?.from ?? null, to: existing?.to ?? null };
  const msg = $('#setup-msg');

  for (const fs of form.querySelectorAll('.place')) {
    const which = fs.dataset.place;
    const q = fs.querySelector('[name=q]'), name = fs.querySelector('[name=name]'), list = fs.querySelector('.matches');
    if (existing) { q.value = existing[which].label; name.value = existing[which].name; showMatches([existing[which]], 0); }
    async function find() {
      msg.textContent = '';
      list.replaceChildren(el('p', 'ev-m', 'Looking…'));
      try {
        const { results } = await api('/api/geocode', { q: q.value });
        if (!results.length) { list.replaceChildren(el('p', 'ev-m', 'No Bay Area match. Try adding the street number or "San Francisco".')); chosen[which] = null; return; }
        showMatches(results, results.length === 1 ? 0 : -1);
      } catch (e) { list.replaceChildren(el('p', 'msg', e.message)); }
    }
    function showMatches(results, pick) {
      list.replaceChildren(...results.map((r, i) => {
        const lab = el('label');
        const radio = Object.assign(document.createElement('input'), { type: 'radio', name: `${which}-pick`, checked: i === pick });
        radio.addEventListener('change', () => { chosen[which] = { label: r.label, at: r.at }; });
        lab.append(radio, el('span', null, r.label));
        return lab;
      }));
      chosen[which] = pick >= 0 ? { label: results[pick].label, at: results[pick].at } : null;
    }
    fs.querySelector('.find').addEventListener('click', find);
    q.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); find(); } });
    q.addEventListener('input', () => { chosen[which] = null; list.replaceChildren(); });
  }

  // one-off trips
  let extras = [...(existing?.extras ?? [])].filter((x) => x.day >= sfDate());
  const xList = $('#extras');
  const drawExtras = () => xList.replaceChildren(...extras.sort((a, b) => (a.day + a.time).localeCompare(b.day + b.time)).map((x) => {
    const li = el('li', null);
    li.append(el('span', null, `${dayLabel(x.day)} · ${clock(sfTime(x.day, x.time))} · ${x.label}`));
    const rm = el('button', 'skipbtn', 'Remove'); rm.type = 'button';
    rm.addEventListener('click', () => { extras = extras.filter((y) => y !== x); drawExtras(); });
    li.append(rm);
    return li;
  }));
  form.elements['x-date'].min = sfDate();
  $('#x-add').addEventListener('click', () => {
    const day = form.elements['x-date'].value, time = form.elements['x-time'].value, label = form.elements['x-label'].value.trim() || 'School event';
    if (!day || !time || day < sfDate()) { msg.textContent = 'Pick a date from today on and a time for the one-off trip.'; return; }
    msg.textContent = '';
    extras.push({ id: `x${Date.now()}`, day, time, label: label.slice(0, 40) });
    form.elements['x-label'].value = '';
    drawExtras();
  });
  drawExtras();

  if (existing) {
    for (const t of existing.trips) { form.elements[`${t.id}-on`].checked = t.on; form.elements[t.id].value = t.time; }
    for (const box of form.querySelectorAll('[name=day]')) box.checked = existing.days.includes(+box.value);
    for (const r of form.querySelectorAll('[name=buffer]')) r.checked = +r.value === existing.buffer;
    const cancel = $('#setup-cancel'); cancel.hidden = false; cancel.addEventListener('click', () => renderTrip());
  }

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    if (!chosen.from || !chosen.to) { msg.textContent = 'Tap Find for both places, then pick the right address.'; return; }
    const trips = [
      { id: 'drop', label: 'Drop-off', time: form.elements.drop.value || '08:00', on: form.elements['drop-on'].checked },
      { id: 'pick', label: 'Pick-up', time: form.elements.pick.value || '15:00', on: form.elements['pick-on'].checked },
    ];
    const days = [...form.querySelectorAll('[name=day]:checked')].map((b) => +b.value);
    if ((!trips.some((t) => t.on) || !days.length) && !extras.length) { msg.textContent = 'Choose at least one trip and one school day, or add a one-off trip.'; return; }
    const moved = !existing || existing.from.at.join() !== chosen.from.at.join() || existing.to.at.join() !== chosen.to.at.join();
    settings = {
      from: { ...chosen.from, name: form.querySelector('[data-place=from] [name=name]').value.trim() || 'Home' },
      to: { ...chosen.to, name: form.querySelector('[data-place=to] [name=name]').value.trim() || 'School' },
      trips, days, extras, buffer: +form.querySelector('[name=buffer]:checked').value,
      skip: (existing?.skip ?? []).filter((d) => d >= sfDate()),
      lastRoute: moved ? null : existing?.lastRoute, lastBadDayMin: moved ? null : existing?.lastBadDayMin,
    };
    if (!store.set(KEY, settings)) msg.textContent = "This browser won't save settings (private mode?), so you'll need to enter them again next time.";
    try { localStorage.removeItem(PLAN_KEY); } catch {}
    renderTrip();
  });
}

// ---- trip view ----
let map, layers, timers = [];
const ICON = { game: '🏟️', concert: '🎵', event: '🎪', roadwork: '🚧', incident: '⚠️' };
const miles = (m) => (m < 160 ? 'A block from your route' : `About ${(m / 1609.34).toFixed(1)} mi from your route`);

function span(w) {
  const a = new Date(w.from), b = new Date(w.to);
  if (b - a >= 23.5 * 3600e3) return 'all day';
  return `${clock(a)}–${clock(b)}`;
}

function eventItem(e) {
  const li = el('li', e.level);
  li.append(el('div', 'ico', ICON[e.kind] || '📍'));
  const body = el('div');
  const t = el('div', 'ev-t');
  t.append(el('span', 'tag', e.level === 'on' ? 'On your route' : e.level === 'near' ? 'Nearby' : 'In SF'), document.createTextNode(e.title));
  const where = e.venue && !(e.where ?? '').startsWith(e.venue) ? [e.venue, e.where].filter(Boolean).join(' · ') : e.where;
  const meta = el('div', 'ev-m', `${e.window.label} ${span(e.window)}${where ? ' · ' + where : ''}`);
  body.append(t, meta);
  if (e.level === 'near' && e.distance != null) body.append(el('div', 'ev-m', miles(e.distance)));
  if (e.note) body.append(el('div', 'ev-m', e.note));
  li.append(body);
  return li;
}

function drawMap(route, assessed) {
  if (!window.L) return;
  if (!map) {
    map = L.map('map', { zoomControl: false, attributionControl: true, scrollWheelZoom: false });
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
    }).addTo(map);
    layers = L.layerGroup().addTo(map);
    new ResizeObserver(() => map.invalidateSize()).observe(document.getElementById('map'));
  }
  layers.clearLayers();
  const color = { on: '#c2410c', near: '#c98a12' };
  for (const e of assessed.filter((x) => x.level !== 'city')) {
    const style = { color: color[e.level], weight: 6, opacity: 0.85 };
    if (e.geom.type === 'Point') L.circleMarker([e.geom.coordinates[1], e.geom.coordinates[0]], { radius: 9, color: '#fff', weight: 2, fillColor: color[e.level], fillOpacity: 1 }).bindTooltip(e.title).addTo(layers);
    else if (e.geom.type === 'LineString') L.polyline(e.geom.coordinates.map(([x, y]) => [y, x]), style).bindTooltip(e.title).addTo(layers);
    else if (e.geom.type === 'MultiLineString') L.polyline(e.geom.coordinates.map((l) => l.map(([x, y]) => [y, x])), style).bindTooltip(e.title).addTo(layers);
  }
  if (route?.length) L.polyline(route, { color: '#3a2616', weight: 5, opacity: 0.85 }).addTo(layers);
  L.circleMarker(settings.from.at, { radius: 8, color: '#fffaf0', weight: 3, fillColor: '#3a2616', fillOpacity: 1 }).bindTooltip(settings.from.name).addTo(layers);
  L.circleMarker(settings.to.at, { radius: 9, color: '#3a2616', weight: 3, fillColor: '#e5a630', fillOpacity: 1 }).bindTooltip(settings.to.name).addTo(layers);
  map.fitBounds(L.latLngBounds(route?.length ? route : [settings.from.at, settings.to.at]), { padding: [24, 24] });
}

/** A few words for the status line: 'Game at Chase Center', 'Street closed on Oak St'. */
function short(e) {
  if (e.venue) return `${{ game: 'Game', concert: 'Concert' }[e.kind] || 'Event'} at ${e.venue}`;
  if (e.kind === 'incident') return 'An incident';
  if (e.kind === 'roadwork') return 'A lane closure';
  return e.title.length > 34 ? e.title.slice(0, 32) + '…' : e.title;
}

function countdown(ms) {
  const m = Math.round(ms / MIN);
  if (m < 1) return 'now';
  if (m < 60) return `in ${m} min`;
  const h = Math.floor(m / 60), r = m % 60;
  return h >= 12 ? '' : `in ${h} hr${r ? ` ${r} min` : ''}`;
}

function whenLabel(t) {
  const today = sfDate();
  const d = t.day === today ? 'Today' : t.day === addDays(today, 1) ? 'Tomorrow' : dayLabel(t.day);
  return `${t.trip.label} · ${d}`;
}

async function renderTrip() {
  timers.forEach(clearInterval); timers = [];
  map = null;
  document.getElementById('open-settings').hidden = false;
  app.replaceChildren(document.getElementById('tpl-trip').content.cloneNode(true));
  const next = upcoming(settings, 8).filter((t) => !t.skipped);
  if (!next.length) { $('#hero .door').replaceChildren(el('p', 'empty', 'No school trips in the next three weeks. Check the school days in Settings.')); return; }
  const t = next[0];
  $('#t-when').textContent = whenLabel(t);
  $('#t-dest').textContent = `to be at ${settings.to.name} by ${clock(t.arriveBy)}`;
  const v = $('#t-verdict'); v.className = 'verdict loading'; v.textContent = 'Checking traffic and events…';

  let plan = null, planErr = null, evs = null, evErr = null;
  const draw = () => {
    const route = plan?.polyline ? decodePolyline(plan.polyline) : settings.lastRoute ? decodePolyline(settings.lastRoute) : null;
    const leaveBy = plan ? new Date(plan.leaveBy) : new Date(t.arriveBy - (settings.buffer + (settings.lastBadDayMin ?? 20)) * MIN);
    const assessed = evs ? assess(evs.events, { leaveBy, arriveBy: t.arriveBy }, route) : [];
    const level = verdict(assessed);
    const hero = $('#hero'), now = Date.now();
    hero.classList.remove('now', 'late');
    if (plan) {
      const safeLeave = level === 'watch' ? new Date(leaveBy - 10 * MIN) : leaveBy;
      if (now < leaveBy) {
        $('#t-label').textContent = 'Leave by';
        $('#t-leave').textContent = clock(safeLeave > now ? safeLeave : leaveBy);
        $('#t-count').textContent = countdown((safeLeave > now ? safeLeave : leaveBy) - now);
      } else {
        const eta = new Date(plan.etaIfLeavingNowBadDay ?? now + plan.badDayMin * MIN);
        const etaUsual = new Date(plan.etaIfLeavingNow ?? now + plan.usualMin * MIN);
        hero.classList.add(etaUsual > t.arriveBy ? 'late' : 'now');
        $('#t-label').textContent = 'Leave';
        $('#t-leave').textContent = 'Now';
        $('#t-count').textContent = etaUsual > t.arriveBy
          ? `You'd get there about ${clock(etaUsual)}, ${Math.round((etaUsual - t.arriveBy) / MIN)} min after ${clock(t.arriveBy)}`
          : `You'd get there about ${clock(etaUsual)} (by ${clock(eta)} on a bad day)`;
      }
      const math = $('#t-math');
      math.replaceChildren();
      math.append(document.createTextNode('Bad-day drive '), el('b', null, `${plan.badDayMin} min`), document.createTextNode(` · usually ${plan.usualMin} · plus your ${plan.bufferMin} min`));
      if (level === 'watch' && now < safeLeave) math.append(el('div', null, `Includes 10 extra min for what's on your route (${clock(leaveBy)} otherwise).`));
      $('#t-via').textContent = `${plan.miles} mi${plan.via ? ` via ${plan.via}` : ''} · ${settings.from.name} → ${settings.to.name}`;
    } else if (planErr) {
      $('#t-leave').textContent = '—';
      $('#t-count').textContent = '';
      $('#t-math').textContent = planErr;
    }
    if (evs || evErr) {
      const onWay = assessed.filter((e) => e.level !== 'city'), city = assessed.filter((e) => e.level === 'city');
      v.className = `verdict ${level}`;
      v.textContent = evErr && !evs ? "Couldn't check events right now"
        : level === 'clear' ? (route ? 'Nothing unusual on your route' : 'No big events in SF around then')
        : level === 'heads-up' ? `${onWay.length} thing${onWay.length > 1 ? 's' : ''} near your route`
        : `${short(assessed.find((e) => e.level === 'on'))} on your route`;
      const list = $('#t-events');
      list.replaceChildren(...onWay.map(eventItem));
      if (!onWay.length) { const p = el('p', 'empty'); p.append(el('b', null, 'All clear. '), document.createTextNode(route ? 'No games, concerts, closures or incidents along your way at that time.' : 'Add the route to check your streets.')); list.append(p); }
      $('#elsewhere').hidden = !city.length;
      $('#t-city').replaceChildren(...city.map(eventItem));
      const off = Object.entries(evs?.sources ?? {}).filter(([, s]) => s !== 'ok').map(([k]) => k);
      $('#t-updated').textContent = `Updated ${clock(new Date())}${off.length ? ` · couldn't reach: ${off.join(', ')}` : ''}`;
    }
    drawMap(route, assessed);
  };

  const loadPlan = (force) => planFor(t, force).then((p) => { plan = p; planErr = null; }).catch((e) => { planErr = e.message; }).finally(draw);
  const loadEvents = () => eventsFor(t.day).then((d) => { evs = d; evErr = null; }).catch((e) => { evErr = e.message; }).finally(draw);
  await Promise.all([loadPlan(false), loadEvents()]);
  renderWeek(t);

  // Keep the countdown live; refresh the drive time every 5 minutes when the trip is
  // within three hours, and events every 10.
  timers.push(setInterval(draw, 20e3));
  timers.push(setInterval(() => { if (t.arriveBy - Date.now() < 3 * 3600e3) loadPlan(true); }, 5 * MIN));
  timers.push(setInterval(() => { eventCache.delete(t.day); loadEvents(); }, 10 * MIN));
  timers.push(setInterval(() => { if (Date.now() > t.arriveBy.getTime() + 15 * MIN) renderTrip(); }, MIN));
}

function renderWeek(hero) {
  const ul = $('#t-week');
  const all = upcoming(settings, 8).filter((x) => !(x.day === hero.day && x.trip.id === hero.trip.id)).slice(0, 6);
  if (!all.length) { ul.replaceChildren(el('p', 'empty', 'Nothing else scheduled.')); return; }
  const route = settings.lastRoute ? decodePolyline(settings.lastRoute) : null;
  // One day at a time: Ticketmaster allows only a few requests a second.
  let queue = Promise.resolve();
  const rows = all.map((t) => {
    const li = el('li', t.skipped ? 'skipped' : '');
    const d = el('div', 'd', t.day === addDays(sfDate(), 1) ? 'Tomorrow' : dayLabel(t.day).replace(/,.*/, ''));
    d.append(el('small', null, dayLabel(t.day).replace(/^\w+, /, '')));
    const dot = el('span', `dot ${t.skipped ? 'skip' : ''}`);
    const w = el('div', 'w');
    const leave = new Date(t.arriveBy - (settings.buffer + (settings.lastBadDayMin ?? 20)) * MIN);
    const head = el('div');
    head.append(el('b', null, `${t.trip.label} ${clock(t.arriveBy)}`), el('div', 'ev-m', t.skipped ? 'No school' : `Leave about ${clock(leave)}`));
    const sub = el('div', 'ev-m', t.skipped ? '' : 'Checking events…');
    w.append(head, sub);
    const btn = el('button', 'skipbtn', t.trip.extra ? 'Remove' : t.skipped ? 'Undo' : 'Skip');
    btn.setAttribute('aria-label', t.trip.extra ? `Remove ${t.trip.label}` : t.skipped ? `Undo no school on ${dayLabel(t.day)}` : `No school on ${dayLabel(t.day)}`);
    btn.addEventListener('click', () => {
      if (t.trip.extra) settings.extras = settings.extras.filter((x) => x.id !== t.trip.id);
      else settings.skip = t.skipped ? settings.skip.filter((x) => x !== t.day) : [...settings.skip, t.day];
      store.set(KEY, settings); renderTrip();
    });
    li.append(d, dot, w, btn);
    if (!t.skipped) queue = queue.then(() => eventsFor(t.day)).then((ev) => {
      const a = assess(ev.events, { leaveBy: leave, arriveBy: t.arriveBy }, route);
      const lv = verdict(a);
      dot.className = `dot ${lv}`;
      const top = a.find((e) => e.level !== 'city') || a[0];
      sub.textContent = top ? `${top.level === 'on' ? 'On your route' : top.level === 'near' ? 'Nearby' : 'In SF'}: ${top.title}` : 'Nothing unusual';
    }).catch(() => { sub.textContent = "Couldn't check events"; });
    return li;
  });
  ul.replaceChildren(...rows);
}

document.getElementById('open-settings').addEventListener('click', () => renderSetup(settings));
if (settings?.from?.at && settings?.to?.at) { settings.skip ??= []; settings.extras = (settings.extras ?? []).filter((x) => x.day >= sfDate()); renderTrip(); } else renderSetup(null);
