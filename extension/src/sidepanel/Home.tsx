// The panel's home: what myTA is doing right now, in plain words. There is nothing to type here and no conversation: the sprite
// (in the tab where you write your work) does the talking. This is where you can see that myTA is following a problem, whether
// it can read your work, which tab it believes is your work and why, and the last thing the sprite said.
import { useEffect, useState } from 'react';
import { isError, send, type EyesState, type PanelState, type TabView, type TrackingState, type WatchState } from '../shared/messages';
import { ago } from './format';

/** "Can it actually see my work?": what the model last read from the student's work, in its own words, and how well. */
function ReadLine({ watch }: { watch: WatchState }) {
  const when = watch.lastReviewAt ? ` (${ago(watch.lastReviewAt)})` : '';
  if (watch.readability === 'clear')
    return (
      <p className="small read ok">
        ✓ I can read your work{when}
        {watch.read ? `: “${watch.read}”` : '. (I\'m not showing the details.)'}
      </p>
    );
  if (watch.readability === 'hard_to_read')
    return (
      <p className="small read warn">
        ⚠ I can see something written{when}, but it's hard to read{watch.read ? `: “${watch.read}”` : ''}. Try writing larger, or use "Use this tab as my work tab" if it's on a different page.
      </p>
    );
  if (watch.readability === 'nothing_written') return <p className="small read">I don't see any work on screen yet{when}. I read it as you write.</p>;
  return <p className="small read muted">I haven't looked at your work yet. I read it every few seconds while you write.</p>;
}

/** Whether myTA knows which problem the student is on and is following it. */
function TrackingCard({ state, onFollow }: { state: PanelState; onFollow: () => void }) {
  const t: TrackingState = state.tracking;
  const title =
    t.mode === 'following'
      ? `Following ${t.label ?? 'this problem'}`
      : t.mode === 'starting'
        ? 'Working out the problem privately…'
        : t.mode === 'noticed'
          ? 'Watching this page'
          : t.mode === 'not-a-problem'
            ? 'This page doesn\'t look like a problem'
            : t.mode === 'pick-one'
              ? 'This page has several questions'
              : t.mode === 'off'
                ? 'Not following anything'
                : 'Not following a problem yet';
  const detail =
    t.mode === 'following'
      ? [t.host && `on ${t.host}`, t.since && `since ${ago(t.since)}`].filter(Boolean).join(' · ')
      : t.mode === 'starting'
        ? 'This is the one model call myTA makes when it starts following a problem.'
        : t.mode === 'noticed'
          ? `You've been here ${t.noticedSec}s. If it's a problem, I'll start following it after ${t.needSec}s.`
          : t.mode === 'not-a-problem'
            ? 'I\'m not following anything. Open a problem and I\'ll notice.'
            : t.mode === 'pick-one'
              ? 'Click into the one you\'re working on and I\'ll start following it, so I check your work against the right problem.'
              : t.mode === 'off'
                ? (t.note ?? '')
                : `Open a problem and stay on it for ${t.needSec}s and I'll start following it. Until then nothing is sent to the model.`;
  return (
    <div className={`card track ${t.mode === 'following' ? 'on' : ''}`}>
      <div className="row">
        <span className={`live-dot ${t.mode === 'following' ? 'on' : t.mode === 'starting' ? 'busy' : ''}`} aria-hidden="true" />
        <h2>{title}</h2>
      </div>
      {detail && <p className="small muted">{detail}</p>}
      {t.mode === 'following' && t.note && <p className="small warn-text">{t.note}</p>}
      {t.mode === 'following' && <ReadLine watch={state.watch} />}
      {t.mode === 'following' && state.trigger.tuning && <p className="small muted tuning">Adapted to this problem: {state.trigger.tuning}</p>}
      {t.mode !== 'following' && t.mode !== 'starting' && (
        <button className="ghost" onClick={onFollow}>
          Follow the problem on this page now
        </button>
      )}
      <p className="small muted">The sprite will appear in the tab where you write your work. I'll point you to the spot, but I'll never give you the answer.</p>
    </div>
  );
}

