const jwksCache = new Map();

function decode(segment) {
  if (!/^[A-Za-z0-9_-]+$/.test(segment)) throw new Error('Invalid JWT encoding');
  const str = atob(segment.replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(str, ch => ch.charCodeAt(0));
}

// app 'admin': the owner-only Access app (ACCESS_AUD, emails in ADMIN_EMAIL_ALLOWLIST).
// app 'guest': the /me Access app (GUEST_ACCESS_AUD); any verified email, the caller checks it against users.
function config(env, app) {
  const issuer = String(env.ACCESS_TEAM_DOMAIN || '').replace(/\/$/, '');
  const audience = String((app === 'guest' ? env.GUEST_ACCESS_AUD : env.ACCESS_AUD) || '');
  const emails = app === 'guest' ? null : String(env.ADMIN_EMAIL_ALLOWLIST || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
  if (!/^https:\/\/[a-z0-9-]+\.cloudflareaccess\.com$/i.test(issuer) || !audience || audience.includes('REPLACE') ||
      (emails && (!emails.length || emails.some(s => !s.includes('@') || s.includes('replace'))))) throw new Error('Access not configured');
  return { issuer, audience, emails };
}

export async function verifyAccessJwt(token, env, { fetcher = fetch, now = Math.floor(Date.now() / 1000), cache = jwksCache, app = 'admin' } = {}) {
  const { issuer, audience, emails } = config(env, app);
  if (typeof token !== 'string' || token.length > 20000) throw new Error('Missing Access token');
  const segments = token.split('.');
  if (segments.length !== 3) throw new Error('Invalid JWT');
  const header = JSON.parse(new TextDecoder().decode(decode(segments[0])));
  const claims = JSON.parse(new TextDecoder().decode(decode(segments[1])));
  if (header.alg !== 'RS256' || typeof header.kid !== 'string' || header.kid.length > 200) throw new Error('Invalid JWT algorithm');
  if (header.crit || header.jku || header.jwk || header.x5u) throw new Error('Unsupported JWT header');
  const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (claims.iss !== issuer || !aud.includes(audience) || claims.type !== 'app' ||
      !Number.isFinite(claims.exp) || claims.exp <= now - 30 ||
      (claims.nbf !== undefined && (!Number.isFinite(claims.nbf) || claims.nbf > now + 30)) ||
      (claims.iat !== undefined && (!Number.isFinite(claims.iat) || claims.iat > now + 30))) throw new Error('Invalid JWT claims');
  const email = String(claims.email || '').toLowerCase();
  if (!email.includes('@') || (emails && !emails.includes(email))) throw new Error('Email not allowed');
  let entry = cache.get(issuer);
  if (!entry || entry.expires <= now || !entry.keys.some(k => k.kid === header.kid)) {
    // workerd does not implement redirect:'error'. Manual plus the success
    // check below rejects redirects without following an untrusted JWKS URL.
    const response = await fetcher(issuer + '/cdn-cgi/access/certs', { redirect: 'manual', signal: AbortSignal.timeout(10000) });
    if (!response.ok) throw new Error('Cannot verify Access key');
    const text = await response.text();
    if (text.length > 200000) throw new Error('Oversized JWKS');
    const doc = JSON.parse(text);
    if (!Array.isArray(doc.keys) || doc.keys.length > 30) throw new Error('Invalid JWKS');
    entry = { keys: doc.keys, expires: now + 3600 };
    cache.set(issuer, entry);
  }
  const jwk = entry.keys.find(k => k.kid === header.kid && k.kty === 'RSA' && (!k.alg || k.alg === 'RS256') && (!k.use || k.use === 'sig'));
  if (!jwk) throw new Error('Unknown Access key');
  const key = await crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
  const valid = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, decode(segments[2]), new TextEncoder().encode(segments[0] + '.' + segments[1]));
  if (!valid) throw new Error('Invalid JWT signature');
  return { email, subject: claims.sub, expiresAt: claims.exp };
}
