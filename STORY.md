# Gongo: the study buddy that knows when you're stuck

## Inspiration

Most students don't ask for help the moment they get stuck. They stare at the problem, re-read it, retype the same
answer, and quietly give up. By the time anyone notices, the frustration has already won. Most tutoring tools wait to
be asked, and most chatbots will happily hand over the answer, which feels good for a minute and teaches nothing.

We wanted the opposite: something that **notices** you're stuck, **asks for nothing**, and **never gives the answer**.
That became Gongo, a small purple owl that appears in the corner of your screen when you seem confused.

## What it does

Gongo is a Chrome extension. It fuses two signals into a live confusion score:

- **Page activity:** idling, a long time on one question, re-reading, backspace bursts, rapid repeat clicks, tab-hopping.
- **Your face:** brow furrow, squint and head tilt, measured by MediaPipe **on your device**. Camera frames never leave it.

When the score stays high, the owl pops up. Click **Let's do it** and it looks at your current tab, Copilot-style. It
reads the screen, the page text, any math, your answer fields, and your drawings. Then it shows a short insight into
what you seem to be stuck on, plus a few concrete "try this next" suggestions. A private answer key and a leak guard keep
it from ever revealing the answer.

## How we built it

**Stack:** Chrome Manifest V3, Vite, React 18 and TypeScript. There is no backend. The service worker calls the OpenAI and
SerpApi APIs directly, and API keys live only in `chrome.storage.local`.

**The score.** Each channel $c$ (activity, face) combines its signals $s_i$ with a noisy-OR, so one strong cue can carry
a channel but several weak cues still add up:

$$
C_c = 1 - \prod_{i}\bigl(1 - w_i\, v_i\bigr)
$$

The channels are smoothed over time and then combined the same way, with the face given a lower gain $g_f < g_a$ because
expressions vary between people:

$$
S_t = (1-\alpha)\,S_{t-1} + \alpha\,\Bigl[\,1 - (1 - g_a C_a)(1 - g_f C_f)\Bigr]
$$

**Face features** are measured against *your own* calm baseline, recorded in a 10-second calibration, using z-scores. A
feature starts to count at $z = 0.7$ and saturates at $z = 2.2$:

$$
v = \operatorname{clamp}_{[0,1]}\!\left(\frac{z - 0.7}{2.2 - 0.7}\right), \qquad z = \frac{x - \mu_{\text{calm}}}{\max(\sigma_{\text{calm}},\ \sigma_{\text{floor}})}
$$

A rolling median throws out one-frame spikes such as blinks, and then an exponential moving average follows the trend.

**Never leaking the answer.** The tutor is a three-step pipeline:

1. A hidden **solver** reads the tab image and text and produces a private answer key.
2. The **tutor** writes an insight and suggestions using that key as private context.
3. A two-layer **leak guard** checks every word before it is shown. First a deterministic matcher catches equivalent
   numbers ($0.5 = \tfrac12 = 50\%$), choice letters and solution code. Then an LLM judge audits the message. A leaking
   draft is regenerated, and if the judge errors, the guard fails closed to a safe generic hint.

**Video help.** If the student needs a prerequisite, SerpApi finds YouTube candidates and OpenAI picks the video and the
start time from titles, descriptions and chapters.

## What we learned

- **Detection design beats model power.** The first versions swung wildly on tiny changes of expression. Median
  filtering, per-channel averaging and a baseline-relative mapping did more for usability than any amount of tuning.
- **Manifest V3 is a different mindset.** The service worker can be killed at any moment, so all state lives in
  `chrome.storage`. Offscreen documents can use the camera but cannot read extension storage.
- **Privacy is a design constraint.** Face analysis stays on-device, passwords are never read, and nothing is sent to OpenAI until the
  student asks for help.
- **Test in the real thing.** Several of our worst bugs were invisible in unit tests and obvious in a real browser.
- **Models differ.** Settings that one model accepts, such as a sampling temperature, another rejects. The client
  has to adapt instead of assuming.

## Challenges

- **The owl that never appeared.** The confusion score and the "nudge shown" status were correct, but the owl's slide-in
  animation was stuck on its first frame, so it was effectively invisible. We only found it by loading the extension in
  headless Chrome and screenshotting the page. That also revealed pages where an owl can never live, such as `chrome://`
  pages, the PDF viewer and `file://`, so we added a toolbar badge and a side-panel explanation as a fallback.
- **A score that was too twitchy, then too stingy.** We tuned it from "a slight frown swings it wildly" to "you have to
  scream to move it" and back. The final version needs only mild, held expressions, and a face the camera can't find no
  longer freezes the score.
- **Not judging right and wrong.** We deliberately removed any attempt to detect whether an answer was correct. The score
  comes only from how the student behaves and looks.
- **Switching AI providers mid-project.** Moving from Gemini to OpenAI meant new structured-output schemas, image inputs,
  and the fact that OpenAI can't watch a YouTube video. We also hit a `temperature` error on a newer model, which led to a client that
  drops a setting a model rejects and retries.
- **Being helpful without being a quiz.** Early versions kept demanding an answer from the student. We reworked the
  prompts and the card so the owl offers an insight, never requires a reply, and can always be closed with the × or Esc.

## What's next

- Run label-mode sessions with real students and measure precision, recall and lead time.
- Run the answer-leak eval across more subjects and report the measured rate.
- Move the solver server-side, so a determined student can't inspect the hidden answer key in extension DevTools.
