// San Francisco time helpers. Everything the app shows is Pacific time, even
// if the phone is set to another zone.
export const TZ = 'America/Los_Angeles';

const parts = (date) => Object.fromEntries(
  new Intl.DateTimeFormat('en-US', { timeZone: TZ, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', weekday: 'short' })
    .formatToParts(date).map((p) => [p.type, p.value]),
);

/** 'YYYY-MM-DD' of a Date in San Francisco. */
export function sfDate(date = new Date()) {
  const p = parts(date);
  return `${p.year}-${p.month}-${p.day}`;
}

/** Day of week in San Francisco, 0 = Sunday. */
export function sfWeekday(date = new Date()) {
  return ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(parts(date).weekday);
}

/** The Date for a San Francisco wall-clock time: sfTime('2026-10-26', '15:00'). */
export function sfTime(day, hhmm) {
  const [y, m, d] = day.split('-').map(Number);
  const [hh, mm] = hhmm.split(':').map(Number);
  // Guess as if UTC, then correct by the zone offset at that moment (twice, for DST edges).
  let t = Date.UTC(y, m - 1, d, hh, mm);
  for (let i = 0; i < 2; i++) {
    const p = parts(new Date(t));
    const asUTC = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
    t += Date.UTC(y, m - 1, d, hh, mm) - asUTC;
  }
  return new Date(t);
}

/** Adds whole days to a 'YYYY-MM-DD'. */
export function addDays(day, n) {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

/** '2:31 PM' */
export const clock = (date) => new Intl.DateTimeFormat('en-US', { timeZone: TZ, hour: 'numeric', minute: '2-digit' }).format(date);
/** 'Mon, Oct 26' */
export const dayLabel = (day) => new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', weekday: 'short', month: 'short', day: 'numeric' }).format(new Date(day + 'T12:00:00Z'));
