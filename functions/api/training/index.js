// /api/training — base route (redirect to sub-routes)
import { json } from '../_lib/auth.js';
export async function onRequest() {
  return json({ message: 'Training API — use /programs, /categories, /requests' });
}
