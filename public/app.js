// 논문 정리 — 화면 전부. 빌드 없음, 의존성은 PDF 열람용 pdf.js 하나(서버가 node_modules 에서 내줌).
import { h, debounce, clamp, fmtTime } from './util.js';

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const COLORS = ['#e5484d', '#f76b15', '#ffc53d', '#46a758', '#12a594', '#0090ff', '#6e56cf', '#d6409f', '#8d8d8d'];
const CARD_W = 132, CARD_H = 150;

const S = {
  db: { papers: [], links: [], labels: [], checks: [], groups: [] },
  view: localStorage.getItem('po.view') || 'board',
  f: { checks: new Set(), labels: new Set(), group: undefined, q: '' },
  graphPos: new Map(),
  treeOpen: new Set(JSON.parse(localStorage.getItem('po.treeOpen') || '[]')),
};
const byId = (id) => S.db.papers.find((p) => p.id === id);
const linksOf = (id) => S.db.links.filter((l) => l.a === id || l.b === id);
const otherEnd = (l, id) => (l.a === id ? l.b : l.a);
const label = (id) => S.db.labels.find((x) => x.id === id);
const check = (id) => S.db.checks.find((x) => x.id === id);
const group = (id) => S.db.groups.find((x) => x.id === id);
const group_ = group;
const short = (s, n = 40) => (s && s.length > n ? s.slice(0, n - 1) + '…' : s || '');
const metaLine = (p) => [p.author || '저자 모름', p.year || '년도 모름'].join(' · ');

// ───────────────────────── 서버 ─────────────────────────
async function api(method, url, body, opts = {}) {
  let res;
  try {
    res = await fetch(url, {
      method,
      headers: body instanceof Blob || body instanceof ArrayBuffer ? opts.headers : { 'content-type': 'application/json', ...(opts.headers || {}) },
      body: body === undefined ? undefined : body instanceof Blob || body instanceof ArrayBuffer ? body : JSON.stringify(body),
      keepalive: opts.keepalive,
    });
  } catch (e) {
    $('#offline').hidden = false;
    throw new Error('서버에 닿지 않아요');
  }
  $('#offline').hidden = true;
  if (res.status === 401) {
    location.href = '/login'; // 로그인이 끝났거나 풀림
    throw new Error('로그인이 필요해요');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `서버 오류 (${res.status})`);
  return data;
}

async function load() {
  S.db = await api('GET', '/api/state');
  render();
}

// ───────────────────────── 알림 ─────────────────────────
function toast(msg, { err = false, action, onAction, ms = 4200 } = {}) {
  const t = h('div', { class: 'toast' + (err ? ' err' : '') }, msg);
  const box = $('#toasts');
  while (box.children.length >= 3) box.firstElementChild.remove(); // 쌓여서 화면을 가리지 않게
  if (action) t.append(h('button', { onclick: () => { onAction(); t.remove(); } }, action));
  box.append(t);
  setTimeout(() => t.remove(), ms);
}
const fail = (e) => toast(e.message || String(e), { err: true });

// ───────────────────────── 거르기 ─────────────────────────
function matches(p) {
  const f = S.f;
  for (const c of f.checks) if (!p.checks.includes(c)) return false;
  for (const l of f.labels) if (!p.labels.includes(l)) return false;
  if (f.group !== undefined) {
    if (f.group === null ? p.groupId : !inGroupTree(p.groupId, f.group)) return false;
  }
  if (f.q) {
    const q = f.q.toLowerCase();
    const hay = [p.title, p.author, p.year, p.note, p.fileName, ...p.labels.map((l) => label(l)?.name)].join(' ').toLowerCase();
    if (!q.split(/\s+/).every((w) => hay.includes(w))) return false;
  }
  return true;
}
function inGroupTree(gid, root) {
  for (let cur = gid; cur; cur = group(cur)?.parentId) if (cur === root) return true;
  return false;
}
const filtering = () => S.f.checks.size || S.f.labels.size || S.f.group !== undefined || S.f.q;

function renderFilterBar() {
  const bar = $('#filterBar');
  bar.replaceChildren();
  if (!filtering()) return (bar.hidden = true);
  bar.hidden = false;
  const n = S.db.papers.filter(matches).length;
  bar.append(h('span', {}, `${n}편 보임`));
  for (const c of S.f.checks) bar.append(chip(`${check(c)?.icon} ${check(c)?.name}`, () => { S.f.checks.delete(c); render(); }));
  for (const l of S.f.labels) bar.append(chip(label(l)?.name, () => { S.f.labels.delete(l); render(); }, label(l)?.color));
  if (S.f.group !== undefined) bar.append(chip(S.f.group === null ? '그룹 없음' : group(S.f.group)?.name, () => { S.f.group = undefined; render(); }));
  if (S.f.q) bar.append(chip(`"${S.f.q}"`, () => { S.f.q = ''; $('#search').value = ''; render(); }));
  bar.append(h('button', { class: 'btn', onclick: () => { S.f = { checks: new Set(), labels: new Set(), group: undefined, q: '' }; $('#search').value = ''; render(); } }, '모두 풀기'));
}
function chip(text, onX, color) {
  return h('span', { class: 'chip on', onclick: onX, title: '풀기' }, color ? h('i', { class: 'dot', style: `background:${color}` }) : null, text, h('span', { class: 'x' }, '×'));
}

// ───────────────────────── 옆 메뉴 ─────────────────────────
function renderSidebar() {
  const counts = (fn) => S.db.papers.filter(fn).length;
  const cl = $('#checkList');
  cl.replaceChildren(
    ...S.db.checks.map((c) =>
      facetItem({ kind: 'checks', item: c, on: S.f.checks.has(c.id), lead: h('span', { style: 'width:18px;text-align:center' }, c.icon),
        count: counts((p) => p.checks.includes(c.id)), toggle: () => toggleSet(S.f.checks, c.id) }),
    ),
  );
  if (!S.db.checks.length) cl.append(h('li', { class: 'hint' }, '＋ 로 "봐야 할 논문" 같은 체크 메뉴를 만들어요'));
  const ll = $('#labelList');
  ll.replaceChildren(
    ...S.db.labels.map((l) =>
      facetItem({ kind: 'labels', item: l, on: S.f.labels.has(l.id), lead: h('i', { class: 'dot', style: `background:${l.color}` }),
        count: counts((p) => p.labels.includes(l.id)), toggle: () => toggleSet(S.f.labels, l.id) }),
    ),
  );
  if (!S.db.labels.length) ll.append(h('li', { class: 'hint' }, '＋ 로 "SLAM", "강화학습" 같은 주제 라벨을 만들어요'));
  const gl = $('#groupList');
  gl.replaceChildren();
  const walk = (parent, depth) => {
    for (const g of S.db.groups.filter((x) => (x.parentId || null) === parent)) {
      gl.append(facetItem({ kind: 'groups', item: g, on: S.f.group === g.id, depth, lead: h('i', { class: 'dot', style: `background:${g.color};border-radius:3px` }),
        count: counts((p) => inGroupTree(p.groupId, g.id)), toggle: () => { S.f.group = S.f.group === g.id ? undefined : g.id; } }));
      walk(g.id, depth + 1);
    }
  };
  walk(null, 0);
  gl.append(facetItem({ kind: 'groups', item: { id: '', name: '그룹 없음' }, on: S.f.group === null, fixed: true, lead: h('i', { class: 'dot', style: 'border:1.5px dashed var(--muted)' }),
    count: counts((p) => !p.groupId), toggle: () => { S.f.group = S.f.group === null ? undefined : null; } }));
}
function toggleSet(set, v) { set.has(v) ? set.delete(v) : set.add(v); }

function facetItem({ kind, item, on, lead, count, toggle, depth = 0, fixed = false }) {
  const li = h('li', { class: on ? 'on' : '', tabindex: 0, style: depth ? `padding-left:${6 + depth * 16}px` : '' },
    lead, h('span', { class: 'name' }, item.name), h('span', { class: 'count' }, String(count)));
  li.dataset[{ checks: 'checkDrop', labels: 'labelDrop', groups: 'groupDrop' }[kind]] = item.id;
  li.onclick = (e) => { if (e.target.closest('.more,input')) return; toggle(); render(); };
  li.onkeydown = (e) => { if (e.key === 'Enter' && e.target === li) { toggle(); render(); } };
  if (!fixed) li.append(h('button', { class: 'more', title: '고치기', onclick: (e) => { e.stopPropagation(); itemMenu(kind, item, li); } }, '⋯'));
  return li;
}

