// the storage host origin access: listing, byte-range reads, streaming URLs.

export function originUrl(env, root, path) {
  const base = env.ORIGIN_BASE_URL.replace(/\/?$/, '/');
  return base + 'src/' + encodeURIComponent(root) + '/' + path.split('/').map(encodeURIComponent).join('/');
}

export function originHeaders(env, extra = {}) {
  // the storage host's firewall rejects PHP requests without a User-Agent.
  return { Authorization: env.ORIGIN_AUTHORIZATION, 'Accept-Encoding': 'identity', 'User-Agent': 'watchbox/2.0', ...extra };
}

export async function fetchListing(env, fetchImpl = fetch) {
  const res = await fetchImpl(env.ORIGIN_BASE_URL.replace(/\/?$/, '/') + 'list.php', { headers: originHeaders(env) });
  if (!res.ok) throw new Error(`listing HTTP ${res.status}`);
  const data = await res.json();
  if (!data || !Array.isArray(data.files) || !data.roots) throw new Error('listing malformed');
  return data;
}

export function makeOrigin(env, fetchImpl = fetch) {
  return {
    reader(root, path, size) {
      const url = originUrl(env, root, path);
      return async (offset, length) => {
        if (size && offset >= size) return new Uint8Array(0);
        const end = size ? Math.min(offset + length, size) - 1 : offset + length - 1;
        const res = await fetchImpl(url, { headers: originHeaders(env, { Range: `bytes=${offset}-${end}` }) });
        if (res.status !== 206 && res.status !== 200) throw new Error(`origin HTTP ${res.status}`);
        if (res.status === 200 && offset > 0) { res.body?.cancel(); throw new Error('origin ignored Range'); }
        // Read at most `length` bytes even if the origin ignored the range.
        const out = new Uint8Array(end - offset + 1);
        let got = 0;
        const rd = res.body.getReader();
        while (got < out.length) {
          const { value, done } = await rd.read();
          if (done) break;
          const n = Math.min(value.length, out.length - got);
          out.set(value.subarray(0, n), got); got += n;
        }
        rd.cancel().catch(() => {});
        return out.subarray(0, got);
      };
    }
  };
}
