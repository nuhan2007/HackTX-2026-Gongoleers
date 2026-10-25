// The myTA mark: the light brown pixel book (the same art as the toolbar icon) and the myTA.tech wordmark.
const ROWS = [
  '................',
  '..OOOOOOOOOOOO..',
  '.OHSSCCCCCCCCCO.',
  '.OHSSCCCCCCCCcO.',
  '.OHSSCOOOOOOCcO.',
  '.OHSSCOGGGGOCcO.',
  '.OHSSCOGggGOCcO.',
  '.OHSSCOGGGGOCcO.',
  '.OHSSCOOOOOOCcO.',
  '.OHSSCCCCCCCCcO.',
  '.OHSSCCCCCCCCcO.',
  '.OOOOOOOOOOOOOO.',
  '..OPPPPPPPPPPpO.',
  '..OppppppppppRO.',
  '...OOOOOOOOOORO.',
  '.............RR.',
];
const COLORS: Record<string, string> = { O: '#54341c', H: '#f0ce96', C: '#d9a566', c: '#be874e', S: '#a06c3c', P: '#fff6dc', p: '#e8d4a8', R: '#e0524d', G: '#ffe08c', g: '#d6aa46' };

const PATHS = (() => {
  const by = new Map<string, string>();
  ROWS.forEach((row, y) => {
    let x = 0;
    while (x < row.length) {
      const ch = row[x];
      let end = x + 1;
      while (end < row.length && row[end] === ch) end++;
      if (ch !== '.') by.set(ch, `${by.get(ch) ?? ''}M${x} ${y}h${end - x}v1h${-(end - x)}z`);
      x = end;
    }
  });
  return [...by].map(([ch, d]) => ({ color: COLORS[ch], d }));
})();

export function BookLogo({ size = 28 }: { size?: number }) {
  return (
    <svg className="book-logo" width={size} height={size} viewBox="0 0 16 16" shapeRendering="crispEdges" aria-hidden="true">
      {PATHS.map((p) => (
        <path key={p.color} d={p.d} fill={p.color} />
      ))}
    </svg>
  );
}

/** The book and the name. `tagline` adds a line under it (setup page). */
export function Brand({ size = 28, tagline }: { size?: number; tagline?: string }) {
  return (
    <div className="brand">
      <BookLogo size={size} />
      <div className="brand-text">
        <strong>
          myTA<span className="tld">.tech</span>
        </strong>
        {tagline && <span className="tagline">{tagline}</span>}
      </div>
    </div>
  );
}
