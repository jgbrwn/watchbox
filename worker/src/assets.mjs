// Static assets bundled into the Worker (see vendor/README.md).
import HLS from '../vendor/hls-1.7.4.light.min.txt';

export function asset(name) {
  if (name === 'hls.js') return new Response(HLS, { headers: { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'private, max-age=604800' } });
  return null;
}
