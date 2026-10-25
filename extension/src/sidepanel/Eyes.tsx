// "What myTA sees": the tabs it is watching, how many snapshots it has taken and kept on this device, and how
// many times it actually asked the model to look (and why). Taking a snapshot costs nothing; a model call does.
import { useEffect, useState } from 'react';
import { send, type EyesState, type FinishView, type SentShot } from '../shared/messages';

const ago = (t: number, now: number) => {
  const s = Math.max(0, Math.round((now - t) / 1000));
  return s < 90 ? `${s}s ago` : `${Math.round(s / 60)} min ago`;
};

const REASON: Record<string, string> = {
  'wrong-answer': 'a wrong answer on the homework page',
  'confusion-rise': 'the confusion score rose',
  'time-on-problem': 'a long time on the problem',
  'work-pause': 'a pause after writing a chunk',
  finished: 'you stopped and looked calm (a check of your answer)',
  progress: 'you were writing (reading along)',
};

const KIND: Record<string, string> = {
  solve: 'reading the problem',
  tutor: 'writing a hint',
  judge: 'making sure a message gives nothing away',
  concept: 'finding the idea you are missing',
  video: 'picking a clip',
  review: 'looking at your work',
  'check-work': 'checking your work',
};

/** When myTA decides the student has finished and checks their answer, and how close that is right now. */
function finishText(f: FinishView, solved: boolean): string {
  if (!f.enabled) return 'Checking your answer by itself is off in settings.';
  if (solved) return 'Your answer was checked and looks right.';
  const rule = `When you stop writing for ${f.idleSec}s and the confusion score is ${f.calmBelow} or lower, I'll take a snapshot and check your answer.`;
  if (!f.hasWork) return `${rule} (Nothing new to check yet.)`;
  return f.idleForSec !== null ? `${rule} You've been still for ${f.idleForSec}s.` : rule;
}

export function Eyes({ eyes, finish }: { eyes: EyesState; finish: FinishView }) {
  const [now, setNow] = useState(Date.now());
  const [sent, setSent] = useState<SentShot[]>([]);
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  // The pictures themselves are fetched separately (they are big), and only while this card is on screen.
  useEffect(() => {
    let alive = true;
    const load = () =>
      send({ type: 'get-sent' })
        .then((r) => alive && Array.isArray(r) && setSent(r))
        .catch(() => {});
    void load();
    const id = setInterval(load, 3000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);

  const mb = (eyes.storedBytes / 1_000_000).toFixed(1);
  const g = eyes.gate;
  const gateText = !g
    ? 'No session running, so nothing is sent to the model.'
    : g.solved
      ? 'You solved it, so I\'ve stopped looking.'
      : g.inFlight
        ? 'Looking at your work now…'
        : g.nextAllowedAt > now
          ? `Resting; the next look is allowed in ${Math.ceil((g.nextAllowedAt - now) / 1000)}s.`
          : 'Waiting for you to write something new (then I read it), or for a wrong answer, rising confusion, or you finishing.';
  const kinds = Object.entries(eyes.calls.byKind)
    .sort((a, b) => b[1] - a[1])
    .map(([k, n]) => `${k} ${n}`)
    .join(' · ');

  return (
    <div className="card">
      <h3>What myTA sees</h3>
      {eyes.tabs.length ? (
        <ul className="eyes-tabs">
          {eyes.tabs.map((t) => (
            <li key={t.tabId}>
              <span className={`chip ${t.role === 'work' ? 'good' : ''}`}>{t.role === 'problem' ? 'problem' : t.role === 'work' ? 'work' : 'other'}</span>
              <span className="host small" title={t.title}>
                {t.host}
              </span>
              <span className="small muted">
                {ago(t.at, now)} · {t.stored} kept
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="small muted">No snapshots yet. They start once myTA is set up and you're on a normal web page.</p>
      )}

      <dl className="kv small">
        <dt>Snapshots taken (every {eyes.intervalSec}s)</dt>
        <dd>{eyes.captures}</dd>
        <dt>Kept on this device</dt>
        <dd>
          {eyes.storedFrames} ({mb} MB)
        </dd>
        <dt>Times myTA asked the model to look</dt>
        <dd>{eyes.reviews}</dd>
        <dt>All model calls</dt>
        <dd>{eyes.calls.total}</dd>
      </dl>
      {kinds && <p className="small muted">By kind: {kinds}</p>}
      {eyes.calls.promptTokens > 0 && (
        <p className="small muted">
          {eyes.calls.promptTokens.toLocaleString()} prompt tokens, {eyes.calls.cachedTokens.toLocaleString()} served from Gemini's cache
        </p>
      )}
      <p className="small">{gateText}</p>
      {g && <p className="small">{finishText(finish, g.solved)}</p>}
      {g && (
        <p className="small muted">
          New work on screen since the last look: {(g.pendingWork * 100).toFixed(1)}% · looks in the last 10 min: {g.callsInWindow}
        </p>
      )}
      {eyes.last && (
        <p className="small">
          Last look {ago(eyes.last.at, now)}: {REASON[eyes.last.reason] ?? eyes.last.reason} →{' '}
          <strong>{eyes.last.outcome === 'running' ? 'in progress' : eyes.last.outcome.replace('_', ' ')}</strong>
        </p>
      )}
      {eyes.log.length > 0 && (
        <ul className="eyes-log small">
          {eyes.log.slice(0, 8).map((l, i) => (
            <li key={i}>
              <time>{new Date(l.t).toLocaleTimeString()}</time>
              {l.text}
            </li>
          ))}
        </ul>
      )}
      <h3 className="sent-title">Pictures sent to the model</h3>
      {sent.length ? (
        <>
          <p className="small muted">The exact screens behind the last few calls. If your work is not in the picture, the model could not see it.</p>
          <ul className="sent">
            {sent.slice(0, 4).map((s) => (
              <li key={s.at}>
                <p className="small">
                  <strong>{KIND[s.kind] ?? s.kind}</strong> · {ago(s.at, now)}
                </p>
                <div className="sent-grid">
                  {s.images.map((im, i) => (
                    <figure key={i}>
                      <img src={im.thumb} alt={im.caption || 'Screen sent to the model'} />
                      <figcaption className="small muted">{im.caption.replace(/\(the box refers to this image\)/, '').replace(/\.$/, '') || 'screen'}</figcaption>
                    </figure>
                  ))}
                </div>
              </li>
            ))}
          </ul>
        </>
      ) : (
        <p className="small muted">Nothing has been sent yet.</p>
      )}
      <button className="ghost small" onClick={() => void send({ type: 'clear-snapshots' }).then(() => setSent([]))}>
        Delete stored snapshots
      </button>
    </div>
  );
}
