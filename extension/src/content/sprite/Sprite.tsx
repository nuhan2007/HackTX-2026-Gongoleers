// The sprite: one character, in one place (the tab where the student writes their work), that says one thing at a time: a hint, where
// the work went wrong, a congratulation, or an offer to check. There is nothing to type; every button is a choice, never a chat.
// The words come from the background (already checked so they never give the answer); this file only shows them nicely.
import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { CHEER_MS } from '../../shared/constants';
import { bitmapOfDataUrl } from '../../shared/imageData';
import type { Msg, SpriteContent, StatusPill } from '../../shared/messages';
import { clampPos, DEFAULT_SPRITE, getMySprite, getSpritePos, onMySpriteChanged, saveSpritePos, type MySprite, type SpritePos } from '../../shared/mySprite';
import type { Box, VideoMoment } from '../../shared/types';
import { Avatar } from './Avatar';
import { confettiBurst } from './confetti';
import type { Mood } from './Monkey';
import { PixelIcon } from './pixelIcons';

export { spriteCss } from './styles';

/** The small status myTA keeps on a page it is following, and a line that says what it just did. */
interface Status {
  pill: StatusPill | null;
  toast: string | null;
}

const TOAST_MS = 8000;
/** The red box drawn on the student's work stays this long (it can be shown again from the bubble). */
const MARK_MS = 30_000;
const DEFAULT_POS: SpritePos = { right: 20, bottom: 20 };
const CHAR_W = 118;

/** Where the character's left edge is, given the distance of its right edge from the right of the window. */
const vw0 = (viewportWidth: number, right: number) => viewportWidth - right - CHAR_W;

const send = (msg: Msg) => chrome.runtime.sendMessage(msg).catch(() => undefined);

/** "2:14", or "1:02:03" past an hour. */
export function fmtTime(s: number): string {
  const t = Math.max(0, Math.floor(s));
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const sec = String(t % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
}

/** Where a clip starts, in parentheses, as the student sees it next to "Watch it": "(2:14)". Approximate when it only came from the search result. */
export function startLabel(v: Pick<VideoMoment, 'start' | 'source'>): string {
  if (v.source === 'metadata' && v.start === 0) return '(from the start)';
  return `(${v.source === 'metadata' ? '~' : ''}${fmtTime(v.start)})`;
}

const reducedMotion = () => !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

/** Reveals text a few characters at a time, so a hint arrives like someone saying it. Instant with reduced motion. */
function useTyped(text: string | undefined): { shown: string; done: boolean } {
  const [n, setN] = useState(0);
  useEffect(() => {
    setN(0);
    if (!text) return;
    if (reducedMotion()) return setN(text.length);
    const step = text.length > 150 ? 2 : 1;
    const every = Math.max(9, Math.min(24, 1500 / text.length));
    let i = 0;
    const id = window.setInterval(() => {
      i += step;
      setN(Math.min(text.length, i));
      if (i >= text.length) window.clearInterval(id);
    }, every);
    return () => window.clearInterval(id);
  }, [text]);
  return { shown: text ? text.slice(0, n) : '', done: !text || n >= text.length };
}

/** The screen myTA checked, with the box drawn on it. Decoded without any network or <img>, so a page's strict CSP can't block it. */
async function drawPicture(canvas: HTMLCanvasElement, dataUrl: string, box: Box | null): Promise<void> {
  const bmp = await bitmapOfDataUrl(dataUrl);
  try {
    const w = 300;
    const h = Math.max(1, Math.round((bmp.height / bmp.width) * w));
    canvas.width = w;
    canvas.height = h;
    const g = canvas.getContext('2d');
    if (!g) return;
    g.drawImage(bmp, 0, 0, w, h);
    if (box) {
      const x = (box[1] / 1000) * w;
      const y = (box[0] / 1000) * h;
      const bw = ((box[3] - box[1]) / 1000) * w;
      const bh = ((box[2] - box[0]) / 1000) * h;
      g.fillStyle = 'rgba(255, 77, 90, .14)';
      g.fillRect(x, y, bw, bh);
      g.strokeStyle = '#ff4d5a';
      g.lineWidth = 3;
      g.strokeRect(x, y, bw, bh);
    }
  } finally {
    bmp.close();
  }
}

type IconName = 'bulb' | 'alert' | 'star' | 'check' | 'play' | 'eye' | 'copy';
const ICON_PATHS: Record<IconName, string> = {
  bulb: 'M9 18h6M10 21h4M12 3a6 6 0 0 0-3.5 10.9c.6.5 1 1.2 1 2v.1h5v-.1c0-.8.4-1.5 1-2A6 6 0 0 0 12 3z',
  alert: 'M12 8v5M12 17h.01M10.3 3.9 2.4 17.6A2 2 0 0 0 4.1 20.6h15.8a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z',
  star: 'M12 2.8l2.9 5.9 6.5.9-4.7 4.6 1.1 6.5L12 17.6l-5.8 3.1 1.1-6.5L2.6 9.6l6.5-.9z',
  check: 'M9 11l3 3 8-8M20 12v6a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h8',
  play: 'M7 4.5v15l13-7.5z',
  eye: 'M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12zM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z',
  copy: 'M9 9h10v10H9zM5 15V5h10',
};
function Icon({ name }: { name: IconName }) {
  return (
    <svg viewBox="0 0 24 24" fill={name === 'play' || name === 'star' ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={ICON_PATHS[name]} />
    </svg>
  );
}

/** The picture of a clip: its thumbnail (handed over as data, drawn on a canvas), with the minute it starts at stamped on it. */
function Thumb({ v, onPlay }: { v: VideoMoment; onPlay: () => void }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    if (!v.thumb) return;
    let dead = false;
    void bitmapOfDataUrl(v.thumb)
      .then((bmp) => {
        const c = ref.current;
        if (dead || !c) return bmp.close();
        c.width = bmp.width;
        c.height = bmp.height;
        c.getContext('2d')?.drawImage(bmp, 0, 0);
        bmp.close();
      })
      .catch(() => undefined);
    return () => {
      dead = true;
    };
  }, [v.thumb]);
  return (
    <button className="thumb" onClick={onPlay} aria-label={`Watch ${v.title}, starting at ${fmtTime(v.start)}`}>
      {v.thumb && <canvas ref={ref} />}
      <span className="play">
        <Icon name="play" />
      </span>
      <span className="stamp">{startLabel(v)}</span>
    </button>
  );
}

