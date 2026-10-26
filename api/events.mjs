// Vercel function: GET /api/events?date=YYYY-MM-DD → the day's SF traffic-relevant events.
import { handle } from '../lib/events.mjs';

export async function GET(request) {
  const { status, headers, body } = await handle(new URL(request.url).searchParams);
  return Response.json(body, { status, headers });
}