function itemMenu(kind, item, li) {
  const pop = $('#popover');
  closePopover(true);
  const close = () => { pop.hidden = true; pop.replaceChildren(); };
  const btns = [
    h('button', { class: 'btn', onclick: () => { close(); renameInline(kind, item, li); } }, '이름 바꾸기'),
  ];
  if (kind !== 'checks') {
    btns.push(h('div', { class: 'chips' }, ...COLORS.map((c) => h('button', { class: 'dot', title: c, style: `width:22px;height:22px;border:${c === item.color ? '2px solid var(--text)' : '0'};background:${c};cursor:pointer`,
      onclick: () => { close(); patchItem(kind, item.id, { color: c }); } }))));
  } else {
    btns.push(h('div', { class: 'chips' }, ...['📌', '✅', '🛠', '⭐', '🔥', '📖', '🧪', '❓', '💡', '📝'].map((ic) => h('button', { class: 'chip', onclick: () => { close(); patchItem(kind, item.id, { icon: ic }); } }, ic))));
  }
  if (kind === 'groups') {
    btns.push(h('button', { class: 'btn', onclick: () => { close(); addInline('groups', item.id); } }, '안에 그룹 만들기'));
    if (item.parentId) btns.push(h('button', { class: 'btn', onclick: () => { close(); patchItem('groups', item.id, { parentId: null }); } }, '맨 위로 꺼내기'));
  }
  const what = { checks: '체크 메뉴', labels: '라벨', groups: '그룹' }[kind];
  btns.push(h('button', { class: 'btn danger', onclick: async () => {
    close();
    if (!confirm(`${what} 「${item.name}」을(를) 지울까요?` + (kind === 'groups' ? '\n안의 논문과 하위 그룹은 위 그룹으로 올라가요.' : '\n논문은 그대로 있고 표시만 빠져요.'))) return;
    try { await api('DELETE', `/api/${kind}/${item.id}`); if (kind === 'checks') S.f.checks.delete(item.id); if (kind === 'labels') S.f.labels.delete(item.id); if (S.f.group === item.id) S.f.group = undefined; await load(); } catch (e) { fail(e); }
  } }, '지우기'));
  pop.className = 'popover edit';
  pop.style.width = '240px';
  pop.replaceChildren(h('div', { class: 'ph' }, item.name), h('div', { style: 'display:flex;flex-direction:column;gap:6px' }, ...btns));
  pop.hidden = false;
  placeBeside(pop, li.getBoundingClientRect());
  pop._owner = 'menu';
}

async function patchItem(kind, id, patch) {
  try { await api('PATCH', `/api/${kind}/${id}`, patch); await load(); } catch (e) { fail(e); }
}

function renameInline(kind, item, li) {
  const name = $('.name', li);
  const inp = h('input', { class: 'rename', value: item.name });
  name.replaceWith(inp);
  inp.focus();
  inp.select();
  let done = false;
  const finish = async (ok) => {
    if (done) return;
    done = true;
    if (ok && inp.value.trim() && inp.value.trim() !== item.name) await patchItem(kind, item.id, { name: inp.value.trim() });
    else renderSidebar();
  };
  inp.onkeydown = (e) => { if (e.key === 'Enter') finish(true); if (e.key === 'Escape') finish(false); };
  inp.onblur = () => finish(true);
}

function addInline(kind, parentId = null) {
  const list = { checks: '#checkList', labels: '#labelList', groups: '#groupList' }[kind];
  const ph = { checks: '예: 🔥 꼭 읽기 (앞에 이모지를 쓰면 아이콘)', labels: '예: SLAM', groups: parentId ? `「${group(parentId)?.name}」 안에 만들 그룹` : '예: 졸업 논문' }[kind];
  const inp = h('input', { class: 'rename', placeholder: ph });
  const li = h('li', {}, inp);
  $(list).append(li);
  inp.focus();
  let done = false;
  const finish = async (ok) => {
    if (done) return;
    done = true;
    let name = inp.value.trim();
    if (!ok || !name) return renderSidebar();
    const body = { name };
    if (kind === 'checks') {
      const m = name.match(/^(\p{Extended_Pictographic}️?|\p{So})\s*(.+)$/u);
      if (m) { body.icon = m[1]; body.name = m[2]; }
    }
    if (kind === 'groups' && parentId) body.parentId = parentId;
    try { await api('POST', `/api/${kind}`, body); await load(); } catch (e) { fail(e); renderSidebar(); }
  };
  inp.onkeydown = (e) => { if (e.key === 'Enter') finish(true); if (e.key === 'Escape') finish(false); };
  inp.onblur = () => finish(true);
}

// ───────────────────────── 논문 아이콘 ─────────────────────────
function paperCard(p) {
  const colors = p.labels.map((l) => label(l)?.color).filter(Boolean);
  const g = group(p.groupId);
  const el = h('div', { class: 'paper', tabindex: 0, 'aria-label': `${p.title} — ${metaLine(p)}` },
    h('div', { class: 'doc' },
      h('div', { class: 'band' }, ...(colors.length ? colors : [g ? g.color : 'transparent']).map((c) => h('span', { style: `background:${c}` }))),
      p.needsReview ? h('span', { class: 'warn', title: '자동으로 읽은 값이 비었거나 불확실해요 — 눌러서 확인' }, '⚠ 확인') : null,
      h('div', { class: 'ttl' }, p.title || '(제목 없음)'),
      h('div', { class: 'meta' }, metaLine(p))),
    h('div', { class: 'badges' }, ...p.checks.map((c) => h('span', { title: check(c)?.name }, check(c)?.icon || ''))));
  el.dataset.paperId = p.id;
  return el;
}

// ───────────────────────── 끌기 (모든 보기 공통) ─────────────────────────
// 논문을 논문 위에 놓기 = 연결 · 그룹 위 = 그룹 넣기 · 라벨/체크 위 = 붙이기 · 빈 곳 = (보드) 자리 옮기기
function dropTargetAt(x, y, selfId) {
  const el = document.elementFromPoint(x, y);
  if (!el) return null;
  const pe = el.closest('[data-paper-id]');
  if (pe && pe.dataset.paperId !== selfId) return { kind: 'paper', id: pe.dataset.paperId, el: pe };
  const ge = el.closest('[data-group-drop]');
  if (ge) return { kind: 'group', id: ge.dataset.groupDrop || null, el: ge };
  const le = el.closest('[data-label-drop]');
  if (le) return { kind: 'label', id: le.dataset.labelDrop, el: le };
  const ce = el.closest('[data-check-drop]');
  if (ce) return { kind: 'check', id: ce.dataset.checkDrop, el: ce };
  return null;
}
function markTarget(t) {
  $$('.drop-target,.drop-ok').forEach((e) => e.classList.remove('drop-target', 'drop-ok'));
  if (!t) return;
  t.el.classList.add(t.kind === 'paper' ? 'drop-target' : t.el.matches('.facet li') ? 'drop-ok' : 'drop-target');
}

function draggable(el, paperId, { onStart, onMove, onEnd, onClick, onDrop, accept, ghost = true } = {}) {
  el.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || e.target.closest('button,input,textarea,a')) return;
    const sx = e.clientX, sy = e.clientY;
    const downTarget = e.target; // 포인터 캡처 뒤에는 이벤트 target 이 el 로 바뀌므로 눌린 곳을 따로 기억
    let dragging = false, gh = null, target = null;
    el.setPointerCapture(e.pointerId);
    let others = [];
    const move = (ev) => {
      const dx = ev.clientX - sx, dy = ev.clientY - sy;
      if (!dragging && Math.hypot(dx, dy) < 5) return;
      if (!dragging) {
        dragging = true;
        closePopover(true);
        el.classList.add('dragging');
        el.style.pointerEvents = 'none';
        others = onStart?.() || []; // 같이 끌리는 요소들 — 놓을 곳 판정에서 빼려고 투명하게
        for (const o of others) o.style.pointerEvents = 'none';
        if (ghost) {
          const p = byId(paperId);
          gh = h('div', { class: 'ghost' }, '📄 ' + short(p?.title, 40));
          document.body.append(gh);
        }
      }
      if (gh) { gh.style.left = ev.clientX + 12 + 'px'; gh.style.top = ev.clientY + 10 + 'px'; }
      onMove?.(dx, dy, ev);
      target = dropTargetAt(ev.clientX, ev.clientY, paperId);
      if (target && accept && !accept(target)) target = null;
      markTarget(target);
    };
    const up = async (ev) => {
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', up);
      el.style.pointerEvents = '';
      for (const o of others) o.style.pointerEvents = '';
      el.classList.remove('dragging');
      gh?.remove();
      markTarget(null);
      if (!dragging) return ev.type === 'pointerup' && onClick?.(ev, downTarget);
      const handled = ev.type === 'pointerup' && target ? await (onDrop ? onDrop(target) : dropPaperOn(paperId, target)) : false;
      onEnd?.(handled, ev);
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
  });
}

async function dropPaperOn(paperId, t) {
  const p = byId(paperId);
  try {
    if (t.kind === 'paper') {
      await linkPapers(paperId, t.id);
    } else if (t.kind === 'group') {
      if ((p.groupId || null) === t.id) return true;
      const before = p.groupId;
      await savePaper(p, { groupId: t.id });
      toast(t.id ? `「${short(p.title, 24)}」 → ${group(t.id)?.name}` : '그룹에서 뺐어요', { action: '되돌리기', onAction: () => savePaper(p, { groupId: before }).then(render) });
    } else if (t.kind === 'label') {
      if (!p.labels.includes(t.id)) await savePaper(p, { labels: [...p.labels, t.id] });
      toast(`라벨 「${label(t.id)?.name}」 붙였어요`);
    } else if (t.kind === 'check') {
      if (!p.checks.includes(t.id)) await savePaper(p, { checks: [...p.checks, t.id] });
      toast(`${check(t.id)?.icon} ${check(t.id)?.name} 에 넣었어요`);
    }
    render();
    return true;
  } catch (e) {
    fail(e);
    return true;
  }
}

