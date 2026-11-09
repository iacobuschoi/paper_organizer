// 데이터는 이 맥 로컬 폴더 하나에: db.json(논문 · 메모 · 링크 · 라벨 · 체크 · 그룹) + pdfs/<id>.pdf
// 쓰기는 임시 파일에 쓰고 rename(원자적), 하루 한 번 backups/ 에 사본을 남긴다.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const COLORS = ['#e5484d', '#f76b15', '#ffc53d', '#46a758', '#12a594', '#0090ff', '#6e56cf', '#d6409f', '#8d8d8d'];

function emptyDb() {
  return {
    version: 1,
    papers: [],
    links: [],
    labels: [],
    checks: [
      { id: 'chk-toread', name: '봐야 할 논문', icon: '📌' },
      { id: 'chk-read', name: '읽은 논문', icon: '✅' },
      { id: 'chk-impl', name: '구현해 본 논문', icon: '🛠' },
    ],
    groups: [],
  };
}

export const newId = (p) => p + '-' + crypto.randomBytes(5).toString('hex');

export class Store {
  constructor(dir) {
    this.dir = dir;
    this.pdfDir = path.join(dir, 'pdfs');
    this.file = path.join(dir, 'db.json');
    fs.mkdirSync(this.pdfDir, { recursive: true });
    fs.mkdirSync(path.join(dir, 'backups'), { recursive: true });
    if (fs.existsSync(this.file)) {
      const raw = fs.readFileSync(this.file, 'utf8');
      try {
        this.db = { ...emptyDb(), ...JSON.parse(raw) };
      } catch (e) {
        // 망가진 파일을 덮어쓰지 않는다 — 옆에 보관하고 멈춘다.
        const keep = this.file + '.broken-' + Date.now();
        fs.copyFileSync(this.file, keep);
        throw new Error(`db.json 을 읽지 못했어요(${e.message}). 사본: ${keep} · backups/ 에서 되살리세요.`);
      }
    } else {
      this.db = emptyDb();
      this.save();
    }
  }

