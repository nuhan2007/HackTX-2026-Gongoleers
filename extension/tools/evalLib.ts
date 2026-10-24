// Replays label-mode logs through the trigger machine to measure precision / recall / lead time.
// The recorded score doesn't depend on the trigger settings, so a grid search over threshold
// and duration is a valid offline replay.
import type { LabelLog } from '../src/background/labelLogger';
import { enterCooldown, initialTriggerState, stepTrigger } from '../src/background/triggerMachine';
import type { TriggerConfig } from '../src/shared/constants';

/** A trigger "catches" a label if it fires up to EARLY_MS before or LATE_MS after the student pressed the key. */
export const EARLY_MS = 90_000;
export const LATE_MS = 30_000;
const EVAL_COOLDOWN_SEC = 60;

export interface EvalResult {
  threshold: number;
  durationSec: number;
  triggers: number;
  labels: number;
  precision: number;
  recall: number;
  medianLeadSec: number;
  f05: number;
}

export function replayTriggers(log: LabelLog, cfg: TriggerConfig): number[] {
  let s = initialTriggerState();
  const fired: number[] = [];
  for (const tick of [...log.ticks].sort((a, b) => a.t - b.t)) {
    const r = stepTrigger(s, tick.score, tick.t, cfg, { enabled: true, snoozedUntil: 0 });
    s = r.state;
    if (r.fired) {
      fired.push(tick.t);
      // In the extension the student answers the nudge; in replay assume it's acknowledged right away.
      s = enterCooldown(s, tick.t, cfg);
    }
  }
  return fired;
}

const median = (xs: number[]) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};

export function evaluate(logs: LabelLog[], threshold: number, durationSec: number): EvalResult {
  const cfg = { threshold, durationSec, cooldownSec: EVAL_COOLDOWN_SEC };
  let triggers = 0, goodTriggers = 0, labels = 0, caught = 0;
  const leads: number[] = [];
  for (const log of logs) {
    const fired = replayTriggers(log, cfg);
    triggers += fired.length;
    labels += log.labels.length;
    const matches = (f: number, l: number) => f >= l - EARLY_MS && f <= l + LATE_MS;
    goodTriggers += fired.filter((f) => log.labels.some((l) => matches(f, l))).length;
    for (const l of log.labels) {
      const hits = fired.filter((f) => matches(f, l));
      if (hits.length) {
        caught++;
        leads.push((l - Math.min(...hits)) / 1000);
      }
    }
  }
  const precision = triggers ? goodTriggers / triggers : 0;
  const recall = labels ? caught / labels : 0;
  // F0.5 weights precision higher: a false nudge annoys more than a late one.
  const f05 = precision + recall ? (1.25 * precision * recall) / (0.25 * precision + recall) : 0;
  return { threshold, durationSec, triggers, labels, precision, recall, medianLeadSec: median(leads), f05 };
}

export function gridSearch(logs: LabelLog[]): EvalResult[] {
  const out: EvalResult[] = [];
  for (let t = 35; t <= 80; t += 5) for (const d of [5, 10, 20, 30, 45, 60, 90]) out.push(evaluate(logs, t, d));
  return out.sort((a, b) => b.f05 - a.f05 || b.precision - a.precision);
}