async function linkPapers(a, b) {
  const r = await api('POST', '/api/links', { a, b });
  if (!r.existed) S.db.links.push(r.link);
  render();
  flash(a); flash(b);
  const A = byId(a), B = byId(b);
  if (r.existed) toast('이미 연결돼 있어요');
  else toast(`「${short(A.title, 22)}」 ↔ 「${short(B.title, 22)}」 연결했어요`, { action: '되돌리기', onAction: () => unlink(r.link.id) });
}
async function unlink(id) {
  try { await api('DELETE', '/api/links/' + id); S.db.links = S.db.links.filter((l) => l.id !== id); render(); } catch (e) { fail(e); }
}
function flash(id) {
  for (const el of $$(`.paper[data-paper-id="${id}"]`)) { el.classList.remove('flash'); void el.offsetWidth; el.classList.add('flash'); }
}

// 고친 값을 바로 화면에 반영하고 서버에 보냄
async function savePaper(p, patch, opts) {
  Object.assign(p, patch);
  const saved = await api('PATCH', '/api/papers/' + p.id, patch, opts);
  Object.assign(p, saved);
  return saved;
}

// ───────────────────────── 보기: 보드 ─────────────────────────
function freeSlot(taken) {
  for (let row = 0; row < 200; row++)
    for (let col = 0; col < 12; col++) {
      const x = 40 + col * (CARD_W + 36), y = 40 + row * (CARD_H + 44);
      if (!taken.some((t) => Math.abs(t.x - x) < CARD_W && Math.abs(t.y - y) < CARD_H)) return { x, y };
    }
  return { x: 40, y: 40 };
}

// 보드 확대 · 이동: .board-inner 에 translate + scale. 논문 좌표(pos)는 확대와 상관없는 보드 좌표.
const Z = { k: 1, tx: 0, ty: 0, ...JSON.parse(localStorage.getItem('po.boardZoom') || '{}') };
const ZMIN = 0.2, ZMAX = 3;
S.sel = new Set(); // 여러 개 선택 (보드)

function applyBoardZoom(save = true) {
  const inner = $('#board .board-inner');
  inner.style.transform = `translate(${Z.tx}px, ${Z.ty}px) scale(${Z.k})`;
  const bd = $('#board');
  bd.style.backgroundSize = `${24 * Z.k}px ${24 * Z.k}px`;
  bd.style.backgroundPosition = `${Z.tx}px ${Z.ty}px`;
  $('#zoomPct').textContent = Math.round(Z.k * 100) + '%';
  if (save) saveZoomSoon();
}
const saveZoomSoon = debounce(() => localStorage.setItem('po.boardZoom', JSON.stringify(Z)), 300);
// 화면 좌표 → 보드 좌표
function toBoard(clientX, clientY) {
  const r = $('#board').getBoundingClientRect();
  return { x: (clientX - r.left - Z.tx) / Z.k, y: (clientY - r.top - Z.ty) / Z.k };
}
// 화면의 (cx, cy) 지점을 붙잡은 채로 배율 바꾸기
function zoomAt(cx, cy, k) {
  const r = $('#board').getBoundingClientRect();
  const nk = clamp(k, ZMIN, ZMAX);
  const mx = cx - r.left, my = cy - r.top;
  Z.tx = mx - ((mx - Z.tx) * nk) / Z.k;
  Z.ty = my - ((my - Z.ty) * nk) / Z.k;
  Z.k = nk;
  applyBoardZoom();
}
function zoomCenter(k) {
  const r = $('#board').getBoundingClientRect();
  zoomAt(r.left + r.width / 2, r.top + r.height / 2, k);
}
function fitBoard() {
  const ps = S.db.papers.filter((p) => p.pos);
  if (!ps.length) return;
  const r = $('#board').getBoundingClientRect();
  const x0 = Math.min(...ps.map((p) => p.pos.x)) - 40, y0 = Math.min(...ps.map((p) => p.pos.y)) - 40;
  const x1 = Math.max(...ps.map((p) => p.pos.x)) + CARD_W + 40, y1 = Math.max(...ps.map((p) => p.pos.y)) + CARD_H + 40;
  Z.k = clamp(Math.min(r.width / (x1 - x0), r.height / (y1 - y0)), ZMIN, 1.5);
  Z.tx = (r.width - (x1 - x0) * Z.k) / 2 - x0 * Z.k;
  Z.ty = (r.height - (y1 - y0) * Z.k) / 2 - y0 * Z.k;
  applyBoardZoom();
}

function setSelection(ids) {
  S.sel = new Set(ids);
  for (const el of $$('#board .paper')) el.classList.toggle('picked', S.sel.has(el.dataset.paperId));
  const n = S.sel.size;
  const info = $('#selInfo');
  info.hidden = n < 2;
  info.textContent = `${n}편 선택 · 끌면 같이 움직여요 · Esc 로 풀기`;
}

function setupBoardControls() {
  const bd = $('#board');
  let space = false;
  addEventListener('keydown', (e) => {
    if (e.code === 'Space' && !e.target.closest('input,textarea,select,[contenteditable]') && S.view === 'board') {
      if (!space) { space = true; bd.classList.add('pan-ready'); }
      e.preventDefault();
    }
    if (e.key === 'Escape' && S.sel.size) setSelection([]);
  });
  addEventListener('keyup', (e) => { if (e.code === 'Space') { space = false; bd.classList.remove('pan-ready'); } });
  addEventListener('blur', () => { space = false; bd.classList.remove('pan-ready'); });

  // 휠: 트랙패드 핀치(ctrlKey) · 마우스 휠 = 커서 기준 확대/축소, 트랙패드 두 손가락 쓸기 = 이동
  bd.addEventListener('wheel', (e) => {
    e.preventDefault();
    const mouseWheel = e.deltaMode === 1 || (e.deltaX === 0 && Number.isInteger(e.deltaY) && Math.abs(e.deltaY) >= 50);
    if (e.ctrlKey || e.metaKey || mouseWheel) {
      const d = e.deltaMode === 1 ? e.deltaY * 33 : e.deltaY;
      zoomAt(e.clientX, e.clientY, Z.k * Math.exp(-d * (e.ctrlKey ? 0.01 : 0.0015)));
    } else {
      Z.tx -= e.deltaX; Z.ty -= e.deltaY;
      applyBoardZoom();
    }
  }, { passive: false });

  // 빈 곳 누르기: 마우스 = 사각형 선택(스페이스 · 가운데 단추면 이동) · 손가락 하나 = 이동 · 둘 = 핀치
  const touches = new Map();
  let pinch = null;
  bd.addEventListener('pointerdown', (e) => {
    if (e.target.closest('.paper,.board-tools')) return;
    if (e.pointerType === 'touch') {
      touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (touches.size === 2) {
        const [p1, p2] = [...touches.values()];
        pinch = { d: Math.hypot(p1.x - p2.x, p1.y - p2.y), k: Z.k, cx: (p1.x + p2.x) / 2, cy: (p1.y + p2.y) / 2, tx: Z.tx, ty: Z.ty };
        return;
      }
    }
    const pan = e.pointerType === 'touch' || space || e.button === 1;
    if (!pan && e.button !== 0) return;
    e.preventDefault();
    try {
      bd.setPointerCapture(e.pointerId);
    } catch (err) {
      // 이미 끝난 포인터(빠른 탭)는 잡을 수 없음 — 잡지 못해도 아래 이동/선택은 그대로 동작
      console.debug('[board] pointer capture 못 함', err.message);
    }
    closePopover(true);
    const sx = e.clientX, sy = e.clientY, t0 = { tx: Z.tx, ty: Z.ty };
    const base = e.shiftKey || e.metaKey || e.ctrlKey ? new Set(S.sel) : new Set();
    let box = null, moved = false, pinched = false;
    if (pan) bd.classList.add('panning');
    const move = (ev) => {
      if (ev.pointerType === 'touch') {
        touches.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
        if (pinch && touches.size >= 2) {
          pinched = true; // 핀치가 끝난 뒤 남은 손가락으로 화면이 튀지 않게
          const [p1, p2] = [...touches.values()];
          const d = Math.hypot(p1.x - p2.x, p1.y - p2.y);
          const cx = (p1.x + p2.x) / 2, cy = (p1.y + p2.y) / 2;
          Z.tx = pinch.tx; Z.ty = pinch.ty; Z.k = pinch.k;
          zoomAt(pinch.cx, pinch.cy, pinch.k * (d / pinch.d));
          Z.tx += cx - pinch.cx; Z.ty += cy - pinch.cy;
          applyBoardZoom();
          return;
        }
      }
      if (ev.pointerId !== e.pointerId) return;
      const dx = ev.clientX - sx, dy = ev.clientY - sy;
      if (!moved && Math.hypot(dx, dy) < 4) return;
      moved = true;
      if (pan) { if (!pinched) { Z.tx = t0.tx + dx; Z.ty = t0.ty + dy; applyBoardZoom(); } return; }
      const r = bd.getBoundingClientRect();
      const x0 = Math.min(sx, ev.clientX), y0 = Math.min(sy, ev.clientY), x1 = Math.max(sx, ev.clientX), y1 = Math.max(sy, ev.clientY);
      if (!box) { box = h('div', { class: 'marquee' }); bd.append(box); document.body.classList.add('selecting'); }
      Object.assign(box.style, { left: x0 - r.left + 'px', top: y0 - r.top + 'px', width: x1 - x0 + 'px', height: y1 - y0 + 'px' });
      const ids = new Set(base);
      for (const el of $$('#board .paper')) {
        const c = el.getBoundingClientRect();
        if (c.right > x0 && c.left < x1 && c.bottom > y0 && c.top < y1) ids.add(el.dataset.paperId);
      }
      setSelection(ids);
    };
    const up = (ev) => {
      if (ev.pointerType === 'touch') { touches.delete(ev.pointerId); if (touches.size < 2) pinch = null; }
      if (ev.pointerId !== e.pointerId) return;
      bd.removeEventListener('pointermove', move);
      bd.removeEventListener('pointerup', up);
      bd.removeEventListener('pointercancel', up);
      bd.classList.remove('panning');
      box?.remove();
      document.body.classList.remove('selecting');
      if (!moved && !pan && !base.size) setSelection([]); // 빈 곳 클릭 = 선택 풀기
    };
    bd.addEventListener('pointermove', move);
    bd.addEventListener('pointerup', up);
    bd.addEventListener('pointercancel', up);
  });
  // 둘째 손가락은 첫 손가락의 move 처리기에서 같이 다룸
  bd.addEventListener('pointermove', (e) => { if (e.pointerType === 'touch' && touches.has(e.pointerId)) touches.set(e.pointerId, { x: e.clientX, y: e.clientY }); });
  bd.addEventListener('pointerup', (e) => { if (e.pointerType === 'touch') { touches.delete(e.pointerId); if (touches.size < 2) pinch = null; } });

  $('#zoomOut').onclick = () => zoomCenter(Z.k / 1.25);
  $('#zoomIn').onclick = () => zoomCenter(Z.k * 1.25);
  $('#zoomReset').onclick = () => zoomCenter(1);
  $('#zoomFit').onclick = fitBoard;
  applyBoardZoom(false);
}

