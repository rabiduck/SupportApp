const encoder = new TextEncoder();

function toHex(bytes) {
  return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function randomHex(bytes = 32) {
  const value = new Uint8Array(bytes);
  crypto.getRandomValues(value);
  return toHex(value);
}

async function sha256(value) {
  return toHex(await crypto.subtle.digest('SHA-256', encoder.encode(value)));
}

async function derivePassword(password, salt, iterations = 150000) {
  const key = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt: encoder.encode(salt), iterations, hash: 'SHA-256' }, key, 256);
  return toHex(bits);
}

export async function setLocalPassword(db, employeeId, password) {
  if (String(password || '').length < 10) throw new Error('Password must be at least 10 characters long.');
  const salt = randomHex(16);
  const iterations = 150000;
  const passwordHash = await derivePassword(password, salt, iterations);
  await db.prepare(`INSERT INTO employee_credentials (employee_id,password_hash,password_salt,password_iterations,updated_at)
    VALUES (?,?,?,?,CURRENT_TIMESTAMP)
    ON CONFLICT(employee_id) DO UPDATE SET password_hash=excluded.password_hash,password_salt=excluded.password_salt,password_iterations=excluded.password_iterations,updated_at=CURRENT_TIMESTAMP`)
    .bind(employeeId, passwordHash, salt, iterations).run();
  await db.prepare('DELETE FROM auth_sessions WHERE employee_id=?').bind(employeeId).run();
}

export async function verifyLocalPassword(db, employeeId, password) {
  const credential = await db.prepare('SELECT password_hash,password_salt,password_iterations FROM employee_credentials WHERE employee_id=?').bind(employeeId).first();
  if (!credential) return false;
  const candidate = await derivePassword(password, credential.password_salt, Number(credential.password_iterations) || 150000);
  return candidate === credential.password_hash;
}

function cookieValue(request, name) {
  const cookie = request.headers.get('Cookie') || '';
  for (const part of cookie.split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return rest.join('=');
  }
  return null;
}

export async function authenticateLocal(request, env = {}) {
  if (!env.DB) return { authenticated: false, source: 'local', reason: 'Local authentication requires the DB binding.' };
  const token = cookieValue(request, 'supportapp_session');
  if (!token) return { authenticated: false, source: 'local', reason: 'Please sign in.' };
  const tokenHash = await sha256(token);
  const session = await env.DB.prepare(`SELECT s.employee_id,e.username,e.email,e.display_name
    FROM auth_sessions s JOIN employees e ON e.id=s.employee_id
    WHERE s.token_hash=? AND s.expires_at>CURRENT_TIMESTAMP AND e.is_active=1`).bind(tokenHash).first();
  if (!session) return { authenticated: false, source: 'local', reason: 'Your session has expired. Please sign in again.' };
  await env.DB.prepare('UPDATE auth_sessions SET last_seen_at=CURRENT_TIMESTAMP WHERE token_hash=?').bind(tokenHash).run();
  return { authenticated: true, source: 'local', employeeId: session.employee_id, username: session.username, email: session.email, displayName: session.display_name };
}

export async function createLocalSession(db, employeeId) {
  const token = randomHex(32);
  const tokenHash = await sha256(token);
  await db.prepare("DELETE FROM auth_sessions WHERE expires_at<=CURRENT_TIMESTAMP").run();
  await db.prepare("INSERT INTO auth_sessions (token_hash,employee_id,expires_at) VALUES (?,?,datetime('now','+12 hours'))").bind(tokenHash, employeeId).run();
  return token;
}

export async function destroyLocalSession(request, db) {
  const token = cookieValue(request, 'supportapp_session');
  if (token) await db.prepare('DELETE FROM auth_sessions WHERE token_hash=?').bind(await sha256(token)).run();
}

export function sessionCookie(token) {
  return `supportapp_session=${token}; Path=/; Max-Age=43200; HttpOnly; Secure; SameSite=Lax`;
}

export function clearSessionCookie() {
  return 'supportapp_session=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax';
}
