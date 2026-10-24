// Tutor sessions, including the hidden solution, live in chrome.storage.session
// (trusted contexts only, cleared when the browser closes) with a 2h TTL.
// The hidden solution is never included in any message to the side panel or content scripts.
import { SESSION_TTL_MS } from '../shared/constants';
import type { ChatMessage, HintLevel, SolverResult } from '../shared/types';

export interface TutorSession {
  id: string;
  createdAt: number;
  triggeredAt: number | null;
  url: string;
  hidden: SolverResult;
  history: ChatMessage[];
  hintLevel: HintLevel;
  /** Consecutive dont_know/misconception turns; 3 in a row suggests the video. */
  struggleStreak: number;
  concepts: string[];
  videos: string[];
  awaitingUnderstanding: boolean;
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
  await chrome.storage.session.remove(key(id));
}

async function purgeExpired(): Promise<void> {
  const all = await chrome.storage.session.get(null);
  const stale = Object.entries(all)
    .filter(([k, v]) => k.startsWith('session:') && Date.now() - (v as TutorSession).createdAt > SESSION_TTL_MS)
    .map(([k]) => k);
  if (stale.length) await chrome.storage.session.remove(stale);
}
