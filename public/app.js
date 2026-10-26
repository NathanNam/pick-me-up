// Pick Me Up: when to leave for school, planned for a bad-traffic day, with the
// San Francisco events that could slow the drive.
//
// Settings (the two places, school times, extra minutes) live only in this
// browser's localStorage. The route is matched to events here, on the phone, so
// the server that lists events never learns where anyone lives.
import { decodePolyline } from './lib/geo.js';
import { sfDate, sfWeekday, sfTime, addDays, clock, dayLabel } from './lib/time.js';
import { assess, verdict, extraMinutes } from './lib/impact.js';

const KEY = 'pickmeup.v1';
const PLAN_KEY = 'pickmeup.plan.v1';
const HOME_KEY = 'pickmeup.home.v1';
const app = document.getElementById('app');
const $ = (sel, root = document) => root.querySelector(sel);
const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; };
const MIN = 60e3;

// ---- storage (private windows can refuse it, so every access is guarded) ----
const store = {
  get(k) { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch { return false; } },
};
let settings = migrate(store.get(KEY));

/**
 * Settings used to hold one start and one destination. Now there's a list of
 * places and each trip picks its own: `from`, `to`, and optionally `then`, the
 * drive onward afterwards (home after pick-up). Old settings become Home and
 * School with every trip Home → School, and pick-up then back Home.
 */
function migrate(s) {
  if (!s || s.places || !s.from?.at || !s.to?.at) return s;
  const { from, to, lastRoute, ...rest } = s;
  return {
    ...rest,
    places: [{ id: 'home', ...from }, { id: 'school', ...to }],
    trips: s.trips.map((t) => ({ ...t, from: 'home', to: 'school', then: t.id === 'pick' ? 'home' : '' })),
    extras: (s.extras ?? []).map((x) => ({ ...x, from: 'home', to: 'school', then: '' })),
    routes: {},
  };
}

const placeById = (id) => settings.places.find((p) => p.id === id);
/** The places one trip uses: where it starts, its stop, and where it goes after (or null). */
function legOf(trip) {
  const ps = settings.places;
  return {
    from: placeById(trip.from) ?? ps[0],
    to: placeById(trip.to) ?? ps[1] ?? ps[0],
    then: trip.then ? placeById(trip.then) ?? null : null,
  };
}
const routeKey = (a, b) => `${a.at}>${b.at}`;
const savedRoute = (a, b) => (settings.routes?.[routeKey(a, b)] ? decodePolyline(settings.routes[routeKey(a, b)]) : null);
function rememberRoute(a, b, polyline) { settings.routes = { ...settings.routes, [routeKey(a, b)]: polyline }; }
/** Minutes a stop takes before driving on (getting a child in the car). */
const STOP_MIN = 5;

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
    if (arriveBy > now && x.day <= addDays(today, 21)) out.push({ day: x.day, trip: { id: x.id, label: x.label, time: x.time, from: x.from, to: x.to, then: x.then, extra: true }, arriveBy, skipped: false });
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

/** Minutes for a bad-day drive on this trip, from the last time it was planned. */
const badDay = (trip) => settings.badDay?.[trip.id] ?? settings.lastBadDayMin ?? 20;
const homeBadDay = (trip) => settings.homeBadDay?.[trip.id] ?? badDay(trip);
const planId = (t, s) => { const l = legOf(t.trip); return [t.day, t.trip.time, l.from.at, l.to.at, s.buffer].join('|'); };

/** The leave-by plan for one trip, reused for 5 minutes so reopening the app doesn't cost a lookup. */
async function planFor(t, force) {
  const id = planId(t, settings);
  const { from, to } = legOf(t.trip);
  const saved = store.get(PLAN_KEY);
  if (!force && saved?.id === id && Date.now() - saved.at < 5 * MIN) return saved.plan;
  const plan = await api('/api/plan', { from: from.at, to: to.at, arriveBy: t.arriveBy.toISOString(), bufferMin: settings.buffer });
  // The places may have changed while this was on its way: then it's stale.
  if (planId(t, settings) !== id) throw Object.assign(new Error('stale'), { stale: true });
  store.set(PLAN_KEY, { id, at: Date.now(), plan });
  // Remember the route and a typical bad-day time for the days ahead.
  rememberRoute(from, to, plan.polyline);
  settings.lastBadDayMin = plan.badDayMin;
  settings.badDay = { ...settings.badDay, [t.trip.id]: plan.badDayMin };
  store.set(KEY, settings);
  return plan;
}

