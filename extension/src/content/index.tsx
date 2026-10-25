import { createRoot } from 'react-dom/client';
import type { Msg } from '../shared/messages';
import { ActivityTracker } from './activityTracker';
import { ContentSignals } from './contentSignals';
import { readPageContext } from './pageContext';
import { Sprite, spriteCss } from './sprite/Sprite';
import { WorkLog } from './workLog';

const isTop = window.top === window;
const log = new WorkLog();
const content = new ContentSignals(log);
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
      activity: activity.signals(),
      idleMs: activity.idleMs,
      dwellMs: content.dwellMs,
      questionLabel: content.questionLabel,
    },
  };
  chrome.runtime.sendMessage(msg).catch(() => {});
}, 1000);

// Every frame answers "what's on screen?" so embedded editors and whiteboards are included.
chrome.runtime.onMessage.addListener((msg: Msg, _sender, reply) => {
  if (msg.type === 'get-page-context') reply(readPageContext(log));
});

if (isTop) {
  // Closed shadow root so host-page CSS can't reach the sprite and page scripts can't reach in.
  const host = document.createElement('div');
  host.id = 'gongo-root';
  host.style.cssText = 'all: initial; position: fixed; z-index: 2147483647; inset: auto 0 0 auto;';
  const shadow = host.attachShadow({ mode: 'closed' });
  const style = document.createElement('style');
  style.textContent = spriteCss;
  const mount = document.createElement('div');
  shadow.append(style, mount);
  // Attach to <html> (not <body>) so a transformed/replaced body can't move or delete the owl,
  // and put it back if a page script wipes it.
  const attach = () => {
    if (!host.isConnected) document.documentElement.appendChild(host);
  };
  attach();
  new MutationObserver(attach).observe(document.documentElement, { childList: true });
  // The owl hides itself while the tab image is taken so it doesn't cover the problem.
  const setHidden = (hidden: boolean) => (host.style.visibility = hidden ? 'hidden' : 'visible');
  createRoot(mount).render(<Sprite setHidden={setHidden} />);
}
