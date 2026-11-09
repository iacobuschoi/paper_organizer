// 시험용 작은 PDF 를 만든다. lines: [{ text, size, y }] — Helvetica, 첫 페이지 하나.
export function makePdf({ lines = [], info = {} } = {}) {
  const esc = (s) => s.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
  const stream = lines.map((l) => `BT /F1 ${l.size} Tf 72 ${l.y} Td (${esc(l.text)}) Tj ET`).join('\n');
  const infoEntries = Object.entries(info).map(([k, v]) => `/${k} (${esc(v)})`).join(' ');
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< ${infoEntries} >>`,
  ];
  let out = '%PDF-1.4\n';
  const offs = [];
  objs.forEach((o, i) => {
    offs.push(Buffer.byteLength(out));
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = Buffer.byteLength(out);
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` + offs.map((o) => String(o).padStart(10, '0') + ' 00000 n \n').join('');
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R /Info 6 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

export const samplePaper = (title, author, year, extra = '') =>
  makePdf({
    lines: [
      { text: title, size: 20, y: 700 },
      { text: `${author}, Second Author and Third Author`, size: 11, y: 670 },
      { text: 'Department of Mechanical Engineering, Some University', size: 9, y: 655 },
      { text: 'Abstract', size: 11, y: 620 },
      { text: `We study things. Published in ${year}. ${extra}`, size: 10, y: 600 },
    ],
  });
