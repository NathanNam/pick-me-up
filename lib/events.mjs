// The day's San Francisco events that can slow traffic, from four sources, in one
// shape. Nothing here knows where the visitor lives: the page matches events to
// its own route, so addresses never reach this function.
//
//   Giants home games ......... MLB Stats API (no key)
//   Arenas, stadiums, Moscone . Ticketmaster Discovery API (TICKETMASTER_API_KEY)
//   Permitted street closures . DataSF "Temporary Street Closures" (no key)
//   Live incidents, roadwork .. 511.org traffic events (TRAFFIC_511_API_KEY), today only
import { sfTime, addDays, sfDate } from '../public/lib/time.js';
import { inSF } from '../public/lib/geo.js';

// Big venues whose crowds change traffic for blocks around them.
export const VENUES = {
  KovZpZAJF7EA: { name: 'Oracle Park', at: [37.7784, -122.3894] },
  KovZ917Ah1H: { name: 'Chase Center', at: [37.7680, -122.3877] },
  KovZpaKope: { name: 'Bill Graham Civic Auditorium', at: [37.7785, -122.4175] },
  KovZpaKFJe: { name: 'Golden Gate Park', at: [37.7661, -122.4643] },
  KovZpZAE1leA: { name: 'Moscone Center', at: [37.7835, -122.4025] },
  KovZpZAFktvA: { name: 'Cow Palace', at: [37.7057, -122.4199] },
};

const point = ([lat, lng]) => ({ type: 'Point', coordinates: [lng, lat] });
const iso = (ms) => new Date(ms).toISOString();
const MIN = 60e3;

/**
 * Traffic windows around a crowd event: people arriving before it starts and
 * leaving after it ends. Ends are rarely published, so they're estimated from
 * typical lengths and flagged as estimates.
 */
export function crowdWindows(startMs, kind) {
  const len = { baseball: 180, basketball: 150, music: 210 }[kind] ?? 180;
  // Venues' own traffic advisories start about two hours before the doors.
  const before = 120;
  return [
    { from: iso(startMs - before * MIN), to: iso(startMs + 15 * MIN), label: 'Crowds arriving' },
    { from: iso(startMs + (len - 15) * MIN), to: iso(startMs + (len + 60) * MIN), label: 'Crowds leaving (estimated)' },
  ];
}

async function getJSON(url, init) {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`${new URL(url).host} ${res.status}`);
  return JSON.parse((await res.text()).replace(/^﻿/, ''));
}

async function giants(day) {
  const d = await getJSON(`https://statsapi.mlb.com/api/v1/schedule?sportId=1&teamId=137&date=${day}`);
  return (d.dates ?? []).flatMap((x) => x.games).filter((g) => g.venue?.name === 'Oracle Park' && !/Postponed|Cancelled/.test(g.status?.detailedState ?? '')).map((g) => {
    const start = Date.parse(g.gameDate);
    return {
      id: `mlb-${g.gamePk}`, source: 'MLB', kind: 'game', reach: 'venue', severity: 'major',
      title: `Giants vs. ${g.teams.away.team.name.replace(/^.* (\w+)$/, '$1')}`,
      venue: 'Oracle Park', where: 'Oracle Park, King St & 3rd St',
      start: iso(start), impact: crowdWindows(start, 'baseball'),
      geom: point(VENUES.KovZpZAJF7EA.at), url: 'https://www.mlb.com/giants/schedule',
    };
  });
}