/** The drive onward after the stop (home after pick-up), leaving a few minutes after arriving. */
async function homeFor(t) {
  const { to, then } = legOf(t.trip);
  if (!then) return null;
  const id = ['home', t.day, t.trip.time, to.at, then.at].join('|');
  const saved = store.get(HOME_KEY);
  if (saved?.id === id && Date.now() - saved.at < 5 * MIN) return saved.plan;
  const plan = await api('/api/plan', { from: to.at, to: then.at, departAt: new Date(t.arriveBy.getTime() + STOP_MIN * MIN).toISOString() });
  store.set(HOME_KEY, { id, at: Date.now(), plan });
  rememberRoute(to, then, plan.polyline);
  settings.homeBadDay = { ...settings.homeBadDay, [t.trip.id]: plan.badDayMin };
  store.set(KEY, settings);
  return plan;
}

// ---- setup ----
function renderSetup(existing) {
  timers.forEach(clearInterval); timers = []; view++; map = null;
  document.getElementById('open-settings').hidden = true;
  app.replaceChildren(document.getElementById('tpl-setup').content.cloneNode(true));
  const form = $('#setup-form');
  const msg = $('#setup-msg');

  // Your places: Home and School to begin with; add more when trips differ.
  let places = existing?.places?.map((p) => ({ ...p })) ?? [
    { id: 'home', name: 'Home', label: '', at: null },
    { id: 'school', name: 'School', label: '', at: null },
  ];
  const placesBox = $('#places');
  const PLACEHOLDER = { home: 'Street address', school: 'School name or address' };

  function placeBlock(p) {
    const box = el('div', 'place-block');
    const head = el('div', 'head');
    const nameIn = Object.assign(document.createElement('input'), { value: p.name, className: 'short', ariaLabel: 'Name for this place', placeholder: 'Name, e.g. After-care' });
    head.append(nameIn);
    if (places.length > 2 && p.id !== 'home' && p.id !== 'school') {
      const rm = el('button', 'ghost', 'Remove'); rm.type = 'button';
      rm.addEventListener('click', () => { places = places.filter((x) => x !== p); drawPlaces(); });
      head.append(rm);
    }
    const row = el('div', 'row');
    const q = Object.assign(document.createElement('input'), { value: p.label, placeholder: PLACEHOLDER[p.id] ?? 'Address', ariaLabel: `${p.name || 'Place'} address` });
    const find = el('button', 'find', 'Find'); find.type = 'button';
    row.append(q);
    const list = el('div', 'matches');
    list.setAttribute('role', 'radiogroup');
    const show = (results, pick) => {
      list.replaceChildren(...results.map((r, i) => {
        const lab = el('label');
        const radio = Object.assign(document.createElement('input'), { type: 'radio', name: `pick-${p.id}`, checked: i === pick });
        radio.addEventListener('change', () => { p.label = r.label; p.at = r.at; });
        lab.append(radio, el('span', null, r.label));
        return lab;
      }));
      if (pick >= 0) { p.label = results[pick].label; p.at = results[pick].at; }
    };
    if (p.at) show([{ label: p.label, at: p.at }], 0);
    const lookup = async () => {
      msg.textContent = '';
      list.replaceChildren(el('p', 'ev-m', 'Looking…'));
      try {
        const { results } = await api('/api/geocode', { q: q.value });
        if (!results.length) { list.replaceChildren(el('p', 'ev-m', 'No Bay Area match. Try adding the street number or "San Francisco".')); p.at = null; return; }
        show(results, results.length === 1 ? 0 : -1);
      } catch (e) { list.replaceChildren(el('p', 'msg', e.message)); }
    };
    find.addEventListener('click', lookup);
    q.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); lookup(); } });
    q.addEventListener('input', () => { p.at = null; list.replaceChildren(); });
    nameIn.addEventListener('input', () => { p.name = nameIn.value; fillSelects(); });
    box.append(head, row, find, list);
    return box;
  }

  // Each trip's From → To, then (optionally) where it drives on to.
  const legSelects = ['drop', 'pick', 'x'].map((t) => ({ t, from: form.elements[`${t}-from`], to: form.elements[`${t}-to`], then: form.elements[`${t}-then`] }));
  const tripDefaults = Object.fromEntries((existing?.trips ?? []).map((t) => [t.id, t]));
  const want = {
    drop: { from: tripDefaults.drop?.from ?? 'home', to: tripDefaults.drop?.to ?? 'school', then: tripDefaults.drop?.then ?? '' },
    pick: { from: tripDefaults.pick?.from ?? 'home', to: tripDefaults.pick?.to ?? 'school', then: tripDefaults.pick?.then ?? 'home' },
    x: { from: 'home', to: 'school', then: '' },
  };
  function fillSelects() {
    for (const { t, from, to, then } of legSelects) {
      for (const [sel, key, none] of [[from, 'from'], [to, 'to'], [then, 'then', 'Nowhere (don’t check)']]) {
        const keep = sel.options.length ? sel.value : want[t][key];
        const opts = places.map((p) => Object.assign(document.createElement('option'), { value: p.id, textContent: p.name || 'Unnamed place' }));
        if (none) opts.unshift(Object.assign(document.createElement('option'), { value: '', textContent: none }));
        sel.replaceChildren(...opts);
        sel.value = [...sel.options].some((o) => o.value === keep) ? keep : (none ? '' : places[key === 'from' ? 0 : Math.min(1, places.length - 1)].id);
      }
    }
  }
  function drawPlaces() {
    placesBox.replaceChildren(...places.map(placeBlock));
    fillSelects();
  }
  $('#add-place').addEventListener('click', () => {
    places.push({ id: `p${Date.now()}`, name: '', label: '', at: null });
    drawPlaces();
    placesBox.lastElementChild?.querySelector('input')?.focus();
  });
  drawPlaces();

  // one-off trips
  let extras = [...(existing?.extras ?? [])].filter((x) => x.day >= sfDate());
  const xList = $('#extras');
  const nameOf = (id) => places.find((p) => p.id === id)?.name ?? '';
  const drawExtras = () => xList.replaceChildren(...extras.sort((a, b) => (a.day + a.time).localeCompare(b.day + b.time)).map((x) => {
    const li = el('li', null);
    const legs = [nameOf(x.from), nameOf(x.to)].filter(Boolean).join(' → ') + (x.then ? `, then ${nameOf(x.then)}` : '');
    li.append(el('span', null, `${dayLabel(x.day)} · ${clock(sfTime(x.day, x.time))} · ${x.label}${legs ? ` · ${legs}` : ''}`));
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
    extras.push({ id: `x${Date.now()}`, day, time, label: label.slice(0, 40), from: form.elements['x-from'].value, to: form.elements['x-to'].value, then: form.elements['x-then'].value });
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
    const missing = places.find((p) => !p.at);
    if (missing) { msg.textContent = `Tap Find for ${missing.name || 'each place'} and pick the right address (or remove places you don't need).`; return; }
    const trip = (id, label, fallback) => ({
      id, label, time: form.elements[id].value || fallback, on: form.elements[`${id}-on`].checked,
      from: form.elements[`${id}-from`].value, to: form.elements[`${id}-to`].value, then: form.elements[`${id}-then`].value,
    });
    const trips = [trip('drop', 'Drop-off', '08:00'), trip('pick', 'Pick-up', '15:00')];
    if (trips.some((t) => t.on && t.from === t.to)) { msg.textContent = 'A trip starts and ends at the same place. Pick a different From or To.'; return; }
    const days = [...form.querySelectorAll('[name=day]:checked')].map((b) => +b.value);
    if ((!trips.some((t) => t.on) || !days.length) && !extras.length) { msg.textContent = 'Choose at least one trip and one school day, or add a one-off trip.'; return; }
    const ids = new Set(places.map((p) => p.id));
    settings = {
      places: places.map((p, i) => ({ ...p, name: p.name.trim() || ['Home', 'School'][i] || `Place ${i + 1}` })),
      trips, days, buffer: +form.querySelector('[name=buffer]:checked').value,
      extras: extras.map((x) => ({ ...x, from: ids.has(x.from) ? x.from : 'home', to: ids.has(x.to) ? x.to : 'school', then: ids.has(x.then) ? x.then : '' })),
      skip: (existing?.skip ?? []).filter((d) => d >= sfDate()),
      // Routes are keyed by their two points, so moved places simply miss.
      routes: existing?.routes ?? {}, badDay: existing?.badDay ?? {}, homeBadDay: existing?.homeBadDay ?? {}, lastBadDayMin: existing?.lastBadDayMin,
    };
    if (!store.set(KEY, settings)) msg.textContent = "This browser won't save settings (private mode?), so you'll need to enter them again next time.";
    try { localStorage.removeItem(PLAN_KEY); localStorage.removeItem(HOME_KEY); } catch {}
    renderTrip();
  });
}

