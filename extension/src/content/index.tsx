import { createRoot } from 'react-dom/client';
import type { Msg } from '../shared/messages';
import { ActivityTracker } from './activityTracker';
import { ContentSignals } from './contentSignals';
import { readPageContext } from './pageContext';
import { Sprite, spriteCss } from './sprite/Sprite';

const isTop = window.top === window;
const content = new ContentSignals();
const activity = new ActivityTracker();

// After the extension reloads, this orphaned script can no longer talk to it; stop quietly.
function alive(): boolean {
  try {
    return !!chrome.runtime?.id;
  } catch {
    return false;
  }
}

const timer = setInterval(() => {
  if (!alive()) {
    clearInterval(timer);
    content.dispose();
    activity.dispose();
    return;
  }
  if (document.visibilityState !== 'visible') return;
  const msg: Msg = {
    type: 'page-signals',
    signals: {
      content: content.signals(),
      activity: activity.signals(),
      idleMs: activity.idleMs,
      dwellMs: content.dwellMs,
      questionLabel: content.questionLabel,
    },
  };
  chrome.runtime.sendMessage(msg).catch(() => {});
}, 1000);

if (isTop) {
  chrome.runtime.onMessage.addListener((msg: Msg, _sender, reply) => {
    if (msg.type === 'get-page-context') reply(readPageContext());
  });

  // Closed shadow root so host-page CSS can't reach the sprite and page scripts can't reach in.
  const host = document.createElement('div');
  host.id = 'gongo-root';
  host.style.cssText = 'all: initial; position: fixed; z-index: 2147483647; inset: auto 0 0 auto;';
  const shadow = host.attachShadow({ mode: 'closed' });
  const style = document.createElement('style');
  style.textContent = spriteCss;
  const mount = document.createElement('div');
  shadow.append(style, mount);
  (document.body ?? document.documentElement).appendChild(host);
  createRoot(mount).render(<Sprite />);
}
