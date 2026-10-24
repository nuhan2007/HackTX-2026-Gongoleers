import { useEffect, useState } from 'react';
import type { Msg } from '../../shared/messages';
import { GongoSvg } from './GongoSvg';

type View = 'hidden' | 'nudge' | 'opening' | 'fallback';

export function Sprite() {
  const [view, setView] = useState<View>('hidden');
  const [reasons, setReasons] = useState<string[]>([]);

  useEffect(() => {
    const onMsg = (msg: Msg) => {
      if (msg.type !== 'nudge') return;
      setReasons(msg.reasons);
      setView((v) => (msg.show ? (v === 'hidden' ? 'nudge' : v) : 'hidden'));
    };
    chrome.runtime.onMessage.addListener(onMsg);
    return () => chrome.runtime.onMessage.removeListener(onMsg);
  }, []);

  if (view === 'hidden') return null;

  const open = async () => {
    setView('opening');
    // sidePanel.open needs the click's user gesture, so the background calls it synchronously.
    const ok = await chrome.runtime.sendMessage({ type: 'open-panel' } satisfies Msg).catch(() => false);
    setView(ok === false ? 'fallback' : 'hidden');
  };
  const dismiss = (snooze: boolean) => {
    chrome.runtime.sendMessage({ type: 'nudge-dismissed', snooze } satisfies Msg).catch(() => {});
    setView('hidden');
  };

  return (
    <div className="wrap">
      <div className="bubble" role="dialog" aria-label="Gongo study buddy">
        {view === 'fallback' ? (
          <p>Click the Gongo icon in your toolbar and I'll meet you in the side panel.</p>
        ) : (
          <>
            <p className="title">Looks tricky. Want to think it through together?</p>
            {reasons.length > 0 && <p className="why">I noticed: {reasons.slice(0, 2).join(', ')}</p>}
            <div className="row">
              <button className="primary" onClick={open} disabled={view === 'opening'}>
                Let's do it
              </button>
              <button onClick={() => dismiss(false)}>Not now</button>
              <button className="link" onClick={() => dismiss(true)}>
                Snooze 15 min
              </button>
            </div>
          </>
        )}
      </div>
      <button className="gongo" onClick={open} aria-label="Open Gongo">
        <GongoSvg />
      </button>
    </div>
  );
}

export const spriteCss = `
.wrap { position: fixed; right: 20px; bottom: 20px; display: flex; align-items: flex-end; gap: 10px;
  font: 14px/1.4 system-ui, -apple-system, "Segoe UI", sans-serif; color: #1f1d2b;
  animation: slide-in .45s cubic-bezier(.2,.9,.3,1.3); }
.bubble { background: #fff; border-radius: 16px 16px 4px 16px; padding: 12px 14px; max-width: 280px;
  box-shadow: 0 8px 28px rgba(40, 30, 90, .25); border: 1px solid #e6e2fb; }
.title { margin: 0 0 4px; font-weight: 600; }
.why { margin: 0 0 8px; font-size: 12px; color: #6b6880; }
.row { display: flex; gap: 6px; flex-wrap: wrap; align-items: center; }
button { font: inherit; cursor: pointer; border-radius: 999px; border: 1px solid #d8d3f5; background: #f6f4ff;
  padding: 5px 12px; color: #3b2f8f; }
button.primary { background: #6c5ce7; border-color: #6c5ce7; color: #fff; }
button.link { border: none; background: none; padding: 5px 4px; color: #6b6880; text-decoration: underline; }
button:disabled { opacity: .6; cursor: progress; }
.gongo { width: 72px; height: 72px; padding: 0; border: none; background: none; border-radius: 50%;
  animation: bob 2.4s ease-in-out infinite; filter: drop-shadow(0 6px 10px rgba(60, 40, 140, .35)); }
.gongo svg { width: 100%; height: 100%; }
@keyframes bob { 0%,100% { transform: translateY(0) } 50% { transform: translateY(-6px) } }
@keyframes slide-in { from { transform: translateY(120%); opacity: 0 } to { transform: none; opacity: 1 } }
@media (prefers-reduced-motion: reduce) { .wrap, .gongo { animation: none } }
`;
