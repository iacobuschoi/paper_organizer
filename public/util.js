// 작은 도우미들 — 글자는 항상 textContent 로 넣는다(PDF 에서 읽은 제목에 HTML 이 섞여도 안전)
export function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else if (k === 'value') el.value = v;
    else if (k === 'selected') el.selected = !!v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat(Infinity)) {
    if (kid === null || kid === undefined || kid === false) continue;
    if (tag === 'textarea' && typeof kid === 'string') el.value = kid;
    else el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  }
  return el;
}

export function debounce(fn, ms) {
  let t = 0;
  const d = (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
  d.cancel = () => clearTimeout(t);
  return d;
}

export const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

export function fmtTime(iso) {
  const d = new Date(iso);
  if (isNaN(d)) return '';
  const now = new Date();
  const hm = d.toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' });
  return d.toDateString() === now.toDateString() ? hm : `${d.getMonth() + 1}월 ${d.getDate()}일 ${hm}`;
}