async function ticketmaster(day, key) {
  if (!key) throw new Error('no Ticketmaster key');
  const from = sfTime(day, '00:00').toISOString().replace(/\.\d+Z$/, 'Z');
  const to = sfTime(addDays(day, 1), '00:00').toISOString().replace(/\.\d+Z$/, 'Z');
  const q = new URLSearchParams({ apikey: key, venueId: Object.keys(VENUES).join(','), startDateTime: from, endDateTime: to, size: '100', sort: 'date,asc' });
  const d = await getJSON(`https://app.ticketmaster.com/discovery/v2/events.json?${q}`);
  const seen = new Set();
  return (d._embedded?.events ?? []).flatMap((e) => {
    const v = VENUES[e._embedded?.venues?.[0]?.id];
    const startStr = e.dates?.start?.dateTime;
    if (!v || !startStr || e.dates?.status?.code === 'cancelled') return [];
    // Ticketmaster lists the same show several times (packages, parking, VIP).
    const dedupe = `${v.name}|${startStr}`;
    if (seen.has(dedupe) || /parking|suite|premium|package/i.test(e.name)) return [];
    seen.add(dedupe);
    const start = Date.parse(startStr);
    const seg = e.classifications?.[0];
    const kind = seg?.segment?.name === 'Music' ? 'music' : /basketball/i.test(seg?.genre?.name ?? '') ? 'basketball' : /baseball/i.test(seg?.genre?.name ?? '') ? 'baseball' : 'other';
    return [{
      id: `tm-${e.id}`, source: 'Ticketmaster', kind: kind === 'music' ? 'concert' : seg?.segment?.name === 'Sports' ? 'game' : 'event',
      reach: 'venue', severity: v.name === 'Cow Palace' || v.name === 'Golden Gate Park' ? 'minor' : 'major',
      title: e.name, venue: v.name, where: v.name, start: iso(start), impact: crowdWindows(start, kind),
      geom: point(v.at), url: e.url,
    }];
  });
}

