import type { VideoMoment } from '../shared/types';

export const fmtTime = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

export function VideoCard({ v, onDone }: { v: VideoMoment; onDone: () => void }) {
  const src = `https://www.youtube-nocookie.com/embed/${v.videoId}?start=${v.start}&end=${v.end}&rel=0&modestbranding=1`;
  return (
    <div className="card video">
      <p>
        <strong>
          Watch {fmtTime(v.start)}–{fmtTime(v.end)}:
        </strong>{' '}
        {v.why}
      </p>
      <div className="video-frame">
        <iframe
          src={src}
          title={v.title}
          allow="accelerometer; encrypted-media; gyroscope; picture-in-picture"
          referrerPolicy="strict-origin-when-cross-origin"
          allowFullScreen
        />
      </div>
      <p className="small muted">
        {v.title} · {v.channel} ·{' '}
        <a href={`https://www.youtube.com/watch?v=${v.videoId}&t=${v.start}s`} target="_blank" rel="noreferrer">
          open on YouTube at {fmtTime(v.start)}
        </a>
      </p>
      {v.practice && v.practice.length > 0 && (
        <div className="small">
          <p>
            <strong>This idea keeps coming up. Some practice:</strong>
          </p>
          <ul>
            {v.practice.map((p) => (
              <li key={p.link}>
                <a href={p.link} target="_blank" rel="noreferrer">
                  {p.title}
                </a>{' '}
                <span className="muted">({p.site})</span>
              </li>
            ))}
          </ul>
        </div>
      )}
      <button className="primary" onClick={onDone}>
        I watched it, back to the problem
      </button>
    </div>
  );
}
