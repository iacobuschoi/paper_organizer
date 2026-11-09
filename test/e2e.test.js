// 실제 브라우저(Chromium)로 화면을 눌러 보는 시험. SHOTS=<폴더> 면 스크린샷을 남긴다.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { createApp } from '../server/app.js';
import { setPassword } from '../server/auth.js';
import { samplePaper, makePdf } from './makepdf.js';

const SHOTS = process.env.SHOTS;

let dir, server, base, browser, page, cookie = '';
const PW = 'e2e-password-5678';
const errors = [];

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'po-e2e-'));
  setPassword(dir, PW);
  ({ server } = createApp({ dataDir: dir, log: { info() {}, warn() {}, error: console.error } }));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch();
  page = await browser.newPage({ viewport: { width: 1280, height: 820 } });
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); if (process.env.DBG && m.text().startsWith('DBG')) console.log(m.text()); });
  page.on('pageerror', (e) => errors.push(String(e)));
  if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });
});
after(async () => {
  await browser?.close();
  server?.close();
  fs.rmSync(dir, { recursive: true, force: true });
});
const shot = (name, p = page) => SHOTS && p.screenshot({ path: path.join(SHOTS, name + '.png') });
const state = () => fetch(base + '/api/state', { headers: { cookie } }).then((r) => r.json());

// 파일 끌어다 놓기를 흉내: 브라우저 안에서 DataTransfer 를 만들어 dragenter → dragover → drop
async function dropFiles(files, x, y) {
  const payload = files.map((f) => ({ name: f.name, b64: f.buf.toString('base64') }));
  await page.evaluate(({ payload, x, y }) => {
    const dt = new DataTransfer();
    for (const f of payload) {
      const bin = Uint8Array.from(atob(f.b64), (c) => c.charCodeAt(0));
      dt.items.add(new File([bin], f.name, { type: 'application/pdf' }));
    }
    const target = document.elementFromPoint(x, y) || document.body;
    for (const type of ['dragenter', 'dragover', 'drop'])
      target.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, dataTransfer: dt }));
  }, { payload, x, y });
}
async function center(sel) {
  const b = await page.locator(sel).first().boundingBox();
  return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
}
async function dragMouse(from, to) {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  for (let i = 1; i <= 8; i++) await page.mouse.move(from.x + ((to.x - from.x) * i) / 8, from.y + ((to.y - from.y) * i) / 8);
  await page.mouse.up();
}
const card = (title) => `#board .paper:has(.ttl:text-is("${title}"))`;

test('로그인: 안 하면 로그인 화면으로, 틀리면 안내, 맞으면 들어감', async () => {
  await page.goto(base);
  await page.waitForURL(/\/login$/);
  await page.fill('#pw', 'wrong-password');
  await page.click('button[type=submit]');
  await page.waitForSelector('#msg:text("비밀번호가 틀렸어요")');
  // 일부러 틀린 비밀번호의 401 은 브라우저가 콘솔에 "Failed to load resource" 로 찍는다 — 이 한 건만 뺀다
  const i = errors.findIndex((e) => /401/.test(e));
  assert.ok(i >= 0);
  errors.splice(i, 1);
  await shot('00-login');
  await page.fill('#pw', PW);
  await page.click('button[type=submit]');
  await page.waitForURL(base + '/');
  const c = (await page.context().cookies()).find((x) => x.name === 'po_session');
  assert.ok(c, '세션 쿠키가 생김');
  assert.equal(c.httpOnly, true);
  cookie = `po_session=${c.value}`;
});

test('빈 화면 → PDF 끌어다 놓기 → 아이콘에 제목 · 저자 · 년도', async () => {
  await page.goto(base);
  await page.waitForSelector('#empty:not([hidden])');
  await shot('01-empty');
  await dropFiles([{ name: 'a.pdf', buf: samplePaper('Legged Locomotion With MPC', 'Jane Doe', 2024) }], 400, 300);
  await page.waitForSelector(card('Legged Locomotion With MPC'));
  assert.match(await page.locator(card('Legged Locomotion With MPC') + ' .meta').innerText(), /Jane Doe · 2024/);
  assert.equal(await page.isHidden('#empty'), true);
});

