// PDF 에서 제목 · 주저자 · 년도를 뽑는다.
// 1) PDF 메타데이터(Title · Author · CreationDate) 2) 첫 페이지 글자 크기 · 위치 3) 본문 속 년도 · arXiv 번호.
// 뽑기에 실패해도 예외를 던지지 않고 빈 칸 + 이유(warnings)를 돌려준다 — 화면에서 사람이 고친다.
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { createRequire } from 'node:module';
import path from 'node:path';

// 한글 · 일본어 PDF 는 CMap 이 있어야 글자를 읽는다
const PDFJS_DIR = path.dirname(createRequire(import.meta.url).resolve('pdfjs-dist/package.json'));
const CMAP_URL = path.join(PDFJS_DIR, 'cmaps') + path.sep;
const FONT_URL = path.join(PDFJS_DIR, 'standard_fonts') + path.sep;

const JUNK_TITLE = /^(untitled|microsoft word|document\d*|paper|main|manuscript|arxiv|\s*)$|\.(docx?|tex|dvi|pdf)$/i;
const NOT_TITLE_LINE = /^(arxiv:|preprint|published|proceedings|journal|vol\.|volume|abstract|https?:|doi|copyright|©|accepted|under review|provided proper attribution|\d+$)/i;
const AFFIL = /(universit|institut|department|dept\.|college|school of|laborator|research|inc\.|google|microsoft|facebook|meta ai|deepmind|openai|corporation|@|\.edu|\.com|\.org|korea|china|usa|germany)/i;

export function cleanText(s) {
  return String(s || '').replace(/\s+/g, ' ').replace(/[\u0000-\u001f]/g, '').trim();
}