const titleCase = (s) => s.toLowerCase().replace(/(^|[\s\-/(&])([a-z])/g, (_, a, c) => a + c.toUpperCase()).replace(/\bSf\b/g, 'SF').replace(/\b0(\d)/g, '$1');

async function closures(day) {
  const q = new URLSearchParams({
    $where: `start_dt <= '${day}T23:59:59' AND end_dt >= '${day}T00:00:00' AND type != 'Roadway Shared Spaces' AND status in ('Permitted','Application In Review','Pending Payment')`,
    $limit: '2000',
  });
  const rows = await getJSON(`https://data.sf.gov/resource/8x25-yybr.json?${q}`);
  const dayStart = sfTime(day, '00:00').getTime(), dayEnd = sfTime(addDays(day, 1), '00:00').getTime();
  const cases = new Map();
  for (const r of rows) {
    if (!r.shape?.coordinates) continue;
    const c = cases.get(r.case_num) ?? { r, lines: [], where: new Set() };
    c.lines.push(r.shape.type === 'MultiLineString' ? r.shape.coordinates.flat() : r.shape.coordinates);
    c.where.add(titleCase(r.loc_desc));
    if (r.veh_imp === 'all-lanes-closed') c.r = { ...c.r, veh_imp: 'all-lanes-closed' };
    cases.set(r.case_num, c);
  }
  return [...cases.values()].map(({ r, lines, where }) => {
    const event = r.type === 'Special Event';
    const all = r.veh_imp === 'all-lanes-closed';
    const s = Math.max(sfTime(r.start_dt.slice(0, 10), r.start_dt.slice(11, 16)).getTime(), dayStart);
    const e = Math.min(sfTime(r.end_dt.slice(0, 10), r.end_dt.slice(11, 16)).getTime(), dayEnd);
    const pending = r.status !== 'Permitted';
    const ws = [...where];
    return {
      id: `sf-${r.case_num}`, source: 'DataSF', kind: event ? 'event' : 'roadwork', reach: 'closure',
      severity: event && all ? 'major' : 'minor',
      title: event ? titleCase(r.case_name) : 'Lane closure for construction',
      where: ws.slice(0, 2).join('; ') + (ws.length > 2 ? ` and ${ws.length - 2} more blocks` : ''),
      note: [all ? 'Street closed to cars' : 'Some lanes closed', pending ? 'permit not yet approved' : ''].filter(Boolean).join(' · '),
      start: iso(s), impact: [{ from: iso(s), to: iso(e), label: all ? 'Street closed' : 'Lanes closed' }],
      geom: { type: 'MultiLineString', coordinates: lines },
      url: 'https://data.sfgov.org/Transportation/Temporary-Street-Closures/8x25-yybr',
    };
  });
}

async function live(day, key) {
  if (!key) throw new Error('no 511 key');
  const d = await getJSON(`https://api.511.org/traffic/events?api_key=${encodeURIComponent(key)}&format=json&limit=500`);
  const dayStart = sfTime(day, '00:00').getTime(), dayEnd = sfTime(addDays(day, 1), '00:00').getTime();
  return (d.events ?? []).flatMap((e) => {
    const coords = e.geography?.type === 'Point' ? [e.geography.coordinates] : (e.geography?.coordinates ?? []).flat(e.geography?.type === 'MultiLineString' ? 1 : 0);
    if (!coords.some((c) => Array.isArray(c) && inSF([c[1], c[0]]))) return [];
    // Special events at the big venues are already covered, with better times.
    if (e.event_type === 'SPECIAL_EVENT' && /Chase Center|Oracle Park|Moscone/i.test(e.headline ?? '')) return [];
    const windows = (e.schedule?.intervals ?? [`${e.created}/`]).map((iv) => {
      const [a, b] = iv.split('/');
      return { from: Math.max(Date.parse(a) || dayStart, dayStart), to: Math.min(Date.parse(b) || dayEnd, dayEnd) };
    }).filter((w) => w.from < w.to);
    if (!windows.length) return [];
    const headline = (e.headline ?? '').replace(/^[^:]{1,20}:\s*/, '').replace(/\s*From \d.*$/, '').trim();
    const kind = e.event_type === 'INCIDENT' ? 'incident' : e.event_type === 'CONSTRUCTION' ? 'roadwork' : 'event';
    return [{
      id: `511-${e.id}`, source: '511', kind, reach: 'live',
      severity: /Major|Severe/i.test(e.severity) || /all lanes (are )?(closed|blocked)/i.test(headline) ? 'major' : 'minor',
      title: headline.split('. ')[0] || 'Traffic event', where: (e.roads ?? []).map((r) => r.name).filter(Boolean).join(', '),
      note: headline.split('. ').slice(1).join('. '),
      start: iso(windows[0].from), impact: windows.map((w) => ({ from: iso(w.from), to: iso(w.to), label: kind === 'incident' ? 'Incident' : 'Roadwork' })),
      geom: e.geography, url: 'https://511.org/traffic',
    }];
  });
}

/** Handles ?date=YYYY-MM-DD and returns { status, headers, body }. */
export async function handle(params, env = process.env) {
  const today = sfDate();
  const day = params.get('date') || today;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || day < addDays(today, -1) || day > addDays(today, 30)) {
    return { status: 400, headers: {}, body: { error: 'date: YYYY-MM-DD within the next 30 days' } };
  }
  const sources = {
    giants: giants(day),
    venues: ticketmaster(day, env.TICKETMASTER_API_KEY),
    closures: closures(day),
    // 511 only knows what's happening now and soon, so only ask for today.
    live: day === today ? live(day, env.TRAFFIC_511_API_KEY) : Promise.resolve([]),
  };
  const names = Object.keys(sources);
  const results = await Promise.allSettled(Object.values(sources));
  const events = [], status = {};
  results.forEach((r, i) => {
    if (r.status === 'fulfilled') { events.push(...r.value); status[names[i]] = 'ok'; }
    else status[names[i]] = r.reason?.message || 'failed';
  });
  // Drop Ticketmaster's copy of a Giants game that MLB already gave us.
  const mlb = events.filter((e) => e.source === 'MLB').map((e) => Date.parse(e.start));
  const merged = events.filter((e) => !(e.source === 'Ticketmaster' && e.venue === 'Oracle Park' && /giants/i.test(e.title) && mlb.some((t) => Math.abs(t - Date.parse(e.start)) < 2 * 3600e3)));
  const ttl = day === today ? 600 : 3600;
  return {
    status: 200,
    headers: { 'Cache-Control': `public, s-maxage=${ttl}, stale-while-revalidate=${ttl * 3}` },
    body: { date: day, fetchedAt: Date.now(), sources: status, events: merged },
  };
}
