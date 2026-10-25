import { useEffect, useState } from 'react';
import { send, type PanelState } from '../shared/messages';
import { Stats } from './Stats';
import { Timeline } from './Timeline';
import { Home } from './Home';
import { Brand } from '../ui/Brand';

type Tab = 'home' | 'timeline' | 'stats';
const TAB_KEY = 'myta.panelTab';

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
      const saved = localStorage.getItem(TAB_KEY);
      return saved === 'timeline' || saved === 'stats' ? saved : 'home';
    } catch {
      return 'home';
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
        <Brand size={26} />
        <div className="spacer" />
        {state && <KeyChip keys={state.keys} />}
        {state && <CameraChip state={state} />}
        <button className="ghost icon" title="Settings" aria-label="Settings" onClick={() => chrome.runtime.openOptionsPage()}>
          ⚙
        </button>
      </header>
      <nav className="tabs" role="tablist">
        {(['home', 'timeline', 'stats'] as Tab[]).map((t) => (
          <button key={t} role="tab" aria-selected={tab === t} className={tab === t ? 'active' : ''} onClick={() => pick(t)}>
            {t === 'home' ? 'Home' : t === 'timeline' ? 'Live' : 'Stats'}
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
            {tab === 'home' && <Home state={state} />}
            {tab === 'timeline' && <Timeline state={state} />}
            {tab === 'stats' && <Stats />}
          </>
        )}
      </main>
    </div>
  );
}

/** Tells the student at a glance whether the Gemini and SerpApi keys were checked and work. */
function KeyChip({ keys }: { keys: PanelState['keys'] }) {
  const rows = [
    ['Gemini', keys.gemini],
    ['SerpApi', keys.serp],
  ] as const;
  const bad = rows.filter(([, k]) => k.state === 'bad');
  const untested = rows.filter(([, k]) => k.state === 'untested');
  const title = rows.map(([name, k]) => `${name}: ${k.detail}`).join('\n');
  const open = () => chrome.runtime.openOptionsPage();
  if (bad.length)
    return (
      <button className="chip bad" title={title} onClick={open}>
        ✗ {bad.map(([n]) => n).join(' + ')} key
      </button>
    );
  if (untested.length)
    return (
      <button className="chip warn" title={title} onClick={open}>
        Keys untested
      </button>
    );
  return (
    <span className="chip good" title={title}>
      ✓ Keys work
    </span>
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
      <h2>Finish setting up myTA</h2>
      <p className="muted">myTA needs a few things before it can help:</p>
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