async function savePositions(items) {
  if (!items.length) return;
  for (const { p, pos } of items) p.pos = pos;
  await api('POST', '/api/papers/positions', { items: items.map(({ p, pos }) => ({ id: p.id, pos })) });
}

function renderBoard() {
  const inner = $('#board .board-inner');
  const svg = $('.board-links', inner);
  $$('.paper', inner).forEach((e) => e.remove());
  const taken = S.db.papers.filter((p) => p.pos).map((p) => p.pos);
  const placed = [];
  for (const p of S.db.papers) {
    if (!p.pos) {
      p.pos = freeSlot(taken);
      taken.push(p.pos);
      placed.push({ p, pos: p.pos });
    }
  }
  savePositions(placed).catch(fail);
  for (const id of [...S.sel]) if (!byId(id)) S.sel.delete(id);
  for (const p of S.db.papers) {
    const el = paperCard(p);
    el.style.left = p.pos.x + 'px';
    el.style.top = p.pos.y + 'px';
    if (filtering() && !matches(p)) el.classList.add('dim');
    if (S.sel.has(p.id)) el.classList.add('picked');
    hoverPeek(el, p.id);
    let group = []; // 같이 끌리는 논문: [{ p, el, start }]
    draggable(el, p.id, {
      ghost: false,
      onStart: () => {
        if (!S.sel.has(p.id)) setSelection([]); // 선택 밖의 논문을 끌면 그것 하나만
        const ids = S.sel.size > 1 ? [...S.sel] : [p.id];
        group = ids.map((id) => ({ p: byId(id), el: $(`#board .paper[data-paper-id="${id}"]`), start: { ...byId(id).pos } })).filter((g) => g.p && g.el);
        for (const g of group) g.el.classList.add('dragging');
        return group.map((g) => g.el).filter((x) => x !== el);
      },
      onMove: (dx, dy) => {
        const over = {};
        for (const g of group) {
          const x = Math.max(0, g.start.x + dx / Z.k), y = Math.max(0, g.start.y + dy / Z.k);
          g.el.style.left = x + 'px';
          g.el.style.top = y + 'px';
          over[g.p.id] = { x, y };
        }
        drawBoardLinks(svg, over);
      },
      // 여러 개를 끌 때는 다른 논문 위에 놓아도 링크를 만들지 않음 — 그냥 그 자리로 옮김
      accept: (t) => !(group.length > 1 && t.kind === 'paper'),
      onDrop: async (t) => {
        if (group.length <= 1) return dropPaperOn(p.id, t);
        try {
          const ps = group.map((g) => g.p);
          if (t.kind === 'group') {
            await Promise.all(ps.map((q) => savePaper(q, { groupId: t.id })));
            toast(`${ps.length}편 → ${t.id ? group_(t.id)?.name : '그룹 없음'}`);
          } else if (t.kind === 'label') {
            await Promise.all(ps.filter((q) => !q.labels.includes(t.id)).map((q) => savePaper(q, { labels: [...q.labels, t.id] })));
            toast(`${ps.length}편에 라벨 「${label(t.id)?.name}」 붙였어요`);
          } else if (t.kind === 'check') {
            await Promise.all(ps.filter((q) => !q.checks.includes(t.id)).map((q) => savePaper(q, { checks: [...q.checks, t.id] })));
            toast(`${ps.length}편을 ${check(t.id)?.icon} ${check(t.id)?.name} 에 넣었어요`);
          }
          render();
        } catch (e) {
          fail(e);
        }
        return true;
      },
      onEnd: async (handled) => {
        for (const g of group) g.el.classList.remove('dragging');
        if (handled) {
          for (const g of group) { g.el.style.left = g.start.x + 'px'; g.el.style.top = g.start.y + 'px'; }
          drawBoardLinks(svg);
          return;
        }
        const items = group.map((g) => ({ p: g.p, pos: { x: Math.round(parseFloat(g.el.style.left)), y: Math.round(parseFloat(g.el.style.top)) } }));
        try { await savePositions(items); } catch (e) { fail(e); }
        drawBoardLinks(svg);
      },
      onClick: (ev) => {
        if (ev.shiftKey || ev.metaKey || ev.ctrlKey) {
          const ids = new Set(S.sel);
          ids.has(p.id) ? ids.delete(p.id) : ids.add(p.id);
          return setSelection(ids);
        }
        setSelection([]);
        openEditor(p.id, el);
      },
    });
    inner.append(el);
  }
  drawBoardLinks(svg);
  setSelection(S.sel);
}
function drawBoardLinks(svg, override = {}) {
  const pos = (id) => override[id] || byId(id)?.pos;
  svg.replaceChildren(...S.db.links.map((l) => {
    const a = pos(l.a), b = pos(l.b);
    if (!a || !b) return null;
    const ln = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    ln.setAttribute('x1', a.x + CARD_W / 2); ln.setAttribute('y1', a.y + CARD_H / 2);
    ln.setAttribute('x2', b.x + CARD_W / 2); ln.setAttribute('y2', b.y + CARD_H / 2);
    ln.dataset.a = l.a; ln.dataset.b = l.b;
    return ln;
  }).filter(Boolean));
}

// ───────────────────────── 보기: 트리 ─────────────────────────
function renderTree() {
  const root = $('#tree');
  root.replaceChildren();
  const vis = (p) => !filtering() || matches(p);
  const groupHas = (gid) => S.db.papers.some((p) => vis(p) && inGroupTree(p.groupId, gid));
  const paperRow = (p, depth, via) => {
    const links = linksOf(p.id);
    const key = (via || '') + '>' + p.id;
    const open = S.treeOpen.has(key);
    const li = h('li');
    const row = h('div', { class: 'row', tabindex: 0 },
      h('span', { class: 'caret', title: links.length ? '연결된 논문 보기' : '' }, links.length && depth < 4 ? (open ? '▾' : '▸') : ''),
      h('span', { class: 'mini' }, h('i', { style: `background:${label(p.labels[0])?.color || group(p.groupId)?.color || 'transparent'}` })),
      h('span', { class: 't' }, p.title || '(제목 없음)'),
      h('span', { class: 'sub' }, metaLine(p)),
      ...p.checks.map((c) => h('span', { title: check(c)?.name }, check(c)?.icon)),
      p.needsReview ? h('span', { title: '자동으로 읽은 값 확인 필요' }, '⚠') : null,
      links.length ? h('span', { class: 'linked' }, `🔗 ${links.length}`) : null);
    row.dataset.paperId = p.id;
    hoverPeek(row, p.id);
    draggable(row, p.id, {
      onClick: (e, down) => {
        if (down.closest('.caret') && links.length) { toggleOpen(key); return renderTree(); }
        openEditor(p.id, row);
      },
    });
    li.append(row);
    if (open && depth < 4) {
      const ul = h('ul');
      for (const l of links) {
        const q = byId(otherEnd(l, p.id));
        if (q && q.id !== via) ul.append(paperRow(q, depth + 1, p.id));
      }
      li.append(ul);
    }
    return li;
  };
  const groupRow = (g, depth) => {
    const key = 'g:' + g.id;
    const closed = S.treeOpen.has(key);
    const papers = S.db.papers.filter((p) => p.groupId === g.id && vis(p));
    const subs = S.db.groups.filter((x) => x.parentId === g.id);
    const li = h('li');
    const row = h('div', { class: 'row group', tabindex: 0 },
      h('span', { class: 'caret' }, closed ? '▸' : '▾'),
      h('i', { class: 'dot', style: `background:${g.color};border-radius:3px` }),
      h('span', { class: 't' }, g.name),
      h('span', { class: 'sub' }, `${S.db.papers.filter((p) => inGroupTree(p.groupId, g.id)).length}편`));
    row.dataset.groupDrop = g.id;
    row.onclick = () => { toggleOpen(key); renderTree(); };
    groupDraggable(row, g);
    li.append(row);
    if (!closed) {
      const ul = h('ul');
      for (const s of subs) if (!filtering() || groupHas(s.id)) ul.append(groupRow(s, depth + 1));
      for (const p of papers) ul.append(paperRow(p, depth + 1));
      if (!subs.length && !papers.length) ul.append(h('li', {}, h('div', { class: 'row sub' }, '비어 있어요 — 논문을 여기로 끌어 오세요')));
      li.append(ul);
    }
    return li;
  };
  const top = h('ul');
  for (const g of S.db.groups.filter((x) => !x.parentId)) if (!filtering() || groupHas(g.id)) top.append(groupRow(g, 0));
  root.append(top);
  const loose = S.db.papers.filter((p) => !p.groupId && vis(p));
  const head = h('h3', {}, `그룹 없음 · ${loose.length}편`);
  head.dataset.groupDrop = '';
  root.append(head, h('ul', {}, ...loose.map((p) => paperRow(p, 0))));
  if (!S.db.groups.length) root.append(h('p', { class: 'hint' }, '왼쪽 「그룹」 ＋ 로 그룹을 만들고 논문을 끌어다 넣으면 폴더처럼 묶여요. 그룹을 그룹 위에 놓으면 안쪽 그룹이 돼요. ▸ 를 누르면 연결된 논문이 가지로 펼쳐져요.'));
}
function toggleOpen(key) {
  S.treeOpen.has(key) ? S.treeOpen.delete(key) : S.treeOpen.add(key);
  localStorage.setItem('po.treeOpen', JSON.stringify([...S.treeOpen]));
}
function groupDraggable(row, g) {
  row.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    const sx = e.clientX, sy = e.clientY;
    let dragging = false, gh = null, t = null;
    const move = (ev) => {
      if (!dragging && Math.hypot(ev.clientX - sx, ev.clientY - sy) < 6) return;
      if (!dragging) {
        dragging = true;
        row.setPointerCapture(ev.pointerId);
        row.style.pointerEvents = 'none';
        gh = h('div', { class: 'ghost' }, '📁 ' + g.name);
        document.body.append(gh);
      }
      gh.style.left = ev.clientX + 12 + 'px'; gh.style.top = ev.clientY + 10 + 'px';
      const el = document.elementFromPoint(ev.clientX, ev.clientY)?.closest('[data-group-drop]');
      t = el && el.dataset.groupDrop !== g.id ? el : null;
      $$('.drop-target,.drop-ok').forEach((x) => x.classList.remove('drop-target', 'drop-ok'));
      t?.classList.add(t.matches('.facet li') ? 'drop-ok' : 'drop-target');
    };
    const up = async () => {
      row.removeEventListener('pointermove', move);
      row.removeEventListener('pointerup', up);
      row.style.pointerEvents = '';
      gh?.remove();
      $$('.drop-target,.drop-ok').forEach((x) => x.classList.remove('drop-target', 'drop-ok'));
      if (!dragging) return;
      row.addEventListener('click', (ce) => ce.stopImmediatePropagation(), { once: true, capture: true });
      if (t) await patchItem('groups', g.id, { parentId: t.dataset.groupDrop || null });
    };
    row.addEventListener('pointermove', move);
    row.addEventListener('pointerup', up);
  });
}

