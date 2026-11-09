import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../server/app.js';
import { setPassword, generatePassword } from '../server/auth.js';
import { extractPdfInfo, firstAuthorFrom, yearFrom } from '../server/extract.js';
import { makePdf, samplePaper } from './makepdf.js';

const quiet = { info() {}, warn() {}, error: console.error };
let dir, server, base, store, cookie;
const PW = 'test-password-1234';

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'po-test-'));
  setPassword(dir, PW);
  ({ server, store } = createApp({ dataDir: dir, log: quiet }));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
  const r = await fetch(base + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: PW }) });
  assert.equal(r.status, 200);
  cookie = r.headers.get('set-cookie').split(';')[0];
});
after(() => {
  server.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

const j = async (method, url, body, headers = {}) => {
  const r = await fetch(base + url, { method, headers: { 'content-type': 'application/json', cookie, ...headers }, body: body && JSON.stringify(body) });
  return { status: r.status, body: await r.json() };
};
const upload = async (buf, name = 'x.pdf', q = '') => {
  const r = await fetch(base + '/api/papers' + q, { method: 'POST', headers: { 'content-type': 'application/pdf', 'x-file-name': encodeURIComponent(name), cookie }, body: buf });
  return { status: r.status, body: await r.json() };
};

test('주저자: 여러 모양의 저자 줄에서 첫 사람만', () => {
  assert.equal(firstAuthorFrom('Ashish Vaswani∗ Noam Shazeer∗ Niki Parmar∗'), 'Ashish Vaswani');
  assert.equal(firstAuthorFrom('Kaiming He, Xiangyu Zhang, Shaoqing Ren'), 'Kaiming He');
  assert.equal(firstAuthorFrom('J. Smith and K. Lee'), 'J. Smith');
  assert.equal(firstAuthorFrom('Jane Doe1,2, John Roe3'), 'Jane Doe');
  assert.equal(firstAuthorFrom('홍길동, 김철수'), '홍길동');
});

test('년도: arXiv 번호가 본문 년도보다 먼저', () => {
  assert.equal(yearFrom('arXiv:1706.03762v7 [cs.CL] 2 Aug 2023'), 2017);
  assert.equal(yearFrom('In CVPR 2016. Pages 1-9. 2016'), 2016);
  assert.equal(yearFrom('no year here 12345'), null);
  assert.equal(yearFrom('in 2999 we', 2026), null);
});

test('추출: 첫 페이지 글자 크기로 제목 · 저자 · 년도', async () => {
  const info = await extractPdfInfo(samplePaper('Contact Implicit Model Predictive Control', 'Jane Doe', 2024));
  assert.equal(info.title, 'Contact Implicit Model Predictive Control');
  assert.equal(info.author, 'Jane Doe');
  assert.equal(info.year, 2024);
  assert.deepEqual(info.warnings, []);
});

test('추출: 메타데이터 제목이 쓸 만하면 그것을, "Microsoft Word - x.docx" 같으면 무시', async () => {
  const good = await extractPdfInfo(makePdf({ lines: [{ text: 'small text', size: 9, y: 700 }], info: { Title: 'A Real Paper Title From Metadata', Author: 'Alice Kim; Bob Park', CreationDate: 'D:20190101' } }));
  assert.equal(good.title, 'A Real Paper Title From Metadata');
  assert.equal(good.author, 'Alice Kim');
  assert.equal(good.year, 2019);
  const junk = await extractPdfInfo(makePdf({ lines: [{ text: 'Learning To Walk', size: 18, y: 700 }, { text: 'Tom Lee and Ann Cho', size: 11, y: 670 }], info: { Title: 'Microsoft Word - draft3.docx' } }));
  assert.equal(junk.title, 'Learning To Walk');
  assert.equal(junk.author, 'Tom Lee');
});

test('추출 실패: 글자 없는 PDF 와 망가진 파일도 예외 없이 경고로', async () => {
  const blank = await extractPdfInfo(makePdf({ lines: [] }));
  assert.equal(blank.title, '');
  assert.ok(blank.warnings.some((w) => w.includes('제목')));
  const broken = await extractPdfInfo(Buffer.from('%PDF-1.4 garbage'));
  assert.ok(broken.warnings.length > 0);
});

test('API: 올리기 → 고치기 → 링크 → 지우기', async () => {
  const a = await upload(samplePaper('Paper Alpha Title', 'Ann Alpha', 2021), 'alpha.pdf');
  assert.equal(a.status, 201);
  assert.equal(a.body.paper.title, 'Paper Alpha Title');
  assert.equal(a.body.paper.needsReview, false);
  const again = await upload(samplePaper('Paper Alpha Title', 'Ann Alpha', 2021), 'alpha-copy.pdf');
  assert.equal(again.body.duplicate, true, '같은 파일은 두 번 들어가지 않음');

  // 새 PDF 를 기존 논문 위에 놓기 = linkTo
  const b = await upload(samplePaper('Paper Beta Title', 'Bo Beta', 2022), 'beta.pdf', `?linkTo=${a.body.paper.id}&x=300&y=200`);
  assert.equal(b.status, 201);
  assert.ok(b.body.link);
  let st = (await j('GET', '/api/state')).body;
  assert.equal(st.links.length, 1);
  assert.deepEqual(st.papers.find((p) => p.id === b.body.paper.id).pos, { x: 300, y: 200 });

  // 같은 쌍을 다시 이으면 새로 안 생김 (반대 방향도)
  const dup = await j('POST', '/api/links', { a: b.body.paper.id, b: a.body.paper.id });
  assert.equal(dup.body.existed, true);
  assert.equal((await j('POST', '/api/links', { a: a.body.paper.id, b: a.body.paper.id })).status, 400);

  const pdf = await fetch(`${base}/api/papers/${a.body.paper.id}/pdf`, { headers: { range: 'bytes=0-4', cookie } });
  assert.equal(pdf.status, 206);
  assert.equal(await pdf.text(), '%PDF-');

  const pt = await j('PATCH', `/api/papers/${a.body.paper.id}`, { note: '메모 — 한국어 ✓', year: '2020', title: '고친 제목' });
  assert.equal(pt.body.note, '메모 — 한국어 ✓');
  assert.equal(pt.body.year, 2020);

  assert.equal((await j('DELETE', `/api/papers/${b.body.paper.id}`)).status, 200);
  st = (await j('GET', '/api/state')).body;
  assert.equal(st.links.length, 0, '논문을 지우면 그 링크도 사라짐');
  assert.ok(fs.existsSync(path.join(dir, 'trash', b.body.paper.id + '.pdf')), 'PDF 는 trash 로');
});

test('API: 라벨 · 체크 · 그룹 만들고 붙이고 지우기, 그룹 순환 막기', async () => {
  const p = (await upload(samplePaper('Gamma Paper', 'Gil Gamma', 2023), 'g.pdf')).body.paper;
  const lb = (await j('POST', '/api/labels', { name: 'SLAM' })).body;
  const ck = (await j('POST', '/api/checks', { name: '구현해 볼 것', icon: '🧪' })).body;
  assert.equal((await j('POST', '/api/labels', { name: 'SLAM' })).status, 400, '같은 이름 막기');
  const g1 = (await j('POST', '/api/groups', { name: '졸업 논문' })).body;
  const g2 = (await j('POST', '/api/groups', { name: '보행', parentId: g1.id })).body;
  assert.equal(g2.parentId, g1.id);
  assert.equal((await j('PATCH', `/api/groups/${g1.id}`, { parentId: g2.id })).status, 400, '자기 아래로 옮기기 막기');

  const up = (await j('PATCH', `/api/papers/${p.id}`, { labels: [lb.id, 'lb-없는것'], checks: [ck.id], groupId: g2.id })).body;
  assert.deepEqual(up.labels, [lb.id]);
  assert.deepEqual(up.checks, [ck.id]);

  await j('DELETE', `/api/groups/${g2.id}`);
  await j('DELETE', `/api/labels/${lb.id}`);
  const st = (await j('GET', '/api/state')).body;
  const q = st.papers.find((x) => x.id === p.id);
  assert.equal(q.groupId, g1.id, '그룹을 지우면 논문은 위 그룹으로');
  assert.deepEqual(q.labels, []);
});

test('API: PDF 가 아닌 것 거절 · 이상한 경로 막기', async () => {
  const r = await fetch(base + '/api/papers', { method: 'POST', headers: { 'content-type': 'application/pdf', cookie }, body: 'hello' });
  assert.equal(r.status, 415);
  assert.equal((await fetch(base + '/api/papers/../../etc/passwd/pdf', { headers: { cookie } })).status, 404);
  assert.equal((await fetch(base + '/api/papers/p-zzzz/pdf', { headers: { cookie } })).status, 404);
});

test('저장: db.json 이 망가졌으면 덮어쓰지 않고 멈춤', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'po-broken-'));
  fs.writeFileSync(path.join(d, 'db.json'), '{ not json');
  setPassword(d, PW);
  assert.throws(() => createApp({ dataDir: d, log: quiet }), /db\.json/);
  assert.equal(fs.readFileSync(path.join(d, 'db.json'), 'utf8'), '{ not json');
  fs.rmSync(d, { recursive: true, force: true });
});

