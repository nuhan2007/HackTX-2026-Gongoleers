// Live confusion timeline: one series (score), threshold reference line, crosshair tooltip,
// and the stacked reasons. A table view is available for screen readers / exact values.
import { useRef, useState } from 'react';
import { send, type PanelState, type TriggerView } from '../shared/messages';
import { Eyes } from './Eyes';
import type { Channel, TimelinePoint, TriggerPhase } from '../shared/types';

const W = 320;
const H = 140;
const PAD = { l: 28, r: 8, t: 10, b: 20 };
const WINDOW_MS = 180_000;

/** The one rule for when the sprite appears, and where its timer stands right now. */
function TriggerLine({ t, score, phase }: { t: TriggerView; score: number; phase: TriggerPhase }) {
  const why =
    t.difficulty !== null && t.extraSec > 0
      ? ` (${t.baseSec}s, plus ${t.extraSec}s for this problem: rated ${t.difficulty} out of 5 for difficulty${t.tuning ? ', and myTA adapted to what kind of work it is' : ''})`
      : t.difficulty !== null
        ? ` (this problem is rated ${t.difficulty} out of 5 for difficulty)`
        : '';
  const rule = `The sprite appears when the score stays at or above ${t.threshold} for ${t.durationSec} seconds${why}.`;
  const status =
    t.paused === 'off'
      ? 'myTA is off.'
      : t.paused === 'snoozed'
        ? 'Snoozed, so the sprite won\'t appear.'
        : t.paused === 'no-camera'
          ? 'Paused: the camera is off, so there\'s no score to watch.'
          : t.paused === 'chatting'
            ? 'Paused while you\'re chatting with myTA.'
            : phase === 'confused'
              ? 'The sprite is showing now.'
              : t.cooldownLeftSec > 0
                ? `Resting after the last nudge: ${t.cooldownLeftSec}s before it can appear again.`
                : t.aboveSec !== null
                  ? `At or above ${t.threshold} for ${t.aboveSec}s of ${t.durationSec}s…`
                  : `Score ${score} is below ${t.threshold}, so the timer isn't running.`;
  const running = t.paused === null && t.aboveSec !== null && phase !== 'confused';
  return (
    <>
      <p className="small">{rule}</p>
      <p className="small muted" aria-live="polite">
        {status}
      </p>
      {running && (
        <div className="trigger-bar" role="progressbar" aria-valuemin={0} aria-valuemax={t.durationSec} aria-valuenow={Math.min(t.aboveSec!, t.durationSec)}>
          <div style={{ width: `${Math.min(100, ((t.aboveSec ?? 0) / t.durationSec) * 100)}%` }} />
        </div>
      )}
    </>
  );
}

