// Vercel function: POST /api/geocode { q } → matching Bay Area addresses.
import { geocode } from '../lib/google.mjs';
import { post } from '../lib/post.mjs';

export const POST = (request) => post(request, geocode);
