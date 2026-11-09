// HTTP 서버 — 의존성 없이 node:http. 정적 파일(public/) + JSON API + PDF 보내기.
import http from 'node:http';
import fs from 'node:fs';
import zlib from 'node:zlib';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from './store.js';
import { extractPdfInfo } from './extract.js';
import { Auth, readCookie, sessionCookie, clearCookie, clientIp } from './auth.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC = path.join(ROOT, 'public');
const MAX_PDF = 200 * 1024 * 1024;
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

// 모든 응답에 붙는 보안 머리글. 인라인 style 속성을 쓰므로 style-src 에 'unsafe-inline'.
const SECURITY_HEADERS = {
  'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data: blob:; worker-src 'self' blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'x-frame-options': 'DENY',
};
// 로그인 없이 열리는 것: 로그인 화면과 그 화면이 쓰는 파일만
const PUBLIC_FILES = new Set(['/login', '/login.html', '/login.js', '/style.css', '/icon.svg']);

class HttpError extends Error {
  constructor(status, msg) {
    super(msg);
    this.status = status;
  }
}

function send(res, status, body, headers = {}) {
  const isBuf = Buffer.isBuffer(body);
  const data = isBuf || typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(status, {
    ...SECURITY_HEADERS,
    'content-type': isBuf ? 'application/octet-stream' : typeof body === 'string' ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    ...headers,
  });
  res.end(data);
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let n = 0;
    req.on('data', (c) => {
      n += c.length;
      if (n > limit) {
        reject(new HttpError(413, `파일이 너무 커요 (최대 ${Math.round(limit / 1048576)}MB)`));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function readJson(req) {
  const buf = await readBody(req, 2 * 1024 * 1024);
  if (!buf.length) return {};
  try {
    return JSON.parse(buf.toString('utf8'));
  } catch {
    throw new HttpError(400, 'JSON 형식이 아니에요');
  }
}

function serveStatic(req, res, urlPath) {
  let rel = decodeURIComponent(urlPath);
  if (rel === '/') rel = '/index.html';
  if (rel === '/login') rel = '/login.html';
  let file;
  if (rel.startsWith('/vendor/pdfjs/')) {
    file = path.join(ROOT, 'node_modules/pdfjs-dist', rel.slice('/vendor/pdfjs/'.length));
    if (!file.startsWith(path.join(ROOT, 'node_modules/pdfjs-dist') + path.sep)) return send(res, 404, '없음');
  } else {
    file = path.join(PUBLIC, rel);
    if (!file.startsWith(PUBLIC + path.sep)) return send(res, 404, '없음');
  }
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) return send(res, 404, '없음');
    const ext = path.extname(file);
    const etag = `"${st.size.toString(16)}-${Math.floor(st.mtimeMs).toString(16)}"`;
    // pdf.js 파일은 판이 바뀌면 경로도 같이 바뀌지 않으므로 하루만 묵힘. 앱 파일은 매번 ETag 로 확인.
    const headers = {
      ...SECURITY_HEADERS,
      'content-type': MIME[ext] || 'application/octet-stream',
      'cache-control': rel.startsWith('/vendor/') ? 'private, max-age=86400' : 'no-cache',
      etag,
      vary: 'Accept-Encoding',
    };
    if (req.headers['if-none-match'] === etag) {
      res.writeHead(304, headers);
      return res.end();
    }
    // 글자 파일은 gzip — Funnel 길은 느려서 pdf.js(약 1.5MB)를 그대로 보내면 열람기가 수십 초 걸림
    if (TEXT_EXT.has(ext) && /\bgzip\b/.test(String(req.headers['accept-encoding'] || ''))) {
      gzipCached(file, etag)
        .then((gz) => {
          res.writeHead(200, { ...headers, 'content-encoding': 'gzip', 'content-length': gz.length });
          res.end(req.method === 'HEAD' ? undefined : gz);
        })
        .catch((e) => {
          console.error('[static] gzip 실패', file, e.message);
          if (!res.headersSent) send(res, 500, '서버 오류');
        });
      return;
    }
    res.writeHead(200, { ...headers, 'content-length': st.size });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(file).pipe(res);
  });
}

const TEXT_EXT = new Set(['.html', '.js', '.mjs', '.css', '.svg', '.json']);
const gzCache = new Map(); // file → { etag, gz }
async function gzipCached(file, etag) {
  const c = gzCache.get(file);
  if (c && c.etag === etag) return c.gz;
  const gz = zlib.gzipSync(await fs.promises.readFile(file), { level: 9 });
  gzCache.set(file, { etag, gz });
  return gz;
}

function sendPdf(req, res, store, id) {
  const p = store.paper(id);
  if (!p) throw new HttpError(404, '없는 논문이에요');
  const file = store.pdfPath(id);
  const st = fs.statSync(file);
  const name = encodeURIComponent(p.fileName || id + '.pdf');
  const headers = {
    ...SECURITY_HEADERS,
    'content-type': 'application/pdf',
    'accept-ranges': 'bytes',
    'content-disposition': `inline; filename*=UTF-8''${name}`,
    'cache-control': 'private, max-age=3600',
  };
  const range = req.headers.range && req.headers.range.match(/^bytes=(\d*)-(\d*)$/);
  if (range) {
    const start = range[1] ? Number(range[1]) : st.size - Number(range[2]);
    const end = range[1] && range[2] ? Math.min(Number(range[2]), st.size - 1) : st.size - 1;
    if (start >= st.size || start < 0 || end < start) {
      res.writeHead(416, { 'content-range': `bytes */${st.size}` });
      return res.end();
    }
    res.writeHead(206, { ...headers, 'content-range': `bytes ${start}-${end}/${st.size}`, 'content-length': end - start + 1 });
    return fs.createReadStream(file, { start, end }).pipe(res);
  }
  res.writeHead(200, { ...headers, 'content-length': st.size });
  fs.createReadStream(file).pipe(res);
}

export function createApp({ dataDir, log = console }) {
  const store = new Store(dataDir);
  const auth = new Auth(dataDir, log);

  // 로그인 · 로그아웃 · 확인. 이것들 말고는 전부 세션 쿠키가 있어야 한다.
  async function authRoutes(req, res, url) {
    const p = url.pathname;
    if (p === '/api/health') return send(res, 200, { ok: true }), true;
    if (p === '/api/login' && req.method === 'POST') {
      const b = await readJson(req);
      const ip = clientIp(req);
      const r = auth.login(String(b.password || ''), ip);
      if (!r.ok) {
        log.warn(`[auth] 로그인 실패 ${ip} (${r.status})`);
        await new Promise((ok) => setTimeout(ok, 400)); // 무작정 대입을 느리게
        send(res, r.status, { error: r.error });
        return true;
      }
      log.info(`[auth] 로그인 ${ip}`);
      send(res, 200, { ok: true }, { 'set-cookie': sessionCookie(r.token, r.maxAge) });
      return true;
    }
    if (p === '/api/logout' && req.method === 'POST') {
      auth.logout(readCookie(req));
      send(res, 200, { ok: true }, { 'set-cookie': clearCookie() });
      return true;
    }
    if (p === '/api/me') return send(res, auth.valid(readCookie(req)) ? 200 : 401, { ok: auth.valid(readCookie(req)) }), true;
    return false;
  }

  // 다른 사이트에서 보낸 쓰기 요청 막기 (SameSite 쿠키 위에 한 겹 더)
  function sameOrigin(req) {
    const origin = req.headers.origin;
    if (!origin || req.method === 'GET' || req.method === 'HEAD') return true;
    try {
      const o = new URL(origin).host;
      const hosts = [req.headers['x-forwarded-host'], req.headers.host].filter(Boolean).flatMap((h) => String(h).split(',').map((x) => x.trim()));
      return hosts.includes(o);
    } catch {
      return false;
    }
  }

  async function api(req, res, url) {
    const parts = url.pathname.split('/').filter(Boolean).slice(1); // ['papers', id, ...]
    const m = req.method;
    const [res0, id, sub] = parts;

    if (res0 === 'state' && m === 'GET') return send(res, 200, store.db);

    if (res0 === 'papers') {
      if (!id && m === 'POST') {
        // 몸통 = PDF 그대로. 파일 이름은 x-file-name(URI 인코딩), 놓은 자리의 논문은 ?linkTo=
        const ct = String(req.headers['content-type'] || '');
        if (!/application\/pdf|octet-stream/.test(ct)) throw new HttpError(415, 'PDF 만 올릴 수 있어요');
        const buf = await readBody(req, MAX_PDF);
        if (buf.subarray(0, 1024).indexOf('%PDF-') < 0) throw new HttpError(415, 'PDF 파일이 아니에요');
        let fileName = 'paper.pdf';
        try {
          fileName = decodeURIComponent(String(req.headers['x-file-name'] || 'paper.pdf')).replace(/[\/\\]/g, '_').slice(0, 200);
        } catch {
          log.warn('[upload] 파일 이름 디코딩 실패 — 기본 이름 사용');
        }
        const info = await extractPdfInfo(buf);
        const { paper, duplicate } = store.addPaper(buf, info, fileName);
        if (!duplicate) {
          const pos = url.searchParams.get('x') && { x: Number(url.searchParams.get('x')), y: Number(url.searchParams.get('y')) };
          const groupId = url.searchParams.get('groupId');
          if (pos || groupId) store.updatePaper(paper.id, { ...(pos ? { pos } : {}), ...(groupId ? { groupId } : {}), needsReview: paper.needsReview });
        }
        let link = null;
        const linkTo = url.searchParams.get('linkTo');
        if (linkTo && linkTo !== paper.id) link = store.link(paper.id, linkTo).link;
        log.info(`[upload] ${fileName} → ${paper.id} ${duplicate ? '(이미 있음)' : ''} 경고 ${info.warnings.length}`);
        return send(res, duplicate ? 200 : 201, { paper, duplicate, link });
      }
      if (id && !sub && m === 'PATCH') {
        const p = store.updatePaper(id, await readJson(req));
        if (!p) throw new HttpError(404, '없는 논문이에요');
        return send(res, 200, p);
      }
      if (id && !sub && m === 'DELETE') {
        if (!store.deletePaper(id)) throw new HttpError(404, '없는 논문이에요');
        return send(res, 200, { ok: true });
      }
      if (id && sub === 'pdf' && m === 'GET') return sendPdf(req, res, store, id);
    }

    if (res0 === 'links') {
      if (!id && m === 'POST') {
        const b = await readJson(req);
        try {
          const r = store.link(b.a, b.b, b.note || '');
          return send(res, r.existed ? 200 : 201, r);
        } catch (e) {
          throw new HttpError(400, e.message);
        }
      }
      if (id && m === 'DELETE') {
        if (!store.unlink(id)) throw new HttpError(404, '없는 링크예요');
        return send(res, 200, { ok: true });
      }
    }

    if (['labels', 'checks', 'groups'].includes(res0)) {
      try {
        if (!id && m === 'POST') return send(res, 201, store.addItem(res0, await readJson(req)));
        if (id && m === 'PATCH') {
          const it = store.updateItem(res0, id, await readJson(req));
          if (!it) throw new HttpError(404, '없어요');
          return send(res, 200, it);
        }
        if (id && m === 'DELETE') {
          if (!store.deleteItem(res0, id)) throw new HttpError(404, '없어요');
          return send(res, 200, { ok: true });
        }
      } catch (e) {
        if (e instanceof HttpError) throw e;
        throw new HttpError(400, e.message);
      }
    }
    throw new HttpError(404, '없는 주소예요');
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    try {
      if (!sameOrigin(req)) {
        log.warn('[auth] 다른 출처의 쓰기 요청 막음', req.headers.origin, req.headers.host, req.headers['x-forwarded-host']);
        throw new HttpError(403, '다른 사이트에서 온 요청이에요');
      }
      if (await authRoutes(req, res, url)) return;
      if (!auth.valid(readCookie(req))) {
        if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/vendor/')) throw new HttpError(401, '로그인이 필요해요');
        if (!PUBLIC_FILES.has(url.pathname)) {
          res.writeHead(302, { ...SECURITY_HEADERS, location: '/login', 'cache-control': 'no-store' });
          return res.end();
        }
      }
      if (url.pathname.startsWith('/api/')) return await api(req, res, url);
      if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, '안 되는 요청이에요');
      return serveStatic(req, res, url.pathname);
    } catch (e) {
      const status = e.status || 500;
      if (status >= 500) log.error('[server]', req.method, url.pathname, e);
      if (!res.headersSent) send(res, status, { error: e.message || '서버 오류' });
      else res.destroy(e);
    }
  });
  return { server, store, auth };
}