interface Where {
  open: boolean;
  loading: boolean;
  image: string | null;
}

/** Which mood the character is in: a hint is a thinking monkey, a mistake an alarmed one, a cheer a jumping one. */
function moodOf(c: SpriteContent): Mood {
  if (c.kind === 'cheer') return 'cheer';
  if (c.kind === 'mistake') return c.mistakeKind === 'copy' ? 'worry' : 'alert';
  if (c.kind === 'check-work' || c.kind === 'hello') return 'happy';
  return 'think';
}

const KIND_ICON: Record<SpriteContent['kind'], IconName> = { stuck: 'bulb', mistake: 'alert', cheer: 'star', 'check-work': 'check', hello: 'star' };

export function Sprite() {
  const [content, setContent] = useState<SpriteContent | null>(null);
  const [status, setStatus] = useState<Status>({ pill: null, toast: null });
  const [busy, setBusy] = useState(false);
  const [markOn, setMarkOn] = useState(false);
  const [where, setWhere] = useState<Where>({ open: false, loading: false, image: null });
  const [collapsed, setCollapsed] = useState(false);
  /** What was on the sprite a moment ago: it takes a beat to leave, rather than blinking out. */
  const [leaving, setLeaving] = useState<SpriteContent | null>(null);
  const leaveTimer = useRef<number | undefined>(undefined);
  const [entering, setEntering] = useState(false);
  const [sprite, setSprite] = useState<MySprite>(DEFAULT_SPRITE);
  const [pos, setPos] = useState<SpritePos>(DEFAULT_POS);
  const [vp, setVp] = useState({ w: window.innerWidth, h: window.innerHeight });
  const lastToast = useRef(0);
  const toastTimer = useRef<number | undefined>(undefined);
  const shownJson = useRef('');
  const contentRef = useRef<SpriteContent | null>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const confettiRef = useRef<HTMLCanvasElement>(null);
  const charRef = useRef<HTMLButtonElement>(null);
  const posRef = useRef(pos);
  const drag = useRef<{ sx: number; sy: number; r: number; b: number; moved: boolean } | null>(null);
  posRef.current = pos;

  /** Takes what the sprite is saying away, with a short goodbye. */
  const clear = useCallback(() => {
    const prev = contentRef.current;
    contentRef.current = null;
    shownJson.current = '';
    setContent(null);
    if (prev && !reducedMotion()) {
      setLeaving(prev);
      window.clearTimeout(leaveTimer.current);
      leaveTimer.current = window.setTimeout(() => setLeaving(null), 280);
    }
  }, []);

  // The character the student chose, and where they last left it.
  useEffect(() => {
    void getMySprite().then(setSprite);
    void getSpritePos().then((p) => p && setPos(clampPos(p, { w: window.innerWidth, h: window.innerHeight })));
    const stop = onMySpriteChanged(setSprite);
    const onResize = () => {
      setVp({ w: window.innerWidth, h: window.innerHeight });
      setPos((p) => clampPos(p, { w: window.innerWidth, h: window.innerHeight }));
    };
    window.addEventListener('resize', onResize);
    return () => {
      stop();
      window.removeEventListener('resize', onResize);
    };
  }, []);

  useEffect(() => {
    const onMsg = (msg: Msg) => {
      if (msg.type === 'status') {
        setStatus((cur) => ({ ...cur, pill: msg.pill }));
        const t = msg.toast;
        if (t && t.id !== lastToast.current) {
          lastToast.current = t.id;
          setStatus((cur) => ({ ...cur, toast: t.text }));
          window.clearTimeout(toastTimer.current);
          toastTimer.current = window.setTimeout(() => setStatus((cur) => ({ ...cur, toast: null })), TOAST_MS);
        }
        return;
      }
      if (msg.type !== 'nudge') return;
      if (msg.show && msg.content) {
        const json = JSON.stringify(msg.content);
        if (json === shownJson.current) return; // the same thing pushed again (a reload re-sends it)
        const c = msg.content;
        const cur = contentRef.current;
        // A different item (not just its hint arriving or a clip being found) starts fresh.
        if (!cur || cur.kind !== c.kind || cur.checkId !== c.checkId || cur.title !== c.title) {
          setWhere({ open: false, loading: false, image: null });
          setMarkOn(!!c.box);
          setCollapsed(false);
        }
        if (!cur) {
          setEntering(true);
          window.setTimeout(() => setEntering(false), 1000);
        }
        window.clearTimeout(leaveTimer.current);
        setLeaving(null);
        contentRef.current = c;
        shownJson.current = json;
        setContent(c);
        setBusy(false);
      } else if (!msg.show && contentRef.current?.kind === msg.kind) {
        clear();
      }
    };
    chrome.runtime.onMessage.addListener(onMsg);
    return () => {
      chrome.runtime.onMessage.removeListener(onMsg);
      window.clearTimeout(toastTimer.current);
    };
  }, [clear]);

  // The red box on the work goes away by itself after a while; "Show me where" brings it back.
  useEffect(() => {
    if (!markOn) return;
    const id = window.setTimeout(() => setMarkOn(false), MARK_MS);
    return () => window.clearTimeout(id);
  }, [markOn, content?.checkId]);

  useEffect(() => {
    if (where.open && where.image && canvasRef.current) void drawPicture(canvasRef.current, where.image, content?.box ?? null).catch(() => undefined);
  }, [where.open, where.image, content?.box]);

  // A right answer: confetti from the character, once per cheer.
  const cheerKey = content?.kind === 'cheer' ? `${content.title}|${content.streak ?? 0}` : '';
  useEffect(() => {
    if (!cheerKey || !confettiRef.current) return;
    const r = charRef.current?.getBoundingClientRect();
    return confettiBurst(confettiRef.current, { x: r ? r.left + r.width / 2 : window.innerWidth - 80, y: r ? r.top + r.height * 0.3 : window.innerHeight - 120 });
  }, [cheerKey]);

  // Dragging the character moves the sprite; a click without a drag folds the bubble away (and brings it back).
  const onPointerDown = useCallback((e: ReactPointerEvent<HTMLButtonElement>) => {
    if (e.button !== 0) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { sx: e.clientX, sy: e.clientY, r: posRef.current.right, b: posRef.current.bottom, moved: false };
  }, []);
  const onPointerMove = useCallback((e: ReactPointerEvent<HTMLButtonElement>) => {
    const d = drag.current;
    if (!d) return;
    const dx = e.clientX - d.sx;
    const dy = e.clientY - d.sy;
    if (!d.moved && Math.hypot(dx, dy) < 5) return;
    d.moved = true;
    setPos(clampPos({ right: d.r - dx, bottom: d.b - dy }, { w: window.innerWidth, h: window.innerHeight }));
  }, []);
  const onPointerUp = useCallback(() => {
    const d = drag.current;
    drag.current = null;
    if (!d) return;
    if (d.moved) void saveSpritePos(posRef.current);
    else setCollapsed((c) => !c);
  }, []);

  const side: 'left' | 'right' = vp.w - pos.right - 59 < vp.w / 2 ? 'right' : 'left';
  // The dock is pinned by the character, whichever side the bubble opens on: by its right edge when the bubble is to its left, by its left edge
  // when the bubble is to its right (the character is as wide as its box, 118px).
  const dockStyle = useMemo(() => (side === 'left' ? { right: pos.right, bottom: pos.bottom } : { left: vw0(vp.w, pos.right), bottom: pos.bottom }), [pos, side, vp.w]);

  const shown = content ?? leaving;
  if (!shown) {
    if (!status.pill && !status.toast) return <canvas ref={confettiRef} className="confetti" />;
    return (
      <div className="root">
        <div className="status">
          {status.toast && (
            <p className="toast" role="status">
              {status.toast}
            </p>
          )}
          {status.pill && (
            <button className={`pill ${status.pill.tone}`} title="Open myTA" onClick={() => void send({ type: 'open-panel' })}>
              <span className="dot" />
              {status.pill.text}
            </button>
          )}
        </div>
        <canvas ref={confettiRef} className="confetti" />
      </div>
    );
  }

  const c = shown;
  const leavingNow = !content;
  const dismiss = (snooze: boolean) => {
    void send({ type: 'nudge-dismissed', snooze, kind: c.kind });
    clear();
  };
  const act = (msg: Msg) => {
    setBusy(true);
    void send(msg);
  };
  const showWhere = async () => {
    setMarkOn(true);
    if (where.open) return setWhere((w) => ({ ...w, open: false }));
    setWhere((w) => ({ ...w, open: true, loading: !w.image }));
    if (where.image || c.checkId == null) return setWhere((w) => ({ ...w, loading: false }));
    const r = await chrome.runtime.sendMessage({ type: 'get-auto-check', id: c.checkId } satisfies Msg).catch(() => null);
    setWhere((w) => ({ ...w, loading: false, image: r?.image ?? null }));
  };

  const mood = moodOf(c);
  const hasVideoButton = !!c.canVideo && !c.video && c.videoState !== 'loading';
  const plainOffer = c.kind === 'stuck' && !c.pending && !c.text;
  const hint = c.kind === 'stuck' && !c.pending && !!c.text;
  const copyMistake = c.kind === 'mistake' && c.mistakeKind === 'copy';
  const box = c.kind === 'mistake' && markOn ? c.box : null;

  return (
    <div className={`root kind-${c.kind}`}>
      <canvas ref={confettiRef} className="confetti" />
      {box && !leavingNow && (
        <div
          className="mark"
          aria-label="Where the work went off track"
          style={{ top: `${box[0] / 10}%`, left: `${box[1] / 10}%`, height: `${(box[2] - box[0]) / 10}%`, width: `${(box[3] - box[1]) / 10}%` }}
        >
          <span className={`tag ${box[0] < 80 ? 'below' : ''}`}>{copyMistake ? 'Compare with the problem' : 'Look here'}</span>
        </div>
      )}
      <div className={`dock side-${side} ${leavingNow ? 'leaving' : ''}`} style={dockStyle}>
        {!collapsed && (
          <Card c={c} where={where} busy={busy} plainOffer={plainOffer} hint={hint} hasVideoButton={hasVideoButton} copyMistake={copyMistake} canvasRef={canvasRef} dismiss={dismiss} act={act} showWhere={() => void showWhere()} />
        )}
        <button
          ref={charRef}
          className="char"
          aria-label={collapsed ? 'Show myTA’s message' : 'myTA. Click to fold the message away; drag to move'}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          onKeyDown={(e) => {
            // From the keyboard there is no pointer: Enter or Space folds and unfolds the bubble.
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              setCollapsed((v) => !v);
            }
          }}
        >
          <Avatar mood={mood} sprite={sprite} entering={entering} mirror={side === 'left'} />
          {collapsed && <span className="badge" />}
        </button>
      </div>
    </div>
  );
}

