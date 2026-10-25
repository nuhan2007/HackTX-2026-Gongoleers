// Tutor sessions, including the hidden solution, live in chrome.storage.session
// (trusted contexts only, cleared when the browser closes) with a 2h TTL.
// The hidden solution is never included in any message to the side panel or content scripts.
import { SESSION_TTL_MS } from '../shared/constants';
import type { ChatMessage, HintLevel, SolverResult, WorkState } from '../shared/types';

export interface TutorSession {
  id: string;
  createdAt: number;
  triggeredAt: number | null;
  url: string;
  hidden: SolverResult;
  history: ChatMessage[];
  hintLevel: HintLevel;
  concepts: string[];
  videos: string[];
  /** How many hints the sprite has shown for this problem. */
  hints?: number;
  /** When myTA last showed a hint on the sprite, so the next one soon after goes a level deeper. */
  lastAutoHintAt?: number;
}

const key = (id: string) => `session:${id}`;

export async function createSession(s: Omit<TutorSession, 'id' | 'createdAt'>): Promise<TutorSession> {
  await purgeExpired();
  const session: TutorSession = { ...s, id: crypto.randomUUID(), createdAt: Date.now() };
  await chrome.storage.session.set({ [key(session.id)]: session });
  return session;
}

export async function getSession(id: string): Promise<TutorSession | null> {
  const { [key(id)]: s } = await chrome.storage.session.get(key(id));
  if (!s) return null;
  if (Date.now() - (s as TutorSession).createdAt > SESSION_TTL_MS) {
    await chrome.storage.session.remove(key(id));
    return null;
  }
  return s as TutorSession;
}

export async function saveSession(s: TutorSession): Promise<void> {
  await chrome.storage.session.set({ [key(s.id)]: s });
}

export async function deleteSession(id: string): Promise<void> {
  await chrome.storage.session.remove([key(id), workKey(id)]);
}

// The watcher's notes live under their own key. They're written by background reviews while a hint is
// being written, so keeping them out of the session object means neither write can clobber the other.
const workKey = (id: string) => `work:${id}`;
export const initialWork = (): WorkState => ({ status: 'unknown', observation: '', reviewedAt: 0 });

export async function getWork(id: string): Promise<WorkState> {
  const { [workKey(id)]: w } = await chrome.storage.session.get(workKey(id));
  return (w as WorkState | undefined) ?? initialWork();
}

export async function saveWork(id: string, w: WorkState): Promise<void> {
  await chrome.storage.session.set({ [workKey(id)]: w });
}

// A solved problem is remembered for the session's lifetime, so coming back to the same numbered question
// (or restarting the tutor on it) doesn't pay for a second solve.
const solvedKey = (key: string) => `solved:${key}`;

export async function getSolved(key: string): Promise<SolverResult | null> {
  const { [solvedKey(key)]: v } = await chrome.storage.session.get(solvedKey(key));
  const hit = v as { hidden: SolverResult; at: number } | undefined;
  return hit && Date.now() - hit.at <= SESSION_TTL_MS ? hit.hidden : null;
}

export async function saveSolved(key: string, hidden: SolverResult): Promise<void> {
  await chrome.storage.session.set({ [solvedKey(key)]: { hidden, at: Date.now() } });
}

async function purgeExpired(): Promise<void> {
  const all = await chrome.storage.session.get(null);
  const stale = Object.entries(all)
    .filter(([k, v]) => {
      if (k.startsWith('session:')) return Date.now() - (v as TutorSession).createdAt > SESSION_TTL_MS;
      if (k.startsWith('work:')) return Date.now() - (v as WorkState).reviewedAt > SESSION_TTL_MS;
      if (k.startsWith('solved:')) return Date.now() - (v as { at: number }).at > SESSION_TTL_MS;
      return false;
    })
    .map(([k]) => k);
  if (stale.length) await chrome.storage.session.remove(stale);
}
