// HTTP 서버 — 의존성 없이 node:http. 정적 파일(public/) + JSON API + PDF 보내기.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from './store.js';
import { extractPdfInfo } from './extract.js';

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
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-cache' });
    fs.createReadStream(file).pipe(res);
  });
}

function sendPdf(req, res, store, id) {
  const p = store.paper(id);
  if (!p) throw new HttpError(404, '없는 논문이에요');
  const file = store.pdfPath(id);
  const st = fs.statSync(file);
  const name = encodeURIComponent(p.fileName || id + '.pdf');
  const headers = {
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

  async function api(req, res, url) {
    const parts = url.pathname.split('/').filter(Boolean).slice(1); // ['papers', id, ...]
    const m = req.method;
    const [res0, id, sub] = parts;

    if (res0 === 'health') return send(res, 200, { ok: true, papers: store.db.papers.length });
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
  return { server, store };
}