// ---- trip view ----
let map, layers, timers = [];
let view = 0; // bumped whenever the screen is rebuilt, so late results for an old screen are dropped
const ICON = { game: '🏟️', concert: '🎵', event: '🎪', roadwork: '🚧', incident: '⚠️' };
const miles = (m) => (m < 160 ? 'A block from your route' : `About ${(m / 1609.34).toFixed(1)} mi from your route`);

function span(w) {
  const a = new Date(w.from), b = new Date(w.to);
  if (b - a >= 23.5 * 3600e3) return 'all day';
  return `${clock(a)}–${clock(b)}`;
}

/** 'On your route', 'Nearby', 'On the way home', 'In SF'. */
function tagText(e) {
  if (e.level === 'city') return 'In SF';
  if (e.leg === 'then') return e.level === 'on' ? `On the way to ${e.legName}` : `Near the way to ${e.legName}`;
  return e.level === 'on' ? 'On your route' : 'Nearby';
}

/** Events for the drive onward, tagged, minus any already listed for the main drive. */
function withOnward(main, onward, name) {
  const seen = new Set(main.map((e) => e.id));
  return [...main, ...onward.filter((e) => e.level !== 'city' && !seen.has(e.id)).map((e) => ({ ...e, leg: 'then', legName: name }))];
}

