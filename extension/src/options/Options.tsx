import { useEffect, useState } from 'react';
import { checkGemini, checkSerp, fingerprint, KEY_STATUS_STORAGE, type KeyCheck, type KeyStatus } from '../ai/keyCheck';
import {
  calmScore,
  DEFAULT_COMPLEXITY_STEP_SEC,
  DEFAULT_FINISH_IDLE_SEC,
  DEFAULT_REVIEW_SEC,
  MAX_COMPLEXITY_STEP_SEC,
  MAX_FINISH_IDLE_SEC,
  MAX_REVIEW_SEC,
  MAX_SNAPSHOT_SEC,
  MIN_FINISH_IDLE_SEC,
  MIN_REVIEW_SEC,
  MIN_SNAPSHOT_SEC,
  NORMAL_TRIGGER,
  scaledWait,
} from '../shared/constants';
import { send, type PanelState } from '../shared/messages';
import { getSettings, onSettingsChanged, readiness, updateSettings, type Settings } from '../shared/settings';
import { Brand } from '../ui/Brand';
import { CameraSetup } from './CameraSetup';
import { SpriteStudio } from './SpriteStudio';

/** The values the setup panel's "Reset" button restores. */
const RECOMMENDED: Partial<Settings> = {
  ...NORMAL_TRIGGER,
  complexityStepSec: DEFAULT_COMPLEXITY_STEP_SEC,
  reviewSec: DEFAULT_REVIEW_SEC,
  finishIdleSec: DEFAULT_FINISH_IDLE_SEC,
};

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
  const [keys, setKeys] = useState({ geminiKey: '', serpKey: '', model: '', solverModel: '' });
  const [saved, setSaved] = useState(false);
  const [checks, setChecks] = useState<KeyStatus>({});
  const [testing, setTesting] = useState(false);

  useEffect(() => {
    getSettings().then(async (x) => {
      setS(x);
      setKeys({ geminiKey: x.geminiKey, serpKey: x.serpKey, model: x.model, solverModel: x.solverModel });
      // Show the last test result, but only if it was for the keys that are saved now.
      const { [KEY_STATUS_STORAGE]: last } = (await chrome.storage.local.get(KEY_STATUS_STORAGE)) as { [KEY_STATUS_STORAGE]?: KeyStatus };
      setChecks({
        gemini: last?.gemini?.fingerprint === fingerprint(x.geminiKey) ? last.gemini : undefined,
        serp: last?.serp?.fingerprint === fingerprint(x.serpKey) ? last.serp : undefined,
      });
    });
    onSettingsChanged(setS);
  }, []);
  if (!s) return null;

  const set = (patch: Partial<Settings>) => updateSettings(patch).then(setS);
  const { ready, missing } = readiness(s);

  /** Really calls Gemini and SerpApi (Gemini: the model list plus one tiny structured call; SerpApi: the free account endpoint) so a bad key shows up here, not mid-session. */
  async function testKeys(k = keys) {
    setTesting(true);
    try {
      const [gemini, serp] = await Promise.all([checkGemini(k.geminiKey, k.model, k.solverModel), checkSerp(k.serpKey)]);
      const status: KeyStatus = { gemini, serp };
      setChecks(status);
      await chrome.storage.local.set({ [KEY_STATUS_STORAGE]: status });
    } finally {
      setTesting(false);
    }
  }

  return (
    <div className="page">
      <header className="hero">
        <Brand size={44} tagline="Your pixel study buddy" />
        <p className="muted">
          It notices you&apos;re stuck before you give up, flags a slip the moment you make it, cheers when you get it, and never gives you the answer.
        </p>
      </header>

      <div className={`card status ${ready ? 'ok' : 'todo'}`}>
        {ready ? (
          <p>
            <strong>✓ All set.</strong> myTA is {s.enabled ? 'watching for stuck moments' : 'paused'}. Open it from the toolbar icon.
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
          Keys are stored only in this browser (<code>chrome.storage.local</code>) and sent only to Google (Gemini) and SerpApi. They&apos;re never part of the code or the repo.
        </p>
        <label>
          Gemini API key{' '}
          <a href="https://aistudio.google.com/apikey" target="_blank" rel="noreferrer" className="small">
            get one
          </a>
          <input type="password" value={keys.geminiKey} onChange={(e) => setKeys({ ...keys, geminiKey: e.target.value.trim() })} autoComplete="off" />
        </label>
        <KeyResult check={checks.gemini} testing={testing} />
        <label>
          SerpApi key{' '}
          <a href="https://serpapi.com/manage-api-key" target="_blank" rel="noreferrer" className="small">
            get one
          </a>
          <input type="password" value={keys.serpKey} onChange={(e) => setKeys({ ...keys, serpKey: e.target.value.trim() })} autoComplete="off" />
        </label>
        <KeyResult check={checks.serp} testing={testing} />
        <label>
          Quick model (reads your work, writes hints, checks them; needs image input)
          <input type="text" value={keys.model} onChange={(e) => setKeys({ ...keys, model: e.target.value.trim() })} />
        </label>
        {checks.gemini?.suggestedModel && checks.gemini.suggestedModel !== keys.model && (
          <p className="small">
            <button className="ghost" onClick={() => setKeys({ ...keys, model: checks.gemini!.suggestedModel! })}>
              Use {checks.gemini.suggestedModel}
            </button>
            , then press Save &amp; test.
          </p>
        )}
        <label>
          Problem-solving model (works each problem out once, privately, and reads circuit diagrams; the stronger the better)
          <input type="text" value={keys.solverModel} onChange={(e) => setKeys({ ...keys, solverModel: e.target.value.trim() })} />
        </label>
        {checks.gemini?.suggestedSolverModel && checks.gemini.suggestedSolverModel !== keys.solverModel && (
          <p className="small">
            <button className="ghost" onClick={() => setKeys({ ...keys, solverModel: checks.gemini!.suggestedSolverModel! })}>
              Use {checks.gemini.suggestedSolverModel}
            </button>
            , then press Save &amp; test.
          </p>
        )}
        <div className="row">
          <button
            className="primary"
            disabled={testing}
            onClick={async () => {
              await set(keys);
              setSaved(true);
              setTimeout(() => setSaved(false), 1500);
              await testKeys(keys);
            }}
          >
            Save &amp; test keys
          </button>
          <button disabled={testing} onClick={() => void testKeys()}>
            Test again
          </button>
          {saved && <span className="small">Saved ✓</span>}
        </div>
      </section>

      <CameraSetup settings={s} onChange={set} />

      <section className="card">
        <h2>3. Detection</h2>
        <label className="row">
          <input type="checkbox" checked={s.enabled} onChange={(e) => set({ enabled: e.target.checked })} /> myTA is on (turning it off also stops the camera)
        </label>
        <h3>When the sprite appears</h3>
        <p className="small">
          The sprite appears when your confusion score stays at or above the threshold for the time below. If the score drops below the threshold, the
          count starts over. When it appears it has already read your work and shows a hint right there. <LiveStatus />
        </p>
        <Slider label="Confusion threshold" value={s.threshold} min={20} max={90} unit="" onChange={(threshold) => set({ threshold })} />
        <Slider label="Show the sprite once the score has stayed at or above it for" value={s.durationSec} min={3} max={120} unit="s" onChange={(durationSec) => set({ durationSec })} />
        <Slider
          label="Harder problems wait longer: add"
          value={s.complexityStepSec}
          min={0}
          max={MAX_COMPLEXITY_STEP_SEC}
          unit="s per difficulty level"
          onChange={(complexityStepSec) => set({ complexityStepSec })}
        />
        <p className="small muted">
          myTA rates each problem from 1 (one quick step) to 5 (long and hard). The wait before the sprite appears, by difficulty:{' '}
          {[1, 2, 3, 4, 5].map((d) => `${d}: ${scaledWait(s.durationSec, d, s.complexityStepSec)}s`).join(' · ')}
        </p>
        <label className="row">
          <input type="checkbox" checked={s.adaptive} onChange={(e) => set({ adaptive: e.target.checked })} />
          Let myTA adapt to each problem (a little more patience and slower reading for circuits and other drawn work; an earlier first check for quick problems). The threshold above is never changed.
        </label>
        <Slider label="Quiet time after a nudge" value={s.cooldownSec} min={10} max={900} step={5} unit="s" onChange={(cooldownSec) => set({ cooldownSec })} />
        <label className="row">
          <input type="checkbox" checked={s.autoHint} onChange={(e) => set({ autoHint: e.target.checked })} />
          When the sprite appears, read my work and give a hint on the spot (it never says the answer)
        </label>
        <label className="row">
          <input type="checkbox" checked={s.flagMistakes} onChange={(e) => set({ flagMistakes: e.target.checked })} />
          Whenever a reading of my work finds a mistake (a wrong step, or the problem copied down wrongly), the sprite tells me right away
        </label>
        <label className="row">
          <input type="checkbox" checked={s.celebrate} onChange={(e) => set({ celebrate: e.target.checked })} />
          When I get the answer right, the sprite pops up to say well done
        </label>

        <h3>Following my work, and checking my answer</h3>
        <label className="row">
          <input type="checkbox" checked={s.autoTrack} onChange={(e) => set({ autoTrack: e.target.checked })} />
          Notice the problem I&apos;m on and start following it by myself (after I&apos;ve stayed on it a few seconds; one model call per problem)
        </label>
        <label className="row">
          <input type="checkbox" checked={s.continuousReview} onChange={(e) => set({ continuousReview: e.target.checked })} />
          While I&apos;m writing, keep reading my work: right after I finish each line (so a slip is flagged a couple of seconds later), and every few seconds while I keep going
        </label>
        <fieldset disabled={!s.continuousReview}>
          <Slider label="Also read my work every" value={s.reviewSec} min={MIN_REVIEW_SEC} max={MAX_REVIEW_SEC} unit="s" onChange={(reviewSec) => set({ reviewSec })} />
        </fieldset>
        <label className="row">
          <input type="checkbox" checked={s.autoCheck} onChange={(e) => set({ autoCheck: e.target.checked })} />
          When I finish a problem, check my answer, and show the sprite with where I went wrong if it&apos;s off (it never says the answer)
        </label>
        <fieldset disabled={!s.autoCheck}>
          <Slider
            label="I count as finished after no new work for"
            value={s.finishIdleSec}
            min={MIN_FINISH_IDLE_SEC}
            max={MAX_FINISH_IDLE_SEC}
            unit="s"
            onChange={(finishIdleSec) => set({ finishIdleSec })}
          />
        </fieldset>
        <p className="small muted">
          &quot;Finished&quot; means: you wrote something, then nothing new for that long (plus the extra time for a harder problem, as above), while your
          confusion score is below the threshold ({calmScore(s.threshold)} or lower right now). myTA then takes a snapshot and checks it. While
          the score is at or above the threshold the sprite is helping you instead.
        </p>
        <p className="small">
          <button className="ghost" onClick={() => set(RECOMMENDED)}>
            Reset these to the recommended values
          </button>
        </p>

        <h3>Snapshots</h3>
        <Slider
          label="Take a snapshot of the tabs I'm using every"
          value={s.snapshotSec}
          min={MIN_SNAPSHOT_SEC}
          max={MAX_SNAPSHOT_SEC}
          unit="s"
          onChange={(snapshotSec) => set({ snapshotSec })}
        />
        <p className="small muted">
          Snapshots stay on this device. Taking a snapshot never costs an API call. myTA asks the model to read your work while you write, when the
          confusion score stays high, on a wrong answer, and when you finish.
        </p>
        {s.snoozedUntil > Date.now() && (
          <p className="small">
            Snoozed until {new Date(s.snoozedUntil).toLocaleTimeString()}. <button className="ghost" onClick={() => set({ snoozedUntil: 0 })}>Unsnooze</button>
          </p>
        )}
      </section>

      <SpriteStudio />

      <section className="card">
        <h2>Privacy &amp; fairness</h2>
        <ul className="small">
          <li>Camera frames are analyzed on this device and never leave it. Only numbers (like &quot;brow furrow: 0.4&quot;) are used.</li>
          <li>
            While myTA is on, it takes a snapshot of the tab you&apos;re in every few seconds and keeps the last few on this device (never mail, sign-in or
            banking pages). Snapshots are not uploaded. If &quot;Notice the problem I&apos;m on&quot; is ticked, once you&apos;ve stayed a few seconds on a page that looks
            like a problem, myTA sends one screenshot of that page, plus its visible text, to Google&apos;s Gemini to work out the problem privately. While it
            follows a problem it also watches the tab where you write your work, and sends a snapshot of it to Gemini while you write, when you seem
            stuck, and when you look finished. When it suggests a video, Gemini watches that public YouTube video to find the minute to start at. Turning
            myTA off or snoozing deletes the stored snapshots.
          </li>
          <li>The picture you make your sprite from is processed on this device (the cut-out model runs in the browser) and stays in this browser.</li>
          <li>Facial expressions vary across people and cultures, so the face counts for only 20% of the score. What happens on the page (wrong answers, repeated errors) carries most of it.</li>
          <li>Looking away or down (for example, writing on paper) never counts as confusion. It just pauses the idle timer.</li>
          <li>Session summaries and metrics are stored only in this browser.</li>
        </ul>
      </section>

      <section className="card">
        <h2>Developer</h2>
        <label className="row">
          <input type="checkbox" checked={s.devMode} onChange={(e) => set({ devMode: e.target.checked })} /> Dev mode (shows &quot;Force trigger&quot;)
        </label>
        <label className="row">
          <input type="checkbox" checked={s.labelMode} onChange={(e) => set({ labelMode: e.target.checked })} /> Label mode: press <kbd>Alt+Shift+S</kbd> the moment you feel stuck
        </label>
        <div className="row">
          <button onClick={async () => download(`myta-label-log-${Date.now()}.json`, await send({ type: 'export-label-log' }))}>Export label log</button>
          <button
            onClick={async () => {
              if (confirm('Clear the label log? Export it first if you need it.')) await chrome.storage.local.remove('labelLog');
            }}
          >
            Clear label log
          </button>
          <button onClick={async () => download('demoCache.json', await send({ type: 'export-video-cache' }))}>Export video cache</button>
          <button onClick={() => send({ type: 'restart-camera' })}>Restart camera</button>
          <button onClick={() => send({ type: 'clear-snapshots' })}>Delete stored snapshots</button>
        </div>
      </section>
    </div>
  );
}

/** "Right now: score 42, the timer isn't running": so the sliders above can be tried against what is really happening. */
function LiveStatus() {
  const [st, setSt] = useState<PanelState | null>(null);
  useEffect(() => {
    let alive = true;
    const poll = () =>
      send({ type: 'get-state' })
        .then((x) => alive && x && setSt(x))
        .catch(() => {});
    void poll();
    const id = setInterval(poll, 2000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);
  if (!st?.ready) return null;
  const t = st.trigger;
  const text = t.paused
    ? 'Not watching right now.'
    : st.phase === 'confused'
      ? 'The sprite is showing.'
      : t.aboveSec !== null
        ? `Above the threshold for ${t.aboveSec}s of ${t.durationSec}s.`
        : 'The timer is not running.';
  return <strong>Right now: score {st.output.score}. {text}</strong>;
}

function KeyResult({ check, testing }: { check?: KeyCheck; testing: boolean }) {
  if (testing) return <p className="small muted">Testing…</p>;
  if (!check) return null;
  return <p className={`small ${check.ok ? '' : 'error'}`}>{check.ok ? '✓' : '✗'} {check.detail}</p>;
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
