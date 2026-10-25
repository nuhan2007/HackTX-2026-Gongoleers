// "Make it yours": the sprite is a pixel monkey until the student gives it a face. Upload a photo or take one, drag and zoom to pick the
// part, and it becomes a sticker (cut out, with a white outline) or pixel art (to sit beside the monkey). It can be changed back any time.
// Nothing is uploaded anywhere: the cut-out model runs here, in the browser.
import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { createPortal } from 'react-dom';
import { Avatar } from '../content/sprite/Avatar';
import type { Mood } from '../content/sprite/Monkey';
import { spriteCss } from '../content/sprite/styles';
import { send } from '../shared/messages';
import { DEFAULT_SPRITE, getMySprite, onMySpriteChanged, saveMySprite, type MySprite } from '../shared/mySprite';
import { loadBitmap, makeSprite, renderSquare, WHOLE_PHOTO, type Crop, type CutChoice, type Made, type Style } from './spriteMaker';

const PREVIEW = 300;
const MOODS: { mood: Mood; label: string }[] = [
  { mood: 'idle', label: 'Hanging out' },
  { mood: 'think', label: 'Thinking' },
  { mood: 'alert', label: 'Found a slip' },
  { mood: 'cheer', label: 'You got it!' },
];

/** Draws children in a shadow root, so the sprite's own styles can't touch this page and this page's can't touch the sprite. */
function Shadow({ children, className }: { children: React.ReactNode; className?: string }) {
  const host = useRef<HTMLDivElement>(null);
  const [mount, setMount] = useState<HTMLElement | null>(null);
  useEffect(() => {
    if (!host.current) return;
    const root = host.current.shadowRoot ?? host.current.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = `${spriteCss}\n:host{display:block}.stage{display:flex;align-items:flex-end;justify-content:center;gap:4px;padding:6px 4px}`;
    const m = document.createElement('div');
    m.className = 'root';
    root.append(style, m);
    setMount(m);
    return () => {
      style.remove();
      m.remove();
    };
  }, []);
  return (
    <div ref={host} className={className}>
      {mount && createPortal(children, mount)}
    </div>
  );
}

