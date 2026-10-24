// Generates demo/physics.pdf (a plain one-page problem sheet) without any PDF dependency.
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const out = join(dirname(fileURLToPath(import.meta.url)), '../../demo/physics.pdf');
const lines = [
  ['F2', 18, 'Physics 1 - Problem Set 5: Energy'],
  ['F1', 12, ''],
  ['F2', 13, 'Problem 2.'],
  ['F1', 12, 'A 2.0 kg block starts from rest at the top of a frictionless ramp'],
  ['F1', 12, 'that is 5.0 m high. It slides down the ramp and onto a level'],
  ['F1', 12, 'floor. What is the speed of the block at the bottom of the ramp?'],
  ['F1', 12, 'Use g = 9.8 m/s^2.'],
  ['F1', 12, ''],
  ['F1', 12, 'Answer: v = ______________ m/s'],
  ['F1', 12, ''],
  ['F2', 13, 'Problem 3.'],
  ['F1', 12, 'The same block then hits a spring (k = 400 N/m) on the floor.'],
  ['F1', 12, 'How far does the spring compress before the block stops?'],
];
const esc = (s) => s.replace(/[\\()]/g, (c) => '\\' + c);
let y = 740;
const content = ['BT'];
for (const [font, size, text] of lines) {
  content.push(`/${font} ${size} Tf 1 0 0 1 72 ${y} Tm (${esc(text)}) Tj`);
  y -= size + 10;
}
content.push('ET');
const stream = content.join('\n');

const objs = [
  '<< /Type /Catalog /Pages 2 0 R >>',
  '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
  '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R /F2 6 0 R >> >> >>',
  `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
  '<< /Type /Font /Subtype /Type1 /BaseFont /Times-Roman >>',
  '<< /Type /Font /Subtype /Type1 /BaseFont /Times-Bold >>',
];
let pdf = '%PDF-1.4\n';
const offsets = [];
objs.forEach((o, i) => {
  offsets.push(Buffer.byteLength(pdf));
  pdf += `${i + 1} 0 obj\n${o}\nendobj\n`;
});
const xref = Buffer.byteLength(pdf);
pdf += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
for (const off of offsets) pdf += `${String(off).padStart(10, '0')} 00000 n \n`;
pdf += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
writeFileSync(out, pdf, 'latin1');
console.log('wrote', out);