test('새 PDF 를 기존 논문 위에 놓으면 연결', async () => {
  const c = await center(card('Legged Locomotion With MPC'));
  await dropFiles([{ name: 'b.pdf', buf: samplePaper('Contact Implicit Planning', 'Kim Lee', 2023) }], c.x, c.y);
  await page.waitForSelector(card('Contact Implicit Planning'));
  const st = await state();
  assert.equal(st.links.length, 1);
  await page.waitForSelector('#board .board-links line');
});

test('제목을 못 읽은 PDF → ⚠ 표시 + 편집 팝업이 바로 열림 → 고치면 저장', async () => {
  await dropFiles([{ name: 'scan_2019.pdf', buf: makePdf({ lines: [] }) }], 900, 600);
  await page.waitForSelector('#popover.edit');
  await page.waitForSelector('#board .paper .warn');
  await shot('03-needs-review');
  const t = page.locator('#popover textarea.field.title');
  await t.fill('Scanned Old Paper');
  await page.locator('#popover input[aria-label="주저자"]').fill('Old Author');
  await page.locator('#popover input[aria-label="년도"]').fill('2019');
  await page.waitForFunction(() => document.querySelector('#popover .save-state')?.textContent.startsWith('저장됨'), null, { timeout: 5000 });
  const p = (await state()).papers.find((x) => x.fileName === 'scan_2019.pdf');
  assert.equal(p.title, 'Scanned Old Paper');
  assert.equal(p.author, 'Old Author');
  assert.equal(p.year, 2019);
  assert.equal(p.needsReview, false);
  await page.keyboard.press('Escape');
  await page.waitForSelector('#popover', { state: 'hidden' });
});

test('마우스 올리면 메모 미리보기, 누르면 커지며 편집 · 자동 저장', async () => {
  const sel = card('Legged Locomotion With MPC');
  await page.hover(sel);
  await page.waitForSelector('#popover.peek:not([hidden])');
  assert.match(await page.innerText('#popover'), /메모 없음/);
  // 팝업이 아이콘 옆에 뜸 (겹치지 않음)
  const cb = await page.locator(sel).boundingBox();
  const pb = await page.locator('#popover').boundingBox();
  assert.ok(pb.x >= cb.x + cb.width || pb.x + pb.width <= cb.x, '팝업이 아이콘 옆');
  await shot('04-peek');
  await page.click(sel);
  await page.waitForSelector('#popover.edit');
  await page.waitForTimeout(250);
  const pb2 = await page.locator('#popover').boundingBox();
  assert.ok(pb2.width > pb.width, '편집하면 팝업이 커짐');
  // 누르자마자 메모 칸에 바로 쓸 수 있음
  await page.keyboard.type('족 접촉 순서를 미리 정하지 않음. 한글 입력 ✓');
  await page.waitForFunction(() => document.querySelector('#popover .save-state')?.textContent.startsWith('저장됨'), null, { timeout: 5000 });
  const p = (await state()).papers.find((x) => x.title === 'Legged Locomotion With MPC');
  assert.equal(p.note, '족 접촉 순서를 미리 정하지 않음. 한글 입력 ✓');
  await shot('05-edit');
  await page.mouse.click(420, 790); // 바깥(빈 보드) 누르면 닫힘
  await page.waitForSelector('#popover', { state: 'hidden' });
  await page.hover(sel);
  await page.waitForSelector('#popover.peek:not([hidden])');
  assert.match(await page.innerText('#popover'), /족 접촉 순서/);
  await page.mouse.move(420, 790);
});

