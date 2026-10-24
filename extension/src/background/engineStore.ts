// Persists engine + trigger state to chrome.storage.session so an MV3 service-worker
// shutdown doesn't reset the score, timers or cooldown.
import { initialEngineState, type EngineState } from './confusionEngine';
import { initialTriggerState, type TriggerState } from './triggerMachine';

export interface PersistedState {
  engine: EngineState;
  trigger: TriggerState;
}

/** Minimal storage surface so tests can pass an in-memory fake. */
export interface KV {
  get(key: string): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
}

const KEY = 'engineState';

export class EngineStore {
  private cache: PersistedState | null = null;
  constructor(private kv: KV) {}

  async load(): Promise<PersistedState> {
    if (this.cache) return this.cache;
    const { [KEY]: stored } = await this.kv.get(KEY);
    this.cache = (stored as PersistedState | undefined) ?? { engine: initialEngineState(), trigger: initialTriggerState() };
    return this.cache;
  }

  async save(state: PersistedState): Promise<void> {
    this.cache = state;
    await this.kv.set({ [KEY]: state });
  }
}
