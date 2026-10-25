import { useEffect, useState } from 'react';
import { send, type Stats as StatsData } from '../shared/messages';
import { fmtDuration } from './format';

const pct = (x: number) => `${Math.round(x * 100)}%`;

export function Stats() {
  const [s, setS] = useState<StatsData | null>(null);
  useEffect(() => {
    send({ type: 'get-stats' }).then(setS).catch(() => {});
  }, []);
  if (!s) return <p className="muted">Loading…</p>;
  const { trigger, leak } = s.eval;

  return (
    <div className="stack">
      <div className="tiles">
        <Tile label="Median time-to-unstuck" value={s.medianTimeToUnstuckSec !== null ? fmtDuration(Math.round(s.medianTimeToUnstuckSec)) : '—'} />
        <Tile label="Sessions solved" value={s.solvedRate !== null ? pct(s.solvedRate) : '—'} sub={`${s.sessions.length} sessions`} />
      </div>

      <div className="card">
        <h3>Measured accuracy</h3>
        {trigger ? (
          <div className="tiles">
            <Tile label="Trigger precision" value={pct(trigger.precision)} />
            <Tile label="Trigger recall" value={pct(trigger.recall)} />
            <Tile label="Median lead time" value={`${Math.round(trigger.medianLeadSec)}s`} sub={`${trigger.sessions} labeled sessions`} />
          </div>
        ) : (
          <p className="small muted">Not measured yet. Collect label-mode sessions and run <code>npm run evaluate</code>.</p>
        )}
        {leak ? (
          <div className="tiles">
            <Tile label="Answer-leak rate" value={pct(leak.leakRate)} sub={`${leak.turns} turns over ${leak.problems} problems`} />
            <Tile label="Before the guard" value={pct(leak.preGuardLeakRate)} sub="raw tutor drafts" />
          </div>
        ) : (
          <p className="small muted">Leak eval not run yet: <code>npm run leak-eval</code>.</p>
        )}
      </div>

      <div className="card">
        <h3>Recent sessions</h3>
        {s.sessions.length === 0 && <p className="small muted">No sessions yet.</p>}
        <ul className="sessions">
          {s.sessions.map((x) => (
            <li key={x.id}>
              <span className={`chip ${x.solved ? 'good' : ''}`}>{x.solved ? '✓ solved' : 'paused'}</span>{' '}
              <span className="small">
                {x.concepts.slice(0, 2).join(', ') || x.url}
                {x.timeToUnstuckSec !== null && ` · ${fmtDuration(x.timeToUnstuckSec)}`}
              </span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

function Tile({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="tile">
      <span className="hero-num">{value}</span>
      <span className="small">{label}</span>
      {sub && <span className="small muted">{sub}</span>}
    </div>
  );
}