test('라벨 · 체크 메뉴 만들기 → 논문을 끌어다 붙이기 → 거르기', async () => {
  await page.click('[data-add="labels"]');
  await page.keyboard.type('로봇 보행');
  await page.keyboard.press('Enter');
  await page.waitForSelector('#labelList li:has-text("로봇 보행")');
  await page.click('[data-add="checks"]');
  await page.keyboard.type('🔥 꼭 읽기');
  await page.keyboard.press('Enter');
  await page.waitForSelector('#checkList li:has-text("꼭 읽기")');
  const st0 = await state();
  const ck = st0.checks.find((c) => c.name === '꼭 읽기');
  assert.equal(ck.icon, '🔥', '앞 이모지는 아이콘으로');

  await dragMouse(await center(card('Contact Implicit Planning')), await center('#labelList li:has-text("로봇 보행")'));
  await page.waitForTimeout(300);
  await dragMouse(await center(card('Contact Implicit Planning')), await center('#checkList li:has-text("꼭 읽기")'));
  await page.waitForTimeout(300);
  const p = (await state()).papers.find((x) => x.title === 'Contact Implicit Planning');
  assert.equal(p.labels.length, 1);
  assert.ok(p.checks.includes(ck.id));
  await page.waitForSelector(card('Contact Implicit Planning') + ' .badges span:text("🔥")');

  await page.click('#checkList li:has-text("꼭 읽기")');
  await page.waitForSelector('#filterBar:not([hidden])');
  assert.equal(await page.locator('#board .paper:not(.dim)').count(), 1);
  await shot('06-filter');
  await page.click('#filterBar button:text("모두 풀기")');
  assert.equal(await page.locator('#board .paper.dim').count(), 0);
});

test('논문을 다른 논문 위에 끌어다 놓으면 연결 · 되돌리기', async () => {
  const before = (await state()).links.length;
  const from = card('Scanned Old Paper');
  const startBox = await page.locator(from).boundingBox();
  await dragMouse(await center(from), await center(card('Contact Implicit Planning')));
  await page.waitForSelector('.toast:has-text("↔")');
  await page.waitForFunction((n) => fetch('/api/state').then((r) => r.json()).then((s) => s.links.length === n), before + 1);
  const endBox = await page.locator(from).boundingBox();
  assert.deepEqual([Math.round(endBox.x), Math.round(endBox.y)], [Math.round(startBox.x), Math.round(startBox.y)], '연결 뒤 아이콘은 제자리로');
  await page.click('.toast:has-text("↔") button');
  await page.waitForFunction((n) => fetch('/api/state').then((r) => r.json()).then((s) => s.links.length === n), before);
  // 다시 연결해 둠
  await dragMouse(await center(from), await center(card('Contact Implicit Planning')));
  await page.waitForTimeout(400);
  assert.equal((await state()).links.length, before + 1);
});

test('보드에서 빈 곳으로 끌면 자리 옮김(저장됨)', async () => {
  const sel = card('Legged Locomotion With MPC');
  const c = await center(sel);
  await dragMouse(c, { x: c.x + 160, y: c.y + 220 });
  await page.waitForTimeout(400);
  const p = (await state()).papers.find((x) => x.title === 'Legged Locomotion With MPC');
  assert.ok(p.pos.y > 200, '새 자리가 저장됨: ' + JSON.stringify(p.pos));
  await shot('07-board');
});

const Zs = () => page.evaluate(() => ({ ...window.__board }));
const idOf = async (title) => (await state()).papers.find((p) => p.title === title).id;
async function boardAt(bx, by) {
  // 보드 좌표 → 화면 좌표
  return page.evaluate(([bx, by]) => {
    const r = document.querySelector('#board').getBoundingClientRect();
    const Z = window.__board;
    return { x: r.left + Z.tx + bx * Z.k, y: r.top + Z.ty + by * Z.k };
  }, [bx, by]);
}

