// The character on screen: the pixel monkey, or the picture the student turned into a sticker. Either way it has a shadow, an idle
// animation, a pose for each mood, and a little pixel "!" or "?" that pops up over its head. Used by the sprite on web pages and by the
// preview in setup, so what they see there is exactly what they get.
import { memo, useEffect, useRef, useState, type CSSProperties } from 'react';
import { bitmapOfDataUrl } from '../../shared/imageData';
import type { MySprite } from '../../shared/mySprite';
import { Monkey, type Mood } from './Monkey';
import { PixelIcon, type IconName } from './pixelIcons';

const EMOTE: Partial<Record<Mood, IconName>> = { think: 'quest', alert: 'excl', cheer: 'star', worry: 'drop' };

/** A sticker drawn on a canvas: no <img>, so a page that blocks images from data: URLs can't stop it. */
const Sticker = memo(function Sticker({ png, pixel }: { png: string; pixel: boolean }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    let dead = false;
    void bitmapOfDataUrl(png)
      .then((bmp) => {
        const c = ref.current;
        if (dead || !c) return bmp.close();
        c.width = bmp.width;
        c.height = bmp.height;
        const g = c.getContext('2d');
        g?.drawImage(bmp, 0, 0);
        bmp.close();
      })
      .catch(() => undefined);
    return () => {
      dead = true;
    };
  }, [png]);
  return <canvas ref={ref} className={`sticker ${pixel ? 'pixel' : ''}`} aria-hidden="true" />;
});

/**
 * How big to draw pixel art so that every cell is a whole number of SCREEN pixels. On a display with 125% or 150% scaling a 108px sprite
 * would put 3.75 or 4.5 screen pixels in a cell and the pixel art would look uneven, so the size is nudged to the nearest size that doesn't.
 */
export function snappedSize(cells: number, target: number, dpr: number): number {
  const k = Math.max(2, Math.round((target * dpr) / cells));
  return (cells * k) / dpr;
}

function useSnappedSize(cells: number, target = 108): number {
  const [dpr, setDpr] = useState(() => window.devicePixelRatio || 1);
  useEffect(() => {
    const on = () => setDpr(window.devicePixelRatio || 1);
    window.addEventListener('resize', on);
    return () => window.removeEventListener('resize', on);
  }, []);
  return snappedSize(cells, target, dpr);
}

export interface AvatarProps {
  mood: Mood;
  sprite?: MySprite;
  /** Show the pixel "!" / "?" over its head for moods that have one. */
  emote?: boolean;
  /** Draw it as if just arrived (pop in). */
  entering?: boolean;
  /** The monkey faces the page; in setup previews it can face right. */
  mirror?: boolean;
  label?: string;
}

export const Avatar = memo(function Avatar({ mood, sprite, emote = true, entering = false, mirror = true, label }: AvatarProps) {
  const custom = sprite?.mode === 'custom' && sprite.png ? sprite : null;
  const icon = emote ? EMOTE[mood] : undefined;
  const px = useSnappedSize(36);
  // Remount the emote when the mood changes, so it pops every time.
  const [tick, setTick] = useState(0);
  useEffect(() => setTick((t) => t + 1), [mood]);
  return (
    <div className={`avatar mood-${mood} ${custom ? 'is-custom' : 'is-monkey'} ${mirror ? 'mirror' : ''} ${entering ? 'entering' : ''}`} role="img" aria-label={label ?? custom?.name ?? 'myTA'}>
      <div className="shadow" />
      <div className="body" style={{ ['--px' as string]: `${px}px` } as CSSProperties}>
        {custom ? <Sticker png={custom.png!} pixel={custom.style === 'pixel'} /> : <Monkey mood={mood} />}
      </div>
      {icon && (
        <div className="emote" key={`${mood}-${tick}`}>
          <PixelIcon name={icon} scale={3} />
        </div>
      )}
    </div>
  );
});