// "Ashish Vaswani∗ Noam Shazeer∗" · "A. Vaswani, N. Shazeer and ..." → "Ashish Vaswani"
export function firstAuthorFrom(line) {
  let s = cleanText(line)
    .replace(/[∗*†‡§¶#♯♮♭✝✉⋆]+/g, ' ')
    .replace(/\(\s*\d+\s*\)/g, ' ')
    .replace(/(\p{L})\d+(,\d+)*/gu, '$1')       // 위첨자 소속 번호
    .replace(/\s+/g, ' ').trim();
  if (!s) return '';
  const parts = s.split(/\s*(?:,|;|\band\b|&|·|\|)\s*/i).map((p) => p.trim()).filter(Boolean);
  let cand = parts[0] || '';
  // 쉼표 없이 이름이 이어진 경우: "Ashish Vaswani Noam Shazeer Niki Parmar" → 처음 두 단어
  const words = cand.split(' ');
  if (words.length > 3 && !parts[1]) cand = words.slice(0, words[0].endsWith('.') ? 3 : 2).join(' ');
  return cand.length > 60 ? cand.slice(0, 60) : cand;
}

export function yearFrom(text, now = new Date().getFullYear()) {
  const t = String(text || '');
  // arXiv 번호 YYMM.NNNNN → 20YY
  const ax = t.match(/arXiv:\s*(\d{2})(\d{2})\.\d{4,5}/i);
  if (ax) {
    const y = 2000 + Number(ax[1]);
    if (y >= 2007 && y <= now + 1) return y;
  }
  const counts = new Map();
  for (const m of t.matchAll(/(?<![\d.])(19[5-9]\d|20\d\d)(?![\d])/g)) {
    const y = Number(m[1]);
    if (y <= now + 1) counts.set(y, (counts.get(y) || 0) + 1);
  }
  if (!counts.size) return null;
  // 가장 많이 나온 해, 같으면 더 최근
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || b[0] - a[0])[0][0];
}

function pdfDateYear(d) {
  const m = String(d || '').match(/^(?:D:)?(\d{4})/);
  return m ? Number(m[1]) : null;
}

// 첫 페이지의 글자 조각을 줄로 묶는다 (같은 y · 같은 크기)
function linesFromItems(items) {
  const rows = [];
  for (const it of items) {
    const str = it.str;
    if (!str || !str.trim()) continue;
    const size = Math.round(Math.hypot(it.transform[2], it.transform[3]) * 10) / 10 || Math.abs(it.transform[0]);
    const y = it.transform[5];
    const x = it.transform[4];
    // 같은 줄 = y 가 가까움. 글자 크기가 섞여도(작은 대문자 제목) 한 줄로 본다.
    let row = rows.find((r) => Math.abs(r.y - y) < Math.max(2, Math.min(r.size, size) * 0.5));
    if (!row) rows.push((row = { y, size, parts: [] }));
    row.size = Math.max(row.size, size);
    row.parts.push({ x, str, size, w: it.width || str.length * size * 0.5 });
  }
  for (const r of rows) {
    r.parts.sort((a, b) => a.x - b.x);
    // 조각 사이 간격이 없으면 붙인다(작은 대문자: "A" + "N IMAGE")
    let t = '';
    let prevEnd = null;
    for (const p of r.parts) {
      if (t && !/\s$/.test(t) && !/^\s/.test(p.str) && prevEnd !== null && p.x - prevEnd > p.size * 0.15) t += ' ';
      t += p.str;
      prevEnd = p.x + p.w;
    }
    r.text = cleanText(t);
  }
  rows.sort((a, b) => b.y - a.y); // 위에서 아래로
  return rows.filter((r) => r.text);
}

export function guessFromLines(lines) {
  // 제목: 위쪽 절반에서 가장 큰 글자 줄(들). 이어지는 같은 크기 줄은 합친다.
  const top = lines.filter((l) => l.text.length >= 3 && !NOT_TITLE_LINE.test(l.text) && /\p{L}{2}/u.test(l.text));
  if (!top.length) return { title: '', author: '' };
  const maxY = Math.max(...lines.map((l) => l.y));
  const upper = top.filter((l) => l.y > maxY - 450);
  const pool = upper.length ? upper : top;
  const maxSize = Math.max(...pool.map((l) => l.size));
  const idx = lines.indexOf(pool.find((l) => l.size === maxSize));
  const titleLines = [];
  let i = idx;
  while (i < lines.length && Math.abs(lines[i].size - maxSize) < 1.2 && titleLines.length < 4) {
    titleLines.push(lines[i].text);
    i++;
  }
  const title = cleanText(titleLines.join(' '));
  // 주저자: 제목 바로 아래, 소속 · 메일이 아닌 첫 줄
  let author = '';
  for (let j = i; j < Math.min(lines.length, i + 8); j++) {
    const t = lines[j].text;
    if (/^abstract/i.test(t)) break;
    if (AFFIL.test(t) || t.length < 3 || /\d{3,}/.test(t)) continue;
    if (!/\p{Lu}/u.test(t) && !/[ㄱ-힝]/.test(t)) continue;
    author = firstAuthorFrom(t);
    if (author) break;
  }
  return { title, author };
}

export async function extractPdfInfo(buf) {
  const out = { title: '', author: '', year: null, pages: 0, warnings: [] };
  let doc;
  try {
    doc = await getDocument({ data: new Uint8Array(buf), cMapUrl: CMAP_URL, cMapPacked: true, standardFontDataUrl: FONT_URL, isEvalSupported: false, disableFontFace: true, verbosity: 0 }).promise;
  } catch (e) {
    out.warnings.push('PDF 를 읽지 못했어요: ' + (e && e.message ? e.message : String(e)));
    return out;
  }
  try {
    out.pages = doc.numPages;
    let meta = {};
    try {
      meta = (await doc.getMetadata()).info || {};
    } catch (e) {
      out.warnings.push('메타데이터 없음: ' + e.message);
    }
    let lines = [];
    let pageText = '';
    try {
      const page = await doc.getPage(1);
      const tc = await page.getTextContent();
      lines = linesFromItems(tc.items);
      pageText = lines.map((l) => l.text).join('\n');
    } catch (e) {
      out.warnings.push('첫 페이지 글자를 못 읽었어요: ' + e.message);
    }
    const guess = guessFromLines(lines);
    const metaTitle = cleanText(meta.Title);
    const metaAuthor = cleanText(meta.Author);
    out.title = metaTitle && !JUNK_TITLE.test(metaTitle) && metaTitle.length > 6 ? metaTitle : guess.title;
    out.author = metaAuthor && !/^(unknown|user|admin|author)$/i.test(metaAuthor) ? firstAuthorFrom(metaAuthor) : guess.author;
    out.year = yearFrom(pageText) || pdfDateYear(meta.CreationDate) || null;
    const doi = pageText.match(/\b10\.\d{4,9}\/[^\s"<>]+/);
    if (doi) out.doi = doi[0].replace(/[.,;]$/, '');
    const ax = pageText.match(/arXiv:\s*(\d{4}\.\d{4,5})(v\d+)?/i);
    if (ax) out.arxiv = ax[1];
    if (!out.title) out.warnings.push('제목을 못 찾았어요');
    if (!out.author) out.warnings.push('주저자를 못 찾았어요');
    if (!out.year) out.warnings.push('년도를 못 찾았어요');
    if (!pageText) out.warnings.push('글자가 없는 PDF(스캔본)일 수 있어요');
  } finally {
    await doc.destroy().catch((e) => console.warn('[extract] destroy 실패', e.message));
  }
  return out;
}
