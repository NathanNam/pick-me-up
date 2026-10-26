// Decides which of the day's events could affect one trip: does the event's
// traffic window overlap the drive, and is it on or near the route?
import { geomToRoute } from './geo.js';

// How close counts, in metres, by kind of event. A stadium's traffic spills
// several blocks in every direction; a lane closure only matters on that street.
export const REACH = {
  venue:   { on: 800, near: 2000 },
  closure: { on: 40,  near: 250 },
  live:    { on: 150, near: 600 },
};

// The trip is "exposed" from a little before she leaves until a little after she
// arrives (the drive home with him counts too).
export const BEFORE_MIN = 15;
export const AFTER_MIN = 30;

const overlaps = (a0, a1, b0, b1) => a0 < b1 && b0 < a1;

/**
 * events: normalized events from /api/events
 * trip: { leaveBy: Date, arriveBy: Date }
 * route: [[lat, lng], ...] or null (before a route is known)
 * Returns events with { level: 'on' | 'near' | 'city', window, distance }, worst first;
 * events whose traffic doesn't overlap the trip are left out.
 */
export function assess(events, trip, route) {
  const t0 = trip.leaveBy.getTime() - BEFORE_MIN * 60e3;
  const t1 = trip.arriveBy.getTime() + AFTER_MIN * 60e3;
  const out = [];
  for (const ev of events) {
    const win = ev.impact.find((w) => overlaps(t0, t1, Date.parse(w.from), Date.parse(w.to)));
    if (!win) continue;
    const reach = REACH[ev.reach] || REACH.venue;
    const distance = route ? geomToRoute(ev.geom, route) : null;
    let level = 'city';
    if (distance != null && distance <= reach.on) level = 'on';
    else if (distance != null && distance <= reach.near) level = 'near';
    // Elsewhere in the city, only big crowds and major incidents are news; a block
    // party or a lane closure matters only if it's on or near the route.
    if (level === 'city' && !(ev.reach === 'venue' || (ev.reach === 'live' && ev.severity === 'major'))) continue;
    // A lane closure a street over doesn't slow you; a fully closed street might.
    if (level === 'near' && ev.reach === 'closure' && ev.severity !== 'major') continue;
    out.push({ ...ev, level, window: win, distance });
  }
  const rank = { on: 0, near: 1, city: 2 };
  return out.sort((a, b) => rank[a.level] - rank[b.level] || (b.severity === 'major') - (a.severity === 'major') || Date.parse(a.window.from) - Date.parse(b.window.from));
}

/** One word for the trip: 'clear', 'heads-up' (something near) or 'watch' (something on the route). */
export function verdict(assessed) {
  if (assessed.some((e) => e.level === 'on')) return 'watch';
  if (assessed.some((e) => e.level === 'near')) return 'heads-up';
  return 'clear';
}
