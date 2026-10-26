import test from 'node:test';
import assert from 'node:assert/strict';
import { decodePolyline, pointToRoute, geomToRoute } from '../public/lib/geo.js';
import { sfTime, sfDate, sfWeekday, addDays, clock } from '../public/lib/time.js';
import { assess, verdict } from '../public/lib/impact.js';
import { crowdWindows } from '../lib/events.mjs';
import { plan } from '../lib/google.mjs';

test('decodes Google polylines', () => {
  // Google's documented example.
  assert.deepEqual(decodePolyline('_p~iF~ps|U_ulLnnqC_mqNvxq`@'), [[38.5, -120.2], [40.7, -120.95], [43.252, -126.453]]);
});

test('distances to a route', () => {
  const route = [[37.77, -122.45], [37.77, -122.40]]; // an east-west street
  assert.ok(Math.abs(pointToRoute([37.771, -122.42], route) - 111) < 3);
  // a closure along the same street is ~0 m away; one on a parallel street 2 blocks away is ~200 m
  assert.ok(geomToRoute({ type: 'LineString', coordinates: [[-122.43, 37.77], [-122.42, 37.77]] }, route) < 1);
  assert.ok(geomToRoute({ type: 'LineString', coordinates: [[-122.43, 37.7718], [-122.42, 37.7718]] }, route) > 150);
});

test('San Francisco wall-clock times, across daylight saving', () => {
  assert.equal(sfTime('2026-10-26', '15:00').toISOString(), '2026-10-26T22:00:00.000Z'); // PDT
  assert.equal(sfTime('2026-11-02', '08:00').toISOString(), '2026-11-02T16:00:00.000Z'); // PST
  assert.equal(sfDate(new Date('2026-10-27T06:30:00Z')), '2026-10-26');
  assert.equal(sfWeekday(new Date('2026-10-26T20:00:00Z')), 1);
  assert.equal(addDays('2026-10-31', 1), '2026-11-01');
  assert.equal(clock(new Date('2026-10-26T22:31:00Z')), '3:31 PM');
});

const chase = [37.768, -122.3877];
const valkyries = { id: 'tm-1', kind: 'game', reach: 'venue', severity: 'major', title: 'Valkyries', geom: { type: 'Point', coordinates: [chase[1], chase[0]] }, impact: crowdWindows(Date.parse('2026-10-27T00:00:00Z'), 'basketball') };

test('a 5 PM game at Chase Center flags a 3:00 pick-up that drives past it', () => {
  const trip = { leaveBy: new Date('2026-10-26T22:00:00Z'), arriveBy: new Date('2026-10-26T22:40:00Z') }; // 3:00–3:40 PM
  const past = [[37.76, -122.39], [37.775, -122.389]]; // up 3rd St beside the arena
  const across = [[37.78, -122.47], [37.80, -122.44]]; // Richmond to the Marina
  assert.equal(assess([valkyries], trip, past)[0].level, 'on');
  assert.equal(verdict(assess([valkyries], trip, past)), 'watch');
  assert.equal(assess([valkyries], trip, across)[0].level, 'city');
  assert.equal(verdict(assess([valkyries], trip, across)), 'clear');
  // the 8 AM drop-off is long before the crowds
  assert.equal(assess([valkyries], { leaveBy: new Date('2026-10-26T14:30:00Z'), arriveBy: new Date('2026-10-26T15:00:00Z') }, past).length, 0);
});

test('a lane closure only counts on or near the route', () => {
  const closure = { id: 'sf-1', kind: 'roadwork', reach: 'closure', severity: 'minor', title: 'Lane closure', geom: { type: 'LineString', coordinates: [[-122.43, 37.77], [-122.42, 37.77]] }, impact: [{ from: '2026-10-26T07:00:00Z', to: '2026-10-27T06:59:00Z', label: 'Lanes closed' }] };
  const trip = { leaveBy: new Date('2026-10-26T22:00:00Z'), arriveBy: new Date('2026-10-26T22:30:00Z') };
  assert.equal(assess([closure], trip, [[37.77, -122.45], [37.77, -122.40]])[0].level, 'on');
  assert.equal(assess([closure], trip, [[37.79, -122.45], [37.79, -122.40]]).length, 0);
});

test('leave-by plans for a bad day and iterates on departure time', async (t) => {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push(body);
    // 20 min on a bad day, 14 usually, 11 with no traffic
    const secs = body.trafficModel === 'PESSIMISTIC' ? 1200 : 840;
    return new Response(JSON.stringify({ routes: [{ duration: `${secs}s`, staticDuration: '660s', distanceMeters: 6437, polyline: { encodedPolyline: 'abc' }, description: 'Divisadero St' }] }), { status: 200 });
  });
  const now = Date.parse('2026-10-26T20:00:00Z'); // 1:00 PM
  const r = await plan({ from: [37.76, -122.44], to: [37.79, -122.42], arriveBy: '2026-10-26T22:00:00Z', bufferMin: 10 }, 'k', now);
  assert.equal(r.status, 200);
  assert.equal(r.body.leaveBy, '2026-10-26T21:30:00.000Z'); // 3:00 − 10 − 20 = 2:30 PM
  assert.equal(r.body.badDayMin, 20);
  assert.equal(r.body.usualMin, 14);
  assert.equal(r.body.miles, 4);
  assert.ok(calls.every((c) => c.routingPreference === 'TRAFFIC_AWARE_OPTIMAL'));
  assert.equal(calls.at(-1).trafficModel, 'BEST_GUESS');
  assert.equal(r.body.etaIfLeavingNow, null);
});

test('when it is already past leave-by, it says when she would arrive', async (t) => {
  t.mock.method(globalThis, 'fetch', async (url, init) => new Response(JSON.stringify({ routes: [{ duration: JSON.parse(init.body).trafficModel === 'PESSIMISTIC' ? '1500s' : '1080s', staticDuration: '660s', distanceMeters: 6437, polyline: { encodedPolyline: 'abc' } }] })));
  const now = Date.parse('2026-10-26T21:45:00Z'); // 2:45 PM for a 3:00 arrival
  const r = await plan({ from: [37.76, -122.44], to: [37.79, -122.42], arriveBy: '2026-10-26T22:00:00Z', bufferMin: 10 }, 'k', now);
  assert.ok(Date.parse(r.body.leaveBy) < now);
  assert.equal(r.body.etaIfLeavingNow, new Date(now + 1080e3).toISOString());
});

test('rejects places outside the Bay Area', async () => {
  const r = await plan({ from: [40.7, -74], to: [37.79, -122.42], arriveBy: new Date(Date.now() + 3600e3).toISOString() }, 'k');
  assert.equal(r.status, 400);
});

import { parseConventions } from '../lib/events.mjs';
test('reads Moscone conventions from the SF Travel calendar', () => {
  const html = '<tr><td>Microsoft IGNITE 2026</td><td>Microsoft Corporation</td><td>Nov 17, 2026 - Nov 20, 2026</td><td>Venue Type:</td><td>Moscone Center</td></tr>'
    + '<tr><td>Other Show</td><td>Org</td><td>Dec 1, 2026 - Dec 2, 2026</td><td>Venue Type:</td><td>Hotel</td></tr>';
  assert.deepEqual(parseConventions(html), [{ name: 'Microsoft IGNITE 2026', from: '2026-11-17', to: '2026-11-20' }]);
});
