# Gongo: the study buddy that knows when you're stuck

> It notices you're stuck before you give up, asks the question that gets you moving, and never gives you the answer.

**HackTX 2026 · Team Gongoleers** · Tracks: Best Overall, SerpApi, Best Pitch

Gongo is a Chrome extension (Manifest V3). It fuses two on-device signals into a live **confusion score**. It never tries to judge whether an answer is right or wrong:

- **page activity**: re-reading, idling, long time on one question, backspace bursts, rage clicks, tab-hopping
- **face**: brow furrow, squint and head tilt, from the webcam via MediaPipe (even mild, held expressions count)

When the score stays high, a purple owl pops up in the corner. Click **Let's do it** and Gongo **looks at the tab, Copilot-style**: an image of the screen, the page text and math, the answer fields, any handwriting or drawings, and a log of what the student typed, submitted and got back. A help card right next to the owl then shows an insight into what they seem stuck on plus 2–3 "try this next" suggestions. Nothing is asked of the student: they can just read it, ask for another angle, watch a short video, or say it helped. The × (or Esc) closes the owl at any point. The same **Socratic tutor** (powered by OpenAI) is also available in Chrome's side panel. A private answer key plus a two-layer leak guard keeps it from ever revealing the answer. If the student doesn't know a prerequisite, **SerpApi + OpenAI** pick a YouTube video, and the chapter or timestamp, that explains the concept.

There is no backend. The extension calls the OpenAI and SerpApi APIs directly from its service worker.

---

## Quick start

```bash
cd extension
npm install          # also copies MediaPipe wasm, downloads the face model, generates icons
npm run build        # → extension/dist
```

1. Open `chrome://extensions`, enable **Developer mode**, click **Load unpacked**, and pick `extension/dist`.
2. The setup page opens automatically:
   - paste your **OpenAI** and **SerpApi** keys (stored only in `chrome.storage.local`)
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
  Owl + help card (closed Shadow DOM)               │
            │ signals / 1 s                         │
            ▼                                       ▼
Service worker ── face smoothing (rolling median + EMA), baseline z-scores
               ── ConfusionEngine (noisy-OR per channel, per-channel EMA, noisy-OR across activity and face, score EMA)
               ── TriggerMachine (threshold × duration, hysteresis, cooldown)
               ── state persisted to chrome.storage.session every tick
               ── tutor: solver (hidden) → tutor turn → leak guard → side panel
               ── video: concept → SerpApi YouTube → OpenAI picks from titles/chapters → timestamp
```

| Piece | Where |
|---|---|
| Fusion + smoothing | `src/background/confusionEngine.ts` |
| Trigger state machine | `src/background/triggerMachine.ts` |
| Restart-safe persistence | `src/background/engineStore.ts` |
| Page-content signals | `src/content/contentSignals.ts` |
| Activity signals | `src/content/activityTracker.ts`, `src/background/tabTracker.ts` |
| Face features | `src/shared/face.ts` (MediaPipe), `src/shared/faceSignals.ts` (baseline z-scores) |
| OpenAI calls (all strict structured JSON) | `src/ai/*` |
| Leak guard | `src/leak/deterministic.ts`, `src/leak/guard.ts` |
| SerpApi + cache | `src/serp/*` |
| Owl + inline help card (hint, suggestions, reply, video, understanding check) | `src/content/sprite/Sprite.tsx` |
| "Look at the tab": screen image + per-frame text, TeX, fields, drawings | `src/background/tabReader.ts`, `src/content/pageContext.ts` |
| Work log (edits, submits, feedback, drawing strokes) | `src/content/workLog.ts` |
| Side panel (chat, video, live timeline, stats) | `src/sidepanel/*` |
| Setup page (keys, camera, calibration, thresholds, dev tools) | `src/options/*` |

### Never leaking the answer
1. **Solver (hidden).** OpenAI reads the tab (screen image, drawings and text) and solves the problem into `{finalAnswer, keySteps, conceptTags, misconceptions, answerKeyPhrases, studentWork}`. `studentWork` describes what the student did and where it likely went wrong. This lives only in `chrome.storage.session`, with a 2 h TTL, and is never messaged to the UI.
2. **Tutor turn.** OpenAI gets the answer key as private context and writes one guiding question at hint level 1–3. The level adapts to the student's replies.
3. **Leak check** before anything is shown:
   - a **deterministic** matcher: equivalent numbers (0.5 = 1/2 = 50%), rounded values, the answer string, MC letters and option endorsements, solution code lines and identifiers, key phrases
   - then a **LLM judge**
   - A failed draft is regenerated up to 2×; after that, a safe generic question is shown. If the judge errors, the guard fails closed.

### Privacy and fairness
- Camera frames are processed on-device and never leave it. Only averaged numbers reach the service worker.
- Nothing is sent to OpenAI until the student asks for help (**Let's do it** on the owl, or **I'm stuck** in the side panel).
- Then Gongo reads only that one tab: a screen image, page text and TeX, answer fields, canvas drawings, and a short work log of edits, submits and feedback. The work log records edits as before → after, not raw keystrokes. Password and payment fields are never read.
- Facial expressions vary across people and cultures, so the face channel can contribute less than page activity (gain 0.65 vs 0.8), and either one can raise the score on its own.
- **Looking away or down** (e.g. writing on paper) is never counted as confusion; it only pauses the idle timer.
- Metrics and session summaries are numbers and timings, stored only in `chrome.storage.local`.

### Known limitations
- The hidden solution is in `chrome.storage.session`. Content scripts and web pages can't read it, but a determined student could with extension DevTools. The post-hackathon fix is a server-side solver.
- The owl lives in the page, so it can't appear on Chrome's own pages (`chrome://`, the Web Store, new-tab), the PDF viewer, or `file://` pages unless you enable "Allow access to file URLs". There the toolbar badge shows **HELP**, the side panel explains why, and "I'm stuck" in the side panel still works.
- Chrome won't capture some pages (`chrome://`, the Web Store). On those, Gongo uses the page text alone or explains that it can't see the page.
- Drawings on cross-origin canvases can't be snapshotted directly, but they still appear in the screen image.
- OpenAI can't watch videos, so the video moment comes from SerpApi's titles, descriptions and chapters. It's only as precise as those are.
- The default model is `gpt-6-luna`; change it on the options page (it needs vision and structured outputs). Check OpenAI's model list if it's rejected.
- The face model can't detect hands, so "hand on face" isn't a signal.
- The sprite is a placeholder SVG; swap in a free asset pack via `public/sprite/`.

---

## Before demo day
- [ ] Turn on **Demo mode** (threshold 30, 8 s, cooldown 30 s; the normal default is 35 for 25 s). Turn on Dev mode only off-stage (it shows "Force trigger").
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
