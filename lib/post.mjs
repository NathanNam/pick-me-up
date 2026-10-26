// Shared wrapper for the two POST functions that need the Google key: JSON in,
// JSON out, never cached, and errors reported without echoing the input.
export async function post(request, fn, env = process.env) {
  const key = env.GOOGLE_MAPS_API_KEY;
  if (!key) return Response.json({ error: "Travel times aren't set up yet (no Google Maps key)." }, { status: 503, headers: { 'Cache-Control': 'no-store' } });
  let input;
  try {
    const text = await request.text();
    if (text.length > 2000) throw new Error('too large');
    input = JSON.parse(text);
  } catch {
    return Response.json({ error: 'Send a small JSON body.' }, { status: 400, headers: { 'Cache-Control': 'no-store' } });
  }
  try {
    const { status, body } = await fn(input, key);
    return Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } });
  } catch (e) {
    console.error('google lookup failed:', e.message);
    return Response.json({ error: e.status === 422 ? e.message : "Couldn't reach Google Maps. Try again in a minute." }, { status: e.status || 502, headers: { 'Cache-Control': 'no-store' } });
  }
}