// ───────────────────────── 보기: 그래프 ─────────────────────────
const G = { k: 1, tx: 0, ty: 0, raf: 0, alpha: 0, nodes: [], edges: [], fitted: false };
const NS = 'http://www.w3.org/2000/svg';
const svgEl = (tag, attrs = {}) => { const e = document.createElementNS(NS, tag); for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v); return e; };

function renderGraph() {
  const wrap = $('#graph');
  const svg = $('svg', wrap);
  const rect = wrap.getBoundingClientRect();
  const W = rect.width || 800, H = rect.height || 600;
  const byGroup = $('#graphGroups').checked;
  const nodes = S.db.papers.map((p) => {
    let pos = S.graphPos.get(p.id);
    if (!pos) {
      // 연결된 이웃이 있으면 그 옆에서 시작
      const nb = linksOf(p.id).map((l) => S.graphPos.get(otherEnd(l, p.id))).find(Boolean);
      pos = nb ? { x: nb.x + (Math.random() - .5) * 60, y: nb.y + (Math.random() - .5) * 60 } : { x: W / 2 + (Math.random() - .5) * W * .6, y: H / 2 + (Math.random() - .5) * H * .6 };
      pos.vx = 0; pos.vy = 0;
      S.graphPos.set(p.id, pos);
    }
    const deg = linksOf(p.id).length;
    const color = (byGroup && group(p.groupId)?.color) || label(p.labels[0])?.color || '#8d8d8d';
    return { p, pos, r: 7 + Math.min(10, Math.sqrt(deg) * 3), color };
  });
  const idx = new Map(nodes.map((n, i) => [n.p.id, i]));
  const edges = S.db.links.filter((l) => idx.has(l.a) && idx.has(l.b)).map((l) => ({ l, s: nodes[idx.get(l.a)], t: nodes[idx.get(l.b)] }));
  G.nodes = nodes; G.edges = edges;

  svg.replaceChildren();
  const vp = svgEl('g', { class: 'vp' });
  const hullG = svgEl('g');
  const edgeG = svgEl('g');
  const nodeG = svgEl('g');
  vp.append(hullG, edgeG, nodeG);
  svg.append(vp);
  for (const e of edges) { e.el = svgEl('line', { class: 'edge' }); edgeG.append(e.el); }
  for (const n of nodes) {
    const g = svgEl('g', { class: 'node' });
    g.dataset.paperId = n.p.id;
    const c = svgEl('circle', { r: n.r, fill: n.color });
    const t = svgEl('text', { y: n.r + 13, 'text-anchor': 'middle' });
    t.textContent = short(n.p.title, 28);
    const tt = svgEl('title'); tt.textContent = `${n.p.title}\n${metaLine(n.p)}`;
    g.append(c, t, tt);
    if (filtering() && !matches(n.p)) g.classList.add('dim');
    n.el = g;
    nodeG.append(g);
    g.addEventListener('pointerenter', () => highlight(n.p.id, true));
    g.addEventListener('pointerleave', () => highlight(n.p.id, false));
    hoverPeek(g, n.p.id);
    let start;
    draggable(g, n.p.id, {
      ghost: false,
      onStart: () => { start = { x: n.pos.x, y: n.pos.y }; n.pos.fixed = true; },
      onMove: (dx, dy) => { n.pos.x = start.x + dx / G.k; n.pos.y = start.y + dy / G.k; n.pos.vx = n.pos.vy = 0; kick(.3); },
      onEnd: (handled) => { n.pos.fixed = false; if (handled) { n.pos.x = start.x; n.pos.y = start.y; } kick(.3); },
      onClick: () => openEditor(n.p.id, g),
    });
  }
  G.hullG = hullG; G.vp = vp; G.byGroup = byGroup;
  if (!G.fitted && nodes.length) { G.fitted = true; setTimeout(fitGraph, 900); }
  applyTransform();
  kick(nodes.length > 1 ? .8 : .1);
}
function highlight(id, on) {
  if (!on) { $$('#graph .hot,#graph .dim2').forEach((e) => e.classList.remove('hot', 'dim2')); return; }
  for (const e of G.edges) if (e.l.a === id || e.l.b === id) e.el.classList.add('hot');
}
function kick(a) {
  G.alpha = Math.max(G.alpha, a);
  if (!G.raf) G.raf = requestAnimationFrame(tick);
}
function tick() {
  G.raf = 0;
  if (S.view !== 'graph') return;
  const { nodes, edges } = G;
  const a = G.alpha;
  const rect = $('#graph').getBoundingClientRect();
  const cx = (rect.width / 2 - G.tx) / G.k, cy = (rect.height / 2 - G.ty) / G.k;
  // 밀어내기
  for (let i = 0; i < nodes.length; i++) {
    const A = nodes[i].pos;
    for (let j = i + 1; j < nodes.length; j++) {
      const B = nodes[j].pos;
      let dx = A.x - B.x, dy = A.y - B.y;
      let d2 = dx * dx + dy * dy;
      if (d2 < 1) { dx = Math.random() - .5; dy = Math.random() - .5; d2 = 1; }
      if (d2 > 250000) continue;
      const f = (2600 / d2) * a;
      const d = Math.sqrt(d2);
      A.vx += (dx / d) * f; A.vy += (dy / d) * f;
      B.vx -= (dx / d) * f; B.vy -= (dy / d) * f;
    }
  }
  // 링크 = 용수철
  for (const e of edges) {
    const A = e.s.pos, B = e.t.pos;
    const dx = B.x - A.x, dy = B.y - A.y;
    const d = Math.sqrt(dx * dx + dy * dy) || 1;
    const f = (d - 110) * 0.04 * a;
    A.vx += (dx / d) * f; A.vy += (dy / d) * f;
    B.vx -= (dx / d) * f; B.vy -= (dy / d) * f;
  }
  // 같은 그룹끼리 모이기
  if (G.byGroup) {
    const cen = new Map();
    for (const n of nodes) if (n.p.groupId) {
      const c = cen.get(n.p.groupId) || { x: 0, y: 0, n: 0 };
      c.x += n.pos.x; c.y += n.pos.y; c.n++;
      cen.set(n.p.groupId, c);
    }
    for (const n of nodes) {
      const c = cen.get(n.p.groupId);
      if (c && c.n > 1) { n.pos.vx += (c.x / c.n - n.pos.x) * 0.02 * a; n.pos.vy += (c.y / c.n - n.pos.y) * 0.02 * a; }
    }
  }
  for (const n of nodes) {
    const P = n.pos;
    P.vx += (cx - P.x) * 0.004 * a; P.vy += (cy - P.y) * 0.004 * a;
    if (P.fixed) { P.vx = P.vy = 0; continue; }
    P.vx *= 0.6; P.vy *= 0.6;
    P.x += clamp(P.vx, -40, 40); P.y += clamp(P.vy, -40, 40);
  }
  drawGraph();
  G.alpha *= 0.97;
  if (G.alpha > 0.01) G.raf = requestAnimationFrame(tick);
}
function drawGraph() {
  for (const e of G.edges) {
    e.el.setAttribute('x1', e.s.pos.x); e.el.setAttribute('y1', e.s.pos.y);
    e.el.setAttribute('x2', e.t.pos.x); e.el.setAttribute('y2', e.t.pos.y);
  }
  for (const n of G.nodes) n.el.setAttribute('transform', `translate(${n.pos.x},${n.pos.y})`);
  // 그룹 테두리(볼록 껍질)
  G.hullG.replaceChildren();
  if (!G.byGroup) return;
  for (const g of S.db.groups) {
    const pts = [];
    for (const n of G.nodes) if (n.p.groupId === g.id) {
      for (let k = 0; k < 8; k++) pts.push([n.pos.x + Math.cos(k * Math.PI / 4) * (n.r + 16), n.pos.y + Math.sin(k * Math.PI / 4) * (n.r + 16)]);
    }
    if (!pts.length) continue;
    const hull = convexHull(pts);
    const path = svgEl('path', { class: 'hull', d: 'M' + hull.map((p) => p.join(',')).join('L') + 'Z', fill: g.color, stroke: g.color });
    const t = svgEl('text', { x: Math.min(...hull.map((p) => p[0])), y: Math.min(...hull.map((p) => p[1])) - 4, fill: g.color, 'font-size': 12, 'font-weight': 600 });
    t.textContent = g.name;
    G.hullG.append(path, t);
  }
}
function convexHull(P) {
  P = P.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lo = [], up = [];
  for (const p of P) { while (lo.length >= 2 && cross(lo[lo.length - 2], lo[lo.length - 1], p) <= 0) lo.pop(); lo.push(p); }
  for (const p of P.reverse()) { while (up.length >= 2 && cross(up[up.length - 2], up[up.length - 1], p) <= 0) up.pop(); up.push(p); }
  return lo.slice(0, -1).concat(up.slice(0, -1));
}
function applyTransform() {
  G.vp?.setAttribute('transform', `translate(${G.tx},${G.ty}) scale(${G.k})`);
  // 확대해도 글자는 화면에서 비슷한 크기로
  G.vp?.style.setProperty('--fs', (12 / Math.sqrt(G.k)).toFixed(2) + 'px');
}
function fitGraph() {
  if (!G.nodes.length) return;
  const rect = $('#graph').getBoundingClientRect();
  const xs = G.nodes.map((n) => n.pos.x), ys = G.nodes.map((n) => n.pos.y);
  const x0 = Math.min(...xs) - 60, x1 = Math.max(...xs) + 60, y0 = Math.min(...ys) - 60, y1 = Math.max(...ys) + 60;
  G.k = clamp(Math.min(rect.width / (x1 - x0), rect.height / (y1 - y0)), 0.2, 1.4);
  G.tx = rect.width / 2 - ((x0 + x1) / 2) * G.k;
  G.ty = rect.height / 2 - ((y0 + y1) / 2) * G.k;
  applyTransform();
}
function setupGraphPanZoom() {
  const svg = $('#graph svg');
  svg.addEventListener('wheel', (e) => {
    e.preventDefault();
    const r = svg.getBoundingClientRect();
    const mx = e.clientX - r.left, my = e.clientY - r.top;
    const nk = clamp(G.k * Math.exp(-e.deltaY * 0.0015), 0.15, 4);
    G.tx = mx - ((mx - G.tx) * nk) / G.k; G.ty = my - ((my - G.ty) * nk) / G.k; G.k = nk;
    applyTransform();
  }, { passive: false });
  svg.addEventListener('pointerdown', (e) => {
    if (e.target.closest('.node')) return;
    const sx = e.clientX - G.tx, sy = e.clientY - G.ty;
    svg.setPointerCapture(e.pointerId);
    const mv = (ev) => { G.tx = ev.clientX - sx; G.ty = ev.clientY - sy; applyTransform(); };
    const up = () => { svg.removeEventListener('pointermove', mv); svg.removeEventListener('pointerup', up); };
    svg.addEventListener('pointermove', mv);
    svg.addEventListener('pointerup', up);
  });
  $('#graphFit').onclick = fitGraph;
  $('#graphGroups').onchange = () => renderGraph();
}

