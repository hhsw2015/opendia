#!/usr/bin/env node
// Phase 0 back-to-back diff. Re-runs tools/schema extraction against the
// current tree and compares to tests/opendia/baseline-tool-schemas.json.
// Exit 0 = safe to ship (schemas match). Exit 1 = drift, print JSON diff.
//
// Every later phase (WXT migration, sidepanel, Cebian import) must keep
// this exiting 0 unless the SPEC explicitly amends the baseline.
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const BASELINE = resolve(ROOT, 'tests/opendia/baseline-tool-schemas.json');
const DUMPER = resolve(ROOT, 'tests/opendia/dump-tool-schemas.mjs');

if (!existsSync(BASELINE)) {
  console.error(`missing baseline: ${BASELINE}`);
  console.error('run: node tests/opendia/dump-tool-schemas.mjs > tests/opendia/baseline-tool-schemas.json');
  process.exit(2);
}

const currentRaw = execFileSync(process.execPath, [DUMPER], { encoding: 'utf8' });
const current = JSON.parse(currentRaw);
const baseline = JSON.parse(readFileSync(BASELINE, 'utf8'));

const drift = diffTools(baseline, current);
if (drift.length === 0) {
  console.log(`ok — ${current.tool_count} tools match baseline`);
  process.exit(0);
}

console.error(`DRIFT: ${drift.length} finding(s)`);
for (const d of drift) console.error(`  · ${d}`);
process.exit(1);

function diffTools(a, b) {
  const out = [];
  if (a.tool_count !== b.tool_count) out.push(`tool_count ${a.tool_count} → ${b.tool_count}`);
  const aByName = new Map(a.tools.map((t) => [t.name, t]));
  const bByName = new Map(b.tools.map((t) => [t.name, t]));
  for (const name of aByName.keys()) if (!bByName.has(name)) out.push(`removed: ${name}`);
  for (const name of bByName.keys()) if (!aByName.has(name)) out.push(`added: ${name}`);
  for (const [name, aTool] of aByName) {
    const bTool = bByName.get(name);
    if (!bTool) continue;
    const aj = JSON.stringify(aTool.inputSchema);
    const bj = JSON.stringify(bTool.inputSchema);
    if (aj !== bj) out.push(`schema drift: ${name}`);
  }
  return out;
}
