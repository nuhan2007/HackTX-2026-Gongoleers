import { useEffect, useRef, useState } from 'react';
import { UNDERSTANDING_QUESTION } from '../ai/prompts';
import { isError, send, type PageContext, type PanelState, type TutorReply } from '../shared/messages';
import type { HintLevel, SessionSummary, TutorAction, VideoMoment } from '../shared/types';
import { Capture } from './Capture';
import { Summary } from './Summary';
import { useSpeech } from './useSpeech';
import { VideoCard } from './VideoCard';

type View = 'home' | 'capture' | 'chat' | 'summary';
interface Bubble {
  role: 'tutor' | 'student' | 'system';
  text: string;
}
interface UiState {
  view: View;
  sessionId: string;
  bubbles: Bubble[];
  hintLevel: HintLevel;
  mode: 'socratic' | 'understanding';
  offerVideo: boolean;
  video: VideoMoment | null;
}
const EMPTY: UiState = { view: 'home', sessionId: '', bubbles: [], hintLevel: 1, mode: 'socratic', offerVideo: false, video: null };
const UI_KEY = 'panelUi';

export function Tutor({ state }: { state: PanelState }) {
  const [ui, setUi] = useState<UiState>(EMPTY);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [summary, setSummary] = useState<SessionSummary | null>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const speech = useSpeech((t) => setDraft((d) => (d ? `${d} ${t}` : t)));

  // Keep the conversation if the panel is closed and reopened (no hidden data is stored here).
  useEffect(() => {
    chrome.storage.session.get(UI_KEY).then((r) => r[UI_KEY] && setUi(r[UI_KEY] as UiState));
  }, []);
  const update = (patch: Partial<UiState> | ((u: UiState) => Partial<UiState>)) =>
    setUi((u) => {
      const next = { ...u, ...(typeof patch === 'function' ? patch(u) : patch) };
      void chrome.storage.session.set({ [UI_KEY]: next });
      return next;
    });
  useEffect(() => endRef.current?.scrollIntoView({ behavior: 'smooth' }), [ui.bubbles.length, busy, ui.video]);

  async function run<T>(label: string, fn: () => Promise<T | { error: string }>): Promise<T | null> {
    setBusy(label);
    setError(null);
    try {
      const r = await fn();
      if (isError(r)) {
        setError(r.error);
        return null;
      }
      return r as T;
    } catch (e) {
      setError(navigator.onLine ? 'Gongo hit a snag. Try again.' : 'You seem to be offline.');
      return null;
    } finally {
      setBusy(null);
    }
  }

  const applyReply = (r: TutorReply) =>
    update((u) => ({
      bubbles: [...u.bubbles, { role: 'tutor', text: r.message }],
      hintLevel: r.hintLevel,
      offerVideo: r.suggestVideo && !u.video,
    }));

  async function start(image: string, context: PageContext | null) {
    update({ ...EMPTY, view: 'chat' });
    const r = await run('Reading the problem…', () => send({ type: 'start-session', image, context }));
    if (!r) return update({ view: 'home' });
    if (!r.problemDetected) {
      setError(r.message);
      return update({ view: 'capture' });
    }
    update({ sessionId: r.sessionId, bubbles: [{ role: 'tutor', text: r.message }], hintLevel: r.hintLevel });
  }

  async function turn(action: TutorAction, text = '') {
    if (text) update((u) => ({ bubbles: [...u.bubbles, { role: 'student', text }] }));
    const r = await run('Thinking…', () => send({ type: 'tutor-turn', sessionId: ui.sessionId, action, text }));
    if (r) applyReply(r);
  }

  async function submit() {
    const text = draft.trim();
    if (!text || busy) return;
    setDraft('');
    if (ui.mode === 'understanding') {
      update((u) => ({ bubbles: [...u.bubbles, { role: 'student', text }] }));
      const r = await run('Checking…', () => send({ type: 'check-understanding', sessionId: ui.sessionId, text }));
      if (!r) return;
      update((u) => ({ bubbles: [...u.bubbles, { role: 'tutor', text: r.feedback }], mode: r.understood ? 'understanding' : 'socratic' }));
      if (r.understood) await finish(true);
      return;
    }
    await turn('reply', text);
  }

  async function dontKnow() {
    update((u) => ({ bubbles: [...u.bubbles, { role: 'student', text: 'I don\'t know at all.' }] }));
    const v = await run('Finding a short video on the idea behind this…', () => send({ type: 'find-video', sessionId: ui.sessionId }));
    if (v) update({ video: v, offerVideo: false });
    else await turn('dont_know');
  }

  async function findVideo() {
    const v = await run('Finding a short video…', () => send({ type: 'find-video', sessionId: ui.sessionId }));
    if (v) update({ video: v, offerVideo: false });
  }

  async function videoDone() {
    const concept = ui.video?.concept ?? 'the concept';
    update({ video: null });
    await turn('reply', `I watched the video on ${concept}.`);
  }

  function gotIt() {
    update((u) => ({ mode: 'understanding', bubbles: [...u.bubbles, { role: 'tutor', text: UNDERSTANDING_QUESTION }] }));
  }

  async function finish(solved: boolean) {
    const s = ui.sessionId ? await send({ type: 'end-session', sessionId: ui.sessionId, solved }).catch(() => null) : null;
    if (solved && s) {
      setSummary(s);
      update({ ...EMPTY, view: 'summary' });
    } else {
      update(EMPTY);
    }
  }

  if (ui.view === 'summary' && summary) return <Summary s={summary} onDone={() => update(EMPTY)} />;

  if (ui.view === 'capture')
    return (
      <>
        {error && <p className="error">{error}</p>}
        <Capture onSend={start} onCancel={() => update(EMPTY)} />
      </>
    );

  if (ui.view === 'home')
    return (
      <div className="stack">
        {state.triggeredAt ? (
          <div className="card nudge-card">
            <h2>Looks tricky. Want to think it through together?</h2>
            {state.output.topContributors.length > 0 && (
              <div className="row">
                {state.output.topContributors.map((r) => (
                  <span className="chip" key={r}>
                    {r}
                  </span>
                ))}
              </div>
            )}
          </div>
        ) : (
          <div className="card">
            <h2>Hi, I'm Gongo 👋</h2>
            <p className="muted">
              I'll check in if it looks like you're stuck. I'll ask questions to get you moving, but I'll never just give you the answer.
            </p>
          </div>
        )}
        <button className="primary big" onClick={() => update({ view: 'capture' })}>
          I'm stuck. Let's think it through
        </button>
        <p className="small muted">Works on any tab, including PDFs. You choose exactly what gets sent.</p>
      </div>
    );

  return (
    <div className="chat">
      <div className="row hint-row">
        <span className="small muted">Hint level</span>
        {[1, 2, 3].map((l) => (
          <span key={l} className={`dot ${l <= ui.hintLevel ? 'on' : ''}`} title={['Nudge', 'Concept', 'Next step'][l - 1]} />
        ))}
        <span className="small muted">{['Nudge', 'Concept', 'Next step'][ui.hintLevel - 1]}</span>
        {ui.mode === 'understanding' && <span className="chip good">Understanding check</span>}
      </div>

      <div className="messages" aria-live="polite">
        {ui.bubbles.map((b, i) => (
          <div key={i} className={`bubble ${b.role}`}>
            {b.text}
          </div>
        ))}
        {ui.offerVideo && !ui.video && (
          <div className="card offer">
            <p>Want a short video on the idea behind this?</p>
            <div className="row">
              <button className="primary" onClick={findVideo} disabled={!!busy}>
                Show me
              </button>
              <button onClick={() => update({ offerVideo: false })}>No thanks</button>
            </div>
          </div>
        )}
        {ui.video && <VideoCard v={ui.video} onDone={videoDone} />}
        {busy && <div className="bubble tutor typing">{busy}</div>}
        {error && <p className="error small">{error}</p>}
        <div ref={endRef} />
      </div>

      <div className="composer">
        <div className="row actions">
          <button onClick={dontKnow} disabled={!!busy || !ui.sessionId}>
            I don't know at all
          </button>
          <button onClick={() => turn('different_hint')} disabled={!!busy || !ui.sessionId}>
            Different hint
          </button>
          <button onClick={gotIt} disabled={!!busy || !ui.sessionId || ui.mode === 'understanding'}>
            I got it!
          </button>
          <button className="ghost" onClick={() => finish(false)}>
            Not now
          </button>
        </div>
        <div className="row input-row">
          <textarea
            value={draft}
            placeholder={ui.mode === 'understanding' ? 'Explain in one sentence…' : 'Type your answer or thinking…'}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                void submit();
              }
            }}
            disabled={!ui.sessionId}
          />
          {speech.supported && (
            <button
              className={speech.listening ? 'mic on' : 'mic'}
              onClick={speech.toggle}
              title={speech.error ?? 'Speak your answer'}
              aria-label="Voice input"
              disabled={!ui.sessionId}
            >
              🎤
            </button>
          )}
          <button className="primary" onClick={submit} disabled={!draft.trim() || !!busy}>
            Send
          </button>
        </div>
        {speech.error && <p className="small error">{speech.error}</p>}
      </div>
    </div>
  );
}