// ───────────────────────── 메모 미리보기 · 편집 팝업 ─────────────────────────
let peekTimer = 0;
function hoverPeek(el, id) {
  el.addEventListener('pointerenter', (e) => {
    if (e.pointerType !== 'mouse') return;
    clearTimeout(peekTimer);
    peekTimer = setTimeout(() => {
      const pop = $('#popover');
      if (!pop.hidden && pop._owner !== 'peek') return; // 편집 중이면 미리보기 안 띄움
      if (document.querySelector('.dragging') || document.body.classList.contains('selecting')) return;
      showPeek(id, el);
    }, 220);
  });
  el.addEventListener('pointerleave', () => {
    clearTimeout(peekTimer);
    const pop = $('#popover');
    if (pop._owner === 'peek') { pop.hidden = true; pop._owner = null; }
  });
}
function showPeek(id, anchor) {
  const p = byId(id);
  if (!p) return;
  const pop = $('#popover');
  pop.className = 'popover peek';
  pop.style.width = '';
  pop.replaceChildren(
    h('div', { class: 'ph' }, p.title || '(제목 없음)'),
    h('div', { class: 'pm' }, metaLine(p) + (linksOf(id).length ? ` · 🔗 ${linksOf(id).length}` : '')),
    p.note ? h('div', { class: 'preview' }, short(p.note, 420)) : h('div', { class: 'preview none' }, '메모 없음 — 누르면 바로 쓸 수 있어요'),
    h('div', { class: 'chips' },
      ...p.checks.map((c) => h('span', { class: 'chip' }, `${check(c)?.icon} ${check(c)?.name}`)),
      ...p.labels.map((l) => h('span', { class: 'chip' }, h('i', { class: 'dot', style: `background:${label(l)?.color}` }), label(l)?.name))),
  );
  pop.hidden = false;
  pop._owner = 'peek';
  placeBeside(pop, anchor.getBoundingClientRect());
}
function placeBeside(pop, r) {
  const vw = innerWidth, vh = innerHeight;
  const w = pop.offsetWidth, hgt = pop.offsetHeight;
  let x = r.right + 10, ox = 'left';
  if (x + w > vw - 8) { x = r.left - w - 10; ox = 'right'; }
  if (x < 8) { x = clamp(r.left, 8, vw - w - 8); }
  const y = clamp(r.top, 8, Math.max(8, vh - hgt - 8));
  pop.style.left = x + 'px';
  pop.style.top = y + 'px';
  pop.style.setProperty('--ox', ox);
}

let editing = null; // { id, flush }
function closePopover(force) {
  const pop = $('#popover');
  if (editing) { editing.flush(); editing = null; }
  if (force || pop._owner) { pop.hidden = true; pop._owner = null; pop.replaceChildren(); }
  $$('.paper.selected').forEach((e) => e.classList.remove('selected'));
}

function openEditor(id, anchor) {
  const p = byId(id);
  if (!p) return;
  closePopover(true);
  const pop = $('#popover');
  pop.className = 'popover peek';
  pop.hidden = false;
  pop._owner = 'edit';
  anchor?.classList?.add('selected');
  const ed = noteEditor(p, { compact: true });
  pop.replaceChildren(...ed.nodes);
  editing = ed;
  const r = anchor?.getBoundingClientRect?.() || { left: innerWidth / 2 - 200, right: innerWidth / 2 - 200, top: 80 };
  placeBeside(pop, r);
  // 미리보기 크기에서 살짝 커지며 편집 모드로
  requestAnimationFrame(() => {
    pop.classList.remove('peek');
    pop.classList.add('edit');
    placeBeside(pop, r);
    ed.focus();
  });
}