interface CardProps {
  c: SpriteContent;
  where: Where;
  busy: boolean;
  plainOffer: boolean;
  hint: boolean;
  hasVideoButton: boolean;
  copyMistake: boolean;
  canvasRef: React.RefObject<HTMLCanvasElement>;
  dismiss: (snooze: boolean) => void;
  act: (msg: Msg) => void;
  showWhere: () => void;
}

function Card({ c, where, busy, plainOffer, hint, hasVideoButton, copyMistake, canvasRef, dismiss, act, showWhere }: CardProps) {
  const typed = useTyped(c.text);
  const score = c.score !== undefined ? Math.max(0, Math.min(100, Math.round(c.score))) : null;
  return (
    <div className="card" role="dialog" aria-label="myTA study buddy" aria-live="polite">
      <div className="fx" aria-hidden="true">
        <i className="bar" />
        {c.kind === 'cheer' && <i className="shine" />}
        {c.kind === 'cheer' && <i className="count" style={{ animationDuration: `${CHEER_MS}ms` }} />}
      </div>
      <span className="nub" aria-hidden="true" />
      <div className="head">
        <span className="icon-chip">
          <Icon name={KIND_ICON[c.kind]} />
        </span>
        <p className="title">{c.title}</p>
        <button className="x" aria-label="Close" onClick={() => dismiss(false)}>
          ×
        </button>
      </div>

      {c.pending && (
        <div className="dots" aria-live="polite">
          <span />
          <span />
          <span />
          <em>reading your work</em>
        </div>
      )}
      {c.checking && (
        <div className="shimmer" aria-label="Finding the right words">
          <i />
          <i />
          <i />
        </div>
      )}
      {c.text && (
        <p className="msg">
          {typed.shown}
          {!typed.done && <span className="caret" />}
        </p>
      )}

      {(hint || c.kind === 'mistake') && (
        <div className="chips">
          {hint && c.hintLevel && (
            <span className="chip">
              <span className="ladder">
                {[1, 2, 3].map((n) => (
                  <i key={n} className={n <= c.hintLevel! ? 'on' : ''} />
                ))}
              </span>
              Hint {c.hintLevel} of 3
            </span>
          )}
          {c.kind === 'mistake' && (
            <span className="chip">
              <Icon name={copyMistake ? 'copy' : 'eye'} />
              {copyMistake ? 'Copied differently' : 'In your working'}
            </span>
          )}
        </div>
      )}

      {c.kind === 'stuck' && (c.pending || plainOffer) && c.reasons && c.reasons.length > 0 && (
        <div className="chips" aria-label="What myTA noticed">
          <span className="chip quiet">I noticed</span>
          {c.reasons.slice(0, 3).map((r) => (
            <span className="chip" key={r}>
              {r}
            </span>
          ))}
        </div>
      )}
      {c.kind === 'stuck' && score !== null && (c.pending || plainOffer) && (
        <>
          <div className="gauge" role="meter" aria-valuenow={score} aria-valuemin={0} aria-valuemax={100} aria-label="Confusion">
            <i style={{ width: `${score}%` }} />
          </div>
          <p className="gauge-label">confusion {score}</p>
        </>
      )}

      {c.kind === 'cheer' && !!c.streak && c.streak > 0 && (
        <div className="chips">
          <span className="chip">
            <PixelIcon name="star" scale={2} />
            {c.streak === 1 ? 'First one today' : `${c.streak} solved today`}
          </span>
        </div>
      )}

      {where.open && (
        <div className="where">
          {where.loading ? (
            <p className="msg muted">Getting the screen I checked…</p>
          ) : where.image ? (
            <canvas ref={canvasRef} aria-label="The screen I checked, with the problem spot boxed" />
          ) : (
            <p className="msg muted">I no longer have that screen, but the red box is on your work.</p>
          )}
        </div>
      )}

      {c.videoState === 'loading' && (
        <div className="dots">
          <span />
          <span />
          <span />
          <em>finding a short clip</em>
        </div>
      )}
      {c.videoState === 'error' && <p className="msg muted">I couldn&apos;t find a clip just now.</p>}
      {c.video && (
        <div className="clip">
          <Thumb v={c.video} onPlay={() => void send({ type: 'open-video', videoId: c.video!.videoId, start: c.video!.start })} />
          <div className="info">
            <p className="why">{c.video.why}</p>
            <p className="meta">
              {c.video.title} · {c.video.channel}
            </p>
            <button className="b primary" onClick={() => void send({ type: 'open-video', videoId: c.video!.videoId, start: c.video!.start })}>
              ▶ Watch it {startLabel(c.video)}
            </button>
            {c.video.practice && c.video.practice.length > 0 && (
              <ul className="practice">
                {c.video.practice.slice(0, 2).map((p) => (
                  <li key={p.link}>
                    <a href={p.link} target="_blank" rel="noreferrer">
                      {p.title}
                    </a>{' '}
                    ({p.site})
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}

      <div className="row">
        {c.kind === 'mistake' && (
          <>
            <button className="b primary" onClick={showWhere} disabled={c.checking}>
              {where.open ? 'Hide the picture' : 'Show me where'}
            </button>
            {hasVideoButton && (
              <button className="b" onClick={() => act({ type: 'video-request' })} disabled={busy}>
                Watch a short clip
              </button>
            )}
            <button className="b" onClick={() => dismiss(false)}>
              Got it
            </button>
          </>
        )}
        {c.kind === 'cheer' && (
          <button className="b primary" onClick={() => dismiss(false)}>
            Thanks!
          </button>
        )}
        {c.kind === 'hello' && (
          <button className="b primary" onClick={() => dismiss(false)}>
            Let&apos;s go
          </button>
        )}
        {c.kind === 'check-work' && (
          <>
            <button className="b primary" onClick={() => act({ type: 'check-now' })} disabled={busy}>
              Check my work
            </button>
            <button className="b" onClick={() => dismiss(false)}>
              Skip
            </button>
          </>
        )}
        {c.kind === 'stuck' &&
          (c.pending ? (
            <button className="b" onClick={() => dismiss(false)}>
              Not now
            </button>
          ) : plainOffer ? (
            <>
              <button className="b primary" onClick={() => act({ type: 'hint-request' })} disabled={busy}>
                Give me a hint
              </button>
              {hasVideoButton && (
                <button className="b" onClick={() => act({ type: 'video-request' })} disabled={busy}>
                  Watch a short clip
                </button>
              )}
              <button className="b" onClick={() => dismiss(false)}>
                Not now
              </button>
              <button className="link" onClick={() => dismiss(true)}>
                Snooze 15 min
              </button>
            </>
          ) : (
            <>
              <button className="b primary" onClick={() => dismiss(false)}>
                Got it
              </button>
              <button className="b" onClick={() => act({ type: 'hint-request' })} disabled={busy}>
                Another hint
              </button>
              {hasVideoButton && (
                <button className="b" onClick={() => act({ type: 'video-request' })} disabled={busy}>
                  Watch a short clip
                </button>
              )}
              <button className="link" onClick={() => dismiss(true)}>
                Snooze 15 min
              </button>
            </>
          ))}
      </div>
    </div>
  );
}