  save() {
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.db, null, 1));
    fs.renameSync(tmp, this.file);
    const day = new Date().toISOString().slice(0, 10);
    const bak = path.join(this.dir, 'backups', `db-${day}.json`);
    if (!fs.existsSync(bak)) {
      fs.copyFileSync(this.file, bak);
      this.pruneBackups();
    }
  }

  pruneBackups(keep = 30) {
    const d = path.join(this.dir, 'backups');
    const files = fs.readdirSync(d).filter((f) => /^db-\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort();
    for (const f of files.slice(0, Math.max(0, files.length - keep))) fs.unlinkSync(path.join(d, f));
  }

  pdfPath(id) {
    if (!/^p-[0-9a-f]{10}$/.test(id)) throw new Error('잘못된 논문 id');
    return path.join(this.pdfDir, id + '.pdf');
  }

  paper(id) {
    return this.db.papers.find((p) => p.id === id);
  }

  addPaper(buf, info, fileName) {
    const sha = crypto.createHash('sha256').update(buf).digest('hex');
    const dup = this.db.papers.find((p) => p.sha256 === sha);
    if (dup) return { paper: dup, duplicate: true };
    const id = newId('p');
    fs.writeFileSync(this.pdfPath(id), buf);
    const now = new Date().toISOString();
    const paper = {
      id,
      title: info.title || fileName.replace(/\.pdf$/i, ''),
      author: info.author || '',
      year: info.year || null,
      doi: info.doi || '',
      arxiv: info.arxiv || '',
      pages: info.pages || 0,
      fileName,
      sha256: sha,
      size: buf.length,
      note: '',
      labels: [],
      checks: [],
      groupId: null,
      pos: null,
      needsReview: !(info.title && info.author && info.year),
      warnings: info.warnings || [],
      createdAt: now,
      updatedAt: now,
    };
    this.db.papers.push(paper);
    this.save();
    return { paper, duplicate: false };
  }

  updatePaper(id, patch) {
    const p = this.paper(id);
    if (!p) return null;
    const allowed = ['title', 'author', 'year', 'doi', 'arxiv', 'note', 'labels', 'checks', 'groupId', 'pos', 'needsReview'];
    for (const k of allowed) if (k in patch) p[k] = patch[k];
    for (const k of ['title', 'author', 'doi', 'arxiv']) if (k in patch) p[k] = String(patch[k] ?? '').slice(0, 500);
    if ('note' in patch) p.note = String(patch.note ?? '');
    if ('needsReview' in patch) p.needsReview = !!patch.needsReview;
    if ('pos' in patch) {
      const x = Number(patch.pos?.x), y = Number(patch.pos?.y);
      p.pos = Number.isFinite(x) && Number.isFinite(y) ? { x: Math.max(0, Math.round(x)), y: Math.max(0, Math.round(y)) } : null;
    }
    if ('year' in patch) p.year = patch.year === '' || patch.year === null ? null : Number(patch.year) || null;
    if ('labels' in patch) p.labels = [...new Set((patch.labels || []).filter((l) => this.db.labels.some((x) => x.id === l)))];
    if ('checks' in patch) p.checks = [...new Set((patch.checks || []).filter((c) => this.db.checks.some((x) => x.id === c)))];
    if ('groupId' in patch && patch.groupId && !this.db.groups.some((g) => g.id === patch.groupId)) p.groupId = null;
    if (['title', 'author', 'year'].some((k) => k in patch) && !('needsReview' in patch)) p.needsReview = false;
    p.updatedAt = new Date().toISOString();
    this.save();
    return p;
  }

  deletePaper(id) {
    const i = this.db.papers.findIndex((p) => p.id === id);
    if (i < 0) return false;
    this.db.papers.splice(i, 1);
    this.db.links = this.db.links.filter((l) => l.a !== id && l.b !== id);
    // PDF 는 지우지 않고 trash/ 로 옮긴다 (실수 되돌리기)
    const trash = path.join(this.dir, 'trash');
    fs.mkdirSync(trash, { recursive: true });
    const src = this.pdfPath(id);
    if (fs.existsSync(src)) fs.renameSync(src, path.join(trash, id + '.pdf'));
    this.save();
    return true;
  }

  // 링크는 방향 없음. 같은 쌍이 이미 있으면 그것을 돌려준다.
  link(a, b, note = '') {
    if (a === b) throw new Error('자기 자신과는 연결할 수 없어요');
    if (!this.paper(a) || !this.paper(b)) throw new Error('없는 논문이에요');
    const ex = this.db.links.find((l) => (l.a === a && l.b === b) || (l.a === b && l.b === a));
    if (ex) return { link: ex, existed: true };
    const link = { id: newId('l'), a, b, note, createdAt: new Date().toISOString() };
    this.db.links.push(link);
    this.save();
    return { link, existed: false };
  }

  unlink(id) {
    const n = this.db.links.length;
    this.db.links = this.db.links.filter((l) => l.id !== id);
    if (this.db.links.length !== n) this.save();
    return this.db.links.length !== n;
  }

  // 라벨 · 체크 · 그룹: 같은 모양의 목록
  addItem(kind, data) {
    const list = this.db[kind];
    const name = String(data.name || '').trim();
    if (!name) throw new Error('이름이 비었어요');
    if (list.some((x) => x.name === name && (kind !== 'groups' || (x.parentId || null) === (data.parentId || null))))
      throw new Error('같은 이름이 이미 있어요');
    const prefix = { labels: 'lb', checks: 'chk', groups: 'g' }[kind];
    const item = { id: newId(prefix), name };
    if (kind === 'labels' || kind === 'groups') item.color = COLORS.includes(data.color) ? data.color : COLORS[list.length % COLORS.length];
    if (kind === 'checks') item.icon = String(data.icon || '☑️').slice(0, 4);
    if (kind === 'groups') {
      item.parentId = data.parentId && this.db.groups.some((g) => g.id === data.parentId) ? data.parentId : null;
      item.collapsed = false;
    }
    list.push(item);
    this.save();
    return item;
  }

  updateItem(kind, id, patch) {
    const it = this.db[kind].find((x) => x.id === id);
    if (!it) return null;
    if ('name' in patch && String(patch.name).trim()) it.name = String(patch.name).trim();
    if ('color' in patch && COLORS.includes(patch.color)) it.color = patch.color;
    if ('icon' in patch && kind === 'checks') it.icon = String(patch.icon).slice(0, 4);
    if ('collapsed' in patch && kind === 'groups') it.collapsed = !!patch.collapsed;
    if ('parentId' in patch && kind === 'groups') {
      const pid = patch.parentId || null;
      // 자기 자신이나 자기 후손 아래로는 못 옮긴다 (순환)
      let cur = pid;
      while (cur) {
        if (cur === id) throw new Error('자기 아래 그룹으로는 옮길 수 없어요');
        cur = this.db.groups.find((g) => g.id === cur)?.parentId || null;
      }
      if (pid && !this.db.groups.some((g) => g.id === pid)) throw new Error('없는 그룹이에요');
      it.parentId = pid;
    }
    this.save();
    return it;
  }

  deleteItem(kind, id) {
    const list = this.db[kind];
    const it = list.find((x) => x.id === id);
    if (!it) return false;
    this.db[kind] = list.filter((x) => x.id !== id);
    if (kind === 'labels') for (const p of this.db.papers) p.labels = p.labels.filter((l) => l !== id);
    if (kind === 'checks') for (const p of this.db.papers) p.checks = p.checks.filter((c) => c !== id);
    if (kind === 'groups') {
      // 하위 그룹 · 논문은 부모 그룹으로 올린다
      for (const g of this.db.groups) if (g.parentId === id) g.parentId = it.parentId || null;
      for (const p of this.db.papers) if (p.groupId === id) p.groupId = it.parentId || null;
    }
    this.save();
    return true;
  }
}
