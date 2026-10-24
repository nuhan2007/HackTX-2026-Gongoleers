# Gongo: the study buddy that knows when you're stuck

> It notices you're stuck before you give up, asks the question that gets you moving, and never gives you the answer.

**HackTX 2026 · Team Gongoleers** · Tracks: Best Overall, MLH Best Use of Gemini, SerpApi, Best Pitch

Gongo is a Chrome extension (Manifest V3). It fuses three on-device signals into a live **confusion score**:

- **page content**: "Incorrect" after a submit, resubmits, the same error repeating
- **activity**: re-reading, idling, backspace bursts, tab-hopping
- **face**: brow furrow and head tilt, from the webcam via MediaPipe

When the score stays high, a small sprite offers help. The **Socratic tutor** in Chrome's side panel (powered by Gemini) then asks one guiding question at a time. A private answer key plus a two-layer leak guard keeps it from ever revealing the answer. If the student doesn't know a prerequisite, **SerpApi + Gemini** find the exact minute of a YouTube video that explains the concept.

There is no backend. The extension calls the Gemini and SerpApi APIs directly from its service worker.

---

## Quick start

```bash
cd extension
npm install          # also copies MediaPipe wasm, downloads the face model, generates icons
npm run build        # → extension/dist
```

1. Open `chrome://extensions`, enable **Developer mode**, click **Load unpacked**, and pick `extension/dist`.
2. The setup page opens automatically:
   - paste your **Gemini** and **SerpApi** keys (stored only in `chrome.storage.local`)
   - **Allow camera**
   - **Calibrate (10 s)**
3. Click the Gongo toolbar icon to open the side panel.

During development, `npm run dev` gives hot reload. Load `extension/dist` the same way.

**Demo pages:** run `npm run demo` and open <http://localhost:5174/math.html>, `/circuit.html` and `/physics.pdf`.
(The content script doesn't run on `file://` URLs unless you enable "Allow access to file URLs", so serve the pages instead.)

| Command | What it does |
|---|---|
| `npm test` | Unit tests (engine, trigger, SW-restart persistence, leak checker, guard, cache, eval) |
| `npm run build` | Type-check and build |
| `npm run evaluate -- <dir>` | Precision/recall/lead time from label-mode logs (default `../label-logs/`) |
| `npm run leak-eval [-- --limit N]` | Measured answer-leak rate over `eval/problems.json` (needs `extension/.env`) |

Both evals write `src/shared/evalResults.json`, which the **Stats** tab shows. Rebuild afterwards.

---

## How it works

```
Content script (every frame)        Offscreen doc (camera, always on)
  ContentSignals + ActivityTracker    MediaPipe Face Landmarker @5 fps → averaged numbers
  Sprite nudge (closed Shadow DOM)                  │
            │ signals / 1 s                         │
            ▼                                       ▼
Service worker ── ConfusionEngine (noisy-OR per channel, 0.5/0.3/0.2 fusion, EMA)
               ── TriggerMachine (threshold × duration, hysteresis, cooldown)
               ── state persisted to chrome.storage.session every tick
               ── tutor: solver (hidden) → tutor turn → leak guard → side panel
               ── video: concept → SerpApi YouTube → Gemini watches → timestamp
```

| Piece | Where |
|---|---|
| Fusion + smoothing | `src/background/confusionEngine.ts` |
| Trigger state machine | `src/background/triggerMachine.ts` |
| Restart-safe persistence | `src/background/engineStore.ts` |
| Page-content signals | `src/content/contentSignals.ts` |
| Activity signals | `src/content/activityTracker.ts`, `src/background/tabTracker.ts` |
| Face features | `src/shared/face.ts` (MediaPipe), `src/shared/faceSignals.ts` (baseline z-scores) |
| Gemini calls (all structured JSON) | `src/ai/*` |
| Leak guard | `src/leak/deterministic.ts`, `src/leak/guard.ts` |
| SerpApi + cache | `src/serp/*` |
| Side panel (consent capture, chat, video, live timeline, stats) | `src/sidepanel/*` |
| Setup page (keys, camera, calibration, thresholds, dev tools) | `src/options/*` |

### Never leaking the answer
1. **Solver (hidden).** Gemini solves the cropped problem into `{finalAnswer, keySteps, conceptTags, misconceptions, answerKeyPhrases}`. This lives only in `chrome.storage.session`, with a 2 h TTL, and is never messaged to the UI.
2. **Tutor turn.** Gemini gets the answer key as private context and writes one guiding question at hint level 1–3. The level adapts to the student's replies.
3. **Leak check** before anything is shown:
   - a **deterministic** matcher: equivalent numbers (0.5 = 1/2 = 50%), rounded values, the answer string, MC letters and option endorsements, solution code lines and identifiers, key phrases
   - then a **Gemini judge**
   - A failed draft is regenerated up to 2×; after that, a safe generic question is shown. If the judge errors, the guard fails closed.

### Privacy and fairness
- Camera frames are processed on-device and never leave it. Only averaged numbers reach the service worker.
- Nothing is sent to Gemini until the student crops the problem, previews exactly what will be sent (outside the crop is blurred by default), and clicks **Send**.
- Facial expressions vary across people and cultures, so the face channel has the **lowest weight (20%)**. Page content carries the score.
- **Looking away or down** (e.g. writing on paper) is never counted as confusion; it only pauses the idle timer.
- Metrics and session summaries are numbers and timings, stored only in `chrome.storage.local`.

### Known limitations
- The hidden solution is in `chrome.storage.session`. Content scripts and web pages can't read it, but a determined student could with extension DevTools. The post-hackathon fix is a server-side solver.
- `chrome.sidePanel.open()` from the sprite relies on the click's user gesture. If Chrome refuses, the sprite tells the student to click the toolbar icon.
- YouTube video input to Gemini depends on the video being public. Gongo falls back to choosing from titles, descriptions and chapters.
- The face model can't detect hands, so "hand on face" isn't a signal.
- The sprite is a placeholder SVG; swap in a free asset pack via `public/sprite/`.

---

## Before demo day
- [ ] Turn on **Demo mode** (threshold 50, 10 s, cooldown 30 s). Turn on Dev mode only off-stage (it shows "Force trigger").
- [ ] Run "I don't know at all" once for each demo concept, then **Export video cache** on the options page and save it over `extension/src/serp/demoCache.json`. Rebuild.
- [ ] Collect ≥10 label-mode sessions (Alt+Shift+S when genuinely stuck), export them to `label-logs/`, then run `npm run evaluate`.
- [ ] Run `npm run leak-eval`, rebuild, and check the Stats tab.
- [ ] Test the camera under venue lighting and record a backup video.
- [ ] Keep the API keys in a password manager. Never commit them (`git grep AIza` should find nothing).

**Demo script:**
1. A judge answers `math.html` Q4 wrong twice, and the nudge appears.
2. The Socratic back-and-forth.
3. "I don't know at all" brings up a timestamped clip.
4. The judge solves it and passes the understanding check.
5. Show the **Stats** tab.
6. Bonus: show `physics.pdf` via the side panel's "I'm stuck" button.