test('보드 확대: 휠은 커서 자리를 붙잡고 확대 · 핀치(ctrl+휠) · 트랙패드 쓸기는 이동 · 원래 크기', async () => {
  assert.equal(await page.innerText('#zoomPct'), '100%');
  const sel = card('Contact Implicit Planning');
  const c0 = await center(sel);
  await page.mouse.move(c0.x, c0.y);
  await page.mouse.wheel(0, -100); // 마우스 휠 한 칸
  await page.waitForTimeout(100);
  const z1 = await Zs();
  assert.ok(z1.k > 1.1, '확대됨 ' + z1.k);
  const c1 = await center(sel);
  assert.ok(Math.abs(c1.x - c0.x) < 2 && Math.abs(c1.y - c0.y) < 2, '커서 밑의 논문은 제자리 ' + JSON.stringify([c0, c1]));
  const box1 = await page.locator(sel).boundingBox();
  assert.ok(Math.abs(box1.width - 132 * z1.k) < 2, '아이콘도 같이 커짐');
  await page.keyboard.down('Control');
  await page.mouse.wheel(0, 30); // 트랙패드 핀치 = ctrl + 작은 휠
  await page.keyboard.up('Control');
  await page.waitForTimeout(100);
  const z2 = await Zs();
  assert.ok(z2.k < z1.k, '핀치로 축소 ' + z2.k);
  // 트랙패드 두 손가락 쓸기(소수 delta) = 이동, 배율은 그대로
  await page.evaluate(() => document.querySelector('#board').dispatchEvent(new WheelEvent('wheel', { deltaX: 15.5, deltaY: 7.25, clientX: 700, clientY: 400, bubbles: true, cancelable: true })));
  const z3 = await Zs();
  assert.equal(z3.k, z2.k);
  assert.ok(Math.abs(z3.tx - (z2.tx - 15.5)) < 0.01 && Math.abs(z3.ty - (z2.ty - 7.25)) < 0.01);
  assert.match(await page.innerText('#zoomPct'), /^\d+%$/);
  await page.click('#zoomReset');
  assert.equal(await page.innerText('#zoomPct'), '100%');
});

test('확대한 채로: 놓은 자리 · 옮긴 거리 · 논문 위 놓기(링크)가 맞음', async () => {
  // 2배로
  const r = await page.locator('#board').boundingBox();
  await page.mouse.move(r.x + 300, r.y + 200);
  for (let i = 0; i < 5 && (await Zs()).k < 1.9; i++) await page.mouse.wheel(0, -100);
  const z = await Zs();
  assert.ok(z.k > 1.4, '확대됨 ' + z.k);
  // 새 PDF 를 빈 곳에 놓기 → 저장된 자리 = 보드 좌표 - 아이콘 반
  const drop = { x: r.x + 560, y: r.y + 520 };
  await dropFiles([{ name: 'zoom.pdf', buf: samplePaper('Zoom Drop Paper', 'Zed Zoom', 2025) }], drop.x, drop.y);
  await page.waitForSelector(card('Zoom Drop Paper'));
  const want = { x: Math.round((drop.x - r.x - z.tx) / z.k - 66), y: Math.round((drop.y - r.y - z.ty) / z.k - 75) };
  const got = (await state()).papers.find((p) => p.title === 'Zoom Drop Paper').pos;
  assert.ok(Math.abs(got.x - want.x) <= 1 && Math.abs(got.y - want.y) <= 1, JSON.stringify({ got, want }));
  const c = await center(card('Zoom Drop Paper'));
  assert.ok(Math.abs(c.x - drop.x) < 3 && Math.abs(c.y - drop.y) < 3, '놓은 자리에 보임');
  // 빈 곳으로 화면에서 80px 끌면 보드에서는 80/k 만큼
  await dragMouse(c, { x: c.x + 80, y: c.y - 40 });
  await page.waitForTimeout(300);
  const moved = (await state()).papers.find((p) => p.title === 'Zoom Drop Paper').pos;
  assert.ok(Math.abs(moved.x - (got.x + 80 / z.k)) <= 1 && Math.abs(moved.y - (got.y - 40 / z.k)) <= 1, JSON.stringify({ moved, got, k: z.k }));
  // 확대한 채로 다른 논문 위에 놓으면 링크
  const before = (await state()).links.length;
  const target = card('Legged Locomotion With MPC');
  await page.click('#zoomFit');
  await dragMouse(await center(card('Zoom Drop Paper')), await center(target));
  await page.waitForFunction((n) => fetch('/api/state').then((r) => r.json()).then((s) => s.links.length === n), before + 1);
  await shot('07b-zoomed');
});

