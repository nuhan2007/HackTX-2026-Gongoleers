// IDLE → RISING → CONFUSED → COOLDOWN → IDLE. Timers are absolute timestamps so the
// state survives a service-worker restart without drifting.
import { HYSTERESIS, type TriggerConfig } from '../shared/constants';
import type { TriggerPhase } from '../shared/types';

export interface TriggerState {
  phase: TriggerPhase;
  aboveSince: number | null;
  confusedAt: number | null;
  cooldownUntil: number;
}

export interface TriggerContext {
  enabled: boolean;
  snoozedUntil: number;
}

export function initialTriggerState(): TriggerState {
  return { phase: 'idle', aboveSince: null, confusedAt: null, cooldownUntil: 0 };
}

/** Returns the next state and whether the nudge should fire on this tick. */
export function stepTrigger(
  s: TriggerState,
  score: number,
  now: number,
  cfg: TriggerConfig,
  ctx: TriggerContext,
): { state: TriggerState; fired: boolean } {
  if (!ctx.enabled || now < ctx.snoozedUntil) {
    // Snooze/off keep an active cooldown but drop anything in progress.
    return { state: { ...initialTriggerState(), cooldownUntil: s.cooldownUntil }, fired: false };
  }

  switch (s.phase) {
    case 'cooldown':
      if (now < s.cooldownUntil) return { state: s, fired: false };
      return stepTrigger({ ...s, phase: 'idle' }, score, now, cfg, ctx);

    case 'idle':
      if (score >= cfg.threshold) {
        return stepTrigger({ ...s, phase: 'rising', aboveSince: now }, score, now, cfg, ctx);
      }
      return { state: s, fired: false };

    case 'rising':
      // Hysteresis: a dip between threshold-HYSTERESIS and threshold keeps the timer running.
      if (score < cfg.threshold - HYSTERESIS) return { state: { ...s, phase: 'idle', aboveSince: null }, fired: false };
      if (s.aboveSince !== null && now - s.aboveSince >= cfg.durationSec * 1000) {
        return { state: { ...s, phase: 'confused', confusedAt: now }, fired: true };
      }
      return { state: s, fired: false };

    case 'confused':
      // Recovered on their own: hide the nudge and cool down.
      if (score < cfg.threshold - HYSTERESIS) return { state: enterCooldown(s, now, cfg), fired: false };
      return { state: s, fired: false };
  }
}

/** Called when the student dismisses the nudge or finishes a tutor session. */
export function enterCooldown(s: TriggerState, now: number, cfg: TriggerConfig): TriggerState {
  return { ...s, phase: 'cooldown', aboveSince: null, confusedAt: null, cooldownUntil: now + cfg.cooldownSec * 1000 };
}

/** Dev-only "Force trigger": jump straight to confused. */
export function forceConfused(s: TriggerState, now: number): TriggerState {
  return { ...s, phase: 'confused', aboveSince: now, confusedAt: now };
}
