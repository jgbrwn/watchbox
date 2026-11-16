// WebCrypto only: shared by the Worker and the explicit private seeding CLI.
export const PASSWORD_ITERATIONS = 100_000;
export const MIN_PASSWORD_LENGTH = 20;
export const MAX_PASSWORD_BYTES = 1024;
const encoder = new TextEncoder();
const hex = bytes => [...bytes].map(v => v.toString(16).padStart(2, '0')).join('');
const unhex = value => Uint8Array.from(value.match(/../g), v => parseInt(v, 16));
// Unknown users and damaged/legacy hashes still pay precisely the same PBKDF2 cost.
const DUMMY = `pbkdf2-sha256$100000$${'00'.repeat(16)}$${'00'.repeat(32)}`;

export function randomHex(bytes = 32) {
  return hex(crypto.getRandomValues(new Uint8Array(bytes)));
}

export function validateUsername(username) {
  return typeof username === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.@-]{0,63}$/.test(username);
}

export function validatePassword(password) {
  return typeof password === 'string' && [...password].length >= MIN_PASSWORD_LENGTH &&
    encoder.encode(password).byteLength <= MAX_PASSWORD_BYTES;
}

async function derive(password, salt) {
  const key = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({
    name: 'PBKDF2', hash: 'SHA-256', salt, iterations: PASSWORD_ITERATIONS
  }, key, 256));
}

export async function hashPassword(password) {
  if (!validatePassword(password)) throw new Error(`Password must have at least ${MIN_PASSWORD_LENGTH} characters and at most ${MAX_PASSWORD_BYTES} UTF-8 bytes`);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  return `pbkdf2-sha256$${PASSWORD_ITERATIONS}$${hex(salt)}$${hex(await derive(password, salt))}`;
}

export async function verifyPassword(password, stored) {
  const usablePassword = typeof password === 'string' && encoder.encode(password).byteLength <= MAX_PASSWORD_BYTES;
  const validHash = typeof stored === 'string' &&
    /^pbkdf2-sha256\$100000\$[a-f0-9]{32}\$[a-f0-9]{64}$/.test(stored);
  const [, , salt, digest] = (validHash ? stored : DUMMY).split('$');
  const actual = await derive(usablePassword ? password : '', unhex(salt));
  const expected = unhex(digest);
  let difference = 0;
  for (let i = 0; i < expected.length; i++) difference |= actual[i] ^ expected[i];
  return validHash && usablePassword && validatePassword(password) && difference === 0;
}
