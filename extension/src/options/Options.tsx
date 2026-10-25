import { useEffect, useState } from 'react';
import { DEMO_TRIGGER } from '../shared/constants';
import { send } from '../shared/messages';
import { getSettings, onSettingsChanged, readiness, updateSettings, type Settings } from '../shared/settings';
import { CameraSetup } from './CameraSetup';

function download(name: string, data: unknown) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function Options() {
  const [s, setS] = useState<Settings | null>(null);
  const [keys, setKeys] = useState({ openaiKey: '', serpKey: '', model: '' });
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    getSettings().then((x) => {
      setS(x);
      setKeys({ openaiKey: x.openaiKey, serpKey: x.serpKey, model: x.model });
    });
    onSettingsChanged(setS);
  }, []);
  if (!s) return null;

  const set = (patch: Partial<Settings>) => updateSettings(patch).then(setS);
  const { ready, missing } = readiness(s);

  return (
    <div className="page">
      <header>
        <h1>Gongo setup</h1>
        <p className="muted">It notices you're stuck before you give up, asks the question that gets you moving, and never gives you the answer.</p>
      </header>

      <div className={`card status ${ready ? 'ok' : 'todo'}`}>
        {ready ? (
          <p>
            <strong>✓ All set.</strong> Gongo is {s.enabled ? 'watching for stuck moments' : 'paused'}. Open it from the toolbar icon.
          </p>
        ) : (
          <p>
            <strong>Still needed:</strong> {missing.join(', ')}.
          </p>
        )}
      </div>

      <section className="card">
        <h2>1. API keys</h2>
        <p className="small muted">
          Keys are stored only in this browser (<code>chrome.storage.local</code>) and sent only to OpenAI's API and SerpApi. They're never
          part of the code or the repo.
        </p>
        <label>
          OpenAI API key{' '}
          <a href="https://platform.openai.com/api-keys" target="_blank" rel="noreferrer" className="small">
            get one
          </a>
          <input type="password" value={keys.openaiKey} onChange={(e) => setKeys({ ...keys, openaiKey: e.target.value.trim() })} autoComplete="off" />
        </label>
        <label>
          SerpApi key{' '}
          <a href="https://serpapi.com/manage-api-key" target="_blank" rel="noreferrer" className="small">
            get one
          </a>
          <input type="password" value={keys.serpKey} onChange={(e) => setKeys({ ...keys, serpKey: e.target.value.trim() })} autoComplete="off" />
        </label>
        <label>
          OpenAI model (needs vision + structured outputs)
          <input type="text" value={keys.model} onChange={(e) => setKeys({ ...keys, model: e.target.value.trim() })} />
        </label>
        <div className="row">
          <button
            className="primary"
            onClick={async () => {
              await set(keys);
              setSaved(true);
              setTimeout(() => setSaved(false), 1500);
            }}
          >
            Save keys
          </button>
          {saved && <span className="small">Saved ✓</span>}
        </div>
      </section>

      <CameraSetup settings={s} onChange={set} />

      <section className="card">
        <h2>3. Detection</h2>
        <label className="row">
          <input type="checkbox" checked={s.enabled} onChange={(e) => set({ enabled: e.target.checked })} /> Gongo is on (turning it off also stops the camera)
        </label>
        <label className="row">
          <input type="checkbox" checked={s.demoMode} onChange={(e) => set({ demoMode: e.target.checked })} />
          Demo mode (threshold {DEMO_TRIGGER.threshold}, {DEMO_TRIGGER.durationSec}s, cooldown {DEMO_TRIGGER.cooldownSec}s)
        </label>
        <fieldset disabled={s.demoMode}>
          <Slider label="Confusion threshold" value={s.threshold} min={15} max={80} unit="" onChange={(threshold) => set({ threshold })} />
          <Slider label="Stuck for at least" value={s.durationSec} min={10} max={180} unit="s" onChange={(durationSec) => set({ durationSec })} />
          <Slider label="Quiet time after a nudge" value={s.cooldownSec} min={30} max={900} step={30} unit="s" onChange={(cooldownSec) => set({ cooldownSec })} />
        </fieldset>
        {s.snoozedUntil > Date.now() && (
          <p className="small">
            Snoozed until {new Date(s.snoozedUntil).toLocaleTimeString()}. <button className="ghost" onClick={() => set({ snoozedUntil: 0 })}>Unsnooze</button>
          </p>
        )}
      </section>

      <section className="card">
        <h2>Privacy & fairness</h2>
        <ul className="small">
          <li>Camera frames are analyzed on this device and never leave it. Only numbers (like "brow furrow: 0.4") are used.</li>
          <li>
            Nothing about your page is sent until you ask for help (<em>Let's do it</em> or <em>I'm stuck</em>). Then Gongo looks at that one tab:
            an image of what's on screen, the page text, your answer fields, your drawings, and a short log of what you typed and submitted. Password
            fields are never read.
          </li>
          <li>Facial expressions vary across people and cultures, so the face contributes a bit less than page activity. What you do on the page (idling, re-reading, backspacing) carries the rest.</li>
          <li>Looking away or down (for example, writing on paper) never counts as confusion. It just pauses the idle timer.</li>
          <li>Session summaries and metrics are stored only in this browser.</li>
        </ul>
      </section>

      <section className="card">
        <h2>Developer</h2>
        <label className="row">
          <input type="checkbox" checked={s.devMode} onChange={(e) => set({ devMode: e.target.checked })} /> Dev mode (shows "Force trigger")
        </label>
        <label className="row">
          <input type="checkbox" checked={s.labelMode} onChange={(e) => set({ labelMode: e.target.checked })} /> Label mode: press <kbd>Alt+Shift+S</kbd> the moment you feel stuck
        </label>
        <div className="row">
          <button onClick={async () => download(`gongo-label-log-${Date.now()}.json`, await send({ type: 'export-label-log' }))}>Export label log</button>
          <button
            onClick={async () => {
              if (confirm('Clear the label log? Export it first if you need it.')) await chrome.storage.local.remove('labelLog');
            }}
          >
            Clear label log
          </button>
          <button onClick={async () => download('demoCache.json', await send({ type: 'export-video-cache' }))}>Export video cache</button>
          <button onClick={() => send({ type: 'restart-camera' })}>Restart camera</button>
        </div>
      </section>
    </div>
  );
}

function Slider(p: { label: string; value: number; min: number; max: number; step?: number; unit: string; onChange: (v: number) => void }) {
  return (
    <label className="slider">
      <span>
        {p.label}: <strong>{p.value}{p.unit}</strong>
      </span>
      <input type="range" min={p.min} max={p.max} step={p.step ?? 1} value={p.value} onChange={(e) => p.onChange(Number(e.target.value))} />
    </label>
  );
}