test('스페이스 + 끌기 = 화면 이동 (선택 상자 안 생김)', async () => {
  const z0 = await Zs();
  const r = await page.locator('#board').boundingBox();
  // 빈 곳 찾기: 오른쪽 위 끝
  const p0 = { x: r.x + r.width - 30, y: r.y + 30 };
  await page.keyboard.down('Space');
  await dragMouse(p0, { x: p0.x - 120, y: p0.y + 60 });
  await page.keyboard.up('Space');
  const z1 = await Zs();
  assert.ok(Math.abs(z1.tx - (z0.tx - 120)) < 1 && Math.abs(z1.ty - (z0.ty + 60)) < 1, JSON.stringify([z0, z1]));
  assert.equal(await page.locator('#board .paper.picked').count(), 0);
});

test('여러 개 선택: 사각형으로 고르고 같이 옮김 · 다른 논문 위에 놓아도 링크 안 만듦 · 시프트 클릭 · Esc', async () => {
  const A = await idOf('Legged Locomotion With MPC'), B = await idOf('Contact Implicit Planning'), C = await idOf('Scanned Old Paper'), D = await idOf('Zoom Drop Paper');
  // 자리를 정해 두고 1배 · 원점으로
  await fetch(base + '/api/papers/positions', { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ items: [
    { id: A, pos: { x: 100, y: 100 } }, { id: B, pos: { x: 300, y: 100 } }, { id: C, pos: { x: 100, y: 400 } }, { id: D, pos: { x: 520, y: 400 } }] }) });
  await page.evaluate(() => localStorage.setItem('po.boardZoom', JSON.stringify({ k: 1, tx: 0, ty: 0 })));
  await page.reload();
  await page.waitForSelector('#board .paper');
  const linksBefore = (await state()).links.length;

  await dragMouse(await boardAt(60, 60), await boardAt(470, 300));
  assert.equal(await page.locator('#board .paper.picked').count(), 2);
  await page.waitForSelector('#selInfo:not([hidden]):has-text("2편 선택")');
  await shot('07c-marquee');

  // A 를 C 위로 끌기 → A·B 가 같이 아래로 300, 링크는 그대로
  await dragMouse(await boardAt(166, 175), await boardAt(166, 475));
  await page.waitForTimeout(400);
  const st = await state();
  const pos = (id) => st.papers.find((p) => p.id === id).pos;
  assert.deepEqual(pos(A), { x: 100, y: 400 });
  assert.deepEqual(pos(B), { x: 300, y: 400 });
  assert.deepEqual(pos(C), { x: 100, y: 400 }, '놓인 자리의 논문은 그대로');
  assert.equal(st.links.length, linksBefore, '여러 개를 놓을 때는 링크 안 생김');
  assert.equal(await page.locator('#board .paper.picked').count(), 2, '옮긴 뒤에도 선택 유지');

  // 시프트 클릭으로 더하고 빼기
  await page.click(card('Zoom Drop Paper'), { modifiers: ['Shift'] });
  assert.equal(await page.locator('#board .paper.picked').count(), 3);
  assert.equal(await page.isHidden('#popover'), true, '시프트 클릭은 메모 팝업을 안 엶');
  await page.click(card('Zoom Drop Paper'), { modifiers: ['Meta'] });
  assert.equal(await page.locator('#board .paper.picked').count(), 2);

  // 여러 개를 라벨 위에 놓으면 모두에 붙음 (A 자리에는 C 가 겹쳐 위에 있으므로 B 를 잡음)
  await dragMouse(await boardAt(366, 475), await center('#labelList li:has-text("로봇 보행")'));
  await page.waitForTimeout(400);
  const st2 = await state();
  const lb = st2.labels.find((l) => l.name === '로봇 보행').id;
  assert.ok([A, B].every((id) => st2.papers.find((p) => p.id === id).labels.includes(lb)));
  assert.deepEqual(st2.papers.find((p) => p.id === A).pos, { x: 100, y: 400 }, '라벨에 놓으면 자리는 원래대로');

  await page.keyboard.press('Escape');
  assert.equal(await page.locator('#board .paper.picked').count(), 0);
  // 다시 고른 뒤 빈 곳 클릭 = 풀기
  await dragMouse(await boardAt(60, 360), await boardAt(470, 600));
  assert.ok((await page.locator('#board .paper.picked').count()) >= 2);
  const e = await boardAt(900, 120);
  await page.mouse.click(e.x, e.y);
  assert.equal(await page.locator('#board .paper.picked').count(), 0);
  // 하나만 끌어 다른 논문 위에 놓기는 여전히 링크
  await dragMouse(await boardAt(586, 475), await boardAt(366, 475));
  await page.waitForFunction((n) => fetch('/api/state').then((r) => r.json()).then((s) => s.links.length === n), linksBefore + 1);
});

