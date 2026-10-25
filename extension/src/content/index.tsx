import { createRoot } from 'react-dom/client';
import type { Msg } from '../shared/messages';
import { ActivityTracker } from './activityTracker';
import { ContentSignals } from './contentSignals';
import { readPageContext } from './pageContext';
import { readRoleHints } from './roleHints';
import { Sprite, spriteCss } from './sprite/Sprite';

// After the extension reloads, an orphaned copy of this script can no longer talk to it; it stops quietly.
function alive(): boolean {
  try {
    return !!chrome.runtime?.id;
  } catch {
    return false;
  }
}

/** Set on the page's isolated world once a copy of this script is running there, so injecting it a second time doesn't run two. */
const RUNNING = '__mytaContent';

function start() {
  const isTop = window.top === window;
  // The background decides whether a "moving on" event matters (only while a problem is being followed).
  const content = new ContentSignals(document, (reason) => {
    if (alive()) chrome.runtime.sendMessage({ type: 'move-on', reason } satisfies Msg).catch(() => {});
  });
  let ticks = 0;
  let lastSentAt = 0;
  let late: ReturnType<typeof setTimeout> | undefined;
  const report = () => {
    clearTimeout(late);
    late = undefined;
    lastSentAt = Date.now();
    if (document.visibilityState !== 'visible') return;
    // What kind of page this is (a drawing board, or a homework page), every few seconds from the top frame only.
    const role = isTop && ticks++ % 3 === 0 ? readRoleHints() : undefined;
    const msg: Msg = {
      type: 'page-signals',
      signals: {
        content: content.signals(),
        activity: activity.signals(),
        idleMs: activity.idleMs,
        dwellMs: content.dwellMs,
        questionLabel: content.questionLabel,
        stats: {
          incorrectTotal: content.incorrectTotal,
          correctTotal: content.correctTotal,
          submitTotal: content.submitTotal,
          keyTotal: activity.keyTotal,
          pointerTotal: activity.pointerTotal,
          scrollY: Math.round(activity.scrollY),
        },
        role,
      },
    };
    chrome.runtime.sendMessage(msg).catch(() => {});
  };
  // Typing or finishing a stroke is reported straight away (at most four times a second) rather than at the next tick: the first look at the
  // line they just wrote begins when they stop writing, not up to a second later.
  const onInput = () => {
    if (late || !alive()) return;
    const wait = Math.max(0, 250 - (Date.now() - lastSentAt));
    late = setTimeout(report, wait);
  };
  const activity = new ActivityTracker(window, onInput);
  const timer = setInterval(() => {
    if (!alive()) {
      clearInterval(timer);
      clearTimeout(late);
      content.dispose();
      activity.dispose();
      return;
    }
    report();
  }, 1000);

  if (!isTop) return;
  chrome.runtime.onMessage.addListener((msg: Msg, _sender, reply) => {
    if (msg.type === 'get-page-context') reply(readPageContext(content.questionLabel));
  });

  // A reload leaves the previous (dead) copy's sprite behind; clear it before mounting ours.
  document.getElementById('myta-root')?.remove();
  // Closed shadow root so host-page CSS can't reach the sprite and page scripts can't reach in.
  const host = document.createElement('div');
  host.id = 'myta-root';
  host.style.cssText = 'all: initial; position: fixed; z-index: 2147483647; inset: auto 0 0 auto;';
  const shadow = host.attachShadow({ mode: 'closed' });
  const mount = document.createElement('div');
  try {
    // A constructable stylesheet isn't blocked by a page's style-src policy the way an inline <style> element can be
    // (sites like Khan Academy set strict policies), so the sprite always looks right.
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(spriteCss);
    shadow.adoptedStyleSheets = [sheet];
    shadow.append(mount);
  } catch {
    const style = document.createElement('style');
    style.textContent = spriteCss;
    shadow.append(style, mount);
  }
  const attach = () => {
    if (!host.isConnected) (document.body ?? document.documentElement).appendChild(host);
  };
  attach();
  // Some single-page apps rebuild <body>; put the sprite back if it was swept away.
  const keep = setInterval(() => (alive() ? attach() : clearInterval(keep)), 2000);
  createRoot(mount).render(<Sprite />);
}

// Only ordinary web pages (and local files). A frame that is about:blank, a data: or blob: document, or an opaque sandbox has nothing for
// myTA to read, and the script can also be injected by hand into every frame of an open tab, so say no here rather than trust the caller.
const ordinary = ['http:', 'https:', 'file:'].includes(location.protocol);
const scope = globalThis as unknown as Record<string, { alive: () => boolean } | undefined>;
if (ordinary && !scope[RUNNING]?.alive()) {
  scope[RUNNING] = { alive };
  start();
}
