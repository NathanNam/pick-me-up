// Geometry helpers shared by the page and the server: Google's encoded
// polylines, and distances from an event (point or street segment) to a route.

/** Decodes a Google encoded polyline into [[lat, lng], ...]. */
export function decodePolyline(str) {
  const pts = [];
  let i = 0, lat = 0, lng = 0;
  while (i < str.length) {
    for (const axis of [0, 1]) {
      let shift = 0, result = 0, b;
      do { b = str.charCodeAt(i++) - 63; result |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20);
      const d = result & 1 ? ~(result >> 1) : result >> 1;
      if (axis === 0) lat += d; else lng += d;
    }
    pts.push([lat / 1e5, lng / 1e5]);
  }
  return pts;
}

// Flat-earth projection in metres around San Francisco: accurate to well under
// 1% across the city, and much simpler than great-circle maths per segment.
const LAT0 = 37.77;
const M_LAT = 111_320;
const M_LNG = 111_320 * Math.cos((LAT0 * Math.PI) / 180);
const xy = ([lat, lng]) => [lng * M_LNG, lat * M_LAT];

function pointToSegment(p, a, b) {
  const [px, py] = xy(p), [ax, ay] = xy(a), [bx, by] = xy(b);
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  const t = len2 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2)) : 0;
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/** Shortest distance in metres from a point [lat, lng] to a route [[lat, lng], ...]. */
export function pointToRoute(p, route) {
  if (route.length === 1) return pointToSegment(p, route[0], route[0]);
  let best = Infinity;
  for (let i = 1; i < route.length; i++) best = Math.min(best, pointToSegment(p, route[i - 1], route[i]));
  return best;
}

/** GeoJSON geometry ([lng, lat] order) to a list of [lat, lng] lines. */
export function geomLines(geom) {
  if (!geom) return [];
  const flip = (c) => [c[1], c[0]];
  switch (geom.type) {
    case 'Point': return [[flip(geom.coordinates)]];
    case 'MultiPoint': return geom.coordinates.map((c) => [flip(c)]);
    case 'LineString': return [geom.coordinates.map(flip)];
    case 'MultiLineString': return geom.coordinates.map((l) => l.map(flip));
    default: return [];
  }
}

/**
 * Distance in metres from a geometry to a route. For a street segment, it is
 * how far the segment's points get from the route, sampled every ~25 m, so a
 * closure on a street the route actually uses comes out near zero.
 */
export function geomToRoute(geom, route) {
  let best = Infinity;
  for (const line of geomLines(geom)) {
    for (let i = 0; i < line.length; i++) {
      best = Math.min(best, pointToRoute(line[i], route));
      if (i + 1 < line.length) {
        const [ax, ay] = xy(line[i]), [bx, by] = xy(line[i + 1]);
        const n = Math.floor(Math.hypot(bx - ax, by - ay) / 25);
        for (let k = 1; k < n; k++) {
          const t = k / n;
          best = Math.min(best, pointToRoute([line[i][0] + t * (line[i + 1][0] - line[i][0]), line[i][1] + t * (line[i + 1][1] - line[i][1])], route));
        }
      }
    }
  }
  return best;
}

/** True if a [lat, lng] is in the wider Bay Area (where this app can route). */
export const inBayArea = ([lat, lng]) => lat > 37.2 && lat < 38.3 && lng > -123.1 && lng < -121.6;
/** True if a [lat, lng] is roughly inside San Francisco. */
export const inSF = ([lat, lng]) => lat > 37.70 && lat < 37.84 && lng > -122.53 && lng < -122.35;
