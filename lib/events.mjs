// The day's San Francisco events that can slow traffic, from four sources, in one
// shape. Nothing here knows where the visitor lives: the page matches events to
// its own route, so addresses never reach this function.
//
//   Giants home games ......... MLB Stats API (no key)
//   Warriors, Valkyries ....... ESPN team schedules (no key)
//   Moscone conventions ....... SF Travel's convention calendar (no key)
//   Arenas, stadiums, concerts  Ticketmaster Discovery API (TICKETMASTER_API_KEY)
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

// Team schedules are the record for games: Ticketmaster sometimes lists a game
// late or under a package name, so a game counts if either source has it.
const yearCache = new Map();
async function cached(key, hours, load) {
  const hit = yearCache.get(key);
  if (hit && Date.now() - hit.at < hours * 3600e3) return hit.value;
  const value = await load();
  yearCache.set(key, { at: Date.now(), value });
  return value;
}

async function chaseCenterTeams(day) {
  const teams = [
    { url: 'https://site.api.espn.com/apis/site/v2/sports/basketball/nba/teams/gsw/schedule', team: 'Warriors' },
    { url: 'https://site.api.espn.com/apis/site/v2/sports/basketball/wnba/teams/gsv/schedule', team: 'Valkyries' },
    // The regular-season list leaves out the playoffs.
    { url: 'https://site.api.espn.com/apis/site/v2/sports/basketball/wnba/teams/gsv/schedule?seasontype=3', team: 'Valkyries' },
  ];
  const lists = await Promise.all(teams.map((t) => cached(t.url, 6, () => getJSON(t.url)).then((d) => (d.events ?? []).map((e) => ({ ...t, e }))).catch(() => [])));
  const seen = new Set();
  return lists.flat().flatMap(({ team, e }) => {
    const c = e.competitions?.[0];
    if (!/Chase Center/i.test(c?.venue?.fullName ?? '') || seen.has(e.id)) return [];
    if (/CANCELED|POSTPONED/.test(c?.status?.type?.name ?? '')) return [];
    const start = Date.parse(e.date);
    if (sfDate(new Date(start)) !== day) return [];
    seen.add(e.id);
    const away = c.competitors?.find((x) => x.homeAway === 'away')?.team?.shortDisplayName;
    return [{
      id: `espn-${e.id}`, source: 'ESPN', kind: 'game', reach: 'venue', severity: 'major',
      title: `${team} vs. ${away ?? e.name.split(' at ')[0]}`, venue: 'Chase Center', where: 'Chase Center, 3rd St & 16th St',
      start: iso(start), impact: crowdWindows(start, 'basketball'),
      geom: point(VENUES.KovZ917Ah1H.at), url: 'https://www.chasecenter.com/events',
    }];
  });
}

const MONTHS = 'Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec';
const BIG_CONVENTION = /dreamforce|ignite|wwdc|oracle|disrupt|game developers|\bgdc\b|rsa|next|agu|jpm|healthcare/i;

/** SF Travel's public convention calendar, as { name, from, to } for Moscone Center. */
export function parseConventions(html) {
  const lines = html.replace(/<[^>]*>/g, '\n').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').split('\n').map((l) => l.trim()).filter(Boolean);
  const out = [];
  const range = new RegExp(`^((?:${MONTHS})[a-z]* \\d{1,2}, \\d{4})\\s*-\\s*((?:${MONTHS})[a-z]* \\d{1,2}, \\d{4})$`);
  for (let i = 2; i + 2 < lines.length; i++) {
    const m = lines[i].match(range);
    if (!m || !/^Venue Type:$/i.test(lines[i + 1]) || !/Moscone/i.test(lines[i + 2])) continue;
    const ymd = (s) => { const d = new Date(`${s} 12:00 UTC`); return d.toISOString().slice(0, 10); };
    out.push({ name: lines[i - 2], from: ymd(m[1]), to: ymd(m[2]) });
  }
  return out;
}

async function conventions(day) {
  const list = await cached('sftravel', 12, async () => {
    const res = await fetch('https://portal.sftravel.com/calendar_public/home_sfdc.cfm', { signal: AbortSignal.timeout(8000) });
    if (!res.ok) throw new Error(`sftravel ${res.status}`);
    return parseConventions(await res.text());
  });
  return list.filter((c) => c.from <= day && day <= c.to).map((c) => {
    // Convention traffic peaks as attendees arrive in the morning and leave late afternoon.
    const impact = [
      { from: iso(sfTime(day, '07:30')), to: iso(sfTime(day, '09:30')), label: 'Convention crowds arriving' },
      { from: iso(sfTime(day, '16:30')), to: iso(sfTime(day, '18:30')), label: 'Convention crowds leaving' },
    ];
    return {
      id: `conv-${c.name}-${day}`, source: 'SF Travel', kind: 'event', reach: 'venue',
      severity: BIG_CONVENTION.test(c.name) ? 'major' : 'minor',
      title: c.name, venue: 'Moscone Center', where: 'Moscone Center, Howard St & 4th St',
      note: `Convention ${c.from === c.to ? 'today' : `through ${new Date(c.to + 'T12:00:00Z').toLocaleDateString('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric' })}`}`,
      start: impact[0].from, impact, geom: point(VENUES.KovZpZAE1leA.at), url: 'https://portal.sftravel.com/calendar_public/home_sfdc.cfm',
    };
  });
}

const titleCase = (s) => s.toLowerCase().replace(/(^|[\s\-/(&])([a-z])/g, (_, a, c) => a + c.toUpperCase()).replace(/\bSf\b/g, 'SF').replace(/\b0(\d)/g, '$1').replace(/ (Between|And|To|Of|At) /g, (m) => m.toLowerCase());

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
    chaseCenter: chaseCenterTeams(day),
    conventions: conventions(day),
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
  // One entry per game: drop Ticketmaster's copy when a team schedule has the same
  // game at the same venue within two hours, and its convention copies.
  const teamGames = events.filter((e) => e.source === 'MLB' || e.source === 'ESPN');
  const merged = events.filter((e) => !(e.source === 'Ticketmaster' && (
    (e.kind === 'game' && teamGames.some((g) => g.venue === e.venue && Math.abs(Date.parse(g.start) - Date.parse(e.start)) < 2 * 3600e3)) ||
    (e.venue === 'Moscone Center' && events.some((c) => c.source === 'SF Travel'))
  )));
  const ttl = day === today ? 600 : 3600;
  return {
    status: 200,
    headers: { 'Cache-Control': `public, s-maxage=${ttl}, stale-while-revalidate=${ttl * 3}` },
    body: { date: day, fetchedAt: Date.now(), sources: status, events: merged },
  };
}
