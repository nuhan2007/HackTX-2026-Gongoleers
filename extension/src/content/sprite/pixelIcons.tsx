// Little pixel icons that go with the sprite: the "!" and "?" that pop up over its head, stars and hearts, a sweat drop, and the banana
// that rains down when the student gets an answer right. Same idea as the monkey: a grid of letters, drawn as SVG paths or on a canvas.
import { memo } from 'react';

export type IconName = 'excl' | 'quest' | 'star' | 'heart' | 'drop' | 'banana' | 'spark' | 'zzz' | 'book';

const COLORS: Record<string, string> = {
  O: '#2a1810',
  Y: '#ffc933',
  W: '#fff6c9',
  R: '#ff5d6c',
  P: '#ff9aa6',
  U: '#59b8ff',
  V: '#bfe6ff',
  G: '#ffe36b',
  K: '#c9902a',
  N: '#8a5a2b',
  B: '#7a4a2b',
  L: '#f2d6a8',
  S: '#fff',
};

const BITMAPS: Record<IconName, string[]> = {
  excl: [
    '.OOOO.',
    'OYYYYO',
    'OYWYYO',
    'OYYYYO',
    'OYYYYO',
    '.OYYO.',
    '.OYYO.',
    '..OO..',
    '.OOOO.',
    'OYYYYO',
    'OYYYYO',
    '.OOOO.',
  ],
  quest: [
    '.OOOOO.',
    'OYYYYYO',
    'OYWWYYO',
    'OOOOYYO',
    '..OYYO.',
    '.OYYO..',
    '.OYYO..',
    '..OO...',
    '.OOOO..',
    'OYYYYO.',
    'OYYYYO.',
    '.OOOO..',
  ],
  star: [
    '....O....',
    '...OYO...',
    '...OYO...',
    'OOOOWYOOO',
    'OYYYWYYYO',
    '.OYYYYYO.',
    '..OYYYO..',
    '..OYOYO..',
    '..OO.OO..',
  ],
  heart: ['.OO.OO.', 'ORROORO', 'ORWRRRO', 'ORRRRRO', '.ORRRO.', '..ORO..', '...O...'],
  drop: ['..O..', '.OUO.', '.OUO.', 'OUVUO', 'OUUUO', '.OUO.', '..O..'],
  banana: ['.OO.........OO.', 'OKKO.......OYYO', 'OKYYO.....OYYYO', '.OYYYOOOOOYYYO.', '..OYYYYYYYYYO..', '...OOYYYYYOO...', '.....OOOOO.....'],
  spark: ['..O..', '..W..', 'OWWWO', '..W..', '..O..'],
  zzz: ['OOOOO', '...O.', '..O..', '.O...', 'OOOOO'],
  book: [
    '.OOOOOOOOOO.',
    'ONNNNONNNNNO',
    'ONLLLONLLLNO',
    'ONLOLONLOLNO',
    'ONLLLONLLLNO',
    'ONLOLONLOLNO',
    'ONLLLONLLLNO',
    'ONNNNONNNNNO',
    '.OOOOOOOOOO.',
  ],
};

/** The icon as one SVG path per colour. */
function pathsOf(rows: string[]): { color: string; d: string }[] {
  const byColor = new Map<string, string>();
  rows.forEach((row, y) => {
    let x = 0;
    while (x < row.length) {
      const ch = row[x];
      let end = x + 1;
      while (end < row.length && row[end] === ch) end++;
      if (ch !== '.') byColor.set(ch, `${byColor.get(ch) ?? ''}M${x} ${y}h${end - x}v1h${-(end - x)}z`);
      x = end;
    }
  });
  return [...byColor].map(([ch, d]) => ({ color: COLORS[ch] ?? '#000', d }));
}

export const ICON_SIZE = (name: IconName) => ({ w: BITMAPS[name][0].length, h: BITMAPS[name].length });

/** A pixel icon as inline SVG, `scale` screen pixels per cell. */
export const PixelIcon = memo(function PixelIcon({ name, scale = 3, className }: { name: IconName; scale?: number; className?: string }) {
  const { w, h } = ICON_SIZE(name);
  return (
    <svg className={className} width={w * scale} height={h * scale} viewBox={`0 0 ${w} ${h}`} shapeRendering="crispEdges" aria-hidden="true">
      {pathsOf(BITMAPS[name]).map((p) => (
        <path key={p.color} d={p.d} fill={p.color} />
      ))}
    </svg>
  );
});

/** The icon on a canvas of its own (for the confetti). */
const sprites = new Map<string, HTMLCanvasElement>();
export function iconCanvas(name: IconName, scale: number): HTMLCanvasElement {
  const key = `${name}@${scale}`;
  let c = sprites.get(key);
  if (c) return c;
  const rows = BITMAPS[name];
  c = document.createElement('canvas');
  c.width = rows[0].length * scale;
  c.height = rows.length * scale;
  const g = c.getContext('2d')!;
  rows.forEach((row, y) =>
    [...row].forEach((ch, x) => {
      if (ch === '.') return;
      g.fillStyle = COLORS[ch] ?? '#000';
      g.fillRect(x * scale, y * scale, scale, scale);
    }),
  );
  sprites.set(key, c);
  return c;
}