export function Timeline({ state }: { state: PanelState }) {
  const [hover, setHover] = useState<TimelinePoint | null>(null);
  const [asTable, setAsTable] = useState(false);
  const svgRef = useRef<SVGSVGElement>(null);
  const pts = state.timeline;
  const now = pts.length ? pts[pts.length - 1].t : Date.now();
  const threshold = state.trigger.threshold;

  const x = (t: number) => PAD.l + ((t - (now - WINDOW_MS)) / WINDOW_MS) * (W - PAD.l - PAD.r);
  const y = (v: number) => PAD.t + (1 - v / 100) * (H - PAD.t - PAD.b);
  const path = pts.map((p, i) => `${i ? 'L' : 'M'}${x(p.t).toFixed(1)},${y(p.score).toFixed(1)}`).join(' ');

  const onMove = (e: React.PointerEvent) => {
    const r = svgRef.current!.getBoundingClientRect();
    const t = now - WINDOW_MS + (((e.clientX - r.left) / r.width) * W - PAD.l) / (W - PAD.l - PAD.r) * WINDOW_MS;
    let best: TimelinePoint | null = null;
    for (const p of pts) if (!best || Math.abs(p.t - t) < Math.abs(best.t - t)) best = p;
    setHover(best);
  };

  return (
    <div className="stack">
      <div className="card">
        <div className="row">
          <h2>Confusion score</h2>
          <div className="spacer" />
          <span className="hero-num small-hero">{state.output.score}</span>
        </div>
        <TriggerLine t={state.trigger} score={state.output.score} phase={state.phase} />
        <p className="small muted">Last 3 minutes</p>
        {asTable ? (
          <table className="small data-table">
            <thead>
              <tr>
                <th>Time</th>
                <th>Score</th>
                <th>Reasons</th>
              </tr>
            </thead>
            <tbody>
              {pts.slice(-15).reverse().map((p) => (
                <tr key={p.t}>
                  <td>{new Date(p.t).toLocaleTimeString()}</td>
                  <td>{p.score}</td>
                  <td>{p.reasons.join(', ')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <div className="chart-wrap">
            <svg
              ref={svgRef}
              viewBox={`0 0 ${W} ${H}`}
              className="chart"
              role="img"
              aria-label={`Confusion score over the last 3 minutes, currently ${state.output.score} out of 100`}
              onPointerMove={onMove}
              onPointerLeave={() => setHover(null)}
            >
              {[0, 50, 100].map((v) => (
                <g key={v}>
                  <line x1={PAD.l} x2={W - PAD.r} y1={y(v)} y2={y(v)} stroke="var(--chart-grid)" strokeWidth={1} />
                  <text x={PAD.l - 6} y={y(v) + 4} textAnchor="end" className="axis">
                    {v}
                  </text>
                </g>
              ))}
              <text x={PAD.l} y={H - 4} className="axis">
                −3 min
              </text>
              <text x={W - PAD.r} y={H - 4} textAnchor="end" className="axis">
                now
              </text>
              <g>
                <line x1={PAD.l} x2={W - PAD.r} y1={y(threshold)} y2={y(threshold)} stroke="var(--ink-3)" strokeDasharray="4 3" strokeWidth={1} />
                <text x={W - PAD.r} y={y(threshold) - 4} textAnchor="end" className="axis">
                  trigger {threshold}
                </text>
              </g>
              <path d={path} fill="none" stroke="var(--chart-line)" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
              {pts.length > 0 && (
                <circle cx={x(now)} cy={y(pts[pts.length - 1].score)} r={4} fill="var(--chart-line)" stroke="var(--surface)" strokeWidth={2} />
              )}
              {hover && (
                <g pointerEvents="none">
                  <line x1={x(hover.t)} x2={x(hover.t)} y1={PAD.t} y2={H - PAD.b} stroke="var(--ink-3)" strokeWidth={1} />
                  <circle cx={x(hover.t)} cy={y(hover.score)} r={4} fill="var(--chart-line)" stroke="var(--surface)" strokeWidth={2} />
                </g>
              )}
            </svg>
            {hover && (
              <div className="tooltip" style={{ left: `${(x(hover.t) / W) * 100}%` }}>
                <strong>{hover.score}</strong> · {new Date(hover.t).toLocaleTimeString()}
                {hover.reasons.length > 0 && <div className="muted">{hover.reasons.join(' · ')}</div>}
              </div>
            )}
          </div>
        )}
        <button className="ghost small" onClick={() => setAsTable((v) => !v)}>
          {asTable ? 'Show chart' : 'Show as table'}
        </button>
      </div>

      <div className="card">
        <h3>Why the score is what it is</h3>
        {state.output.topContributors.length ? (
          <div className="row">
            {state.output.topContributors.map((r) => (
              <span key={r} className="chip">
                {r}
              </span>
            ))}
          </div>
        ) : (
          <p className="small muted">Nothing notable right now.</p>
        )}
        <div className="meters">
          {(['content', 'activity', 'face'] as Channel[]).map((c) => (
            <div key={c} className="meter">
              <span className="small">{c === 'content' ? 'Page content' : c === 'activity' ? 'Activity' : 'Face'}</span>
              <div className="meter-track">
                <div className="meter-fill" style={{ width: `${Math.round(state.output.channels[c] * 100)}%` }} />
              </div>
              <span className="small muted num">{Math.round(state.output.channels[c] * 100)}</span>
            </div>
          ))}
        </div>
        <p className="small muted">Weights: content 50% · activity 30% · face 20%</p>
      </div>

      <Eyes eyes={state.eyes} finish={state.finish} />

      {(state.devMode || state.labelMode) && (
        <div className="card">
          <h3>Developer</h3>
          {state.labelMode && <p className="small">Label mode on: press Alt+Shift+S the moment you feel stuck.</p>}
          {state.devMode && <button onClick={() => send({ type: 'force-trigger' })}>Force trigger</button>}
        </div>
      )}
    </div>
  );
}