test('API: 고치기 값 다듬기 — 이상한 pos · 숫자 제목도 안전하게', async () => {
  const p = (await upload(samplePaper('Delta Paper', 'Dee Delta', 2018), 'd.pdf')).body.paper;
  const r = (await j('PATCH', `/api/papers/${p.id}`, { pos: { x: '12.4', y: -5, evil: 1 }, title: 42, note: null })).body;
  assert.deepEqual(r.pos, { x: 12, y: 0 });
  assert.equal(r.title, '42');
  assert.equal(r.note, '');
  assert.equal((await j('PATCH', `/api/papers/${p.id}`, { pos: 'nope' })).body.pos, null);
});

// ───────── 로그인 ─────────
const raw = (url, opts = {}) => fetch(base + url, { redirect: 'manual', ...opts });

test('로그인 없이: API · PDF · 화면은 막히고 로그인 화면만 열림', async () => {
  const id = (await j('GET', '/api/state')).body.papers[0].id;
  assert.equal((await raw('/api/state')).status, 401);
  assert.equal((await raw(`/api/papers/${id}/pdf`)).status, 401);
  assert.equal((await raw(`/api/papers/${id}`, { method: 'PATCH', body: '{}' })).status, 401);
  assert.equal((await raw(`/api/papers/${id}`, { method: 'DELETE' })).status, 401);
  assert.equal((await raw('/api/links', { method: 'POST', body: '{}' })).status, 401);
  assert.equal((await raw('/api/labels', { method: 'POST', body: '{}' })).status, 401);
  const up = await raw('/api/papers', { method: 'POST', headers: { 'content-type': 'application/pdf' }, body: samplePaper('Sneaky', 'X Y', 2020) });
  assert.equal(up.status, 401);
  assert.equal((await j('GET', '/api/state')).body.papers.some((p) => p.title === 'Sneaky'), false, '로그인 없이 올린 것은 저장 안 됨');
  for (const pth of ['/', '/index.html', '/app.js', '/util.js']) {
    const r = await raw(pth);
    assert.equal(r.status, 302, pth);
    assert.equal(r.headers.get('location'), '/login');
  }
  assert.equal((await raw('/vendor/pdfjs/legacy/build/pdf.min.mjs')).status, 401);
  for (const pth of ['/login', '/login.js', '/style.css', '/icon.svg']) assert.equal((await raw(pth)).status, 200, pth);
  assert.deepEqual(await (await raw('/api/health')).json(), { ok: true }, 'health 는 아무것도 드러내지 않음');
  assert.equal((await raw('/api/state', { headers: { cookie: 'po_session=made-up-token' } })).status, 401);
  assert.match((await raw('/login')).headers.get('content-security-policy'), /frame-ancestors 'none'/);
});

