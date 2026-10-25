// IDLE → RISING → CONFUSED → COOLDOWN → IDLE. Timers are absolute timestamps so the
// state survives a service-worker restart without drifting.
//
// The one rule that decides when the sprite appears: the confusion score stays AT OR ABOVE the threshold for
// `durationSec` seconds in a row. The timer starts the moment the score reaches the threshold and starts over if
// it drops below it, even for a moment (the score is already smoothed, so it doesn't jitter). Once the sprite is
// showing, it only goes away again when the score falls clearly (HYSTERESIS) below the threshold.
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
      // Any dip below the threshold starts the count over.
      if (score < cfg.threshold) return { state: { ...s, phase: 'idle', aboveSince: null }, fired: false };
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

/** How the timer stands, in words the side panel can show: seconds above the threshold so far, out of the seconds needed. */
export function triggerProgress(s: TriggerState, now: number): { aboveSec: number | null; cooldownLeftSec: number } {
  return {
    aboveSec: s.phase === 'rising' && s.aboveSince !== null ? Math.max(0, Math.floor((now - s.aboveSince) / 1000)) : null,
    cooldownLeftSec: s.phase === 'cooldown' ? Math.max(0, Math.ceil((s.cooldownUntil - now) / 1000)) : 0,
  };
}

/** Dev-only "Force trigger": jump straight to confused. */
export function forceConfused(s: TriggerState, now: number): TriggerState {
  return { ...s, phase: 'confused', aboveSince: now, confusedAt: now };
}