/** What the sprite is saying right now, and what it last found. */
function Latest({ state }: { state: PanelState }) {
  const sp = state.sprite;
  const c = state.autoCheck && state.autoCheck.sessionId === state.sessionId ? state.autoCheck : null;
  const h = state.autoHint && state.autoHint.sessionId === state.sessionId ? state.autoHint : null;
  const [picture, setPicture] = useState<{ id: number; image: string | null; box: [number, number, number, number] | null } | null>(null);
  const [open, setOpen] = useState(false);
  useEffect(() => setOpen(false), [c?.id]);
  async function show() {
    if (!c) return;
    setOpen((v) => !v);
    if (picture?.id === c.id) return;
    const r = await send({ type: 'get-auto-check', id: c.id }).catch(() => null);
    if (r) setPicture({ id: r.id, image: r.image, box: r.box });
  }
  if (!sp && !c && !h && !state.flagged) return null;
  return (
    <div className="card">
      <h3>What the sprite has said</h3>
      {sp && (
        <p className="small">
          Showing now ({sp.kind === 'mistake' ? 'a mistake' : sp.kind === 'cheer' ? 'a cheer' : sp.kind === 'check-work' ? 'an offer to check' : 'a hint'}): <strong>{sp.title}</strong> {sp.text}
        </p>
      )}
      {h && !sp && (
        <p className="small">
          Last hint ({ago(h.at)}): {h.message}
        </p>
      )}
      {c && (
        <p className="small">
          {c.verdict === 'mistake' ? (
            <>
              {c.origin === 'read' ? 'While you wrote' : c.origin === 'page' ? 'When the page said it was wrong' : 'When you finished'}, I flagged {c.kind === 'copy' ? 'the way you copied the problem' : c.kind === 'answer' ? 'your answer' : 'a mistake'} ({ago(c.at)}).{' '}
              <button className="ghost" onClick={() => void show()}>
                {open ? 'Hide the screen' : 'See the screen I checked'}
              </button>
            </>
          ) : c.verdict === 'correct' ? (
            <>✓ Your answer was right ({ago(c.at)}).</>
          ) : c.verdict === 'incomplete' ? (
            <>I checked {ago(c.at)}: it looks on track, but not finished.</>
          ) : (
            <>I tried to check your answer {ago(c.at)}, but couldn't read enough of your work.</>
          )}
        </p>
      )}
      {open && picture?.image && (
        <div className="review-shot">
          <img src={picture.image} alt="Your work as myTA saw it" />
          {picture.box && (
            <div
              className="review-box"
              style={{ top: `${picture.box[0] / 10}%`, left: `${picture.box[1] / 10}%`, height: `${(picture.box[2] - picture.box[0]) / 10}%`, width: `${(picture.box[3] - picture.box[1]) / 10}%` }}
              aria-label="Where the work went off track"
            />
          )}
        </div>
      )}
      {state.flagged > 0 && <p className="small muted">Mistakes flagged on this problem: {state.flagged}</p>}
    </div>
  );
}

/** Which tabs myTA is watching: the problem tab, the tab where the student writes their work, and why it thinks so. */
function TabsCard({ eyes }: { eyes: EyesState }) {
  const [note, setNote] = useState<string | null>(null);
  const problem = eyes.tabs.find((t) => t.role === 'problem');
  const work = eyes.tabs.find((t) => t.role === 'work');
  async function pin() {
    const r = await send({ type: 'pin-work-tab' }).catch(() => null);
    setNote(!r ? 'Couldn\'t do that just now.' : isError(r) ? r.error : `Now watching ${r.host} as your work tab.`);
  }
  const line = (label: string, t: TabView | undefined, fallback: string) => (
    <li>
      <span className="small">
        <strong>{label}</strong> {t ? t.host : fallback}
        {t && t.looksLike !== 'unknown' && ` · looks like ${t.looksLike === 'work' ? 'where you write' : 'where the problem is'} (${Math.round(t.confidence * 100)}% sure)`}
      </span>
      {t && t.why.length > 0 && <span className="small muted why-line">because {t.why.join('; ')}</span>}
    </li>
  );
  return (
    <div className="card">
      <h3>Which tab is which</h3>
      <ul className="role-list">
        {line('📄 Problem:', problem, '…')}
        {line('✏️ Work:', work, eyes.workTabId !== null ? 'waiting for a snapshot' : 'the problem page itself')}
      </ul>
      {eyes.workPinned && <p className="small muted">You chose this work tab by hand.</p>}
      <div className="row">
        <button className="ghost" onClick={pin} title="Switch to the tab where you write your work, then press this">
          {eyes.workTabId === null ? 'Use this tab as my work tab' : 'Use this tab as my work tab instead'}
        </button>
        {eyes.workPinned && (
          <button className="ghost" onClick={() => void send({ type: 'unpin-work-tab' })}>
            Unpin
          </button>
        )}
      </div>
      {note && <p className="small">{note}</p>}
    </div>
  );
}

export function Home({ state }: { state: PanelState }) {
  const [error, setError] = useState<string | null>(null);
  const st = state.start;
  const startError = st?.status === 'error' && Date.now() - st.at < 120_000 ? (st.error ?? null) : null;
  async function follow() {
    setError(null);
    const r = await send({ type: 'start-session' }).catch(() => null);
    if (!r) setError('myTA hit a snag. Try again.');
    else if (isError(r)) setError(r.error);
    else if (!r.problemDetected) setError(r.message);
  }
  return (
    <div className="stack">
      <TrackingCard state={state} onFollow={() => void follow()} />
      {(error ?? startError) && <p className="error">{error ?? startError}</p>}
      <Latest state={state} />
      {state.tracking.mode === 'following' && <TabsCard eyes={state.eyes} />}
    </div>
  );
}