// 메모 편집기 — 팝업과 PDF 열람 옆 칸이 같이 씀. 자동 저장.
function noteEditor(p, { compact }) {
  const state = h('div', { class: 'save-state' }, p.updatedAt ? `저장됨 · ${fmtTime(p.updatedAt)}` : '');
  let pending = {};
  // 저장은 한 줄로 세워서 보낸다 — 앞 요청의 응답이 뒤에 쓴 글자를 덮지 않게
  let chain = Promise.resolve();
  const doSave = (keepalive) => (chain = chain.then(() => saveNow(keepalive)));
  const saveNow = async (keepalive) => {
    const patch = pending;
    pending = {};
    if (!Object.keys(patch).length) return;
    state.className = 'save-state';
    state.textContent = '저장 중…';
    try {
      await savePaper(p, patch, { keepalive });
      Object.assign(p, pending); // 응답을 기다리는 동안 더 쓴 것은 화면 값을 유지
      state.textContent = Object.keys(pending).length ? '고치는 중…' : `저장됨 · ${fmtTime(p.updatedAt)}`;
      refreshCards(p.id);
    } catch (e) {
      pending = { ...patch, ...pending }; // 실패한 것을 되살리되, 그 사이 새로 쓴 값이 이김
      state.className = 'save-state err';
      state.textContent = '저장 못 함 — ' + e.message + ' (3초 뒤 다시 시도)';
      setTimeout(() => saveSoon(), 3000);
    }
  };
  const saveSoon = debounce(() => doSave(false), 500);
  const set = (k, v) => { pending[k] = v; p[k] = v; state.className = 'save-state'; state.textContent = '고치는 중…'; saveSoon(); };

  const title = h('textarea', { class: 'field title', rows: 1, 'aria-label': '제목', placeholder: '제목' }, p.title);
  const grow = () => { title.style.height = 'auto'; title.style.height = title.scrollHeight + 'px'; };
  title.oninput = () => { set('title', title.value.replace(/\n/g, ' ')); grow(); };
  requestAnimationFrame(grow);
  const author = h('input', { class: 'field', value: p.author, 'aria-label': '주저자', placeholder: '주저자' });
  author.oninput = () => set('author', author.value);
  const year = h('input', { class: 'field', value: p.year || '', inputmode: 'numeric', 'aria-label': '년도', placeholder: '년도', maxlength: 4 });
  year.oninput = () => { const v = year.value.replace(/\D/g, '').slice(0, 4); if (v !== year.value) year.value = v; if (!v || v.length === 4) set('year', v ? Number(v) : null); };

  const note = h('textarea', { class: 'note', placeholder: '메모를 쓰세요. 자동으로 저장돼요.' }, p.note);
  note.oninput = () => set('note', note.value);

  const nodes = [];
  nodes.push(h('div', { class: 'edit-grid' }, title, author, year));
  if (p.needsReview) {
    const box = h('div', { class: 'warn-box' },
      '자동으로 읽은 값이에요' + (p.warnings?.length ? ` (${p.warnings.join(', ')})` : '') + '. 틀리면 위 칸을 고쳐 주세요. ',
      h('button', { class: 'chip', onclick: () => { set('needsReview', false); box.remove(); refreshCards(p.id); } }, '맞아요'));
    nodes.push(box);
  }
  nodes.push(note, state);

  // 체크 · 라벨 · 그룹
  const toggleChip = (list, key, it, text) => {
    const on = p[key].includes(it.id);
    const c = h('button', { class: 'chip' + (on ? ' on' : '') }, text);
    c.onclick = () => {
      const now = p[key].includes(it.id) ? p[key].filter((x) => x !== it.id) : [...p[key], it.id];
      c.classList.toggle('on');
      set(key, now);
    };
    return c;
  };
  nodes.push(h('div', { class: 'pop-sec' }, h('div', { class: 'lbl' }, '체크'),
    h('div', { class: 'chips' }, ...S.db.checks.map((c) => toggleChip(S.db.checks, 'checks', c, `${c.icon} ${c.name}`)),
      S.db.checks.length ? null : h('span', { class: 'hint' }, '왼쪽 「체크 메뉴」 ＋ 로 만들어요'))));
  nodes.push(h('div', { class: 'pop-sec' }, h('div', { class: 'lbl' }, '주제 라벨'),
    h('div', { class: 'chips' }, ...S.db.labels.map((l) => toggleChip(S.db.labels, 'labels', l, [h('i', { class: 'dot', style: `background:${l.color}` }), ' ', l.name])),
      newLabelInput(p, set))));
  const gsel = h('select', { class: 'field', 'aria-label': '그룹' }, h('option', { value: '' }, '그룹 없음'),
    ...groupOptions().map(([g, depth]) => h('option', { value: g.id, selected: p.groupId === g.id }, ' '.repeat(depth * 2) + g.name)));
  gsel.onchange = () => set('groupId', gsel.value || null);
  nodes.push(h('div', { class: 'pop-sec' }, h('div', { class: 'lbl' }, '그룹'), gsel));

  // 연결
  const linkUl = h('ul', { class: 'links-list' });
  const drawLinks = () => {
    linkUl.replaceChildren(...linksOf(p.id).map((l) => {
      const q = byId(otherEnd(l, p.id));
      return h('li', {}, '🔗', h('a', { onclick: () => { closePopover(true); openEditor(q.id, $(`[data-paper-id="${q.id}"]`)); } }, q?.title || '?'),
        h('button', { title: '연결 끊기', onclick: async () => { await unlink(l.id); drawLinks(); } }, '×'));
    }));
    if (!linkUl.children.length) linkUl.append(h('li', { class: 'hint', style: 'margin:0' }, '아이콘을 다른 논문 위에 끌어다 놓으면 연결돼요'));
  };
  drawLinks();
  const others = S.db.papers.filter((q) => q.id !== p.id);
  const linkSel = h('select', { class: 'field link-add', 'aria-label': '논문 연결하기' }, h('option', { value: '' }, '＋ 다른 논문과 연결…'),
    ...others.map((q) => h('option', { value: q.id }, short(q.title, 60))));
  linkSel.onchange = async () => { if (!linkSel.value) return; try { await linkPapers(p.id, linkSel.value); } catch (e) { fail(e); } linkSel.value = ''; drawLinks(); };
  nodes.push(h('div', { class: 'pop-sec' }, h('div', { class: 'lbl' }, '연결된 논문'), linkUl, others.length ? linkSel : null));

  if (compact) {
    nodes.push(h('div', { class: 'pop-actions' },
      h('button', { class: 'btn primary', onclick: () => { closePopover(true); openViewer(p.id); } }, 'PDF 보기'),
      h('a', { class: 'btn', href: `/api/papers/${p.id}/pdf`, target: '_blank', rel: 'noopener' }, '새 탭'),
      h('span', { style: 'flex:1' }),
      h('button', { class: 'btn danger', onclick: async () => {
        if (!confirm(`「${short(p.title, 50)}」을(를) 지울까요?\n메모 · 연결도 같이 지워져요. PDF 파일은 데이터 폴더의 trash/ 로 옮겨져요.`)) return;
        try { editing = null; await api('DELETE', '/api/papers/' + p.id); closePopover(true); await load(); toast('지웠어요'); } catch (e) { fail(e); }
      } }, '지우기')));
  }
  return {
    nodes,
    flush: () => { saveSoon.cancel(); doSave(true); },
    focus: () => (p.needsReview && !p.title ? title : note).focus({ preventScroll: true }),
  };
}
function groupOptions() {
  const out = [];
  const walk = (parent, d) => { for (const g of S.db.groups.filter((x) => (x.parentId || null) === parent)) { out.push([g, d]); walk(g.id, d + 1); } };
  walk(null, 0);
  return out;
}
function newLabelInput(p, set) {
  const inp = h('input', { class: 'chip', placeholder: '＋ 새 라벨', style: 'width:90px;cursor:text' });
  inp.onkeydown = async (e) => {
    if (e.key !== 'Enter' || !inp.value.trim()) return;
    try {
      const l = await api('POST', '/api/labels', { name: inp.value.trim() });
      S.db.labels.push(l);
      set('labels', [...p.labels, l.id]);
      inp.replaceWith(h('span', { class: 'chip on' }, h('i', { class: 'dot', style: `background:${l.color}` }), ' ', l.name), newLabelInput(p, set));
      renderSidebar();
    } catch (er) { fail(er); }
  };
  return inp;
}
// 팝업을 유지한 채 아이콘 글자만 새로 고침
const dirtyCards = new Set();
const refreshCards = (id) => { dirtyCards.add(id); refreshCardsSoon(); };
const refreshCardsSoon = debounce(() => {
  const ids = [...dirtyCards];
  dirtyCards.clear();
  if (S.view === 'board') {
    for (const id of ids)
      for (const el of $$(`#board .paper[data-paper-id="${id}"]`)) {
        const p = byId(id);
        if (!p) continue;
        el.replaceChildren(...paperCard(p).childNodes);
        el.classList.toggle('dim', !!filtering() && !matches(p));
      }
  } else if (S.view === 'tree') renderTree();
  else if (S.view === 'graph') renderGraph();
  renderSidebar();
  renderFilterBar();
}, 300);

document.addEventListener('pointerdown', (e) => {
  const pop = $('#popover');
  if (pop.hidden || pop._owner === 'peek') return;
  if (e.target.closest('#popover,#viewer,.toast')) return;
  if (pop._owner === 'edit' && e.target.closest('[data-paper-id]')) return; // 다른 논문 누르면 그쪽 openEditor 가 처리
  closePopover(true);
});
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (!$('#viewer').hidden) return closeViewer();
  closePopover(true);
});
addEventListener('beforeunload', () => editing?.flush());

