// 실제 브라우저(Chromium)로 화면을 눌러 보는 시험. SHOTS=<폴더> 면 스크린샷을 남긴다.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { createApp } from '../server/app.js';
import { samplePaper, makePdf } from './makepdf.js';

const SHOTS = process.env.SHOTS;

let dir, server, base, browser, page;
const errors = [];

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'po-e2e-'));
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
const state = () => fetch(base + '/api/state').then((r) => r.json());

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
  const r = await fetch(base + '/api/papers/' + (await state()).papers[0].id + '/pdf');
  assert.equal(r.headers.get('content-type'), 'application/pdf');
});

test('다크 모드 · 좁은 화면에서도 글자가 보이고 오류 없음', async () => {
  const ctx = await browser.newContext({ colorScheme: 'dark', viewport: { width: 375, height: 700 } });
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

test('콘솔 오류 0', () => {
  assert.deepEqual(errors, []);
});
