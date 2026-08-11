import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let failures = 0;

export function check(label, cond, extra = '') {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? ` — ${extra}` : ''}`);
  if (!cond) failures++;
}

export function note(text) {
  console.log(`      ${text}`);
}

/** Isolated CONFIG_DIR. Must be called before importing store.js. */
export function tmpConfigDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'fihas-test-'));
}

export function finish() {
  if (failures) {
    console.log(`\n${failures} FAILURE(S)`);
    process.exit(1);
  }
  console.log('\nAll checks passed');
  process.exit(0);
}