// ───────────────────────── PDF 열람 ─────────────────────────
let pdfjs = null, viewerState = null;
async function openViewer(id) {
  const p = byId(id);
  const v = $('#viewer');
  const pages = h('div', { class: 'pages' }, h('div', { class: 'vmsg' }, 'PDF 를 여는 중…'));
  let scale = Number(localStorage.getItem('po.zoom') || 1.3);
  const zoomLbl = h('span', { style: 'min-width:44px;text-align:center' }, Math.round(scale * 100) + '%');
  const ed = noteEditor(p, { compact: false });
  v.replaceChildren(h('div', { class: 'vbox' },
    h('div', { class: 'vtop' },
      h('span', { class: 'vt' }, p.title),
      h('button', { class: 'btn', title: '작게', onclick: () => zoom(-0.15) }, '−'), zoomLbl,
      h('button', { class: 'btn', title: '크게', onclick: () => zoom(0.15) }, '+'),
      h('a', { class: 'btn', href: `/api/papers/${id}/pdf`, target: '_blank', rel: 'noopener', title: '브라우저 PDF 보기로 열기 (글자 찾기 · 인쇄)' }, '새 탭'),
      h('button', { class: 'btn', onclick: closeViewer }, '닫기')),
    h('div', { class: 'vbody' }, pages, h('div', { class: 'side' }, ...ed.nodes))));
  v.hidden = false;
  v.onclick = (e) => { if (e.target === v) closeViewer(); };
  viewerState = { ed, doc: null, io: null };
  try {
    pdfjs ||= await import('/vendor/pdfjs/legacy/build/pdf.min.mjs');
    pdfjs.GlobalWorkerOptions.workerSrc = '/vendor/pdfjs/legacy/build/pdf.worker.min.mjs';
    const doc = await pdfjs.getDocument({ url: `/api/papers/${id}/pdf`, cMapUrl: '/vendor/pdfjs/cmaps/', cMapPacked: true, standardFontDataUrl: '/vendor/pdfjs/standard_fonts/' }).promise;
    if (viewerState?.ed !== ed) return doc.destroy();
    viewerState.doc = doc;
    await layout();
  } catch (e) {
    pages.replaceChildren(h('div', { class: 'vmsg' }, 'PDF 를 그리지 못했어요: ' + e.message + ' — 「새 탭」으로 열어 보세요.'));
    console.error('[viewer]', e);
  }
  async function layout() {
    const doc = viewerState.doc;
    viewerState.io?.disconnect();
    const first = await doc.getPage(1);
    const vp1 = first.getViewport({ scale: scale * (devicePixelRatio || 1) });
    const cssW = vp1.width / (devicePixelRatio || 1), cssH = vp1.height / (devicePixelRatio || 1);
    pages.replaceChildren();
    const io = new IntersectionObserver((ents) => {
      for (const en of ents) if (en.isIntersecting && !en.target._drawn) { en.target._drawn = true; drawPage(en.target); }
    }, { root: pages, rootMargin: '600px 0px' });
    viewerState.io = io;
    for (let i = 1; i <= doc.numPages; i++) {
      const ph = h('div', { class: 'ph-page', style: `width:${cssW}px;height:${cssH}px` });
      ph._n = i;
      pages.append(ph);
      io.observe(ph);
    }
  }
  async function drawPage(ph) {
    try {
      const page = await viewerState.doc.getPage(ph._n);
      const dpr = devicePixelRatio || 1;
      const vp = page.getViewport({ scale: scale * dpr });
      const c = h('canvas', { width: vp.width, height: vp.height, style: `width:${vp.width / dpr}px;height:${vp.height / dpr}px` });
      await page.render({ canvasContext: c.getContext('2d'), viewport: vp, canvas: c }).promise;
      ph.replaceWith(c);
    } catch (e) {
      ph.textContent = `${ph._n}쪽을 그리지 못했어요`;
      console.error('[viewer] page', ph._n, e);
    }
  }
  function zoom(d) {
    scale = clamp(Math.round((scale + d) * 100) / 100, 0.5, 3);
    localStorage.setItem('po.zoom', scale);
    zoomLbl.textContent = Math.round(scale * 100) + '%';
    if (viewerState?.doc) {
      const frac = pages.scrollTop / (pages.scrollHeight || 1);
      layout().then(() => { pages.scrollTop = frac * pages.scrollHeight; });
    }
  }
}
function closeViewer() {
  if (!viewerState) return;
  viewerState.ed.flush();
  viewerState.io?.disconnect();
  viewerState.doc?.destroy();
  viewerState = null;
  $('#viewer').hidden = true;
  $('#viewer').replaceChildren();
  render();
}

// ───────────────────────── PDF 올리기 (끌어다 놓기) ─────────────────────────
let dragDepth = 0;
const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
addEventListener('dragenter', (e) => { if (!hasFiles(e)) return; e.preventDefault(); dragDepth++; $('#dropShade').hidden = false; });
addEventListener('dragleave', (e) => { if (!hasFiles(e)) return; if (--dragDepth <= 0) { dragDepth = 0; $('#dropShade').hidden = true; markTarget(null); } });
addEventListener('dragover', (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = 'copy';
  markTarget(fileDropTarget(e));
});
addEventListener('drop', async (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  dragDepth = 0;
  $('#dropShade').hidden = true;
  const t = fileDropTarget(e);
  markTarget(null);
  const files = [...e.dataTransfer.files];
  let at = null;
  if (S.view === 'board' && !t) {
    const b = toBoard(e.clientX, e.clientY);
    at = { x: Math.max(0, Math.round(b.x - CARD_W / 2)), y: Math.max(0, Math.round(b.y - CARD_H / 2)) };
  }
  await uploadFiles(files, { linkTo: t?.kind === 'paper' ? t.id : null, groupId: t?.kind === 'group' ? t.id : null, at });
});
function fileDropTarget(e) {
  const t = dropTargetAt(e.clientX, e.clientY, null);
  return t && (t.kind === 'paper' || (t.kind === 'group' && t.id)) ? t : null;
}

async function uploadFiles(files, { linkTo = null, groupId = null, at = null } = {}) {
  const pdfs = files.filter((f) => /\.pdf$/i.test(f.name) || f.type === 'application/pdf');
  if (files.length && !pdfs.length) return toast('PDF 파일만 올릴 수 있어요', { err: true });
  if (pdfs.length < files.length) toast(`PDF 가 아닌 파일 ${files.length - pdfs.length}개는 건너뛰었어요`);
  const added = [];
  for (let i = 0; i < pdfs.length; i++) {
    const f = pdfs[i];
    const prog = h('div', { class: 'toast' }, `올리는 중 ${i + 1}/${pdfs.length} · ${short(f.name, 40)}`);
    $('#toasts').append(prog);
    try {
      const q = new URLSearchParams();
      if (linkTo) q.set('linkTo', linkTo);
      if (groupId) q.set('groupId', groupId);
      if (at) { q.set('x', at.x + i * 30); q.set('y', at.y + i * 30); }
      const r = await api('POST', '/api/papers?' + q, f, { headers: { 'content-type': 'application/pdf', 'x-file-name': encodeURIComponent(f.name) } });
      added.push(r);
    } catch (e) {
      toast(`「${short(f.name, 30)}」 올리지 못했어요 — ${e.message}`, { err: true, ms: 7000 });
    } finally {
      prog.remove();
    }
  }
  if (!added.length) return;
  await load();
  for (const r of added) flash(r.paper.id);
  if (linkTo) flash(linkTo);
  const dups = added.filter((r) => r.duplicate).length;
  const news = added.length - dups;
  const parts = [];
  if (news) parts.push(`${news}편 올렸어요`);
  if (dups) parts.push(`${dups}편은 이미 있던 논문이에요`);
  if (linkTo) parts.push(`「${short(byId(linkTo)?.title, 22)}」와 연결했어요`);
  const review = added.filter((r) => !r.duplicate && byId(r.paper.id)?.needsReview);
  if (review.length) parts.push(`${review.length}편은 제목 · 저자 · 년도를 확인해 주세요`);
  toast(parts.join(' · '), { ms: 6000 });
  if (added.length === 1 && review.length) {
    const id = added[0].paper.id;
    openEditor(id, $(`[data-paper-id="${id}"]`));
  }
}
$('#fileInput').onchange = (e) => { uploadFiles([...e.target.files]); e.target.value = ''; };
$$('.file-alt').forEach((i) => (i.onchange = (e) => { uploadFiles([...e.target.files]); e.target.value = ''; }));

// ───────────────────────── 전체 그리기 ─────────────────────────
function render() {
  renderSidebar();
  renderFilterBar();
  $$('.views button').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.view === S.view)));
  $$('main .view').forEach((v) => (v.hidden = v.dataset.view !== S.view));
  $('#empty').hidden = S.db.papers.length > 0;
  if (S.view === 'board') renderBoard();
  if (S.view === 'tree') renderTree();
  if (S.view === 'graph') renderGraph();
}

$$('.views button').forEach((b) => (b.onclick = () => { closePopover(true); S.view = b.dataset.view; localStorage.setItem('po.view', S.view); render(); }));
$('#search').oninput = debounce((e) => { S.f.q = e.target.value.trim(); render(); }, 200);
$$('[data-add]').forEach((b) => (b.onclick = () => addInline(b.dataset.add)));
$('#logout').onclick = async () => {
  editing?.flush();
  await fetch('/api/logout', { method: 'POST' }).catch((e) => console.warn('[logout]', e.message));
  location.href = '/login';
};
$('#sidebarToggle').onclick = () => {
  if (matchMedia('(max-width: 700px)').matches) document.body.classList.toggle('show-sidebar');
  else document.body.classList.toggle('no-sidebar');
};
addEventListener('resize', debounce(() => { if (S.view === 'graph') kick(.2); }, 200));
setupGraphPanZoom();
setupBoardControls();
addEventListener('online', () => load().catch(fail));
// 다른 기기에서 고친 것을 가끔 가져옴 (편집 중이 아닐 때만)
setInterval(async () => {
  if (editing || viewerState || document.hidden || document.querySelector('.dragging')) return;
  try {
    const db = await api('GET', '/api/state');
    if (JSON.stringify(db) !== JSON.stringify(S.db)) { S.db = db; render(); }
  } catch (e) { console.warn('[sync]', e.message); }
}, 15000);

window.__po = S; // 시험용
window.__board = Z; // 시험용
load().catch((e) => { fail(e); $('#empty').hidden = false; });
