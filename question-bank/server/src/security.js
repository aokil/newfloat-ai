import {randomBytes, scrypt as scryptCallback, timingSafeEqual, createHash, randomUUID} from 'node:crypto';
import {promisify} from 'node:util';
import {accountInfo} from './account.js';
const scrypt = promisify(scryptCallback);
export const sha256 = value => createHash('sha256').update(value).digest('hex');
export const id = prefix => `${prefix}_${randomUUID()}`;
export const ACCESS_MS = 15 * 60 * 1000;
export const REFRESH_MS = 30 * 24 * 60 * 60 * 1000;
export const OFFLINE_MS = 7 * 24 * 60 * 60 * 1000;
export class ApiError extends Error {
  constructor(statusCode, code, message, details) { super(message); Object.assign(this, {statusCode, code, details}); }
}
export function text(value, name, min = 1, max = 128) {
  if (typeof value !== 'string' || value.trim().length < min || value.length > max) throw new ApiError(400, 'INVALID_REQUEST', `${name}格式无效（${min}–${max}字符）`);
  return value;
}
export function fields(body, allowed) {
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(k => !allowed.includes(k)))
    throw new ApiError(400, 'INVALID_REQUEST', '请求含未支持字段');
}
export function credentials(body, register = false) {
  fields(body, register ? ['username','password','passwordConfirmation','verificationCode','challengeId','displayName','clientId'] : ['username','password','clientId']);
  const username = phoneNumber(body.username);
  if (!['web','android'].includes(body.clientId)) throw new ApiError(400, 'INVALID_REQUEST', 'clientId须为web或android');
  if (typeof body.password !== 'string' || body.password.length < (register ? 6 : 1) || body.password.length > (register ? 64 : 128))
    throw new ApiError(400, 'INVALID_REQUEST', '密码长度无效');
  if(register&&body.passwordConfirmation!==body.password)throw new ApiError(400,'INVALID_REQUEST','两次密码不一致');
  return {username, password: body.password, clientId: body.clientId, displayName: body.displayName === undefined ? username : text(body.displayName, '显示名', 1, 128)};
}
export function newPassword(value, confirmation, confirmationRequired = false) {
  if(typeof value!=='string'||value.length<6||value.length>64)throw new ApiError(400,'INVALID_REQUEST','新密码须为6–64字符');
  if(confirmationRequired&&confirmation!==value)throw new ApiError(400,'INVALID_REQUEST','两次密码不一致');
  return value;
}
let hashing = 0;
async function derive(password, salt) {
  if (hashing >= 2) throw new ApiError(429, 'RATE_LIMITED', '认证繁忙，请稍后重试');
  hashing++;
  try { return await scrypt(password, salt, 64, {N: 131072, r: 8, p: 1, maxmem: 192 * 1024 * 1024}); }
  finally { hashing--; }
}
export async function hashPassword(password) {
  const salt = randomBytes(16).toString('hex');
  return `scrypt$131072$8$1$${salt}$${(await derive(password, salt)).toString('hex')}`;
}
export async function verifyPassword(password, stored) {
  const parts = stored?.split('$');
  const salt = parts?.[4] || '00000000000000000000000000000000';
  const actual = await derive(password, salt);
  const expected = parts?.[5] ? Buffer.from(parts[5], 'hex') : Buffer.alloc(64);
  return actual.length === expected.length && timingSafeEqual(actual, expected) && !!stored;
}
export function phoneNumber(value) {
  if(typeof value!=='string')throw new ApiError(400,'INVALID_REQUEST','请输入手机号');
  const phone=value.startsWith('+86')?value.slice(3):value;
  if(!/^1[3-9]\d{9}$/u.test(phone))throw new ApiError(400,'INVALID_REQUEST','当前支持大陆11位手机号或+86格式');
  return `+86${phone}`;
}
export function safeUser(row) { return {userId: row.id, username: row.username, phoneNumber:row.phone_number,phoneVerified:!!row.phone_verified,displayName: row.display_name,avatarId:row.avatar_id??null, roles: row.role === 'admin' ? ['user','admin'] : ['user']}; }
export function issueSession(store, user, clientId, previous = null) {
  const accessToken = randomBytes(32).toString('base64url'); const refreshToken = randomBytes(48).toString('base64url');
  const now = Date.now(); const sessionId = previous?.id || id('s'); const expires = previous?.refresh_expires || now + REFRESH_MS;
  const accessExpires = Math.min(now + ACCESS_MS, expires);
  if (previous) store.run('UPDATE sessions SET access_hash=?,refresh_hash=?,access_expires=? WHERE id=?', sha256(accessToken), sha256(refreshToken), accessExpires, sessionId);
  else store.run('INSERT INTO sessions(id,user_id,family_id,client_id,access_hash,refresh_hash,access_expires,refresh_expires,created_at) VALUES(?,?,?,?,?,?,?,?,?)',
    sessionId, user.id, id('family'), clientId, sha256(accessToken), sha256(refreshToken), accessExpires, expires, now);
  return {principal: safeUser(user), account:accountInfo(store,user,expires),session: {sessionId, clientId}, tokenType: 'Bearer', accessToken, refreshToken,
    accessExpiresAt: new Date(accessExpires).toISOString(), refreshExpiresAt: new Date(expires).toISOString(),
    offlineUntil: new Date(Math.min(now + OFFLINE_MS, expires)).toISOString(), serverTime: new Date(now).toISOString()};
}
export function authenticate(store, request) {
  const header = request.headers.authorization;
  if (typeof header !== 'string' || !/^Bearer [A-Za-z0-9_-]{40,100}$/.test(header)) throw new ApiError(401, 'INVALID_CREDENTIALS', '请先登录');
  const tokenHash = sha256(header.slice(7));
  const session = store.get('SELECT s.*,u.username,u.role,u.disabled FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.access_hash=?', tokenHash);
  if (!session || session.revoked) throw new ApiError(401, 'SESSION_REVOKED', '登录已失效');
  if (session.disabled) throw new ApiError(403, 'ACCOUNT_DISABLED', '账号不可用');
  if (session.access_expires <= Date.now()) throw new ApiError(401, 'ACCESS_EXPIRED', '访问凭据已过期');
  return session;
}
