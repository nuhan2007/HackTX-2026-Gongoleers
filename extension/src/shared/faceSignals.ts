// Pure face-feature math (no MediaPipe import), safe to use in the service worker.
import type { CalibrationBaseline, FaceSignalId, Signal } from './types';

export type RawFace = Record<FaceSignalId, number>;

const REASONS: Record<FaceSignalId, string> = {
  browFurrow: 'brow furrowed',
  browRaise: 'puzzled brow raise',
  squint: 'squinting at the screen',
  lipPress: 'lips pressed / frowning',
  headTilt: 'head tilted',
};
const STD_FLOOR: Record<FaceSignalId, number> = { browFurrow: 0.03, browRaise: 0.03, squint: 0.03, lipPress: 0.03, headTilt: 3 };

/** z-score against the student's own neutral baseline: 0 at +1σ, 1 at +3σ. */
export function toSignals(raw: RawFace, baseline: CalibrationBaseline): Signal[] {
  const out: Signal[] = [];
  for (const id of Object.keys(REASONS) as FaceSignalId[]) {
    const mean = baseline.mean[id] ?? 0;
    const std = Math.max(baseline.std[id] ?? 0, STD_FLOOR[id]);
    const z = (raw[id] - mean) / std;
    const value = Math.min(1, Math.max(0, (z - 1) / 2));
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
