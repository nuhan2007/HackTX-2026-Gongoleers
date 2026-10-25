// The owl and its help card. "Let's do it" opens the help right here next to the owl:
// Gongo looks at the tab, then shows an insight into what they seem stuck on plus a few "try this next"
// suggestions. Nothing is ever required of the student: they can read, ask for another angle, watch a
// short video, say it helped, or close the owl (the x and Esc always work).
import { useEffect, useRef, useState } from 'react';
import { isError, type HelpStage, type Msg, type StartSessionResult, type TutorReply } from '../../shared/messages';
import type { HintLevel, TutorAction, VideoMoment } from '../../shared/types';
import { GongoSvg } from './GongoSvg';

type View = 'hidden' | 'nudge' | 'working' | 'help' | 'video' | 'done' | 'error';

const STAGE_TEXT: Record<HelpStage, string> = {
  looking: 'Looking at your tab…',
  reading: 'Reading the problem and your work…',
  thinking: 'Thinking of a good nudge…',
};
const LEVEL_NAME = ['Nudge', 'Concept', 'Next step'];
const fmtTime = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
const fmtDuration = (s: number) => (s >= 60 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${s}s`);
const nextFrame = () => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())));

function send<T>(msg: Msg): Promise<T | { error: string }> {
  return chrome.runtime.sendMessage(msg).catch(() => ({ error: 'Gongo was just updated. Reload this page.' }));
}

export function Sprite({ setHidden }: { setHidden: (hidden: boolean) => void }) {
  const [view, setView] = useState<View>('hidden');
  const [reasons, setReasons] = useState<string[]>([]);
  const [stage, setStage] = useState<HelpStage>('looking');
  const [sessionId, setSessionId] = useState('');
  const [message, setMessage] = useState('');
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [level, setLevel] = useState<HintLevel>(1);
  const [offerVideo, setOfferVideo] = useState(false);
  const [video, setVideo] = useState<VideoMoment | null>(null);
  const [lastReply, setLastReply] = useState('');
  const [draft, setDraft] = useState('');
  const [askOpen, setAskOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [doneText, setDoneText] = useState('');
  const inputRef = useRef<HTMLTextAreaElement>(null);
  // Bumped whenever the student closes the owl, so a slow reply can't pop it back open.
  const run = useRef(0);

  useEffect(() => {
    const onMsg = (msg: Msg) => {
      if (msg.type === 'nudge') {
        setReasons(msg.reasons);
        // A new nudge never interrupts a help session that's already open.
        setView((v) => (msg.show ? (v === 'hidden' ? 'nudge' : v) : v === 'nudge' ? 'hidden' : v));
      } else if (msg.type === 'help-progress') {
        setHidden(false);
        setStage(msg.stage);
      }
    };
    chrome.runtime.onMessage.addListener(onMsg);
    return () => chrome.runtime.onMessage.removeListener(onMsg);
  }, [setHidden]);

  useEffect(() => {
    if (view === 'help' && askOpen) inputRef.current?.focus();
  }, [view, askOpen]);

  const showReply = (r: TutorReply) => {
    setMessage(r.message);
    setSuggestions(r.suggestions);
    setLevel(r.hintLevel);
    setOfferVideo(r.suggestVideo);
  };

  async function startHelp() {
    const mine = ++run.current;
    setView('working');
    setStage('looking');
    setError('');
    // Hide the owl so the tab image shows the problem, not Gongo; the worker un-hides us after capture.
    setHidden(true);
    await nextFrame();
    const r = await send<StartSessionResult>({ type: 'start-help' });
    setHidden(false);
    if (mine !== run.current) {
      // Closed while we were thinking: don't reopen, but don't leave an orphaned session either.
      if (!isError(r) && r.sessionId) void send({ type: 'end-session', sessionId: r.sessionId, solved: false });
      return;
    }
    if (isError(r)) {
      setError(r.error);
      return setView('error');
    }
    if (!r.problemDetected) {
      setError(r.message);
      return setView('error');
    }
    setSessionId(r.sessionId);
    showReply(r);
    setLastReply('');
    setAskOpen(false);
    setView('help');
  }

  async function turn(action: TutorAction, text = '') {
    setBusy(action === 'different_hint' ? 'Finding another way in…' : 'Thinking…');
    setError('');
    const r = await send<TutorReply>({ type: 'tutor-turn', sessionId, action, text });
    setBusy(null);
    if (isError(r)) return setError(r.error);
    showReply(r);
  }

  async function reply() {
    const text = draft.trim();
    if (!text || busy) return;
    setDraft('');
    setAskOpen(false);
    setLastReply(text);
    await turn('reply', text);
  }

  async function dontKnow() {
    setLastReply("I don't know at all.");
    setBusy('Finding a short video on the idea behind this…');
    setError('');
    const v = await send<VideoMoment>({ type: 'find-video', sessionId });
    setBusy(null);
    if (isError(v)) return turn('dont_know');
    setVideo(v);
    setOfferVideo(false);
    setView('video');
  }

  async function findVideo() {
    setBusy('Finding a short video…');
    const v = await send<VideoMoment>({ type: 'find-video', sessionId });
    setBusy(null);
    if (isError(v)) return setError(v.error);
    setVideo(v);
    setOfferVideo(false);
    setView('video');
  }

  async function backFromVideo() {
    const concept = video?.concept ?? 'the concept';
    setView('help');
    setLastReply(`I watched the video on ${concept}.`);
    await turn('reply', `I watched the video on ${concept}.`);
  }

  async function gotIt() {
    const summary = await send<{ timeToUnstuckSec: number | null } | null>({ type: 'end-session', sessionId, solved: true });
    const secs = summary && !isError(summary) ? summary.timeToUnstuckSec : null;
    setDoneText(`Glad that helped! ${secs !== null ? `You got unstuck in ${fmtDuration(secs)}. 🎉` : '🎉'}`);
    setSessionId('');
    setView('done');
    setTimeout(() => setView((v) => (v === 'done' ? 'hidden' : v)), 6000);
  }

  function close(snooze = false) {
    run.current++;
    if (sessionId) void send({ type: 'end-session', sessionId, solved: false });
    else void send({ type: 'nudge-dismissed', snooze });
    setSessionId('');
    setVideo(null);
    setAskOpen(false);
    setView('hidden');
  }

  // Esc always closes the owl while it's showing.
  const open = view !== 'hidden';
  useEffect(() => {
    if (!open) return;
    const onEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
    };
    window.addEventListener('keydown', onEsc, true);
    return () => window.removeEventListener('keydown', onEsc, true);
  });

  if (view === 'hidden') return null;

  const onKey = (submit: () => void) => (e: React.KeyboardEvent) => {
    e.stopPropagation(); // keep the page's own shortcuts out of our text box
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  };

  return (
    <div className="wrap">
      <div className={`card ${view === 'nudge' ? 'small' : ''}`} role="dialog" aria-label="Gongo study buddy" aria-live="polite">
        <button className="x" onClick={() => close()} aria-label="Close" title="Close (Esc)">
          ×
        </button>

        {view === 'nudge' && (
          <>
            <p className="title">Looks tricky. Want to think it through together?</p>
            {reasons.length > 0 && <p className="why">I noticed: {reasons.slice(0, 2).join(', ')}</p>}
            <div className="row">
              <button className="primary" onClick={startHelp}>
                Let's do it
              </button>
              <button onClick={() => close(false)}>Not now</button>
              <button className="link" onClick={() => close(true)}>
                Snooze 15 min
              </button>
            </div>
          </>
        )}

        {view === 'working' && (
          <div className="working">
            <span className="spinner" aria-hidden="true" />
            <span>{STAGE_TEXT[stage]}</span>
          </div>
        )}

        {view === 'error' && (
          <>
            <p>{error}</p>
            <div className="row">
              <button className="primary" onClick={startHelp}>
                Try again
              </button>
              <button onClick={() => close()}>Close</button>
            </div>
          </>
        )}

        {view === 'help' && (
          <>
            <div className="level">
              {[1, 2, 3].map((l) => (
                <span key={l} className={`dot ${l <= level ? 'on' : ''}`} />
              ))}
              <span>{LEVEL_NAME[level - 1]}</span>
            </div>
            {lastReply && <p className="you">You: {lastReply}</p>}
            <p className="label">What I noticed</p>
            <p className="insight">{message}</p>
            {suggestions.length > 0 && (
              <>
                <p className="label">Try this next</p>
                <ul className="suggestions">
                  {suggestions.map((s) => (
                    <li key={s}>{s}</li>
                  ))}
                </ul>
              </>
            )}
            {offerVideo && (
              <button className="link" onClick={findVideo} disabled={!!busy}>
                ▶ Want a short video on the idea behind this?
              </button>
            )}
            {busy ? (
              <div className="working">
                <span className="spinner" aria-hidden="true" />
                <span>{busy}</span>
              </div>
            ) : (
              <>
                {askOpen && (
                  <div className="reply">
                    <textarea
                      ref={inputRef}
                      rows={2}
                      value={draft}
                      placeholder="Anything you want me to know? (optional)"
                      onChange={(e) => setDraft(e.target.value)}
                      onKeyDown={onKey(reply)}
                    />
                    <button className="primary" onClick={reply} disabled={!draft.trim()}>
                      Send
                    </button>
                  </div>
                )}
                <div className="row">
                  <button onClick={() => turn('different_hint')}>Another angle</button>
                  <button onClick={dontKnow}>Explain the idea</button>
                  <button className="good" onClick={gotIt}>
                    That helped
                  </button>
                  {!askOpen && (
                    <button className="link" onClick={() => setAskOpen(true)}>
                      Tell me more
                    </button>
                  )}
                  <button className="link" onClick={() => close()}>
                    Close
                  </button>
                </div>
              </>
            )}
            {error && <p className="err">{error}</p>}
          </>
        )}

        {view === 'video' && video && (
          <>
            <p className="label">A short video on {video.concept}</p>
            <p className="question">
              Watch {fmtTime(video.start)}–{fmtTime(video.end)}: {video.why}
            </p>
            <p className="why">
              {video.title} · {video.channel}
            </p>
            <div className="row">
              <button
                className="primary"
                onClick={() => window.open(`https://www.youtube.com/watch?v=${video.videoId}&t=${video.start}s`, '_blank', 'noopener')}
              >
                ▶ Open video at {fmtTime(video.start)}
              </button>
              <button onClick={backFromVideo}>I watched it, back to the problem</button>
            </div>
            {video.practice && video.practice.length > 0 && (
              <>
                <p className="label">This keeps coming up. Some practice:</p>
                <ul className="suggestions">
                  {video.practice.map((p) => (
                    <li key={p.link}>
                      <a href={p.link} target="_blank" rel="noreferrer">
                        {p.title}
                      </a>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </>
        )}

        {view === 'done' && <p className="question">{doneText}</p>}
      </div>

      <button className="gongo" onClick={view === 'nudge' ? startHelp : undefined} aria-label="Gongo">
        <GongoSvg />
      </button>
    </div>
  );
}

export const spriteCss = `
.wrap { position: fixed; right: 20px; bottom: 20px; display: flex; align-items: flex-end; gap: 10px;
  font: 14px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif; color: #1f1d2b;
  }
.card { position: relative; background: #fff; border-radius: 16px 16px 4px 16px; padding: 14px 16px;
  width: min(340px, calc(100vw - 130px)); max-height: calc(100vh - 60px); overflow-y: auto;
  box-shadow: 0 10px 32px rgba(40, 30, 90, .28); border: 1px solid #e6e2fb; }
.card.small { width: min(290px, calc(100vw - 130px)); }
.card p { margin: 0 0 8px; }
.title { font-weight: 600; }
.why { font-size: 12px; color: #6b6880; }
.question { font-size: 15px; font-weight: 500; }
.insight { font-size: 14.5px; margin: 0 0 8px; }
.title { padding-right: 18px; }
.you { font-size: 12px; color: #6b6880; font-style: italic; }
.label { font-size: 11px; font-weight: 700; letter-spacing: .04em; text-transform: uppercase; color: #6c5ce7; margin-top: 4px !important; }
.suggestions { margin: 0 0 10px; padding-left: 18px; }
.suggestions li { margin-bottom: 4px; }
.suggestions a { color: #3b2f8f; }
.level { display: flex; align-items: center; gap: 4px; font-size: 11px; color: #6b6880; margin-bottom: 8px; }
.dot { width: 8px; height: 8px; border-radius: 50%; background: #ece9fd; border: 1px solid #d8d3f5; }
.dot.on { background: #6c5ce7; border-color: #6c5ce7; }
.row { display: flex; gap: 6px; flex-wrap: wrap; align-items: center; margin-top: 6px; }
.reply { display: flex; gap: 6px; align-items: flex-end; }
textarea { flex: 1; font: inherit; resize: none; border: 1px solid #d8d3f5; border-radius: 10px; padding: 6px 8px; color: #1f1d2b; background: #fff; }
textarea:focus { outline: 2px solid #a29bfe; outline-offset: 0; }
button { font: inherit; font-size: 13px; cursor: pointer; border-radius: 999px; border: 1px solid #d8d3f5; background: #f6f4ff;
  padding: 5px 12px; color: #3b2f8f; }
button:hover:not(:disabled) { border-color: #6c5ce7; }
button.primary { background: #6c5ce7; border-color: #6c5ce7; color: #fff; }
button.good { background: #e6f6ee; border-color: #9fd9bb; color: #1b6b43; }
button.link { border: none; background: none; padding: 4px 0; color: #6c5ce7; text-decoration: underline; }
button:disabled { opacity: .55; cursor: default; }
button.x { position: absolute; top: 6px; right: 8px; border: none; background: none; font-size: 18px; line-height: 1; padding: 2px 6px; color: #8a879c; }
.working { display: flex; align-items: center; gap: 10px; color: #57546b; padding: 4px 0; }
.spinner { width: 16px; height: 16px; border-radius: 50%; border: 2px solid #d8d3f5; border-top-color: #6c5ce7; animation: spin .8s linear infinite; flex: none; }
.err { color: #b3261e; font-size: 12px; }
.gongo { width: 72px; height: 72px; padding: 0; border: none; background: none; border-radius: 50%; flex: none;
  animation: bob 2.4s ease-in-out infinite; filter: drop-shadow(0 6px 10px rgba(60, 40, 140, .35)); }
.gongo svg { width: 100%; height: 100%; }
@keyframes bob { 0%,100% { transform: translateY(0) } 50% { transform: translateY(-6px) } }
@keyframes slide-in { from { transform: translateY(120%); opacity: 0 } to { transform: none; opacity: 1 } }
@keyframes spin { to { transform: rotate(360deg) } }
@media (prefers-reduced-motion: reduce) { .wrap, .gongo, .spinner { animation: none } }
`;
