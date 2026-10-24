// Label mode: logs the numeric feature/score timeline plus "I feel stuck" key presses
// (Alt+Shift+S) so tools/evaluate.ts can measure trigger precision/recall.
import type { Channel, SignalId } from '../shared/types';

export interface LabelTick {
  t: number;
  score: number;
  channels: Record<Channel, number>;
  signals: Partial<Record<SignalId, number>>;
  fired: boolean;
}

export interface LabelLog {
  sessionStart: number;
  ticks: LabelTick[];
  labels: number[];
}

const KEY = 'labelLog';
const FLUSH_MS = 10_000;

export class LabelLogger {
  private buffer: LabelTick[] = [];
  private labels: number[] = [];
  private lastFlush = Date.now();

  tick(t: LabelTick): void {
    this.buffer.push(t);
    if (Date.now() - this.lastFlush > FLUSH_MS) void this.flush();
  }

  async label(now = Date.now()): Promise<void> {
    this.labels.push(now);
    await this.flush();
  }

  async flush(): Promise<void> {
    this.lastFlush = Date.now();
    if (!this.buffer.length && !this.labels.length) return;
    const ticks = this.buffer;
    const labels = this.labels;
    this.buffer = [];
    this.labels = [];
    const { [KEY]: log } = await chrome.storage.local.get(KEY);
    const cur: LabelLog = (log as LabelLog) ?? { sessionStart: Date.now(), ticks: [], labels: [] };
    cur.ticks.push(...ticks);
    cur.labels.push(...labels);
    await chrome.storage.local.set({ [KEY]: cur });
  }

  async export(): Promise<LabelLog | null> {
    await this.flush();
    const { [KEY]: log } = await chrome.storage.local.get(KEY);
    return (log as LabelLog) ?? null;
  }
}
