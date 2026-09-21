// Scale benchmark: synthesize a 500-claim repo, measure hot paths.
// Run: node test/bench.js
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { State } from '../src/state.js';
import { doctor } from '../src/doctor.js';
import { brief } from '../src/brief.js';
import { verify } from '../src/verify.js';
import { selectForDiff } from '../src/diff.js';
import { loadManual } from '../src/claims.js';
import { changedFiles } from '../src/diff.js';

const N = Number(process.env.MANUAL_BENCH_N || 500);

function buildSynthetic(root, n) {
  fs.mkdirSync(path.join(root, '.manual', 'claims'), { recursive: true });
  fs.mkdirSync(path.join(root, 'src', 'mod'), { recursive: true });
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'bench', type: 'module', scripts: { test: 'node --test' } }));
  fs.writeFileSync(path.join(root, 'src', 'mod', 'code.js'), 'export const x = 1;\n');
  for (let i = 0; i < n; i++) {
    const id = `bench.claim${String(i).padStart(4, '0')}`;
    const isTrap = i % 25 === 0;
    const isPolicy = i % 50 === 0;
    const kind = isTrap ? 'trap' : isPolicy ? 'policy' : 'fact';
    const check = isTrap
      ? '  expr: exists("src/mod/code.js")'
      : isPolicy
        ? '  expr: manifest("package.json").name === "bench"'
        : '  expr: nodeMajor() >= 20';
    const dep = i >= 3 ? `depends_on:\n  - id: bench.claim${String(i - 3).padStart(4, '0')}\n    required: true\n` : '';
    fs.writeFileSync(
      path.join(root, '.manual', 'claims', `${id}.md`),
      `---\nschema: manual/v1\nid: ${id}\nkind: ${kind}\nstatement: Synthetic claim ${i} for the scale benchmark.\npriority: normal\napplies_to:\n  - "src/**"\nevidence:\n  files:\n    - "src/mod/**"\n${dep}check:\n${check}\nverify: on_change\nprovenance:\n  author: bench\n  origin: observed\n  evidence: synthetic\nlifecycle: accepted\n---\nSynthetic claim ${i} for the scale benchmark.\n`,
    );
  }
}

const time = async (label, fn) => {
  const t0 = performance.now();
  const out = await fn();
  const ms = Math.round(performance.now() - t0);
  console.log(`${label.padEnd(34)} ${String(ms).padStart(7)}ms`);
  return { ms, out };
};

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'manual-bench-'));
buildSynthetic(root, N);
console.log(`synthetic repo: ${N} claims, shared evidence glob (src/mod/**)\n`);

const state = new State(root);
await time('loadManual (parse 500 claims)', async () => loadManual(root));
await time('doctor (500 digests)', async () => doctor(root, state));
await time('brief (10 files in scope)', async () => brief(root, Array.from({ length: 10 }, (_, i) => `src/mod/f${i}.ts`), { state, budget: 2000, quiet: true }));
const { ms: diffMs, out: diffOut } = await time('verify --diff selection (no stamp)', async () => {
  const { claims } = loadManual(root);
  return selectForDiff(claims, ['src/mod/code.js']).length;
});
console.log(`${'  → claims selected'.padEnd(34)} ${String(diffOut).padStart(7)}`);
const { out: verifyOut } = await time('verify --force (500 expr checks)', async () => {
  const res = await verify(root, { state, force: true });
  return res.results.filter((r) => r.stamp.state === 'fresh').length;
});
console.log(`${'  → fresh'.padEnd(34)} ${String(verifyOut).padStart(7)}`);
const { ms: warmMs } = await time('verify (warm: digest skip)', async () => {
  const res = await verify(root, { state, force: false });
  return res.results.filter((r) => r.skipped).length;
});
console.log(`${'  → skipped'.padEnd(34)} ${String(warmMs).padStart(7)}`);
await time('verify --diff full run', async () => verify(root, { state, diff: true }));

fs.rmSync(root, { recursive: true, force: true });
console.log('\nbench complete');
