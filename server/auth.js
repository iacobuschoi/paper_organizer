// 비밀번호 로그인 — 비밀번호는 scrypt 해시만 DATA_DIR/auth.json 에 둔다(저장소에는 없음).
// 세션: 무작위 32바이트 토큰을 쿠키로 주고, 서버에는 그 sha256 만 저장(30일).
// 실패 제한: IP 마다 15분에 5번, 전체로 1시간에 30번 틀리면 잠깐 잠금.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const COOKIE = 'po_session';
const SESSION_MS = 30 * 24 * 3600 * 1000;
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };
const PER_IP = { max: 5, windowMs: 15 * 60 * 1000, lockMs: 15 * 60 * 1000 };
const GLOBAL = { max: 30, windowMs: 60 * 60 * 1000, lockMs: 15 * 60 * 1000 };

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

// 사람이 폰에서도 칠 수 있는 강한 비밀번호: 헷갈리는 글자(0 O 1 l I) 빼고 20자 ≈ 103비트
export function generatePassword() {
  const abc = 'abcdefghijkmnpqrstuvwxyz23456789';
  const bytes = crypto.randomBytes(20);
  const chars = [...bytes].map((b) => abc[b % abc.length]);
  return [0, 5, 10, 15].map((i) => chars.slice(i, i + 5).join('')).join('-');
}

export function hashPassword(pw, salt = crypto.randomBytes(16)) {
  const hash = crypto.scryptSync(pw, salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p });
  return { algo: 'scrypt', ...SCRYPT, salt: salt.toString('hex'), hash: hash.toString('hex') };
}

export function setPassword(dataDir, pw) {
  if (!pw || pw.length < 12) throw new Error('비밀번호는 12자 이상이어야 해요');
  const file = path.join(dataDir, 'auth.json');
  fs.mkdirSync(dataDir, { recursive: true });
  // 비밀번호를 바꾸면 기존 로그인은 모두 끊는다
  const data = { password: hashPassword(pw), sessions: {} };
  fs.writeFileSync(file + '.tmp', JSON.stringify(data, null, 1), { mode: 0o600 });
  fs.renameSync(file + '.tmp', file);
}

export class Auth {
  constructor(dataDir, log = console) {
    this.file = path.join(dataDir, 'auth.json');
    this.log = log;
    this.fails = new Map(); // ip → { times: [], lockedUntil }
    this.globalFails = [];
    this.globalLockedUntil = 0;
    this.load();
  }

  // set-password 가 다른 프로세스에서 파일을 바꿨으면 다시 읽는다 (안 그러면 다음 저장 때 옛 비밀번호로 덮음)
  fresh() {
    let m = 0;
    try {
      m = fs.statSync(this.file).mtimeMs;
    } catch (e) {
      if (e.code !== 'ENOENT') this.log.error('[auth] auth.json stat 실패', e.message);
    }
    if (m !== this.mtime) this.load();
  }

  load() {
    try {
      this.mtime = fs.statSync(this.file).mtimeMs;
      this.data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch (e) {
      if (e.code !== 'ENOENT') this.log.error('[auth] auth.json 을 읽지 못함 — 모든 요청을 막음', e.message);
      this.data = null;
      this.mtime = 0;
    }
  }

  get configured() {
    return !!this.data?.password?.hash;
  }

  save() {
    fs.writeFileSync(this.file + '.tmp', JSON.stringify(this.data, null, 1), { mode: 0o600 });
    fs.renameSync(this.file + '.tmp', this.file);
    this.mtime = fs.statSync(this.file).mtimeMs;
  }

  checkPassword(pw) {
    const p = this.data?.password;
    if (!p || typeof pw !== 'string' || pw.length > 200) return false;
    const got = crypto.scryptSync(pw, Buffer.from(p.salt, 'hex'), p.keylen, { N: p.N, r: p.r, p: p.p });
    const want = Buffer.from(p.hash, 'hex');
    return got.length === want.length && crypto.timingSafeEqual(got, want);
  }

  // 잠겨 있으면 남은 초, 아니면 0
  lockedFor(ip, now = Date.now()) {
    const g = this.globalLockedUntil - now;
    const f = (this.fails.get(ip)?.lockedUntil || 0) - now;
    return Math.max(0, Math.ceil(Math.max(g, f) / 1000));
  }

  recordFail(ip, now = Date.now()) {
    const f = this.fails.get(ip) || { times: [], lockedUntil: 0 };
    f.times = f.times.filter((t) => now - t < PER_IP.windowMs);
    f.times.push(now);
    if (f.times.length >= PER_IP.max) {
      f.lockedUntil = now + PER_IP.lockMs;
      f.times = [];
      this.log.warn(`[auth] ${ip} 로그인 ${PER_IP.max}번 실패 — 15분 잠금`);
    }
    this.fails.set(ip, f);
    this.globalFails = this.globalFails.filter((t) => now - t < GLOBAL.windowMs);
    this.globalFails.push(now);
    if (this.globalFails.length >= GLOBAL.max) {
      this.globalLockedUntil = now + GLOBAL.lockMs;
      this.globalFails = [];
      this.log.warn(`[auth] 전체 로그인 실패 ${GLOBAL.max}번 — 모든 로그인 15분 잠금`);
    }
    if (this.fails.size > 5000) this.fails.clear(); // 메모리 보호
  }

  // 성공하면 쿠키에 넣을 토큰
  login(pw, ip) {
    this.fresh();
    if (!this.configured) return { ok: false, status: 503, error: '비밀번호가 아직 없어요 — 맥에서 npm run set-password 를 실행하세요' };
    const wait = this.lockedFor(ip);
    if (wait) return { ok: false, status: 429, error: `너무 많이 틀렸어요. ${Math.ceil(wait / 60)}분 뒤에 다시 해 보세요` };
    if (!this.checkPassword(pw)) {
      this.recordFail(ip);
      return { ok: false, status: 401, error: '비밀번호가 틀렸어요' };
    }
    this.fails.delete(ip);
    const token = crypto.randomBytes(32).toString('base64url');
    const now = Date.now();
    for (const [k, s] of Object.entries(this.data.sessions)) if (s.exp < now) delete this.data.sessions[k];
    this.data.sessions[sha(token)] = { exp: now + SESSION_MS, created: new Date(now).toISOString() };
    this.save();
    return { ok: true, token, maxAge: SESSION_MS / 1000 };
  }

  logout(token) {
    this.fresh();
    if (token && this.data?.sessions?.[sha(token)]) {
      delete this.data.sessions[sha(token)];
      this.save();
    }
  }

  valid(token) {
    if (!token) return false;
    this.fresh();
    if (!this.configured) return false;
    const s = this.data.sessions[sha(token)];
    return !!s && s.exp > Date.now();
  }
}

export function readCookie(req, name = COOKIE) {
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return '';
}

export function sessionCookie(token, maxAge) {
  return `${COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
}
export const clearCookie = () => `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;

// X-Forwarded-For 의 마지막 주소 = tailscale serve/funnel(역방향 프록시)이 덧붙인 실제 상대 주소.
// 앞쪽 주소는 요청자가 지어 넣을 수 있으므로 쓰지 않는다. 서버는 127.0.0.1 에만 떠 있다.
export function clientIp(req) {
  const xff = String(req.headers['x-forwarded-for'] || '').split(',').map((s) => s.trim()).filter(Boolean).pop();
  return xff || req.socket.remoteAddress || '?';
}
