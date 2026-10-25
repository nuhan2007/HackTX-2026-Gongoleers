// Snapshots live on this device only. The monitor captures every few seconds and keeps a short ring
// of frames per tab here; a frame leaves the device only when the call gate decides to ask the model
// and attaches it. IndexedDB keeps them across service-worker restarts (an MV3 worker sleeps after
// ~30 s idle); the in-memory twin backs the tests and is the fallback if IndexedDB is unavailable.
import { FRAME_TTL_MS, FRAMES_PER_TAB } from '../shared/constants';
import type { Frame } from './frames';

export interface StoreStats {
  frames: number;
  bytes: number;
  /** Frame count per tab id. */
  perTab: Record<number, number>;
}

export interface FrameStore {
  put(f: Frame): Promise<void>;
  latest(tabId: number): Promise<Frame | null>;
  recent(tabId: number, n: number): Promise<Frame[]>;
  dropTab(tabId: number): Promise<void>;
  clear(): Promise<void>;
  stats(): Promise<StoreStats>;
}

/** Oldest-first list → what to keep: at most `perTab` newest, none older than the TTL. */
export function survivors<T extends { at: number }>(oldestFirst: T[], now: number, perTab = FRAMES_PER_TAB, ttl = FRAME_TTL_MS): T[] {
  return oldestFirst.filter((f) => now - f.at <= ttl).slice(-perTab);
}

export class MemoryFrameStore implements FrameStore {
  private byTab = new Map<number, Frame[]>();
  constructor(private now: () => number = Date.now) {}

  async put(f: Frame) {
    this.byTab.set(f.tabId, survivors([...(this.byTab.get(f.tabId) ?? []), f], this.now()));
  }
  async latest(tabId: number) {
    return this.byTab.get(tabId)?.at(-1) ?? null;
  }
  async recent(tabId: number, n: number) {
    return (this.byTab.get(tabId) ?? []).slice(-n).reverse();
  }
  async dropTab(tabId: number) {
    this.byTab.delete(tabId);
  }
  async clear() {
    this.byTab.clear();
  }
  async stats(): Promise<StoreStats> {
    const perTab: Record<number, number> = {};
    let frames = 0;
    let bytes = 0;
    for (const [id, list] of this.byTab) {
      perTab[id] = list.length;
      frames += list.length;
      for (const f of list) bytes += f.jpeg.length;
    }
    return { frames, bytes, perTab };
  }
}

interface Row extends Frame {
  id?: number;
}

const DB = 'myta-frames';
const OS = 'frames';

const done = <T>(req: IDBRequest<T>) =>
  new Promise<T>((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
const txDone = (tx: IDBTransaction) =>
  new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });

export class IdbFrameStore implements FrameStore {
  private db: Promise<IDBDatabase> | null = null;
  constructor(private now: () => number = Date.now) {}

  private open(): Promise<IDBDatabase> {
    this.db ??= new Promise((resolve, reject) => {
      const req = indexedDB.open(DB, 1);
      req.onupgradeneeded = () => {
        const os = req.result.createObjectStore(OS, { keyPath: 'id', autoIncrement: true });
        os.createIndex('tab', 'tabId');
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return this.db;
  }

  private async rows(tabId: number): Promise<Row[]> {
    const db = await this.open();
    return (await done(db.transaction(OS).objectStore(OS).index('tab').getAll(tabId))) as Row[];
  }

  async put(f: Frame) {
    const db = await this.open();
    const tx = db.transaction(OS, 'readwrite');
    const os = tx.objectStore(OS);
    os.add({ ...f });
    // Ids grow with time, so the index returns each tab's rows oldest first.
    const all = (await done(os.index('tab').getAll(f.tabId))) as Row[];
    const keep = new Set(survivors(all, this.now()).map((r) => r.id));
    for (const r of all) if (!keep.has(r.id)) os.delete(r.id!);
    await txDone(tx);
  }
  async latest(tabId: number) {
    return (await this.rows(tabId)).at(-1) ?? null;
  }
  async recent(tabId: number, n: number) {
    return (await this.rows(tabId)).slice(-n).reverse();
  }
  async dropTab(tabId: number) {
    const db = await this.open();
    const tx = db.transaction(OS, 'readwrite');
    const os = tx.objectStore(OS);
    for (const r of (await done(os.index('tab').getAll(tabId))) as Row[]) os.delete(r.id!);
    await txDone(tx);
  }
  async clear() {
    const db = await this.open();
    const tx = db.transaction(OS, 'readwrite');
    tx.objectStore(OS).clear();
    await txDone(tx);
  }
  async stats(): Promise<StoreStats> {
    const db = await this.open();
    const all = (await done(db.transaction(OS).objectStore(OS).getAll())) as Row[];
    const perTab: Record<number, number> = {};
    let bytes = 0;
    for (const r of all) {
      perTab[r.tabId] = (perTab[r.tabId] ?? 0) + 1;
      bytes += r.jpeg.length;
    }
    return { frames: all.length, bytes, perTab };
  }
}

/** IndexedDB when the environment has it, otherwise memory. */
export function createFrameStore(): FrameStore {
  return typeof indexedDB === 'undefined' ? new MemoryFrameStore() : new IdbFrameStore();
}