function eventItem(e) {
  const li = el('li', e.level);
  li.append(el('div', 'ico', ICON[e.kind] || '📍'));
  const body = el('div');
  const t = el('div', 'ev-t');
  t.append(el('span', 'tag', tagText(e)), document.createTextNode(' ' + e.title));
  const where = e.venue && !(e.where ?? '').startsWith(e.venue) ? [e.venue, e.where].filter(Boolean).join(' · ') : e.where;
  const meta = el('div', 'ev-m', `${e.window.label} ${span(e.window)}${where ? ' · ' + where : ''}`);
  body.append(t, meta);
  if (e.level === 'near' && e.distance != null) body.append(el('div', 'ev-m', miles(e.distance)));
  if (e.note) body.append(el('div', 'ev-m', e.note));
  li.append(body);
  return li;
}

function drawMap(route, assessed, leg, homeRoute) {
  if (!window.L) return;
  if (!map) {
    map = L.map('map', { zoomControl: false, attributionControl: true, scrollWheelZoom: false });
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
    }).addTo(map);
    layers = L.layerGroup().addTo(map);
    const m = map;
    const ro = new ResizeObserver(() => { if (map === m) m.invalidateSize(); else ro.disconnect(); });
    ro.observe(document.getElementById('map'));
  }
  layers.clearLayers();
  const color = { on: '#c2410c', near: '#c98a12' };
  for (const e of assessed.filter((x) => x.level !== 'city')) {
    const style = { color: color[e.level], weight: 6, opacity: 0.85 };
    if (e.geom.type === 'Point') L.circleMarker([e.geom.coordinates[1], e.geom.coordinates[0]], { radius: 9, color: '#fff', weight: 2, fillColor: color[e.level], fillOpacity: 1 }).bindTooltip(e.title).addTo(layers);
    else if (e.geom.type === 'LineString') L.polyline(e.geom.coordinates.map(([x, y]) => [y, x]), style).bindTooltip(e.title).addTo(layers);
    else if (e.geom.type === 'MultiLineString') L.polyline(e.geom.coordinates.map((l) => l.map(([x, y]) => [y, x])), style).bindTooltip(e.title).addTo(layers);
  }
  if (homeRoute?.length) L.polyline(homeRoute, { color: '#7a4a24', weight: 4, opacity: 0.75, dashArray: '8 7' }).addTo(layers);
  if (route?.length) L.polyline(route, { color: '#3a2616', weight: 5, opacity: 0.85 }).addTo(layers);
  L.circleMarker(leg.from.at, { radius: 8, color: '#fffaf0', weight: 3, fillColor: '#3a2616', fillOpacity: 1 }).bindTooltip(leg.from.name).addTo(layers);
  if (leg.then && leg.then.id !== leg.from.id) L.circleMarker(leg.then.at, { radius: 8, color: '#fffaf0', weight: 3, fillColor: '#7a4a24', fillOpacity: 1 }).bindTooltip(leg.then.name).addTo(layers);
  L.circleMarker(leg.to.at, { radius: 9, color: '#3a2616', weight: 3, fillColor: '#e5a630', fillOpacity: 1 }).bindTooltip(leg.to.name).addTo(layers);
  const pts = [...(route ?? []), ...(homeRoute ?? [])];
  map.fitBounds(L.latLngBounds(pts.length ? pts : [leg.from.at, leg.to.at]), { padding: [24, 24] });
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
  const gen = ++view;
  document.getElementById('open-settings').hidden = false;
  app.replaceChildren(document.getElementById('tpl-trip').content.cloneNode(true));
  const next = upcoming(settings, 8).filter((t) => !t.skipped);
  if (!next.length) { $('#hero .door').replaceChildren(el('p', 'empty', 'No school trips in the next three weeks. Check the school days in Settings.')); return; }
  const t = next[0];
  const leg = legOf(t.trip);
  $('#t-when').textContent = whenLabel(t);
  $('#t-dest').textContent = `to be at ${leg.to.name} by ${clock(t.arriveBy)}`;
  const v = $('#t-verdict'); v.className = 'verdict loading'; v.textContent = 'Checking traffic and events…';

  let plan = null, planErr = null, evs = null, evErr = null, home = null;
  const draw = () => {
    if (gen !== view) return;
    const route = plan?.polyline ? decodePolyline(plan.polyline) : savedRoute(leg.from, leg.to);
    const leaveBy = plan ? new Date(plan.leaveBy) : new Date(t.arriveBy - (settings.buffer + badDay(t.trip)) * MIN);
    const mainAssessed = evs ? assess(evs.events, { leaveBy, arriveBy: t.arriveBy }, route) : [];
    // The drive onward (home after pick-up): its own route and time window.
    const homeRoute = !leg.then ? null : home?.polyline ? decodePolyline(home.polyline) : savedRoute(leg.to, leg.then);
    const homeStart = new Date(t.arriveBy.getTime() + STOP_MIN * MIN);
    const homeEnd = home ? new Date(home.arriveBadDay) : new Date(homeStart.getTime() + homeBadDay(t.trip) * MIN);
    const homeAssessed = leg.then && evs && homeRoute ? assess(evs.events, { leaveBy: homeStart, arriveBy: homeEnd }, homeRoute) : [];
    const assessed = leg.then ? withOnward(mainAssessed, homeAssessed, leg.then.name) : mainAssessed;
    const homeLevel = verdict(homeAssessed.filter((e) => e.level !== 'city'));
    const level = verdict(mainAssessed);
    const hero = $('#hero'), now = Date.now();
    hero.classList.remove('now', 'late');
    if (plan) {
      const extra = extraMinutes(mainAssessed);
      const safeLeave = new Date(leaveBy - extra * MIN);
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
      if (extra && now < safeLeave) math.append(el('div', null, `Includes ${extra} extra min for what's on your route (${clock(leaveBy)} otherwise).`));
      if (leg.then && home) math.append(el('div', 'then-line', `Then ${leg.then.name}: about ${clock(new Date(home.arriveUsual))} (by ${clock(new Date(home.arriveBadDay))} on a bad day)`));
      $('#t-via').textContent = `${plan.miles} mi${plan.via ? ` via ${plan.via}` : ''} · ${leg.from.name} → ${leg.to.name}${leg.then ? ` → ${leg.then.name}` : ''}`;
    } else if (planErr) {
      $('#t-leave').textContent = '—';
      $('#t-count').textContent = '';
      $('#t-math').textContent = planErr;
    }
    if (evs || evErr) {
      const onWay = assessed.filter((e) => e.level !== 'city'), city = assessed.filter((e) => e.level === 'city');
      const mainOn = mainAssessed.filter((e) => e.level !== 'city');
      const shown = level === 'clear' && homeLevel !== 'clear' ? homeLevel : level;
      v.className = `verdict ${shown}`;
      v.textContent = evErr && !evs ? "Couldn't check events right now"
        : level === 'watch' ? `${short(mainAssessed.find((e) => e.level === 'on'))} on your route`
        : level === 'heads-up' ? `${mainOn.length} thing${mainOn.length > 1 ? 's' : ''} near your route`
        : homeLevel === 'watch' ? `${short(homeAssessed.find((e) => e.level === 'on'))} on the way to ${leg.then.name}`
        : homeLevel === 'heads-up' ? `Something near the way to ${leg.then.name}`
        : route ? `Nothing unusual on your route${leg.then ? 's' : ''}` : 'No big events in SF around then';
      const list = $('#t-events');
      list.replaceChildren(...onWay.map(eventItem));
      if (!onWay.length) { const p = el('p', 'empty'); p.append(el('b', null, 'All clear. '), document.createTextNode(route ? 'No games, concerts, closures or incidents along your way at that time.' : 'Add the route to check your streets.')); list.append(p); }
      $('#elsewhere').hidden = !city.length;
      $('#t-city').replaceChildren(...city.map(eventItem));
      const off = Object.entries(evs?.sources ?? {}).filter(([, s]) => s !== 'ok').map(([k]) => k);
      $('#t-updated').textContent = `Updated ${clock(new Date())}${off.length ? ` · couldn't reach: ${off.join(', ')}` : ''}`;
    }
    drawMap(route, assessed, leg, homeRoute);
  };

  const loadPlan = (force) => planFor(t, force).then((p) => { plan = p; planErr = null; }).catch((e) => { if (!e.stale) planErr = e.message; }).finally(draw);
  const loadEvents = () => eventsFor(t.day).then((d) => { evs = d; evErr = null; }).catch((e) => { evErr = e.message; }).finally(draw);
  const loadHome = () => (leg.then ? homeFor(t).then((h) => { home = h; }).catch(() => {}).finally(draw) : Promise.resolve());
  await Promise.all([loadPlan(false), loadEvents(), loadHome()]);
  if (gen === view) renderWeek(t);

  // Keep the countdown live; refresh the drive time every 5 minutes when the trip is
  // within three hours, and events every 10.
  timers.push(setInterval(draw, 20e3));
  timers.push(setInterval(() => { if (t.arriveBy - Date.now() < 3 * 3600e3) { loadPlan(true); loadHome(); } }, 5 * MIN));
  timers.push(setInterval(() => { eventCache.delete(t.day); loadEvents(); }, 10 * MIN));
  timers.push(setInterval(() => { if (Date.now() > t.arriveBy.getTime() + 15 * MIN) renderTrip(); }, MIN));
}

