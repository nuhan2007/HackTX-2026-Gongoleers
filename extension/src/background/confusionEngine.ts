// Pure fusion logic: signals in, smoothed 0..100 confusion score out.
// State is a plain JSON object so engineStore can persist it across service-worker restarts.
import {
  CHANNEL_ALPHA_PER_SEC,
  CHANNEL_GAIN,
  DWELL_RAMP_MS,
  DWELL_START_MS,
  EMA_ALPHA_PER_SEC,
  IDLE_RAMP_MS,
  IDLE_START_MS,
  SIGNAL_WEIGHTS,
  TIMELINE_LENGTH,
} from '../shared/constants';
import type { Channel, EngineInput, EngineOutput, Signal, TimelinePoint } from '../shared/types';

export interface EngineState {
  ema: number; // 0..1
  /** Smoothed per-channel values (what the fusion and the Live meters use). */
  channels: Record<Channel, number>;
  lastTs: number | null;
  /** Face-away time accumulated since the last page input; subtracted from idle so it "pauses". */
  idleAwayMs: number;
  dwellAwayMs: number;
  lastIdleMs: number;
  lastDwellMs: number;
  timeline: TimelinePoint[];
}

export function initialEngineState(): EngineState {
  return { ema: 0, channels: { activity: 0, face: 0 }, lastTs: null, idleAwayMs: 0, dwellAwayMs: 0, lastIdleMs: 0, lastDwellMs: 0, timeline: [] };
}

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));
const ramp = (ms: number, start: number, len: number) => clamp01((ms - start) / len);

function fmtDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  return s >= 90 ? `${Math.round(s / 60)} min` : `${s}s`;
}

/** Noisy-OR within a channel: 1 - Π(1 - w·v). */
function channelScore(signals: Signal[]): number {
  let keep = 1;
  for (const s of signals) keep *= 1 - SIGNAL_WEIGHTS[s.id].weight * clamp01(s.value);
  return 1 - keep;
}

export function step(prev: EngineState, input: EngineInput): { state: EngineState; output: EngineOutput } {
  const { now, page, face } = input;
  const dt = prev.lastTs === null ? 1000 : Math.max(0, Math.min(now - prev.lastTs, 10_000));
  // Only an actual look-away pauses idle. A face the camera simply can't find (lighting, glasses, angle)
  // must not freeze the score, or the owl could never appear.
  const away = !!face && face.facePresent && face.gazeAway;

  const state: EngineState = { ...prev, lastTs: now };
  const signals: Signal[] = [...input.tab];

  if (page) {
    signals.push(...page.activity);

    // Idle/dwell timers reset when the page reports fresh input (the counter went down).
    if (page.idleMs < prev.lastIdleMs) state.idleAwayMs = 0;
    if (page.dwellMs < prev.lastDwellMs) state.dwellAwayMs = 0;
    if (away) {
      state.idleAwayMs += dt;
      state.dwellAwayMs += dt;
    }
    state.lastIdleMs = page.idleMs;
    state.lastDwellMs = page.dwellMs;

    const idle = Math.max(0, page.idleMs - state.idleAwayMs);
    const dwell = Math.max(0, page.dwellMs - state.dwellAwayMs);
    const idleV = ramp(idle, IDLE_START_MS, IDLE_RAMP_MS);
    const dwellV = ramp(dwell, DWELL_START_MS, DWELL_RAMP_MS);
    if (idleV > 0) signals.push({ id: 'idle', value: idleV, reason: `idle ${fmtDuration(idle)} on the problem` });
    if (dwellV > 0)
      signals.push({ id: 'dwell', value: dwellV, reason: `${fmtDuration(dwell)} on ${page.questionLabel} with no progress` });
  }

  const faceUsable = !!face && face.facePresent;
  if (faceUsable) signals.push(...face!.signals);

  const byChannel: Record<Channel, Signal[]> = { activity: [], face: [] };
  for (const s of signals) byChannel[SIGNAL_WEIGHTS[s.id].channel].push(s);
  const rawChannels: Record<Channel, number> = {
    activity: channelScore(byChannel.activity),
    face: channelScore(byChannel.face),
  };

  // Smooth each channel first so one twitchy frame can't swing the score.
  const prevCh = prev.channels ?? { activity: 0, face: 0 };
  const chAlpha = 1 - Math.pow(1 - CHANNEL_ALPHA_PER_SEC, dt / 1000);
  const channels = { ...prevCh };
  for (const c of ['activity', 'face'] as Channel[]) {
    // While no face is visible the face channel holds its value (it's excluded from fusion below).
    if (c === 'face' && !faceUsable) continue;
    channels[c] = prev.lastTs === null ? rawChannels[c] * chAlpha : prevCh[c] + chAlpha * (rawChannels[c] - prevCh[c]);
  }
  state.channels = channels;

  // Noisy-OR across channels: either one can carry the score, and agreement adds up smoothly.
  // With no face visible, the face simply doesn't contribute (and never drags the score down).
  const active: Channel[] = faceUsable ? ['activity', 'face'] : ['activity'];
  const raw = clamp01(1 - active.reduce((keep, c) => keep * (1 - CHANNEL_GAIN[c] * channels[c]), 1));

  const alpha = 1 - Math.pow(1 - EMA_ALPHA_PER_SEC, dt / 1000);
  state.ema = prev.lastTs === null ? raw * alpha : prev.ema + alpha * (raw - prev.ema);

  const topContributors = signals
    .map((s) => ({ s, impact: SIGNAL_WEIGHTS[s.id].weight * CHANNEL_GAIN[SIGNAL_WEIGHTS[s.id].channel] * s.value }))
    .filter((x) => x.impact > 0.02)
    .sort((a, b) => b.impact - a.impact)
    .slice(0, 4)
    .map((x) => x.s.reason);

  const score = Math.round(state.ema * 100);
  const last = prev.timeline[prev.timeline.length - 1];
  if (!last || now - last.t >= 1000) {
    state.timeline = [...prev.timeline, { t: now, score, reasons: topContributors }].slice(-TIMELINE_LENGTH);
  }

  return { state, output: { score, channels: { ...channels, face: faceUsable ? channels.face : 0 }, topContributors } };
}
