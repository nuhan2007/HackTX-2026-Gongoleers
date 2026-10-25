# myTA.tech: the pixel study buddy that knows when you're stuck

> It notices you're stuck before you give up, flags a slip the moment you make it, cheers when you get it, and never gives you the answer.

**HackTX 2026 · Team Gongoleers** · Tracks: Best Overall, SerpApi, Best Pitch

myTA is a Chrome extension (Manifest V3) with a **pixel monkey** (or your own TA's face) that lives in the tab where you do your work. It fuses three on-device signals into a live **confusion score**:

- **page content**: "Incorrect" after a submit, resubmits, the same error repeating
- **activity**: re-reading, idling, backspace bursts, tab-hopping
- **face**: brow furrow and head tilt, from the webcam via MediaPipe

It watches **two tabs**: the **problem tab** (a homework site like Khan Academy) and the **work tab** (a drawing board like sketch.io, or any document, where you write your solution). It takes a **snapshot of them every 3 seconds and keeps them on the device**. There is **no chat and nothing to type**: you write your solution, and one **sprite**, which lives only in the work tab, reads it and speaks up. With nobody clicking anything:

1. **It notices the problem you're on, and which tab is which.** Once you've stayed on a page that looks like a problem for a few seconds, a stronger Gemini model works it out privately (one call; it reads the figure too, e.g. a circuit schematic) and myTA starts *following* it. It never decides which tab is the work from one clue: it scores every tab on several indicators (a known drawing board or notes site; a canvas filling the screen with drawing tools; a big writing area; typing or strokes on it, against a known homework site, a "Check" button, an answer box, numbered questions). The side panel lists them, with reasons.
2. **A slip is flagged a couple of seconds after the line is written.** The moment you finish a line (you wrote something, then went still for about a second) the work tab is captured and read. If the line is wrong, the sprite appears *right then* with a red box on your work, and the words (checked so they never give the answer) follow a moment later. It also reads every few seconds while you keep writing. Clear handwriting is flagged at once; unclear handwriting needs two readings in a row to agree.
3. **Copying the problem down wrongly is called out, but only once you've finished writing it.** A half-written copy always differs from the whole problem, so the model must say the copy is complete, a second reading must agree, and you must have been still when it was taken. Until then, nothing is said.
4. **The sprite steps in when you're confused, always.** When your score stays **at or above the threshold for X seconds in a row** (both are setup sliders), the sprite appears *immediately*, even if the problem is still being worked out or the model is unreachable (then it asks a general guiding question). It reads your work and turns into a short hint about where to look, never the answer. If a message about your work is on screen when the nudge comes due, the nudge waits and appears right after you've read it, if you're still stuck. **Another hint** goes one level deeper.
5. **A short video, with the minute to start at.** A hint that finds a missing idea puts a clip on the sprite: found with **SerpApi**, and where the explanation begins found by **Gemini watching the YouTube video** (or from the video's chapters). The button says **Watch it (2:14)** and opens the video there.
6. **It checks your answer.** When you stop writing and you're calm, or the moment the homework page says your answer is wrong, myTA checks it against its private key and says where it went off. The page has the last word.
7. **When you get it right, it cheers**: confetti, bananas, a jumping monkey, and "3 solved today". Different words each time.
8. **It adapts to the problem.** The solver also reports the subject (circuits, calculus, programming, …), the method ("node voltage analysis"), how hard it is, how long it should take, and what your work will look like. A circuit gets more patience and slower reading (it's a drawing), a quick problem an earlier first check, and every reading gets the *playbook* of typical slips for that subject (flipped KCL signs, a supernode forgotten, a dropped chain-rule factor, an off-by-one…). The threshold itself is never changed. Whatever method you use is judged on its own merits, not by whether it matches the key's.
9. **It's yours.** The default sprite is a pixel monkey. Upload or take a photo of your TA (or a pet) and it becomes a sticker or pixel-art sprite, cut out on your device, and you can switch back any time.

A private answer key plus a two-layer leak guard keeps every message from revealing the answer.

There is no backend. The extension calls the **Gemini** and **SerpApi** APIs directly from its service worker.

---

## Quick start

```bash
cd extension
npm install          # also copies MediaPipe wasm and downloads the face and person-cutout models
npm run build        # → extension/dist
```

1. Open `chrome://extensions`, enable **Developer mode**, click **Load unpacked**, and pick `extension/dist`.
2. The setup page opens automatically:
   - paste your **Gemini** key ([aistudio.google.com/apikey](https://aistudio.google.com/apikey)) and your **SerpApi** key (stored only in `chrome.storage.local`), then press **Save & test keys**. It makes a real call to each service: Gemini's model list, a check that both model names exist, and one tiny structured call; SerpApi's free account endpoint. If a model isn't available to the key, it suggests one that is.
   - **Quick model** (default `gemini-3.8-flash`): reads your work, writes hints, checks them. **Problem-solving model** (default `gemini-4-argon`): works each problem out once. If the key can't use the stronger one, myTA falls back to the quick one by itself.
   - **Allow camera**, then **Calibrate (10 s)**
   - **Make it yours** (optional): upload or take a picture for your sprite.
3. Click the myTA toolbar icon to open the side panel. When setup is complete the monkey says hello, once.

After changing code, rebuild and press the reload icon on the extension in `chrome://extensions`. Tabs that were already open get the content script injected automatically.

`npm run build` builds the page script as **one self-contained classic file** (`dist/content.js`, via `vite.content.config.ts` and `scripts/finalize-manifest.mjs`) instead of CRXJS's default loader, which `import()`s web-accessible modules in every frame. Chrome refuses that import in some frames (sandboxed iframes, YouTube pages after a reload) and logs "Unsafe attempt to load URL chrome-extension://…" under the extension's Errors. The classic script has nothing to fetch, so it can't fail that way. (`npm run dev` still uses the loader.)

**About the name:** the extension is called **myTA.tech** (the book icon is a light brown pixel book). The domain `myta.tech` itself has to be registered by you (a `.tech` domain is a free perk with many hackathons); nothing in the extension depends on it.

**Demo pages:** run `npm run demo` and open <http://localhost:5174/khan.html> (a Khan Academy stand-in: one problem at a time, same address for the next), `/sketch.html` (a canvas drawing board with Pen, Eraser, Clear: the "work tab", in a second window), `/circuit2.html` (a two-node circuit with a schematic that is only a picture: V1 = 6 V, V2 = 12 V), `/circuit.html`, `/math.html`, `/work.html`, `/physics.pdf`. (The content script doesn't run on `file://` URLs unless you enable "Allow access to file URLs", so serve the pages instead.)

| Command | What it does |
|---|---|
| `npm test` | Unit tests (engine, trigger, call gate, monitor, tab roles, Gemini client, key checks, leak checker, guard, caches, photo-to-sprite, eval) |
| `npm run build` | Type-check and build |
| `npm run evaluate -- <dir>` | Precision/recall/lead time from label-mode logs (default `../label-logs/`) |
| `npm run leak-eval [-- --limit N]` | Measured answer-leak rate over `eval/problems.json`, now with circuit problems (needs `GEMINI_API_KEY` in `extension/.env`) |

---

## How it works

```
Content script (every frame)        Offscreen doc (camera, always on)
  ContentSignals + ActivityTracker    MediaPipe Face Landmarker @5 fps → averaged numbers
  running totals: wrong answers,                        │
  keys, drags, scroll                                   │
  Sprite (closed Shadow DOM: pixel monkey or sticker),  │
  page-role hints                                       │
            │ signals + totals / 1 s                    │
            ▼                                           ▼
Service worker ── ConfusionEngine (noisy-OR per channel, 0.5/0.3/0.2 fusion, EMA)
               ── TriggerMachine (score ≥ threshold for X s in a row, cooldown) → sprite, ALWAYS
               ── ProblemTracker → one Gemini call (stronger model, thinking on, sees the figure):
               │        answer key + subject + method + difficulty + milestones + how sure it is
               ── Monitor ── snapshots every 3 s ─► IndexedDB ring (on this device)
               │        └─► CallGate: a finished line (new writing, then ~1 s still) · every few s while writing
               │                      · wrong answer · confusion · time on problem · FINISHED
               │                       │ only then: capture the work tab, then
               │                       ▼
               │              Gemini (quick model, little thinking): read the work → status, copy state, box
               │                       ├─► onEarly: flag (red box) goes up NOW
               │                       └─► leak guard → the words follow
               ── readPolicy: flag · cheer · clear · settle (wait for the copy to be finished)
               ── video: concept → SerpApi YouTube → Gemini picks → chapters, or Gemini watches the video → "Watch it (2:14)"
```

### How often it asks the model

Taking a snapshot never costs a call. Reading what's new does, so it is paced: **read when something new is on screen, one read at a time.**

| Reason | What triggers it |
|---|---|
| **a finished line** | something new was written, then ~0.9 s of stillness (and at least 1.5 s since the last read). The work tab is captured (one capture, taken as the pause begins, so the picture is ready) and read. This is what makes a slip show up about two seconds after the line |
| **progress** | new work on screen and the reading interval (a slider, 5 s) has passed, while you keep writing |
| **a wrong answer** | the homework page newly says "incorrect", after 2 s to let the screen settle. A **check of the answer**, not a quiet look; it overrules a reading that guessed "solved" |
| **finished** | new work since the last check, then no new work for the idle time (default 8 s, longer for a harder problem and for drawn work), with the score below the sprite's threshold |
| settled look | a reading suspects a wrongly copied problem: look again once you've been still 2.5 s |
| confusion rising / time on problem / a stuck pause | the quiet extra looks, which double their gap when they find nothing |

The confusion score itself doesn't call the model; it brings up the sprite. Every reading can flag a mistake or a wrong copy, or cheer a correct answer; that costs one extra leak-guard call only when there is something to say, and the flag itself doesn't wait for it.

### Gemini

`src/ai/llmClient.ts` is a small `generateContent` client with structured JSON output, image input and YouTube-video input. Gemini changes quickly, so what it can't know is **learned from the API**: models take a thinking budget (2.5) or a level (3 and later), and "minimal" isn't valid everywhere; a request that names something the model refuses is retried with the next best value and what worked is remembered. The same goes for how the schema is passed (`responseJsonSchema`, the older `responseSchema`, or only described in the prompt). A bad key (a 400 on Gemini) is told apart from other 400s. Gemini returns keys in schema order, so the schemas are ordered on purpose: transcribe the handwriting first, then decide whether the copy is finished, then whether it is wrong, then the verdict, then the words.

### Never leaking the answer
1. **Solver (hidden).** Gemini solves the problem on screen into `{finalAnswer, keySteps, checkpoints, givens, domain, difficulty, …}`. This lives only in `chrome.storage.session`, with a 2 h TTL, and is never messaged to the UI.
2. **Hint.** The model gets the answer key (and the subject's playbook) as private context and writes one short hint at level 1–3.
3. **Leak check** before anything is shown (hints, mistake messages, congratulations *and* the final work review):
   - a **deterministic** matcher: equivalent numbers (0.5 = 1/2 = 50%), rounded values, the answer string, **each value of a multi-value answer** ("V1 = 6 V, V2 = 12 V"), milestone values, MC letters, solution code, key phrases (numbers the problem itself gives are fine)
   - then a **model judge**
   - A failed draft is regenerated up to 2×; after that, a safe generic question is shown. If the judge errors, the guard fails closed.

### The sprite

| Piece | Where |
|---|---|
| The pixel monkey (36×36 cells, layered poses: idle, thinking, alarmed, cheering, worried) | `src/content/sprite/monkeyArt.ts` (generated art), `Monkey.tsx` |
| The speech bubble, cards, drag-to-move, fold-away, the red box, confetti | `src/content/sprite/Sprite.tsx`, `styles.ts`, `confetti.ts`, `pixelIcons.tsx` |
| Monkey or custom sticker (drawn on a canvas, so a strict page can't block it) | `Avatar.tsx`, `src/shared/mySprite.ts` |
| Photo → sprite: crop, person cut-out (MediaPipe selfie model), plain-background cut-out, sticker outline, pixel art | `src/options/SpriteStudio.tsx`, `spriteMaker.ts`, `src/shared/cutout.ts` |
| What the sprite says (phrase pools, never the same twice in a row) | `src/shared/phrases.ts` |
| What a reading means for the sprite (flag, cheer, clear, settle) | `src/background/readPolicy.ts` |

### Everything else

| Piece | Where |
|---|---|
| Fusion + smoothing | `src/background/confusionEngine.ts` |
| Trigger state machine (the sprite rule) | `src/background/triggerMachine.ts` |
| Which problem, and when it changes | `src/background/problemTracker.ts` |
| Page-content signals, activity signals, face features | `src/content/*`, `src/shared/face*.ts` |
| Which tab is the problem, which is the work | `src/shared/pageRole.ts`, `src/content/roleHints.ts`, `src/background/tabRoles.ts` |
| Snapshot capture, diff, local store | `src/background/frames.ts`, `frameDiff.ts`, `frameStore.ts` |
| When to call the model | `src/background/callGate.ts`, the loop in `monitor.ts` |
| Model calls and prompts, subject playbooks | `src/ai/*` (`solver.ts`, `work.ts`, `tutor.ts`, `prompts.ts`, `playbooks.ts`, `videoTimestamp.ts`) |
| Per-problem adaptation (patience, pace, first check) | `src/shared/settings.ts` (`triggerConfig`, `reviewMs`, `finishConfig`, `tuningNote`) |
| Leak guard | `src/leak/*` |
| SerpApi + cache | `src/serp/*` |
| Everything the background does | `src/background/index.ts`, `tutorService.ts` |
| Side panel (what myTA is following, which tab is which, live timeline, stats) | `src/sidepanel/*` |
| Setup page (keys, camera, thresholds, make it yours) | `src/options/*` |

### Privacy and fairness
- Camera frames are processed on-device and never leave it. Only averaged numbers reach the service worker.
- **Snapshots stay on this device.** While myTA is on, it keeps the last few snapshots of the tab you're in (never mail, sign-in or banking pages) in IndexedDB. A snapshot, plus visible page text, goes to Gemini when myTA starts following a problem (once), and after that only when the call gate asks for a look (a finished line, a wrong answer, you look finished), a hint is needed, or you ask for a check. When it suggests a video, Gemini watches that *public* YouTube video. Turning myTA off, or snoozing it, deletes every stored snapshot.
- **The photo you make your sprite from is processed on this device** (the cut-out model runs in the browser) and the result stays in this browser.
- Facial expressions vary across people and cultures, so the face channel has the **lowest weight (20%)**. Page content carries the score.
- **Looking away or down** (e.g. writing on paper) is never counted as confusion; it only pauses the idle timer.

### Known limitations
- The hidden solution is in `chrome.storage.session`. Content scripts and web pages can't read it, but a determined student could with extension DevTools. The post-hackathon fix is a server-side solver.
- A harder problem is only as good as the answer key. The key says how sure it is; when it isn't, a different answer from the student isn't called wrong without a slip being found. The solver model is the lever: use the strongest one your key allows.
- Snapshots see browser tabs, not paper or other apps. Chrome blocks capture on `chrome://` pages and the Web Store, and only the active tab of each window can be captured. A work tab in the *same* window as the problem is only photographed while it's the active tab.
- The model reads handwriting at about the size of a full-screen photo. Very small handwriting on a huge canvas may be hard to read; write a little larger or zoom the page in.
- Telling a wrongly copied problem from a right one, and a mistake from unfinished work, is the model's judgement; the policy around it (a finished copy, two agreeing readings, you being still) is what keeps it from crying wolf.
- Gemini can only watch public YouTube videos, and not very long ones; otherwise the start minute comes from the video's chapters or, failing that, the search result's text (shown as `(~1:00)` or `(from the start)`).
- The person cut-out model is for people; pets and drawings use a plain-background cut-out, which works best against a simple background (there is a slider for it).

---

## Before demo day
- [ ] Paste the Gemini key (paid) in setup, press **Save & test keys**, and check both models are accepted.
- [ ] In setup → Detection, pick the threshold and seconds you want (the page shows the wait for each difficulty). There is no hidden preset: the numbers on the sliders are the numbers in force. Turn on Dev mode only off-stage (it shows "Force trigger").
- [ ] Make your TA's sprite in **Make it yours** and watch it say hello.
- [ ] Let the sprite offer a clip once for each demo concept (its **Watch a short clip** button), then **Export video cache** on the options page and save it over `extension/src/serp/demoCache.json`. Rebuild.
- [ ] Run `npm run leak-eval`, rebuild, and check the Stats tab.
- [ ] Test the camera under venue lighting and record a backup video.
- [ ] Keep the API keys in a password manager. Never commit them.

**Demo script** (the student never types to myTA; everything below is the sprite on its own):
1. Open `khan.html` in one window and `sketch.html` in another. Touch nothing: a few seconds in, the page says "myTA · following …", and **Which tab is which** shows the board recognised as the work tab before you've drawn a thing, and why.
2. Write the solution on the board. Make a slip in a line and stop: about two seconds later the monkey appears with a red box on the line and says where, never the answer.
3. Copy the problem down with a wrong number. While you're writing, nothing. Once you've finished and stopped: "What you wrote doesn't match the problem."
4. Get confused (or lower the threshold). The monkey appears at once, reads your work and gives a hint about it; a missing idea brings a video with the start minute in parentheses. **Another hint** goes deeper.
5. Open `circuit2.html`, work node-voltage analysis on the board: same flow, now for a figure that is only a picture. The panel says how myTA adapted ("node voltage analysis · difficulty 4 · steps in after 25 s · reads every 8 s").
6. Type the right answer on the homework page: confetti and bananas. **Next question** and it follows the new problem by itself.
7. In setup → **Make it yours**, upload a photo of your TA: it becomes a sticker (or pixel art), and says hello.
