// npm run evaluate -- [dir-or-files...]
// Reads label-mode exports (default: ../label-logs/*.json), grid-searches threshold × duration,
// prints the best configs, and writes the winner to src/shared/evalResults.json for the Stats page.
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { LabelLog } from '../src/background/labelLogger';
import { NORMAL_TRIGGER } from '../src/shared/constants';
import { evaluate, gridSearch } from './evalLib';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const inputs = args.length ? args : [resolve(root, '../label-logs')];

const files = inputs.flatMap((p) =>
  statSync(p).isDirectory() ? readdirSync(p).filter((f) => f.endsWith('.json')).map((f) => join(p, f)) : [p],
);
const logs: LabelLog[] = files.map((f) => JSON.parse(readFileSync(f, 'utf8'))).filter((l) => l?.ticks?.length);
if (!logs.length) {
  console.error(`No label logs found in ${inputs.join(', ')}. Export them from the options page (label mode).`);
  process.exit(1);
}
console.log(`${logs.length} sessions, ${logs.reduce((a, l) => a + l.labels.length, 0)} "stuck" labels, ${logs.reduce((a, l) => a + l.ticks.length, 0)} ticks\n`);

const pct = (x: number) => `${(x * 100).toFixed(0)}%`.padStart(5);
const results = gridSearch(logs);
console.log('threshold  duration  triggers  precision  recall  lead(s)  F0.5');
for (const r of results.slice(0, 10)) {
  console.log(
    `${String(r.threshold).padStart(9)}  ${String(r.durationSec + 's').padStart(8)}  ${String(r.triggers).padStart(8)}  ${pct(r.precision).padStart(9)}  ${pct(r.recall).padStart(6)}  ${r.medianLeadSec.toFixed(0).padStart(7)}  ${r.f05.toFixed(2)}`,
  );
}
const current = evaluate(logs, NORMAL_TRIGGER.threshold, NORMAL_TRIGGER.durationSec);
console.log(`\nCurrent default (${current.threshold}, ${current.durationSec}s): precision ${pct(current.precision)}, recall ${pct(current.recall)}`);

const best = results[0];
const outPath = join(root, 'src/shared/evalResults.json');
const existing = JSON.parse(readFileSync(outPath, 'utf8'));
existing.trigger = {
  precision: best.precision,
  recall: best.recall,
  medianLeadSec: best.medianLeadSec,
  sessions: logs.length,
  threshold: best.threshold,
  durationSec: best.durationSec,
  generatedAt: new Date().toISOString(),
};
writeFileSync(outPath, JSON.stringify(existing, null, 2) + '\n');
console.log(`\nBest: threshold ${best.threshold}, ${best.durationSec}s → wrote ${outPath}`);
console.log('Update NORMAL_TRIGGER in src/shared/constants.ts if you want these as the new defaults.');