test('폰: 두 손가락 핀치로 확대 · 한 손가락으로 이동', async () => {
  await page.evaluate(() => {
    const bd = document.querySelector('#board');
    const r = bd.getBoundingClientRect();
    const ev = (type, id, x, y) => bd.dispatchEvent(new PointerEvent(type, { pointerId: id, pointerType: 'touch', isPrimary: id === 11, clientX: r.left + x, clientY: r.top + y, bubbles: true, cancelable: true, button: 0, buttons: 1 }));
    window.__z0 = { ...window.__board };
    ev('pointerdown', 11, 700, 300);
    ev('pointerdown', 12, 800, 300);
    ev('pointermove', 12, 900, 300); // 손가락 사이 100 → 200
    ev('pointerup', 12, 900, 300);
    ev('pointerup', 11, 700, 300);
  });
  const [z0, z1] = await page.evaluate(() => [window.__z0, { ...window.__board }]);
  assert.ok(Math.abs(z1.k / z0.k - 2) < 0.05, `핀치 두 배: ${z0.k} → ${z1.k}`);
  await page.evaluate(() => {
    const bd = document.querySelector('#board');
    const r = bd.getBoundingClientRect();
    const ev = (type, x, y) => bd.dispatchEvent(new PointerEvent(type, { pointerId: 21, pointerType: 'touch', isPrimary: true, clientX: r.left + x, clientY: r.top + y, bubbles: true, cancelable: true, button: 0, buttons: 1 }));
    window.__z0 = { ...window.__board };
    ev('pointerdown', 900, 100);
    ev('pointermove', 850, 140);
    ev('pointerup', 850, 140);
  });
  const [a, b] = await page.evaluate(() => [window.__z0, { ...window.__board }]);
  assert.ok(Math.abs(b.tx - (a.tx - 50)) < 1 && Math.abs(b.ty - (a.ty + 40)) < 1, '한 손가락 = 이동');
  assert.equal(await page.locator('#board .paper.picked').count(), 0, '손가락 끌기는 선택 상자를 만들지 않음');
  await page.click('#zoomReset');
});

test('그룹 만들기 → 트리에서 끌어다 넣기 · 연결 가지 펼치기', async () => {
  await page.click('[data-add="groups"]');
  await page.keyboard.type('보행 제어');
  await page.keyboard.press('Enter');
  await page.waitForSelector('#groupList li:has-text("보행 제어")');
  await page.click('.views [data-view="tree"]');
  await page.waitForSelector('#tree .row[data-paper-id]');
  const row = (t) => `#tree .row[data-paper-id]:has(.t:text-is("${t}"))`;
  await dragMouse(await center(row('Legged Locomotion With MPC')), await center('#tree .row.group:has-text("보행 제어")'));
  await page.waitForSelector('#tree .row.group:has-text("보행 제어") + ul ' + row('Legged Locomotion With MPC').replace('#tree ', ''));
  // 연결된 논문이 가지로
  await page.locator(row('Legged Locomotion With MPC') + ' .caret').click();
  await page.waitForSelector(`${row('Legged Locomotion With MPC')} + ul .row:has-text("Contact Implicit Planning")`);
  // 하위 그룹: 그룹을 그룹 위에
  await page.click('[data-add="groups"]');
  await page.keyboard.type('MPC');
  await page.keyboard.press('Enter');
  await page.waitForSelector('#tree .row.group:has-text("MPC")');
  await dragMouse(await center('#tree .row.group:has(.t:text-is("MPC"))'), await center('#tree .row.group:has(.t:text-is("보행 제어"))'));
  await page.waitForFunction(() => fetch('/api/state').then((r) => r.json()).then((s) => s.groups.find((g) => g.name === 'MPC')?.parentId));
  await shot('08-tree');
});

