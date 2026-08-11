import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

const SUITES = [
  'store.test.mjs',
  'poller.test.mjs',
  'prefix.test.mjs',
  'web.test.mjs',
  'ui.test.mjs'
];

let failed = 0;

for (const suite of SUITES) {
  console.log(`\n${'='.repeat(60)}\n  ${suite}\n${'='.repeat(60)}`);
  const code = await new Promise((resolve) => {
    spawn(process.execPath, [path.join(HERE, suite)], { stdio: 'inherit' }).on('exit', resolve);
  });
  if (code !== 0) {
    failed++;
    console.log(`\n>>> ${suite} FAILED (exit ${code})`);
  }
}

console.log(`\n${'='.repeat(60)}`);
if (failed) {
  console.log(`${failed} of ${SUITES.length} suite(s) failed`);
  process.exit(1);
}
console.log(`All ${SUITES.length} suites passed`);
