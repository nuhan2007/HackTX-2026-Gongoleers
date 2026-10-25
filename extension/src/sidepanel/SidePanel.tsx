import { useEffect, useState } from 'react';
import { send, type PanelState } from '../shared/messages';
import { Stats } from './Stats';
import { Timeline } from './Timeline';
import { Tutor } from './Tutor';

type Tab = 'tutor' | 'timeline' | 'stats';
const TAB_KEY = 'gongo.panelTab';

function usePanelState(): PanelState | null {
  const [state, setState] = useState<PanelState | null>(null);
  useEffect(() => {
    let alive = true;
    const poll = async () => {
      const s = await send({ type: 'get-state' }).catch(() => null);
      if (alive && s) setState(s);
    };
    void poll();
    const id = setInterval(poll, 1000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);
  return state;
}

export function SidePanel() {
  const state = usePanelState();
  const [tab, setTab] = useState<Tab>(() => {
    try {
      return (localStorage.getItem(TAB_KEY) as Tab) || 'tutor';
    } catch {
      return 'tutor';
    }
  });
  const pick = (t: Tab) => {
    setTab(t);
    try {
      localStorage.setItem(TAB_KEY, t);
    } catch {
      /* per-viewer convenience only */
    }
  };

  return (
    <div className="panel">
      <header className="panel-head">
        <div className="brand">
          <span className="logo" aria-hidden="true" />
          <strong>Gongo</strong>
        </div>
        <div className="spacer" />
        {state && <CameraChip state={state} />}
        <button className="ghost icon" title="Settings" aria-label="Settings" onClick={() => chrome.runtime.openOptionsPage()}>
          ⚙
        </button>
      </header>
      <nav className="tabs" role="tablist">
        {(['tutor', 'timeline', 'stats'] as Tab[]).map((t) => (
          <button key={t} role="tab" aria-selected={tab === t} className={tab === t ? 'active' : ''} onClick={() => pick(t)}>
            {t === 'tutor' ? 'Tutor' : t === 'timeline' ? 'Live' : 'Stats'}
          </button>
        ))}
      </nav>
      <main className="panel-body">
        {!state ? (
          <p className="muted">Connecting…</p>
        ) : !state.ready ? (
          <SetupCard missing={state.missing} />
        ) : (
          <>
            {!state.pageVisible && (
              <div className="card nudge-card" role="status">
                <p className="small">
                  <strong>Gongo can't see this page,</strong> so the owl can't appear here and page activity isn't counted. Reload the page. For a
                  local file, turn on "Allow access to file URLs" for Gongo at <code>chrome://extensions</code>, or serve it over http. Chrome's
                  own pages and the PDF viewer never allow it; use "I'm stuck" here instead.
                </p>
              </div>
            )}
            {tab === 'tutor' && <Tutor state={state} />}
            {tab === 'timeline' && <Timeline state={state} />}
            {tab === 'stats' && <Stats />}
          </>
        )}
      </main>
    </div>
  );
}

function CameraChip({ state }: { state: PanelState }) {
  if (!state.enabled) return <span className="chip">Paused</span>;
  if (!state.ready) return null;
  return state.cameraOk ? (
    <span className="chip bad" title="Processed on-device only. Frames never leave your computer.">● Camera on</span>
  ) : (
    <span className="chip warn" title={state.cameraError ?? ''}>Camera off: tracking paused</span>
  );
}

function SetupCard({ missing }: { missing: string[] }) {
  return (
    <div className="card">
      <h2>Finish setting up Gongo</h2>
      <p className="muted">Gongo needs a few things before it can help:</p>
      <ul>
        {missing.map((m) => (
          <li key={m}>{m}</li>
        ))}
      </ul>
      <button className="primary" onClick={() => chrome.runtime.openOptionsPage()}>
        Open setup
      </button>
    </div>
  );
}
