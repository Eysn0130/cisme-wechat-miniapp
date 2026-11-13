import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

// Original geometric print plates. No raster noise, external art or SVG filters.
const directory = resolve('apps/miniprogram/assets/cisme');
mkdirSync(directory, { recursive: true });
const n = (v: number) => Math.round(v * 100) / 100;
const wrap = (body: string) => '<svg xmlns="http://www.w3.org/2000/svg" width="960" height="480" viewBox="0 0 960 480">' + body + '</svg>\n';
const rose: string[] = [];
for (let i = 0; i <= 144; i++) {
  const theta = i / 144 * Math.PI * 2, radius = 138 + 23 * Math.sin(theta * 11);
  rose.push((i ? 'L' : 'M') + n(Math.cos(theta) * radius) + ' ' + n(Math.sin(theta) * radius));
}
const rings = Array.from({ length: 21 }, (_, i) => '<use href="#rose" transform="rotate(' + n(i * 6.7) + ') scale(' + n(.52 + i * .025) + ')"/>').join('');
const strands = Array.from({ length: 25 }, (_, i) => '<path d="M-90 ' + (390 + i * 8) + 'C155 ' + (40 + i * 9) + ' 510 ' + (590 - i * 3) + ' 1050 ' + (-110 + i * 10) + '"/>').join('');
const engraving = '<defs><linearGradient id="ink" x1="0" x2="1" y1=".2" y2=".8"><stop stop-color="#80dee6"/><stop offset=".35" stop-color="#bf87db"/><stop offset=".67" stop-color="#ead09a"/><stop offset="1" stop-color="#9bcfc8"/></linearGradient><path id="rose" d="' + rose.join('') + 'Z"/></defs><g fill="none" stroke="url(#ink)" stroke-width="1.25" opacity=".66">' + strands + '</g><g transform="translate(737 204)" fill="none" stroke="url(#ink)" stroke-width="1.15">' + rings + '<circle r="34" opacity=".65"/><circle r="39" opacity=".45"/><circle r="166" opacity=".4"/></g>';
writeFileSync(resolve(directory, 'card-guilloche-v2.svg'), wrap(engraving));

const brush = Array.from({ length: 18 }, (_, i) => {
  const y = n(i * 3.6), bend = n(Math.sin(i * 1.7) * 2.5);
  return '<path d="M-4 ' + y + 'C16 ' + n(y + bend) + ' 42 ' + n(y - bend) + ' 68 ' + y + '" opacity="' + n(.24 + i % 4 * .12) + '"/>';
}).join('');
const facets = Array.from({ length: 11 }, (_, i) => {
  const x = n((i * 23.71 + 5) % 62), y = n((i * 17.37 + 7) % 62);
  return '<path d="M' + x + ' ' + y + 'l1.1 -.5 .8 1.5 -1.2 .6Z" opacity="' + n(.3 + i % 3 * .1) + '"/>';
}).join('');
writeFileSync(resolve(directory, 'card-silk-v2.svg'), wrap('<defs><pattern id="silk" width="64" height="64" patternUnits="userSpaceOnUse"><g fill="none" stroke="#ded2e9" stroke-width=".65">' + brush + '</g><g fill="#fff1da">' + facets + '</g></pattern></defs><path fill="url(#silk)" d="M0 0H960V480H0Z"/>'));
