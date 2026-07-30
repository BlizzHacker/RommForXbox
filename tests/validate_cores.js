/* Checks every EJS_CORES value against the systems EmulatorJS actually has, and
 * reports platforms in a real library that nothing is mapped for.
 *
 * An invalid core name is the worst kind of bug here: the platform looks playable,
 * the grid loads, and the game fails only when the user presses A. Game Boy Color
 * shipped that way — mapped to a core called "gbc", which does not exist.
 *
 * The system list comes from EmulatorJS itself (emulator.min.js getCores()), not
 * from documentation:
 *   node tests/validate_cores.js [platforms.json]
 */
'use strict';
const fs = require('fs');
const path = require('path');

// EmulatorJS 4.x systems, extracted from getCores() in emulator.min.js.
const EJS_SYSTEMS = new Set([
  '3do', 'amiga', 'arcade', 'atari2600', 'atari5200', 'atari7800', 'c128',
  'c64', 'coleco', 'dos', 'gb', 'gba', 'jaguar', 'lynx', 'mame', 'n64', 'nds',
  'nes', 'ngp', 'pce', 'pcfx', 'pet', 'plus4', 'psp', 'psx', 'sega', 'sega32x',
  'segaCD', 'segaGG', 'segaMD', 'segaMS', 'segaSaturn', 'snes', 'vb', 'vic20',
  'ws',
]);

const appJs = fs.readFileSync(
  path.join(__dirname, '..', 'app.js'), 'utf8');
const blob = appJs.split('const EJS_CORES = {')[1].split('};')[0];
const pairs = [...blob.matchAll(
  /(?:^\s*|[,{]\s*)'?([A-Za-z0-9_-]+)'?\s*:\s*'([A-Za-z0-9_]+)'/gm)]
  .map(m => [m[1], m[2]]);

let bad = 0;
const invalid = [];
for (const [slug, core] of pairs) {
  if (!EJS_SYSTEMS.has(core)) { invalid.push([slug, core]); bad++; }
}

console.log(`${pairs.length} slug->core mappings in app.js`);
console.log(`${EJS_SYSTEMS.size} systems EmulatorJS actually supports\n`);

if (invalid.length) {
  console.log('INVALID core names — these platforms fail at launch, not at browse:');
  for (const [slug, core] of invalid) {
    console.log(`  ${slug.padEnd(38)} -> '${core}'  (no such EmulatorJS system)`);
  }
} else {
  console.log('every mapped core name is a real EmulatorJS system');
}

const platsFile = process.argv[2];
if (platsFile && fs.existsSync(platsFile)) {
  const plats = JSON.parse(fs.readFileSync(platsFile, 'utf8'));
  const mapped = new Set(pairs.map(p => p[0]));
  const rows = plats
    .map(p => [p.rom_count || 0, p.slug, p.name])
    .filter(([n, s]) => n > 0 && !mapped.has(s))
    .sort((a, b) => b[0] - a[0]);
  let tot = 0;
  console.log('\nplatforms in the library with NO EmulatorJS mapping:');
  for (const [n, s, name] of rows) {
    console.log(`  ${String(n).padStart(6)}  ${String(s).padEnd(30)}${name}`);
    tot += n;
  }
  console.log(`\n  ${tot} games not playable on the console itself`);

  const brokenCount = plats
    .filter(p => invalid.some(([s]) => s === p.slug))
    .reduce((a, p) => a + (p.rom_count || 0), 0);
  if (brokenCount) {
    console.log(`  ${brokenCount} games in platforms that LOOK playable but cannot launch`);
  }
}

process.exit(bad ? 1 : 0);