function renderWeek(hero) {
  const ul = $('#t-week');
  const all = upcoming(settings, 8).filter((x) => !(x.day === hero.day && x.trip.id === hero.trip.id)).slice(0, 6);
  if (!all.length) { ul.replaceChildren(el('p', 'empty', 'Nothing else scheduled.')); return; }
  // One day at a time: Ticketmaster allows only a few requests a second.
  let queue = Promise.resolve();
  const rows = all.map((t) => {
    const li = el('li', t.skipped ? 'skipped' : '');
    // Weekday on top; underneath, "Tomorrow" or the date.
    const d = el('div', 'd', dayLabel(t.day).replace(/,.*/, ''));
    d.append(el('small', null, t.day === addDays(sfDate(), 1) ? 'Tomorrow' : dayLabel(t.day).replace(/^\w+, /, '')));
    const dot = el('span', `dot ${t.skipped ? 'skip' : ''}`);
    const w = el('div', 'w');
    const leg = legOf(t.trip);
    const route = savedRoute(leg.from, leg.to);
    const homeRoute = leg.then ? savedRoute(leg.to, leg.then) : null;
    const mins = badDay(t.trip);
    const leave = new Date(t.arriveBy - (settings.buffer + mins) * MIN);
    const homeStart = new Date(t.arriveBy.getTime() + STOP_MIN * MIN);
    const homeEnd = new Date(homeStart.getTime() + homeBadDay(t.trip) * MIN);
    let extra = 0;
    const leaveText = () => `Leave by ${clock(new Date(leave - extra * MIN))}`;
    const head = el('div');
    const leaveLine = el('div', 'ev-m', t.skipped ? 'No school' : leaveText());
    head.append(el('b', null, `${t.trip.label} ${clock(t.arriveBy)}`), leaveLine);
    if (!t.skipped && (leg.then || leg.from.id !== settings.places[0].id || leg.to.id !== settings.places[1]?.id)) head.append(el('div', 'ev-m', `${leg.from.name} → ${leg.to.name}${leg.then ? ` → ${leg.then.name}` : ''}`));
    const sub = el('div', 'ev-m', t.skipped ? '' : 'Checking events…');
    w.append(head, sub);
    const btn = el('button', 'skipbtn', t.trip.extra ? 'Remove' : t.skipped ? 'Undo' : 'Skip');
    btn.setAttribute('aria-label', t.trip.extra ? `Remove ${t.trip.label}` : t.skipped ? `Undo no school on ${dayLabel(t.day)}` : `No school on ${dayLabel(t.day)}`);
    btn.addEventListener('click', () => {
      if (t.trip.extra) settings.extras = settings.extras.filter((x) => x.id !== t.trip.id);
      else settings.skip = t.skipped ? settings.skip.filter((x) => x !== t.day) : [...settings.skip, t.day];
      store.set(KEY, settings); renderTrip();
    });
    // Tap a row to see everything about that trip.
    const more = el('div', 'more');
    more.hidden = true;
    let found = null;
    const fill = () => {
      more.replaceChildren();
      if (t.skipped) { more.append(el('p', null, 'Marked as no school. Tap Undo to bring this trip back.')); return; }
      more.append(el('p', null, `${leaveText()} from ${leg.from.name} to be at ${leg.to.name} by ${clock(t.arriveBy)}: about ${mins} min on a bad day, plus your ${settings.buffer} min${extra ? `, plus ${extra} min for what's on your route` : ''}.`));
      if (leg.then) more.append(el('p', null, `Then on to ${leg.then.name}, getting there by about ${clock(homeEnd)} on a bad day.`));
      if (!found) { more.append(el('p', 'ev-m', 'Checking events…')); return; }
      if (!found.length) more.append(el('p', null, 'Nothing unusual: no games, concerts, conventions or street closures along your way around then.'));
      for (const e of found) {
        const where = e.venue && !(e.where ?? '').startsWith(e.venue) ? [e.venue, e.where].filter(Boolean).join(' · ') : e.where;
        const p1 = el('p', `ev ${e.level}`);
        p1.append(el('span', 'tag', tagText(e)), document.createTextNode(' ' + e.title));
        more.append(p1, el('p', 'ev-m', [`${e.window.label} ${span(e.window)}`, where, e.note].filter(Boolean).join(' · ')));
      }
      if (extra) more.append(el('p', null, found.some((e) => e.level === 'on' && e.reach !== 'closure')
        ? `That's why it says to leave ${extra} minutes earlier than usual.`
        : `A closed street on your way: Google may route around it, but the time above allows ${extra} extra minutes.`));
      more.append(el('p', 'ev-m', 'The exact drive time shows up at the top on the day.'));
    };
    w.tabIndex = 0;
    w.setAttribute('role', 'button');
    w.setAttribute('aria-expanded', 'false');
    const toggle = () => {
      more.hidden = !more.hidden;
      li.classList.toggle('open', !more.hidden);
      w.setAttribute('aria-expanded', String(!more.hidden));
      if (!more.hidden) fill();
    };
    w.addEventListener('click', toggle);
    w.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); } });
    li.append(d, dot, w, btn, more);
    if (!t.skipped) queue = queue.then(() => eventsFor(t.day)).then((ev) => {
      const main = assess(ev.events, { leaveBy: leave, arriveBy: t.arriveBy }, route);
      const onward = homeRoute ? assess(ev.events, { leaveBy: homeStart, arriveBy: homeEnd }, homeRoute) : [];
      const a = leg.then ? withOnward(main, onward, leg.then.name) : main;
      found = a;
      extra = extraMinutes(main);
      leaveLine.textContent = leaveText();
      const lv = verdict(a);
      dot.className = `dot ${lv}`;
      const top = a.find((e) => e.level !== 'city') || a[0];
      sub.textContent = top ? `${tagText(top)}: ${top.title}${a.length > 1 ? ` +${a.length - 1}` : ''}` : 'Nothing unusual';
      if (!more.hidden) fill();
    }).catch(() => { sub.textContent = "Couldn't check events"; });
    return li;
  });
  ul.replaceChildren(...rows);
}

document.getElementById('open-settings').addEventListener('click', () => renderSetup(settings));
if (settings?.places?.length >= 2 && settings.places.every((p) => p.at)) { settings.skip ??= []; store.set(KEY, settings); settings.extras = (settings.extras ?? []).filter((x) => x.day >= sfDate()); renderTrip(); } else renderSetup(null);