test('그래프 보기: 노드 · 선 · 그룹 테두리, 노드끼리 놓으면 연결', async () => {
  await page.click('.views [data-view="graph"]');
  await page.waitForSelector('#graph .node');
  await page.waitForTimeout(1500);
  const st = await state();
  assert.equal(await page.locator('#graph .node').count(), st.papers.length);
  assert.equal(await page.locator('#graph line.edge').count(), st.links.length);
  assert.ok(await page.locator('#graph path.hull').count() >= 1);
  await shot('09-graph');
  // 아직 연결 안 된 쌍: Legged ↔ Scanned
  const n = (t) => `#graph .node:has(title:text-matches("^${t}"))`;
  const before = st.links.length;
  await page.click('#graphFit');
  await dragMouse(await center(n('Scanned Old Paper') + ' circle'), await center(n('Legged Locomotion') + ' circle'));
  await page.waitForTimeout(500);
  assert.equal((await state()).links.length, before + 1);
  await page.hover(n('Legged Locomotion') + ' circle');
  await page.waitForSelector('#popover.peek:not([hidden])');
});

test('PDF 열람: 쪽이 그려지고 옆 칸에서 메모 편집', async () => {
  await page.click('.views [data-view="board"]');
  await page.click(card('Contact Implicit Planning'));
  await page.waitForSelector('#popover.edit');
  await page.click('#popover button:text("PDF 보기")');
  await page.waitForSelector('#viewer .pages canvas', { timeout: 10000 });
  await page.locator('#viewer .side textarea.note').fill('열람하면서 쓴 메모');
  await page.waitForFunction(() => document.querySelector('#viewer .save-state')?.textContent.startsWith('저장됨'), null, { timeout: 5000 });
  await shot('10-viewer');
  await page.keyboard.press('Escape');
  await page.waitForSelector('#viewer', { state: 'hidden' });
  assert.equal((await state()).papers.find((x) => x.title === 'Contact Implicit Planning').note, '열람하면서 쓴 메모');
  const r = await fetch(base + '/api/papers/' + (await state()).papers[0].id + '/pdf', { headers: { cookie } });
  assert.equal(r.headers.get('content-type'), 'application/pdf');
});

test('다크 모드 · 좁은 화면에서도 글자가 보이고 오류 없음', async () => {
  const ctx = await browser.newContext({ colorScheme: 'dark', viewport: { width: 375, height: 700 }, storageState: await page.context().storageState() });
  const p2 = await ctx.newPage();
  const errs = [];
  p2.on('pageerror', (e) => errs.push(String(e)));
  await p2.goto(base);
  await p2.waitForSelector('#board .paper');
  const [fg, bg] = await p2.evaluate(() => {
    const el = document.querySelector('#board .paper .ttl');
    return [getComputedStyle(el).color, getComputedStyle(el.closest('.doc')).backgroundColor];
  });
  assert.notEqual(fg, bg);
  assert.match(fg, /rgb\(2[0-9]{2}/, '다크에서 글자가 밝음: ' + fg);
  await shot('11-dark-mobile', p2);
  await p2.click('#sidebarToggle');
  await p2.waitForSelector('#sidebar', { state: 'visible' });
  await shot('12-dark-mobile-menu', p2);
  await p2.click('.views [data-view="graph"]');
  await p2.waitForSelector('#graph .node');
  assert.deepEqual(errs, []);
  await ctx.close();
});

test('로그아웃하면 다시 로그인 화면', async () => {
  await page.click('#logout');
  await page.waitForURL(/\/login$/);
  await page.goto(base + '/');
  await page.waitForURL(/\/login$/);
  assert.equal((await fetch(base + '/api/state', { headers: { cookie } })).status, 401);
});

test('콘솔 오류 0', () => {
  assert.deepEqual(errors, []);
});
