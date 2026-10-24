// Checks the per-pixel layer tags against the known layout in layers.bin
// (built by make_layers_rom.py).
import { readFileSync } from 'fs';
import { Core } from '../web/core.js';

const core = await Core.create(readFileSync(new URL('../web/core.wasm', import.meta.url)), { log: () => {} });
core.vfs.addBytes('/layers.bin', new Uint8Array(readFileSync(new URL('./layers.bin', import.meta.url))));
core.load('/layers.bin');
for (let i = 0; i < 10; i++) core.run();

const f = core.frame(), t = core.tags();
const at = (x, y) => t[y * f.w + x];
const checks = [
  ['plane B background', 10, 10, 1],
  ['plane A band', 200, 100, 4],
  ['sprite above band', 103, 61, 7],
  ['sprite overlapping high-priority band', 103, 66, 4],
  ['plane B below band', 10, 200, 1],
];
let ok = true;
for (const [name, x, y, want] of checks) {
  const got = at(x, y), pass = got === want; ok &&= pass;
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}: tag ${got} (want ${want})`);
}
const hist = {}; for (const v of t) hist[v] = (hist[v] || 0) + 1;
console.log(`frame ${f.w}x${f.h}, tag counts`, hist);
process.exit(ok ? 0 : 1);
