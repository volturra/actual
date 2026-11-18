// Bundles each workload into one self-contained ES2020 script per iteration
// count, so every engine and compiler sees byte-identical input.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { build } from 'esbuild';

const here = path.dirname(fileURLToPath(import.meta.url));

export const WORKLOADS = [
  'crdt',
  'protobuf',
  'arithmetic',
  'months',
  'transactions',
  'rules',
  'templates',
  'graph',
  'gc',
];
const counts = JSON.parse(readFileSync(path.join(here, 'counts.json'), 'utf8'));
const ITERS = Number(process.env.ITERS ?? 4);

// Regenerate the goal-template parser the same way loot-core's build does.
execFileSync(path.join(here, '../../node_modules/.bin/peggy'), [
  '--format',
  'es',
  '-o',
  path.join(here, 'workloads/goal-template.generated.js'),
  path.join(
    here,
    '../../packages/loot-core/src/server/budget/goal-template.pegjs',
  ),
]);

for (const wl of WORKLOADS) {
  for (const [tag, n, iters] of [
    ['n0', 0, 1],
    ['run', counts[wl], ITERS],
  ]) {
    await build({
      entryPoints: [path.join(here, 'entry.ts')],
      bundle: true,
      format: 'iife',
      platform: 'neutral',
      target: 'es2020',
      conditions: ['api'],
      mainFields: ['module', 'main'],
      outfile: path.join(here, 'out', `${wl}.${tag}.js`),
      define: {
        __N__: String(n),
        __ITERS__: String(iters),
        __WL__: JSON.stringify(wl),
      },
      alias: {
        workload: path.join(here, 'workloads', `${wl}.ts`),
        uuid: path.join(here, 'shims', 'uuid.ts'),
        '#platform/server/log': path.join(here, 'shims', 'log.ts'),
      },
      external: ['fs'], // handlebars' require.extensions hook only; never called
      logLevel: 'warning',
      legalComments: 'none',
    });
  }
}
