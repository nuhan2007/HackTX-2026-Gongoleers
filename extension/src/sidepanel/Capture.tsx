// Consent capture: the student crops the problem, sees exactly what will be sent, and
// chooses Send or Cancel. Nothing leaves the device until Send.
import { useEffect, useRef, useState } from 'react';
import { isError, send, type PageContext } from '../shared/messages';

const MAX_W = 1280;

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export function Capture({ onSend, onCancel }: { onSend: (image: string, ctx: PageContext | null) => void; onCancel: () => void }) {
  const [shot, setShot] = useState<HTMLImageElement | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ctx, setCtx] = useState<PageContext | null>(null);
  const [includeText, setIncludeText] = useState(true);
  const [blur, setBlur] = useState(true);
  const [crop, setCrop] = useState<Rect | null>(null); // in natural image px
  const [preview, setPreview] = useState<string>('');
  const stageRef = useRef<HTMLDivElement>(null);
  const drag = useRef<{ x: number; y: number } | null>(null);

  useEffect(() => {
    (async () => {
      const [cap, pc] = await Promise.all([send({ type: 'capture-tab' }), send({ type: 'page-context' }).catch(() => null)]);
      if (isError(cap)) return setError(cap.error);
      const img = new Image();
      img.onload = () => setShot(img);
      img.src = cap.image;
      setCtx(pc);
    })();
  }, []);

  // Re-render the outgoing image whenever the crop or blur setting changes.
  useEffect(() => {
    if (!shot) return;
    const scale = Math.min(1, MAX_W / shot.naturalWidth);
    const c = document.createElement('canvas');
    c.width = Math.round(shot.naturalWidth * scale);
    c.height = Math.round(shot.naturalHeight * scale);
    const g = c.getContext('2d')!;
    if (crop && blur) {
      g.filter = 'blur(14px)';
      g.drawImage(shot, 0, 0, c.width, c.height);
      g.filter = 'none';
      g.drawImage(shot, crop.x, crop.y, crop.w, crop.h, crop.x * scale, crop.y * scale, crop.w * scale, crop.h * scale);
      g.strokeStyle = '#6c5ce7';
      g.lineWidth = 3;
      g.strokeRect(crop.x * scale, crop.y * scale, crop.w * scale, crop.h * scale);
    } else {
      g.drawImage(shot, 0, 0, c.width, c.height);
    }
    setPreview(c.toDataURL('image/jpeg', 0.85));
  }, [shot, crop, blur]);

  const toNatural = (e: React.PointerEvent) => {
    const r = stageRef.current!.getBoundingClientRect();
    const k = shot!.naturalWidth / r.width;
    return { x: Math.max(0, Math.min(r.width, e.clientX - r.left)) * k, y: Math.max(0, Math.min(r.height, e.clientY - r.top)) * k };
  };
  const onDown = (e: React.PointerEvent) => {
    (e.target as Element).setPointerCapture(e.pointerId);
    drag.current = toNatural(e);
    setCrop(null);
  };
  const onMove = (e: React.PointerEvent) => {
    if (!drag.current) return;
    const p = toNatural(e);
    const a = drag.current;
    setCrop({ x: Math.min(a.x, p.x), y: Math.min(a.y, p.y), w: Math.abs(p.x - a.x), h: Math.abs(p.y - a.y) });
  };
  const onUp = () => {
    drag.current = null;
    setCrop((c) => (c && c.w > 20 && c.h > 20 ? c : null));
  };

  if (error)
    return (
      <div className="card">
        <p className="error">{error}</p>
        <button onClick={onCancel}>Back</button>
      </div>
    );
  if (!shot) return <p className="muted">Capturing this tab…</p>;

  const k = stageRef.current ? stageRef.current.getBoundingClientRect().width / shot.naturalWidth : 0;
  const textLen = (ctx?.viewportText.length ?? 0) + (ctx?.selection.length ?? 0);

  return (
    <div className="stack">
      <div className="card">
        <h3>1. Drag a box around the problem</h3>
        <div ref={stageRef} className="crop-stage" onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp}>
          <img src={shot.src} alt="Screenshot of the current tab" draggable={false} />
          {crop && k > 0 && (
            <div className="crop-box" style={{ left: crop.x * k, top: crop.y * k, width: crop.w * k, height: crop.h * k }} />
          )}
        </div>
        <label className="row small">
          <input type="checkbox" checked={blur} onChange={(e) => setBlur(e.target.checked)} /> Blur everything outside the box
        </label>
      </div>
      <div className="card">
        <h3>2. This is exactly what Gongo will send</h3>
        {preview && <img className="preview" src={preview} alt="Image that will be sent" />}
        {ctx && textLen > 0 && (
          <label className="row small">
            <input type="checkbox" checked={includeText} onChange={(e) => setIncludeText(e.target.checked)} />
            Also send the page text I can see ({textLen.toLocaleString()} characters{ctx.selection ? ', including your selection' : ''})
          </label>
        )}
        {!ctx && <p className="small muted">Page text isn't available here (e.g. a PDF), so only the image is sent.</p>}
        <div className="row">
          <button className="primary" onClick={() => onSend(preview.replace(/^data:image\/jpeg;base64,/, ''), includeText ? ctx : null)}>
            Send to Gongo
          </button>
          <button onClick={onCancel}>Cancel</button>
        </div>
      </div>
    </div>
  );
}
