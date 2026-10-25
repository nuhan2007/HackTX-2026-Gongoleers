// A burst of bananas, stars, hearts and confetti for when the student gets the answer right. Drawn on a canvas laid over the page
// (pointer-events off), for about three seconds, then wiped. Pixel icons are drawn without smoothing so they stay chunky.
import { iconCanvas, type IconName } from './pixelIcons';

export interface ConfettiOptions {
  /** Where it shoots up from, in window coordinates. */
  x: number;
  y: number;
  count?: number;
  durationMs?: number;
}

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  rot: number;
  vr: number;
  born: number;
  life: number;
  kind: IconName | 'square';
  scale: number;
  color: string;
  size: number;
}

const COLORS = ['#ffc933', '#ff6b81', '#3ddbd9', '#9b8cff', '#7bd88f', '#ff9f43'];
const ICONS: IconName[] = ['banana', 'banana', 'banana', 'star', 'heart', 'spark'];

export function confettiBurst(canvas: HTMLCanvasElement, o: ConfettiOptions): () => void {
  const g = canvas.getContext('2d');
  if (!g || window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return () => undefined;
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  canvas.width = Math.round(window.innerWidth * dpr);
  canvas.height = Math.round(window.innerHeight * dpr);
  g.setTransform(dpr, 0, 0, dpr, 0, 0);

  const now = performance.now();
  const count = o.count ?? 64;
  const parts: Particle[] = Array.from({ length: count }, (_, i) => {
    const angle = -Math.PI / 2 + (Math.random() - 0.5) * 1.5; // a fan, mostly upward
    const speed = 420 + Math.random() * 520;
    const icon = i % 3 === 0 ? ICONS[Math.floor(Math.random() * ICONS.length)] : null;
    return {
      x: o.x + (Math.random() - 0.5) * 30,
      y: o.y + (Math.random() - 0.5) * 20,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed,
      rot: Math.random() * Math.PI * 2,
      vr: (Math.random() - 0.5) * 9,
      born: now + Math.random() * 160,
      life: (o.durationMs ?? 3200) * (0.7 + Math.random() * 0.3),
      kind: icon ?? 'square',
      scale: icon === 'spark' ? 2 : 3,
      color: COLORS[Math.floor(Math.random() * COLORS.length)],
      size: 5 + Math.random() * 6,
    };
  });

  let raf = 0;
  let last = now;
  let stopped = false;
  const stop = () => {
    stopped = true;
    cancelAnimationFrame(raf);
    g.clearRect(0, 0, window.innerWidth, window.innerHeight);
  };
  const frame = (t: number) => {
    if (stopped) return;
    const dt = Math.min(0.05, (t - last) / 1000);
    last = t;
    g.clearRect(0, 0, window.innerWidth, window.innerHeight);
    g.imageSmoothingEnabled = false;
    let alive = 0;
    for (const p of parts) {
      const age = t - p.born;
      if (age < 0) {
        alive++;
        continue;
      }
      if (age > p.life) continue;
      alive++;
      p.vy += 980 * dt;
      p.vx *= 1 - 0.55 * dt;
      p.vy *= 1 - 0.25 * dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.rot += p.vr * dt;
      const fade = Math.min(1, (p.life - age) / 600);
      g.save();
      g.globalAlpha = Math.max(0, fade);
      g.translate(p.x, p.y);
      g.rotate(p.rot);
      if (p.kind === 'square') {
        g.fillStyle = p.color;
        g.fillRect(-p.size / 2, -p.size / 4, p.size, p.size / 2);
      } else {
        const c = iconCanvas(p.kind, p.scale);
        g.drawImage(c, -c.width / 2, -c.height / 2);
      }
      g.restore();
    }
    if (alive > 0) raf = requestAnimationFrame(frame);
    else stop();
  };
  raf = requestAnimationFrame(frame);
  return stop;
}
