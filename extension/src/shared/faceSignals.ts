// Pure face-feature math (no MediaPipe import), safe to use in the service worker.
import { FACE_EMA_ALPHA, FACE_MEDIAN_WINDOW } from './constants';
import type { CalibrationBaseline, FaceSignalId, Signal } from './types';

export type RawFace = Record<FaceSignalId, number>;

const REASONS: Record<FaceSignalId, string> = {
  browFurrow: 'brow furrowed',
  browRaise: 'puzzled brow raise',
  squint: 'squinting at the screen',
  lipPress: 'lips pressed / frowning',
  headTilt: 'head tilted',
};
// Generous floors: a calm baseline has a tiny σ, which would otherwise make small twitches look huge.
const STD_FLOOR: Record<FaceSignalId, number> = { browFurrow: 0.025, browRaise: 0.025, squint: 0.025, lipPress: 0.025, headTilt: 2.5 };
const Z_START = 0.7;
const Z_FULL = 2.2;

/** z-score against the student's own neutral baseline: 0 at +0.7σ, 1 at +2.2σ (a mild, held expression). */
export function toSignals(raw: RawFace, baseline: CalibrationBaseline): Signal[] {
  const out: Signal[] = [];
  for (const id of Object.keys(REASONS) as FaceSignalId[]) {
    const mean = baseline.mean[id] ?? 0;
    const std = Math.max(baseline.std[id] ?? 0, STD_FLOOR[id]);
    const z = (raw[id] - mean) / std;
    const value = Math.min(1, Math.max(0, (z - Z_START) / (Z_FULL - Z_START)));
    if (value > 0) out.push({ id, value, reason: REASONS[id] });
  }
  return out;
}

export function averageRaw(samples: RawFace[]): RawFace {
  const keys = Object.keys(REASONS) as FaceSignalId[];
  const out = {} as RawFace;
  for (const k of keys) out[k] = samples.reduce((a, s) => a + s[k], 0) / Math.max(1, samples.length);
  return out;
}

export function buildBaseline(samples: RawFace[]): CalibrationBaseline {
  const mean = averageRaw(samples);
  const std: Record<string, number> = {};
  for (const k of Object.keys(mean) as FaceSignalId[]) {
    std[k] = Math.sqrt(samples.reduce((a, s) => a + (s[k] - mean[k]) ** 2, 0) / Math.max(1, samples.length));
  }
  return { mean, std, capturedAt: Date.now() };
}

/**
 * Per-feature smoothing for the once-a-second face readings: a rolling median drops one-off
 * spikes (a blink, a sneeze), then a slow EMA turns the rest into a steady trend.
 */
export class FaceSmoother {
  private history: RawFace[] = [];
  private ema: RawFace | null = null;

  push(raw: RawFace): RawFace {
    this.history = [...this.history, raw].slice(-FACE_MEDIAN_WINDOW);
    const keys = Object.keys(REASONS) as FaceSignalId[];
    const med = {} as RawFace;
    for (const k of keys) {
      const xs = this.history.map((h) => h[k]).sort((a, b) => a - b);
      med[k] = xs[Math.floor(xs.length / 2)];
    }
    if (!this.ema) this.ema = med;
    else for (const k of keys) this.ema[k] += FACE_EMA_ALPHA * (med[k] - this.ema[k]);
    return { ...this.ema };
  }

  reset(): void {
    this.history = [];
    this.ema = null;
  }
}
