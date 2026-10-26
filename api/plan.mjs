// Vercel function: POST /api/plan { from, to, arriveBy, bufferMin } → when to leave.
import { plan } from '../lib/google.mjs';
import { post } from '../lib/post.mjs';

export const POST = (request) => post(request, (input, key) => plan(input, key));
