// After `vite build` (the extension) and `vite build -c vite.content.config.ts` (the content script as one classic file):
// point the manifest's content script at dist/content.js and drop the CRXJS loader and the web-accessible module chunks it needed.
// Why: see vite.content.config.ts.
import fs from 'node:fs';
import path from 'node:path';

const dist = path.resolve(process.argv[2] ?? 'dist');
const manifestPath = path.join(dist, 'manifest.json');
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
if (!fs.existsSync(path.join(dist, 'content.js'))) throw new Error('dist/content.js is missing: run the content build first.');

const isLoader = (f) => /(^|\/)index\.tsx-loader[^/]*\.js$/.test(f);
const remove = new Set();
for (const cs of manifest.content_scripts ?? []) {
  cs.js = (cs.js ?? []).map((f) => {
    if (!isLoader(f)) return f;
    remove.add(f);
    return 'content.js';
  });
}
// The content script's own module chunks were made web-accessible so the loader could import them. Nothing imports them now.
for (const w of manifest.web_accessible_resources ?? []) {
  w.resources = w.resources.filter((r) => {
    if (/^assets\/index\.tsx-[^/]*\.js$/.test(r)) {
      remove.add(r);
      return false;
    }
    return !/^assets\/.*\.js$/.test(r) || !/^assets\/client-/.test(r);
  });
}
manifest.web_accessible_resources = (manifest.web_accessible_resources ?? []).filter((w) => w.resources.length > 0);

for (const f of remove) fs.rmSync(path.join(dist, f), { force: true });
fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
console.log(`manifest: content script → content.js; removed ${[...remove].join(', ') || 'nothing'}`);
