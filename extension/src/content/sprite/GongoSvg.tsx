// Placeholder character. To use a sprite from a free asset pack instead, drop the PNG in
// public/sprite/ (already web-accessible) and render <img src={chrome.runtime.getURL('sprite/gongo.png')} />.
export function GongoSvg() {
  return (
    <svg viewBox="0 0 100 100" aria-hidden="true">
      <ellipse cx="50" cy="56" rx="40" ry="38" fill="#6c5ce7" />
      <ellipse cx="50" cy="66" rx="24" ry="20" fill="#a29bfe" />
      <path d="M22 26 L30 8 L40 22 Z M78 26 L70 8 L60 22 Z" fill="#6c5ce7" />
      <circle cx="36" cy="46" r="12" fill="#fff" />
      <circle cx="64" cy="46" r="12" fill="#fff" />
      <circle cx="38" cy="47" r="5" fill="#1f1d2b">
        <animate attributeName="r" values="5;5;0.6;5" keyTimes="0;0.92;0.96;1" dur="4s" repeatCount="indefinite" />
      </circle>
      <circle cx="62" cy="47" r="5" fill="#1f1d2b">
        <animate attributeName="r" values="5;5;0.6;5" keyTimes="0;0.92;0.96;1" dur="4s" repeatCount="indefinite" />
      </circle>
      <path d="M44 60 L50 66 L56 60 Z" fill="#fdcb6e" />
      <text x="80" y="22" fontSize="20" fontWeight="bold" fill="#fdcb6e">?</text>
    </svg>
  );
}