export function SpriteStudio() {
  const [current, setCurrent] = useState<MySprite>(DEFAULT_SPRITE);
  const [source, setSource] = useState<ImageBitmap | null>(null);
  const [crop, setCrop] = useState<Crop>(WHOLE_PHOTO);
  const [style, setStyle] = useState<Style>('sticker');
  const [cut, setCut] = useState<CutChoice>('auto');
  const [tolerance, setTolerance] = useState(44);
  const [name, setName] = useState('');
  const [made, setMade] = useState<Made | null>(null);
  const [making, setMaking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [stream, setStream] = useState<MediaStream | null>(null);
  const cropRef = useRef<HTMLCanvasElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const dragRef = useRef<{ x: number; y: number; cx: number; cy: number } | null>(null);
  const runId = useRef(0);

  useEffect(() => {
    void getMySprite().then((s) => {
      setCurrent(s);
      if (s.name) setName(s.name);
    });
    return onMySpriteChanged(setCurrent);
  }, []);

  // The photo, drawn in the crop box.
  useEffect(() => {
    const c = cropRef.current;
    if (!c || !source) return;
    const sq = renderSquare(source, crop, PREVIEW);
    c.width = c.height = PREVIEW;
    c.getContext('2d')!.drawImage(sq, 0, 0);
  }, [source, crop]);

  // A new sprite is made a moment after the student stops adjusting.
  useEffect(() => {
    if (!source) return;
    const id = ++runId.current;
    setMaking(true);
    setError(null);
    const t = window.setTimeout(async () => {
      try {
        const result = await makeSprite(renderSquare(source, crop), style, cut, tolerance);
        if (id === runId.current) setMade(result);
      } catch (e) {
        if (id === runId.current) setError(`Couldn't make a sprite from that picture: ${e instanceof Error ? e.message : e}`);
      } finally {
        if (id === runId.current) setMaking(false);
      }
    }, 280);
    return () => window.clearTimeout(t);
  }, [source, crop, style, cut, tolerance]);

  useEffect(() => () => stream?.getTracks().forEach((t) => t.stop()), [stream]);
  useEffect(() => {
    if (stream && videoRef.current) {
      videoRef.current.srcObject = stream;
      void videoRef.current.play().catch(() => undefined);
    }
  }, [stream]);

  const take = useCallback(async (blob: Blob) => {
    setError(null);
    setMade(null);
    try {
      setSource(await loadBitmap(blob));
      setCrop(WHOLE_PHOTO);
    } catch {
      setError('I couldn’t read that file. Try a JPG or PNG photo.');
    }
  }, []);

  const startCamera = async () => {
    setError(null);
    try {
      setStream(await navigator.mediaDevices.getUserMedia({ video: { width: 720, height: 720, facingMode: 'user' }, audio: false }));
    } catch {
      setError('The camera is blocked or busy. Allow it for this page (the camera icon in the address bar), or upload a photo instead.');
    }
  };
  const snap = async () => {
    const v = videoRef.current;
    if (!v || !v.videoWidth) return;
    const c = document.createElement('canvas');
    c.width = v.videoWidth;
    c.height = v.videoHeight;
    c.getContext('2d')!.drawImage(v, 0, 0);
    stream?.getTracks().forEach((t) => t.stop());
    setStream(null);
    c.toBlob((b) => b && void take(b), 'image/jpeg', 0.92);
  };

  const onDown = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    dragRef.current = { x: e.clientX, y: e.clientY, cx: crop.cx, cy: crop.cy };
  };
  const onMove = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    const d = dragRef.current;
    if (!d || !source) return;
    // Dragging the photo moves it under the frame: the centre moves the other way, scaled to how much of the photo the frame shows.
    const side = Math.min(source.width, source.height) / crop.zoom;
    const dx = ((e.clientX - d.x) / PREVIEW) * (side / source.width);
    const dy = ((e.clientY - d.y) / PREVIEW) * (side / source.height);
    setCrop((c) => ({ ...c, cx: Math.min(1, Math.max(0, d.cx - dx)), cy: Math.min(1, Math.max(0, d.cy - dy)) }));
  };
  const onUp = () => (dragRef.current = null);

  const use = async () => {
    if (!made) return;
    await saveMySprite({ mode: 'custom', png: made.png, style, name: name.trim() || undefined, updatedAt: Date.now() });
    void send({ type: 'say-hello' }).catch(() => undefined);
    setSaved(true);
    window.setTimeout(() => setSaved(false), 2000);
  };
  const useMonkey = async () => {
    await saveMySprite({ mode: 'monkey', updatedAt: Date.now() });
    void send({ type: 'say-hello' }).catch(() => undefined);
  };

  const preview: MySprite = useMemo(() => (made ? { mode: 'custom', png: made.png, style, name: name.trim() || undefined, updatedAt: 0 } : current), [made, style, name, current]);
  const using = current.mode === 'custom' ? current.name || 'your picture' : 'the pixel monkey';
  const methodNote = made?.method === 'person' ? 'Cut out with the on-device person model.' : made?.method === 'plain' ? 'Cut out from its plain background. Pick "Against a plain background" to adjust how much is cut.' : made?.method === 'none' ? 'Kept the whole picture as a sticker. If you wanted the subject cut out, pick another way of cutting above.' : '';

  return (
    <section className="card studio">
      <h2>4. Make it yours</h2>
      <p className="small muted">
        The sprite is a pixel monkey until you give it a face: your TA, a pet, a friend. Upload or take a picture and it becomes a sticker you can change any time.
        Photos are processed on this device and never uploaded. Right now myTA is <strong>{using}</strong>.
      </p>

      <div className="studio-grid">
        <div className="stack">
          <div className="row">
            <button className="primary" onClick={() => fileRef.current?.click()}>
              Upload a picture
            </button>
            <button onClick={() => (stream ? (stream.getTracks().forEach((t) => t.stop()), setStream(null)) : void startCamera())}>{stream ? 'Close camera' : 'Take a photo'}</button>
            {current.mode === 'custom' && <button onClick={() => void useMonkey()}>Back to the monkey</button>}
            <input
              ref={fileRef}
              type="file"
              accept="image/*"
              hidden
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void take(f);
                e.target.value = '';
              }}
            />
          </div>

          {stream && (
            <div className="cam-box">
              <video ref={videoRef} muted playsInline className="mirrorcam" />
              <button className="primary" onClick={() => void snap()}>
                Snap it
              </button>
            </div>
          )}

          {source && !stream && (
            <div className="crop-box">
              <canvas ref={cropRef} className="crop" width={PREVIEW} height={PREVIEW} onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp} aria-label="Drag to choose the part of the picture" />
              <label className="slider">
                <span>Zoom</span>
                <input type="range" min={1} max={3.5} step={0.05} value={crop.zoom} onChange={(e) => setCrop((c) => ({ ...c, zoom: Number(e.target.value) }))} />
              </label>
              <p className="small muted">Drag the picture to centre your TA&apos;s face.</p>
            </div>
          )}
          {!source && !stream && <p className="small muted dropnote">Pick a picture to start. A photo of the face works best, with the person looking at the camera.</p>}
        </div>

        <div className="stack">
          <div className="row">
            <span className="small">Look:</span>
            <label className="row">
              <input type="radio" name="style" checked={style === 'sticker'} onChange={() => setStyle('sticker')} /> Sticker
            </label>
            <label className="row">
              <input type="radio" name="style" checked={style === 'pixel'} onChange={() => setStyle('pixel')} /> Pixel art (matches the monkey)
            </label>
          </div>
          <label className="small">
            Cut out the background
            <select value={cut} onChange={(e) => setCut(e.target.value as CutChoice)}>
              <option value="auto">Automatically (people, pets, drawings)</option>
              <option value="person">A person</option>
              <option value="plain">Against a plain background</option>
              <option value="none">Keep the whole picture</option>
            </select>
          </label>
          {cut === 'plain' && (
            <label className="slider small">
              <span>
                How different from the background counts as the subject: <strong>{tolerance}</strong>
              </span>
              <input type="range" min={12} max={120} value={tolerance} onChange={(e) => setTolerance(Number(e.target.value))} />
            </label>
          )}
          <label className="small">
            Name
            <input type="text" value={name} placeholder="e.g. Professor Rao" maxLength={30} onChange={(e) => setName(e.target.value)} />
          </label>

          <div className={`preview ${making ? 'busy' : ''}`}>
            <Shadow>
              <div className="stage">
                {MOODS.map((m) => (
                  <div key={m.mood} style={{ textAlign: 'center' }}>
                    <div style={{ width: 118, height: 124, transform: 'scale(.78)', transformOrigin: '50% 100%', margin: '0 -10px' }}>
                      <Avatar mood={m.mood} sprite={preview} mirror={false} emote />
                    </div>
                    <div style={{ font: '600 11px system-ui', color: '#6a6684', marginTop: -2 }}>{m.label}</div>
                  </div>
                ))}
              </div>
            </Shadow>
            {making && <p className="small muted">Making your sprite…</p>}
          </div>
          {methodNote && <p className="small muted">{methodNote}</p>}
          {error && <p className="small error">{error}</p>}

          <div className="row">
            <button className="primary" disabled={!made || making} onClick={() => void use()}>
              Use as my TA
            </button>
            {saved && <span className="small">✓ Saved. It shows on every page.</span>}
          </div>
        </div>
      </div>
    </section>
  );
}
