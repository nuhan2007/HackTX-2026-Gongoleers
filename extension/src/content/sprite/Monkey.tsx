// The default sprite: a pixel monkey, drawn from the layers in monkeyArt.ts (36 x 36 cells). Each layer becomes a few <path>s, one per
// colour, so the whole monkey is a handful of SVG nodes with no image to load (a page's strict security policy can't block it).
// Faces and poses are just different layers; blinking and the tail's sway are CSS, so they cost nothing.
import { memo, useMemo } from 'react';
import { GRID, LAYERS, PALETTE } from './monkeyArt';

export type Mood = 'idle' | 'think' | 'alert' | 'cheer' | 'worry' | 'happy';

/** A layer as one path per colour: a run of same-coloured cells in a row is one rectangle. */
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
  return [...byColor].map(([ch, d]) => ({ color: PALETTE[ch], d }));
}

const cache = new Map<string, { color: string; d: string }[]>();
function layer(name: string) {
  let p = cache.get(name);
  if (!p) {
    p = pathsOf(LAYERS[name] ?? []);
    cache.set(name, p);
  }
  return p;
}

function Layer({ name, className }: { name: string; className?: string }) {
  const paths = layer(name);
  return (
    <g className={className}>
      {paths.map((p) => (
        <path key={p.color + p.d.length} d={p.d} fill={p.color} />
      ))}
    </g>
  );
}

/** What each mood shows: the eyes, the mouth, the arms, whether the near cheek blushes. */
const FACES: Record<Mood, { eyes: string; mouth: string; arms: string; backArms?: string; frontExtra?: string; blush: boolean; blinks: boolean }> = {
  idle: { eyes: 'eyes_open', mouth: 'mouth_smile', arms: 'arms_rest', blush: true, blinks: true },
  think: { eyes: 'eyes_think', mouth: 'mouth_neutral', arms: 'arms_chin', blush: false, blinks: false },
  alert: { eyes: 'eyes_wide', mouth: 'mouth_o', arms: 'arms_whoa', blush: false, blinks: false },
  cheer: { eyes: 'eyes_happy', mouth: 'mouth_cheer', arms: 'arms_up', backArms: 'arms_up_back', blush: true, blinks: false },
  worry: { eyes: 'eyes_worry', mouth: 'mouth_frown', arms: 'arms_rest', blush: false, blinks: true },
  happy: { eyes: 'eyes_happy', mouth: 'mouth_smile', arms: 'arms_rest', blush: true, blinks: false },
};

/** The monkey in a given mood. It faces right in the art; the sprite mirrors it so it faces the page. */
export const Monkey = memo(function Monkey({ mood = 'idle', title }: { mood?: Mood; title?: string }) {
  const f = FACES[mood];
  const viewBox = useMemo(() => `0 0 ${GRID} ${GRID}`, []);
  return (
    <svg className={`monkey mood-${mood}`} viewBox={viewBox} shapeRendering="crispEdges" role={title ? 'img' : undefined} aria-label={title} aria-hidden={title ? undefined : true}>
      <Layer name="tail" className="tail" />
      <Layer name="torso" />
      {f.backArms && <Layer name={f.backArms} className="arm-back" />}
      <Layer name="head" />
      {f.blush && <Layer name="cheeks" />}
      <Layer name={f.eyes} className={f.blinks ? 'eyes open' : 'eyes'} />
      {f.blinks && <Layer name="eyes_blink" className="eyes shut" />}
      <Layer name={f.mouth} />
      <Layer name={f.arms} className="arm-front" />
    </svg>
  );
});
