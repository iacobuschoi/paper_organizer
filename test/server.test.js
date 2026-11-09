import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../server/app.js';
import { extractPdfInfo, firstAuthorFrom, yearFrom } from '../server/extract.js';
import { makePdf, samplePaper } from './makepdf.js';

const quiet = { info() {}, warn() {}, error: console.error };
let dir, server, base, store;

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'po-test-'));
  ({ server, store } = createApp({ dataDir: dir, log: quiet }));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => {
  server.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

const j = async (method, url, body) => {
  const r = await fetch(base + url, { method, headers: { 'content-type': 'application/json' }, body: body && JSON.stringify(body) });
  return { status: r.status, body: await r.json() };
};
const upload = async (buf, name = 'x.pdf', q = '') => {
  const r = await fetch(base + '/api/papers' + q, { method: 'POST', headers: { 'content-type': 'application/pdf', 'x-file-name': encodeURIComponent(name) }, body: buf });
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

  const pdf = await fetch(`${base}/api/papers/${a.body.paper.id}/pdf`, { headers: { range: 'bytes=0-4' } });
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
  const r = await fetch(base + '/api/papers', { method: 'POST', headers: { 'content-type': 'application/pdf' }, body: 'hello' });
  assert.equal(r.status, 415);
  assert.equal((await fetch(base + '/api/papers/../../etc/passwd/pdf')).status, 404);
  assert.equal((await fetch(base + '/api/papers/p-zzzz/pdf')).status, 404);
});

test('저장: db.json 이 망가졌으면 덮어쓰지 않고 멈춤', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'po-broken-'));
  fs.writeFileSync(path.join(d, 'db.json'), '{ not json');
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
