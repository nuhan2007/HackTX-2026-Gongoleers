// Everything the sprite looks like. It lives in a closed shadow root (see content/index.tsx), so none of this can leak into the page
// and nothing the page does can reach it. Light and dark follow the page's colour scheme; reduced motion turns the motion off.
export const spriteCss = `
:host { all: initial; }
* { box-sizing: border-box; }
.root {
  --ink: #1d1a2e; --muted: #6a6684; --card: rgba(255,255,255,.92); --card-edge: rgba(108,92,231,.16); --chip: rgba(108,92,231,.1);
  --btn: #f3f1ff; --btn-ink: #3b2f8f; --btn-edge: #ddd8fb; --track: rgba(40,30,90,.1);
  --accent: #6c5ce7; --accent-2: #3ddbd9; --accent-ink: #fff;
  font: 14px/1.45 ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; color: var(--ink);
}
.root.kind-mistake { --accent: #e5484d; --accent-2: #ff9f43; --chip: rgba(229,72,77,.1); --card-edge: rgba(229,72,77,.22); --btn: #fff1f1; --btn-ink: #a62b30; --btn-edge: #f6cfd0; }
.root.kind-cheer { --accent: #f2a100; --accent-2: #ff6b81; --accent-ink: #2b1d00; --chip: rgba(242,161,0,.14); --card-edge: rgba(242,161,0,.35); --btn: #fff7e0; --btn-ink: #7a4f00; --btn-edge: #f7e1a6; }
.root.kind-check-work { --accent: #7c6cf0; --accent-2: #3ddbd9; }
.root.kind-hello { --accent: #19b97a; --accent-2: #5aa9ff; --chip: rgba(25,185,122,.12); --card-edge: rgba(25,185,122,.28); }
@media (prefers-color-scheme: dark) {
  .root { --ink: #f3f0ff; --muted: #aaa6c6; --card: rgba(30,28,46,.9); --card-edge: rgba(255,255,255,.12); --chip: rgba(255,255,255,.09); --btn: rgba(255,255,255,.08); --btn-ink: #e7e3ff; --btn-edge: rgba(255,255,255,.16); --track: rgba(255,255,255,.14); }
  .root.kind-mistake { --card-edge: rgba(255,120,125,.35); --chip: rgba(255,120,125,.14); --btn: rgba(255,120,125,.1); --btn-ink: #ffc9cb; --btn-edge: rgba(255,120,125,.3); }
  .root.kind-cheer { --card-edge: rgba(255,200,80,.4); --chip: rgba(255,200,80,.14); --btn: rgba(255,200,80,.1); --btn-ink: #ffe3a0; --btn-edge: rgba(255,200,80,.3); }
}

/* ---------- layout ---------- */
.dock { position: fixed; z-index: 2; display: flex; align-items: flex-end; gap: 6px; pointer-events: none; }
.dock.side-right .char { order: -1; }
.dock > * { pointer-events: auto; }
.dock.leaving > * { pointer-events: none; }
.dock.leaving .card { animation: card-out .24s ease-in both; }
.dock.leaving .avatar .body { animation: hop-away .28s ease-in both; }
.dock.leaving .avatar .emote { display: none; }
.char { position: relative; flex: none; width: 118px; height: 124px; padding: 0; margin: 0; border: 0; background: none; cursor: grab; touch-action: none; -webkit-tap-highlight-color: transparent; }
.char:active { cursor: grabbing; }
.char:focus-visible { outline: 3px solid var(--accent); outline-offset: 2px; border-radius: 16px; }
.badge { position: absolute; top: 4px; right: 8px; width: 16px; height: 16px; border-radius: 50%; background: var(--accent); border: 2px solid #fff; box-shadow: 0 0 0 0 var(--accent); animation: ping 1.6s infinite; }

/* ---------- the character ---------- */
.avatar { position: relative; width: 118px; height: 124px; }
.avatar .shadow { position: absolute; left: 50%; bottom: 3px; width: 82px; height: 14px; margin-left: -41px; border-radius: 50%; background: radial-gradient(closest-side, rgba(20,10,40,.34), transparent); animation: shadow-bob 2.6s ease-in-out infinite; }
.avatar .body { position: absolute; inset: 0 5px 8px 5px; display: flex; align-items: flex-end; justify-content: center; transform-origin: 50% 100%; animation: breathe 2.6s ease-in-out infinite; filter: drop-shadow(0 2px 0 rgba(255,255,255,.55)) drop-shadow(0 8px 10px rgba(40,20,70,.28)); }
.avatar .monkey, .avatar .sticker.pixel { display: block; flex: none; width: var(--px, 108px); height: var(--px, 108px); }
.avatar .sticker { display: block; width: 100%; height: 100%; }
.avatar.mirror.is-monkey .monkey { transform: scaleX(-1); }
.avatar .sticker { object-fit: contain; image-rendering: auto; }
.avatar .sticker.pixel { image-rendering: pixelated; }
.avatar .monkey .tail { transform-origin: 10px 30px; animation: tail-sway 2.8s ease-in-out infinite; }
.avatar .monkey .eyes.open { animation: eyes-open 5.2s infinite; }
.avatar .monkey .eyes.shut { opacity: 0; animation: eyes-shut 5.2s infinite; }
.avatar .emote { position: absolute; top: -4px; right: 14px; transform-origin: 50% 100%; animation: emote-pop .55s cubic-bezier(.2,1.6,.4,1) both, emote-bob 1.8s .55s ease-in-out infinite; filter: drop-shadow(0 3px 3px rgba(40,20,70,.3)); }
.avatar.mirror.is-monkey .emote { right: auto; left: 16px; }
.avatar.entering .body { animation: swing-in .75s cubic-bezier(.2,1.3,.4,1) both, breathe 2.6s .75s ease-in-out infinite; }
.avatar.entering .shadow { animation: fade-in .5s both, shadow-bob 2.6s .5s ease-in-out infinite; }
.avatar.mood-think .body { animation: breathe 2.6s ease-in-out infinite, tilt 3.2s ease-in-out infinite; }
.avatar.mood-alert .body { animation: jolt .5s cubic-bezier(.2,1.6,.4,1) both, breathe 2s .5s ease-in-out infinite; }
.avatar.mood-worry .body { animation: breathe 1.4s ease-in-out infinite, tremble .22s linear infinite; }
.avatar.mood-cheer .body { animation: hop .62s cubic-bezier(.3,0,.3,1) infinite; }
.avatar.mood-cheer .shadow { animation: shadow-hop .62s cubic-bezier(.3,0,.3,1) infinite; }
.avatar.mood-happy .body { animation: breathe 2s ease-in-out infinite; }

/* ---------- the speech bubble ---------- */
.card { position: relative; width: 330px; max-width: min(330px, calc(100vw - 150px)); margin-bottom: 14px; padding: 15px 16px 13px; border-radius: 20px 20px 6px 20px; background: var(--card); border: 1px solid var(--card-edge); backdrop-filter: blur(16px) saturate(1.5); -webkit-backdrop-filter: blur(16px) saturate(1.5);
  box-shadow: 0 1px 0 rgba(255,255,255,.7) inset, 0 12px 34px rgba(30,20,80,.22), 0 2px 6px rgba(30,20,80,.1); animation: card-in .5s cubic-bezier(.2,1.25,.4,1) both; transform-origin: 100% 100%; }
.side-right .card { border-radius: 20px 20px 20px 6px; transform-origin: 0 100%; }
.fx { position: absolute; inset: 0; border-radius: inherit; overflow: hidden; pointer-events: none; }
.fx .bar { position: absolute; left: 0; right: 0; top: 0; height: 4px; background: linear-gradient(90deg, var(--accent), var(--accent-2)); }
.fx .shine { position: absolute; inset: 0; background: linear-gradient(105deg, transparent 38%, rgba(255,255,255,.7) 50%, transparent 62%); transform: translateX(-120%); animation: shine 2.6s .5s ease-in-out 2; }
.fx .count { position: absolute; left: 0; bottom: 0; width: 100%; height: 3px; background: linear-gradient(90deg, var(--accent), var(--accent-2)); transform-origin: 0 50%; animation: drain linear forwards; }
.nub { position: absolute; right: -7px; bottom: 22px; width: 13px; height: 13px; background: var(--card); border: 1px solid var(--card-edge); border-left: 0; border-bottom: 0; transform: rotate(45deg); border-radius: 0 3px 0 0; }
.side-right .card .nub { right: auto; left: -7px; border: 1px solid var(--card-edge); border-right: 0; border-top: 0; border-radius: 0 0 0 3px; }
.kind-cheer .card { background: linear-gradient(165deg, var(--card), rgba(255,230,160,.5)); }
.head { display: flex; align-items: center; gap: 10px; margin: 2px 0 6px; }
.icon-chip { flex: none; width: 30px; height: 30px; border-radius: 10px; display: grid; place-items: center; color: var(--accent-ink); background: linear-gradient(145deg, var(--accent), var(--accent-2)); box-shadow: 0 4px 10px -2px var(--accent); }
.icon-chip svg { width: 17px; height: 17px; }
.title { margin: 0; flex: 1; font-weight: 700; font-size: 14.5px; letter-spacing: -.01em; }
.kind-cheer .title { font-size: 18px; background: linear-gradient(90deg, #f2a100, #ff6b81); -webkit-background-clip: text; background-clip: text; color: transparent; }
.x { flex: none; width: 24px; height: 24px; border-radius: 8px; border: 0; background: transparent; color: var(--muted); font-size: 17px; line-height: 1; cursor: pointer; }
.x:hover { background: var(--chip); color: var(--ink); }
.msg { margin: 0 0 10px; font-size: 14px; }
.msg.muted { color: var(--muted); }
.caret { display: inline-block; width: 2px; height: 1em; margin-left: 1px; vertical-align: -2px; background: var(--accent); animation: caret .8s steps(1) infinite; }
.chips { display: flex; flex-wrap: wrap; gap: 5px; margin: 0 0 10px; }
.chip svg { width: 13px; height: 13px; flex: none; }
.chip { white-space: nowrap; display: inline-flex; align-items: center; gap: 5px; padding: 2px 9px; border-radius: 999px; font-size: 11.5px; font-weight: 600; color: var(--btn-ink); background: var(--chip); }
.chip.quiet { font-weight: 500; color: var(--muted); }
.ladder { display: inline-flex; gap: 3px; margin-right: 2px; }
.ladder i { width: 14px; height: 5px; border-radius: 3px; background: var(--track); }
.ladder i.on { background: linear-gradient(90deg, var(--accent), var(--accent-2)); }
.gauge { height: 6px; border-radius: 4px; background: var(--track); overflow: hidden; margin: 0 0 4px; }
.gauge i { display: block; height: 100%; border-radius: 4px; background: linear-gradient(90deg, #3ddbd9, #f2a100 55%, #e5484d); transition: width .6s cubic-bezier(.2,1,.3,1); }
.gauge-label { margin: 0 0 10px; font-size: 11.5px; color: var(--muted); }
.shimmer { display: grid; gap: 7px; margin: 2px 0 12px; }
.shimmer i { display: block; height: 11px; border-radius: 6px; background: linear-gradient(90deg, var(--track) 25%, rgba(255,255,255,.55) 50%, var(--track) 75%); background-size: 200% 100%; animation: shimmer 1.2s linear infinite; }
.shimmer i:nth-child(2) { width: 82%; }
.shimmer i:nth-child(3) { width: 56%; }
.dots { display: flex; align-items: center; gap: 5px; margin: 4px 0 12px; color: var(--muted); font-size: 12.5px; }
.dots span { width: 7px; height: 7px; border-radius: 50%; background: var(--accent); animation: bounce 1s infinite; }
.dots span:nth-child(2) { animation-delay: .15s; }
.dots span:nth-child(3) { animation-delay: .3s; }
.dots em { margin-left: 4px; font-style: normal; }

/* ---------- buttons ---------- */
.row { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }
button.b { font: inherit; font-size: 13px; font-weight: 600; cursor: pointer; padding: 6px 13px; border-radius: 999px; border: 1px solid var(--btn-edge); background: var(--btn); color: var(--btn-ink); transition: transform .12s, box-shadow .12s, background .12s; }
button.b:hover { transform: translateY(-1px); box-shadow: 0 4px 10px -3px rgba(40,30,90,.3); }
button.b:active { transform: translateY(0) scale(.98); }
button.b.primary { color: var(--accent-ink); border-color: transparent; background: linear-gradient(135deg, var(--accent), var(--accent-2)); box-shadow: 0 5px 12px -4px var(--accent); }
button.b:disabled { opacity: .55; cursor: progress; transform: none; box-shadow: none; }
button.b:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
button.link { font: inherit; font-size: 12px; cursor: pointer; border: 0; background: none; padding: 6px 4px; color: var(--muted); text-decoration: underline; }

/* ---------- where it went wrong ---------- */
.where { margin: 0 0 10px; position: relative; border-radius: 12px; overflow: hidden; border: 1px solid var(--card-edge); background: var(--track); }
.where canvas { display: block; width: 100%; }
.where .msg { padding: 12px; margin: 0; }
.mark { position: fixed; z-index: 1; pointer-events: none; border-radius: 10px; border: 2px solid #ff4d5a; background: rgba(255,77,90,.1); box-shadow: 0 0 0 3px rgba(255,255,255,.75), 0 0 28px rgba(255,77,90,.55); animation: mark-in .5s cubic-bezier(.2,1.4,.4,1) both, mark-pulse 1.6s .5s ease-in-out infinite; }
.mark::before, .mark::after { content: ''; position: absolute; width: 14px; height: 14px; border: 3px solid #ff4d5a; }
.mark::before { left: -6px; top: -6px; border-right: 0; border-bottom: 0; border-radius: 8px 0 0 0; }
.mark::after { right: -6px; bottom: -6px; border-left: 0; border-top: 0; border-radius: 0 0 8px 0; }
.mark .tag { position: absolute; left: -2px; top: -30px; padding: 3px 10px; border-radius: 999px; background: #ff4d5a; color: #fff; font: 700 11.5px/1.3 ui-sans-serif, system-ui, sans-serif; letter-spacing: .02em; white-space: nowrap; box-shadow: 0 4px 10px rgba(229,72,77,.4); }
.mark .tag.below { top: auto; bottom: -30px; }

/* ---------- a clip ---------- */
.clip { margin: 0 0 10px; border-radius: 14px; overflow: hidden; border: 1px solid var(--card-edge); background: var(--chip); }
.thumb { position: relative; width: 100%; aspect-ratio: 16 / 9; background: linear-gradient(135deg, #2b2b3f, #4b3f8f); cursor: pointer; border: 0; padding: 0; display: block; }
.thumb canvas { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; }
.thumb .play { position: absolute; left: 50%; top: 50%; width: 46px; height: 46px; margin: -23px 0 0 -23px; border-radius: 50%; background: rgba(255,255,255,.94); display: grid; place-items: center; box-shadow: 0 6px 18px rgba(0,0,0,.35); transition: transform .15s; }
.thumb:hover .play { transform: scale(1.1); }
.thumb .play svg { width: 18px; height: 18px; margin-left: 3px; color: var(--accent); }
.thumb .stamp { position: absolute; right: 8px; bottom: 8px; padding: 2px 8px; border-radius: 6px; background: rgba(0,0,0,.78); color: #fff; font: 700 12px/1.4 ui-monospace, "SF Mono", Consolas, monospace; }
.clip .info { padding: 9px 11px 10px; }
.clip .why { margin: 0 0 2px; font-weight: 600; font-size: 13px; }
.clip .meta { margin: 0 0 8px; font-size: 11.5px; color: var(--muted); display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.clip .practice { margin: 8px 0 0; padding-left: 18px; font-size: 12px; }
.clip .practice a { color: var(--btn-ink); }

/* ---------- status pill and toast ---------- */
.status { position: fixed; right: 20px; bottom: 20px; display: flex; flex-direction: column; align-items: flex-end; gap: 6px; font: 12px/1.35 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; pointer-events: none; }
.toast { margin: 0; max-width: 270px; padding: 9px 13px; border-radius: 14px; background: rgba(29,26,46,.94); color: #fff; box-shadow: 0 10px 28px rgba(30,20,80,.32); pointer-events: auto; animation: toast-in .4s cubic-bezier(.2,1.3,.4,1) both; }
.pill { display: inline-flex; align-items: center; gap: 7px; padding: 4px 11px 4px 8px; font: inherit; font-weight: 600; cursor: pointer; pointer-events: auto; background: var(--card); backdrop-filter: blur(10px); border: 1px solid var(--card-edge); color: var(--btn-ink); border-radius: 999px; box-shadow: 0 4px 14px rgba(40,30,90,.18); }
.pill:hover { box-shadow: 0 6px 18px rgba(40,30,90,.26); }
.pill svg { flex: none; }
.pill .dot { width: 8px; height: 8px; border-radius: 50%; background: #6c5ce7; flex: none; animation: ping 2.4s infinite; }
.pill.ok .dot { background: #19b97a; }
.pill.warn .dot { background: #f08a3c; }
.confetti { position: fixed; inset: 0; width: 100vw; height: 100vh; pointer-events: none; z-index: 3; }

/* ---------- motion ---------- */
@keyframes breathe { 0%,100% { transform: translateY(0) } 50% { transform: translateY(-3px) } }
@keyframes shadow-bob { 0%,100% { transform: scale(1); opacity: 1 } 50% { transform: scale(.88); opacity: .75 } }
@keyframes tail-sway { 0%,100% { transform: rotate(-4deg) } 50% { transform: rotate(5deg) } }
@keyframes eyes-open { 0%,93%,98.5%,100% { opacity: 1 } 94%,98% { opacity: 0 } }
@keyframes eyes-shut { 0%,93%,98.5%,100% { opacity: 0 } 94%,98% { opacity: 1 } }
@keyframes swing-in { 0% { transform: translate(150%, 20px) rotate(24deg) scale(.8); opacity: 0 } 55% { transform: translate(-8%, -10px) rotate(-6deg); opacity: 1 } 78% { transform: translate(3%, 0) rotate(2deg) } 100% { transform: none; opacity: 1 } }
@keyframes fade-in { from { opacity: 0 } to { opacity: 1 } }
@keyframes tilt { 0%,100% { rotate: 0deg } 50% { rotate: -4deg } }
@keyframes jolt { 0% { transform: translateY(0) scale(1) } 30% { transform: translateY(-18px) scale(.94, 1.08) } 55% { transform: translateY(0) scale(1.08, .92) } 100% { transform: translateY(0) scale(1) } }
@keyframes tremble { 0%,100% { translate: 0 0 } 25% { translate: -1.2px .6px } 75% { translate: 1.2px -.6px } }
@keyframes hop { 0%,100% { transform: translateY(0) scale(1.06, .92) } 12% { transform: translateY(-4px) scale(.96, 1.06) } 50% { transform: translateY(-22px) rotate(-3deg) scale(.97, 1.04) } 88% { transform: translateY(-4px) scale(.98, 1.03) } }
@keyframes shadow-hop { 0%,100% { transform: scale(1.05); opacity: 1 } 50% { transform: scale(.62); opacity: .45 } }
@keyframes emote-pop { 0% { transform: scale(0) rotate(-30deg); opacity: 0 } 100% { transform: scale(1) rotate(0); opacity: 1 } }
@keyframes emote-bob { 0%,100% { transform: translateY(0) } 50% { transform: translateY(-4px) } }
@keyframes card-in { 0% { transform: translateY(14px) scale(.82); opacity: 0 } 100% { transform: none; opacity: 1 } }
@keyframes card-out { to { transform: translateY(10px) scale(.86); opacity: 0 } }
@keyframes hop-away { 0% { transform: none; opacity: 1 } 35% { transform: translateY(-14px) } 100% { transform: translate(60px, 18px) rotate(14deg) scale(.7); opacity: 0 } }
@keyframes toast-in { from { transform: translateY(12px) scale(.94); opacity: 0 } to { transform: none; opacity: 1 } }
@keyframes mark-in { from { transform: scale(1.12); opacity: 0 } to { transform: none; opacity: 1 } }
@keyframes mark-pulse { 0%,100% { box-shadow: 0 0 0 3px rgba(255,255,255,.75), 0 0 20px rgba(255,77,90,.4) } 50% { box-shadow: 0 0 0 3px rgba(255,255,255,.75), 0 0 36px rgba(255,77,90,.8) } }
@keyframes shine { to { transform: translateX(120%) } }
@keyframes shimmer { to { background-position: -200% 0 } }
@keyframes bounce { 0%,80%,100% { transform: translateY(0); opacity: .45 } 40% { transform: translateY(-5px); opacity: 1 } }
@keyframes caret { 50% { opacity: 0 } }
@keyframes ping { 0% { box-shadow: 0 0 0 0 color-mix(in srgb, var(--accent) 60%, transparent) } 70% { box-shadow: 0 0 0 9px transparent } 100% { box-shadow: 0 0 0 0 transparent } }
@keyframes drain { from { transform: scaleX(1) } to { transform: scaleX(0) } }

@media (max-width: 560px) { .dock { flex-direction: column !important; align-items: flex-end; } .card { max-width: calc(100vw - 24px); margin-bottom: 0; } }
@media (prefers-reduced-motion: reduce) {
  .avatar *, .card, .mark, .toast, .pill .dot, .badge, .shimmer i, .dots span, .fx .count, .fx .shine { animation: none !important; }
  .confetti { display: none; }
}
`;