test('로그인: 쿠키는 HttpOnly · Secure · SameSite, 틀리면 401, 로그아웃하면 끊김', async () => {
  const bad = await raw('/api/login', { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': '10.0.0.1' }, body: JSON.stringify({ password: 'nope' }) });
  assert.equal(bad.status, 401);
  assert.equal(bad.headers.get('set-cookie'), null);
  const ok = await raw('/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: PW }) });
  const sc = ok.headers.get('set-cookie');
  assert.match(sc, /HttpOnly/);
  assert.match(sc, /Secure/);
  assert.match(sc, /SameSite=Lax/);
  const c = sc.split(';')[0];
  assert.equal((await raw('/api/state', { headers: { cookie: c } })).status, 200);
  await raw('/api/logout', { method: 'POST', headers: { cookie: c } });
  assert.equal((await raw('/api/state', { headers: { cookie: c } })).status, 401, '로그아웃한 쿠키는 못 씀');
  const db = fs.readFileSync(path.join(dir, 'auth.json'), 'utf8');
  assert.ok(!db.includes(PW), 'auth.json 에 비밀번호 원문 없음');
  assert.ok(!db.includes(cookie.split('=')[1]), 'auth.json 에 세션 토큰 원문 없음');
});

test('로그인 실패 제한: 한 주소에서 5번 틀리면 맞는 비밀번호도 잠시 거절', async () => {
  const h = { 'content-type': 'application/json', 'x-forwarded-for': '1.2.3.4, 203.0.113.9' };
  for (let i = 0; i < 5; i++) assert.equal((await raw('/api/login', { method: 'POST', headers: h, body: JSON.stringify({ password: 'wrong' + i }) })).status, 401);
  const locked = await raw('/api/login', { method: 'POST', headers: h, body: JSON.stringify({ password: PW }) });
  assert.equal(locked.status, 429);
  // 앞쪽 X-Forwarded-For 를 바꿔도(지어낸 주소) 마지막 주소(프록시가 붙인 것)로 묶임
  const spoof = await raw('/api/login', { method: 'POST', headers: { ...h, 'x-forwarded-for': '9.9.9.9, 203.0.113.9' }, body: JSON.stringify({ password: PW }) });
  assert.equal(spoof.status, 429);
  const other = await raw('/api/login', { method: 'POST', headers: { ...h, 'x-forwarded-for': '198.51.100.7' }, body: JSON.stringify({ password: PW }) });
  assert.equal(other.status, 200, '다른 주소는 그대로');
});

test('다른 사이트에서 온 쓰기 요청은 쿠키가 있어도 403', async () => {
  const r = await raw('/api/labels', { method: 'POST', headers: { 'content-type': 'application/json', cookie, origin: 'https://evil.example' }, body: JSON.stringify({ name: 'evil' }) });
  assert.equal(r.status, 403);
  const same = await raw('/api/labels', { method: 'POST', headers: { 'content-type': 'application/json', cookie, origin: base }, body: JSON.stringify({ name: 'same-origin' }) });
  assert.equal(same.status, 201);
});

test('비밀번호가 없으면 모두 막힘(열린 채로 뜨지 않음) · 다른 곳에서 바꾼 비밀번호는 바로 반영', async () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'po-nopw-'));
  const { server: s2 } = createApp({ dataDir: d, log: quiet });
  await new Promise((r) => s2.listen(0, '127.0.0.1', r));
  const b2 = `http://127.0.0.1:${s2.address().port}`;
  assert.equal((await fetch(b2 + '/api/state')).status, 401);
  const l = await fetch(b2 + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: '' }) });
  assert.equal(l.status, 503);
  const npw = generatePassword();
  assert.match(npw, /^[a-z2-9]{5}(-[a-z2-9]{5}){3}$/);
  setPassword(d, npw); // 서버가 돌고 있는 중에 바꿈
  const l2 = await fetch(b2 + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: npw }) });
  assert.equal(l2.status, 200);
  s2.close();
  fs.rmSync(d, { recursive: true, force: true });
  assert.throws(() => setPassword(dir, 'short'), /12자/);
});

test('정적 파일: gzip · ETag 304 · pdf.js 는 묵혀 둠', async () => {
  const r = await fetch(base + '/vendor/pdfjs/legacy/build/pdf.worker.min.mjs', { headers: { cookie, 'accept-encoding': 'gzip' } });
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('content-encoding'), 'gzip');
  assert.ok(Number(r.headers.get('content-length')) < 600000, '압축됨: ' + r.headers.get('content-length'));
  assert.match(r.headers.get('cache-control'), /max-age=86400/);
  assert.ok((await r.text()).length > 1000000, '풀면 원래 크기');
  const etag = (await fetch(base + '/app.js', { headers: { cookie } })).headers.get('etag');
  assert.equal((await fetch(base + '/app.js', { headers: { cookie, 'if-none-match': etag } })).status, 304);
  assert.equal((await fetch(base + '/app.js', { redirect: 'manual', headers: { 'if-none-match': etag } })).status, 302, 'ETag 가 있어도 로그인 먼저');
});
