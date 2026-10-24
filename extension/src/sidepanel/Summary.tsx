import type { SessionSummary } from '../shared/types';

export const fmtDuration = (sec: number) => (sec >= 60 ? `${Math.floor(sec / 60)}m ${sec % 60}s` : `${sec}s`);

export function Summary({ s, onDone }: { s: SessionSummary; onDone: () => void }) {
  return (
    <div className="card summary">
      <h2>You got it! 🎉</h2>
      <div className="hero">
        <span className="hero-num">{s.timeToUnstuckSec !== null ? fmtDuration(s.timeToUnstuckSec) : '—'}</span>
        <span className="muted small">time from stuck to unstuck</span>
      </div>
      {s.concepts.length > 0 && (
        <>
          <h3>Concepts you practiced</h3>
          <div className="row">
            {s.concepts.map((c) => (
              <span className="chip" key={c}>
                {c}
              </span>
            ))}
          </div>
        </>
      )}
      {s.videosWatched.length > 0 && (
        <>
          <h3>Videos watched</h3>
          <ul className="small">
            {s.videosWatched.map((v) => (
              <li key={v}>{v}</li>
            ))}
          </ul>
        </>
      )}
      <p className="small muted">
        {s.turns} replies. This summary stays on your device.
      </p>
      <button className="primary" onClick={onDone}>
        Done
      </button>
    </div>
  );
}
