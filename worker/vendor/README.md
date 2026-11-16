# Vendored

- `hls-1.7.4.light.min.txt`: hls.js 1.7.4 `dist/hls.light.min.js` (Apache-2.0, `hls.js-LICENSE.txt`), from the npm tarball
  checked against its registry integrity `sha512` before copying. Served by the Worker at `/me/assets/hls.js` and
  `/admin/assets/hls.js` for browser playback of converted streams (Chrome/Firefox; Safari plays HLS natively).
  The `.txt` extension makes Wrangler bundle it as a string. To upgrade: `npm pack hls.js@<v>`, compare
  `npm view hls.js@<v> dist.integrity` with the tarball's sha512, copy `dist/hls.light.min.js`.
