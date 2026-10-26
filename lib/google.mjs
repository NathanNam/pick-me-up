// Address lookup and drive times from Google Maps Platform (GOOGLE_MAPS_API_KEY,
// with the Geocoding API and the Routes API enabled).
//
// Addresses arrive in POST bodies (never URLs, so they stay out of logs and
// caches), go to Google for the lookup, and aren't stored or logged here.
import { inBayArea } from '../public/lib/geo.js';

const SF_BOUNDS = '37.70,-122.52|37.84,-122.35';

async function google(url, init) {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(10000) });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(body.error?.message || `Google ${res.status}`), { status: 502 });
  return body;
}

/** { q: '123 Main St' } → { results: [{ label, at: [lat, lng] }] } */
export async function geocode(input, key) {
  const q = String(input?.q ?? '').trim();
  if (q.length < 3 || q.length > 200) return { status: 400, body: { error: 'Type a street address or place name.' } };
  const url = `https://maps.googleapis.com/maps/api/geocode/json?${new URLSearchParams({ address: q, bounds: SF_BOUNDS, region: 'us', key })}`;
  const d = await google(url);
  if (d.status !== 'OK' && d.status !== 'ZERO_RESULTS') throw Object.assign(new Error(`Geocoding ${d.status}`), { status: 502 });
  const results = (d.results ?? []).map((r) => ({
    label: r.formatted_address.replace(/, USA$/, ''),
    at: [r.geometry.location.lat, r.geometry.location.lng],
  })).filter((r) => inBayArea(r.at)).slice(0, 4);
  return { status: 200, body: { results } };
}

const FIELDS = 'routes.duration,routes.staticDuration,routes.distanceMeters,routes.polyline.encodedPolyline,routes.description';

/** One drive from a to b, leaving at `depart`, with Google's traffic model. */
export async function drive(a, b, depart, model, key) {
  const body = {
    origin: { location: { latLng: { latitude: a[0], longitude: a[1] } } },
    destination: { location: { latLng: { latitude: b[0], longitude: b[1] } } },
    travelMode: 'DRIVE',
    routingPreference: 'TRAFFIC_AWARE_OPTIMAL',
    trafficModel: model,
    departureTime: depart.toISOString(),
    units: 'IMPERIAL',
  };
  const d = await google('https://routes.googleapis.com/directions/v2:computeRoutes', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': key, 'X-Goog-FieldMask': FIELDS },
    body: JSON.stringify(body),
  });
  const r = d.routes?.[0];
  if (!r) throw Object.assign(new Error('No driving route between those places.'), { status: 422 });
  return {
    seconds: parseInt(r.duration, 10),
    freeFlowSeconds: parseInt(r.staticDuration, 10),
    meters: r.distanceMeters,
    polyline: r.polyline?.encodedPolyline ?? '',
    via: r.description ?? '',
  };
}

const MIN = 60e3;

/**
 * When to leave to arrive by `arriveBy`, planning for a bad-traffic day:
 * Google's PESSIMISTIC model for the departure time, plus her buffer. Drive time
 * depends on when you leave, so it's worked out twice (three times if traffic is
 * changing fast around then).
 */
export async function plan(input, key, now = Date.now()) {
  if (input?.departAt) return homeward(input, key, now);
  const from = input?.from, to = input?.to;
  const arriveBy = new Date(input?.arriveBy);
  const buffer = Math.max(0, Math.min(60, Number(input?.bufferMin ?? 10)));
  const ok = (p) => Array.isArray(p) && p.length === 2 && p.every(Number.isFinite) && inBayArea(p);
  if (!ok(from) || !ok(to)) return { status: 400, body: { error: 'Both places need to be in the Bay Area.' } };
  if (Number.isNaN(arriveBy.getTime()) || arriveBy - now > 8 * 24 * 3600e3) return { status: 400, body: { error: 'arriveBy: a time in the next week' } };

  // Google only predicts traffic for departures from now on.
  const at = (t) => new Date(Math.max(t, now + MIN));
  let depart = at(arriveBy - buffer * MIN - 25 * MIN);
  let bad = await drive(from, to, depart, 'PESSIMISTIC', key);
  for (let i = 0; i < 2; i++) {
    const next = at(arriveBy - buffer * MIN - bad.seconds * 1000);
    if (Math.abs(next - depart) < 2 * MIN) break;
    depart = next;
    bad = await drive(from, to, depart, 'PESSIMISTIC', key);
  }
  const usual = await drive(from, to, depart, 'BEST_GUESS', key);
  const leaveBy = new Date(arriveBy - buffer * MIN - bad.seconds * 1000);
  const late = leaveBy.getTime() < now;
  return {
    status: 200,
    body: {
      arriveBy: arriveBy.toISOString(),
      leaveBy: leaveBy.toISOString(),
      bufferMin: buffer,
      badDayMin: Math.ceil(bad.seconds / 60),
      usualMin: Math.ceil(usual.seconds / 60),
      noTrafficMin: Math.ceil(bad.freeFlowSeconds / 60),
      miles: Math.round((bad.meters / 1609.34) * 10) / 10,
      via: bad.via,
      polyline: bad.polyline,
      // Already past the leave-by time: when she'd get there leaving right now.
      etaIfLeavingNow: late ? new Date(now + usual.seconds * 1000).toISOString() : null,
      etaIfLeavingNowBadDay: late ? new Date(now + bad.seconds * 1000).toISOString() : null,
      computedAt: new Date(now).toISOString(),
    },
  };
}

/**
 * The drive onward from a stop (home after pick-up): leaving at `departAt`, when
 * you'd get there on a usual and on a bad-traffic day.
 */
async function homeward(input, key, now) {
  const from = input?.from, to = input?.to;
  const departAt = new Date(input?.departAt);
  const ok = (p) => Array.isArray(p) && p.length === 2 && p.every(Number.isFinite) && inBayArea(p);
  if (!ok(from) || !ok(to)) return { status: 400, body: { error: 'Both places need to be in the Bay Area.' } };
  if (Number.isNaN(departAt.getTime()) || departAt - now > 8 * 24 * 3600e3) return { status: 400, body: { error: 'departAt: a time in the next week' } };
  const depart = new Date(Math.max(departAt.getTime(), now + MIN));
  const [bad, usual] = await Promise.all([drive(from, to, depart, 'PESSIMISTIC', key), drive(from, to, depart, 'BEST_GUESS', key)]);
  return {
    status: 200,
    body: {
      departAt: depart.toISOString(),
      arriveUsual: new Date(depart.getTime() + usual.seconds * 1000).toISOString(),
      arriveBadDay: new Date(depart.getTime() + bad.seconds * 1000).toISOString(),
      badDayMin: Math.ceil(bad.seconds / 60),
      usualMin: Math.ceil(usual.seconds / 60),
      miles: Math.round((bad.meters / 1609.34) * 10) / 10,
      via: bad.via,
      polyline: bad.polyline,
      computedAt: new Date(now).toISOString(),
    },
  };
}
