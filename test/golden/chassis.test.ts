// Every MEK chassis record in MW2.PRJ parsed by the port, printed the way
// tools/dump_chassis.py prints it and compared with listing/chassis.txt; and
// the loose MEK\*.MEK user variants parsed with the same parser and checked
// to tile to the byte.
import fs from 'node:fs';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { ExeImage } from '../../src/data/exe/ExeImage.ts';
import { readWeaponTypes } from '../../src/data/exe/tables/weaponTypes.ts';
import { ProjectFile } from '../../src/data/prj/ProjectFile.ts';
import { MEK_HEADER_SIZE, MEK_MOUNT_SIZE, MEK_TRAILER_SIZE, parseMek } from '../../src/data/formats/mek.ts';
import { gameSource, hasDecompiled, hasGameData, MW2_ROOT, readListing } from '../support/env.ts';
import { expectSameLines, lines, padL, padR } from '../support/listing.ts';
import { pyFixed } from '../support/formatHelpers.ts';

// dump_chassis.py's EQUIPMENT (names from MW2SHELL.EXE's item table) and ROLE
const EQUIPMENT: Record<number, string> = {
  5000: 'MASC', 5050: 'targ-comp', 5100: 'ECM', 5150: 'artemis', 5200: 'beagle', 5250: 'TAG',
  5300: 'shoulder', 5350: 'upper-arm', 5400: 'lower-arm', 5450: 'hand',
  5500: 'hip', 5550: 'upper-leg', 5600: 'lower-leg', 5650: 'foot',
  5700: 'sensors', 5750: 'cockpit', 5800: 'gyro', 5850: 'engine',
  5900: 'life-sup', 6000: 'heatsink', 7000: 'jumpjet', 8000: 'endo-steel', 9000: 'ferro-fib',
};
const ROLE = ['', 'head', 'RT', 'CT', 'LT', 'RA', 'LA', 'RL', 'LL'];

function slotName(code: number, weapons: string[]): string | null {
  if (code === 0) return null;
  const t = Math.floor(code / 100);
  if (t === 100) return `ammo:${weapons[0] ?? 'wpn0'}(inert)`;
  if (code >= 6000 && code < 7000 && Math.floor(code / 10) * 10 !== 6000) return 'heatsink(inert)';
  if (t > 100) {
    const w = Math.floor((code - 10000) / 100);
    return 'ammo:' + (w >= 0 && w < weapons.length ? weapons[w] : String(code));
  }
  if (t < 50) return t < weapons.length ? weapons[t]! : `wpn${t}`;
  return EQUIPMENT[Math.floor(code / 10) * 10] ?? String(code);
}
const pyStr = (v: string | null) => v ?? 'None';

describe.runIf(hasGameData && hasDecompiled)('MEK chassis', () => {
  let prj: ProjectFile;
  let weapons: string[];
  beforeAll(async () => {
    prj = new ProjectFile(await gameSource().read('MW2.PRJ'));
    weapons = readWeaponTypes(ExeImage.fromExe(await gameSource().read('MW2.EXE'))).map((w) => w.name);
  });

  it('chassis.txt corresponds', () => {
    const L: string[] = [];
    let n = 0;
    const t = prj.type('MEK')!;
    for (let id = 0; id < t.entries.length; id++) {
      const name = prj.resourceName('MEK', id);
      if (!name) continue;
      const m = parseMek(prj.readResource('MEK', id)!);
      if (!m) continue;
      n++;
      const { tons, moveSpeed: move, jump, heatSinks, numWeapons: nw, numAmmo: na } = m.chassis;
      const speed = `${pyFixed(move * 10.8, 1)} kph`;
      const thrust = move > 0 && jump > 0 ? `${pyFixed((4.0 * jump) / move, 2)} g` : 'none';
      L.push(`${name} (MEK ${id})  ${tons} t  move ${move} = ${speed}  jump ${jump} = thrust ${thrust}  heat sinks ${heatSinks}  weapons ${nw}  ammo bins ${na}`);
      m.chassis.sections.forEach((s, i) => {
        const names = s.slots.slice(0, Math.max(0, Math.min(s.numSlots, 12))).map((x) => slotName(x, weapons));
        L.push(
          `  loc${i + 1} ${padR(ROLE[i + 1]!, 6)} armour ${padL(s.armorFront, 3)} front ${padL(s.armorRear, 3)} rear  internal ${padL(s.internal, 3)}  ${names.filter((x) => x).join(' ')}`,
        );
      });
      m.weapons.forEach((w, i) => {
        L.push(`  weapon ${i}  ${padR(pyStr(slotName(w.slotCode, weapons)), 7)} code ${padL(w.slotCode, 4)}  location ${w.location >= 0 ? w.location : 'from slots'}`);
      });
      m.ammo.forEach((a, i) => {
        L.push(`  ammo   ${i}  class ${padL(a.binCode, 4)}  feeds code ${padL(a.weaponCode, 4)} (${pyStr(slotName(a.weaponCode, weapons))})`);
      });
      L.push('');
      // every resource tiles: header, mounts, bins, the 50-byte trailer
      expect(m.end + MEK_TRAILER_SIZE, name).toBe(prj.readResource('MEK', id)!.length);
    }
    L.unshift(`MW2 mech chassis - MW2.PRJ, ${n} MEK records`, '');
    expectSameLines('chassis.txt', lines(readListing('chassis.txt')), L);
  });

  const mekDir = path.join(MW2_ROOT, 'MEK');
  it.runIf(fs.existsSync(mekDir))('loose MEK\\*.MEK user variants parse with the same layout and tile to the byte', () => {
    const files = fs.readdirSync(mekDir).filter((f) => /\.mek$/i.test(f));
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) {
      const c = new Uint8Array(fs.readFileSync(path.join(mekDir, f)));
      const m = parseMek(c)!;
      expect(m, f).not.toBeNull();
      const { numWeapons, numAmmo, tons } = m.chassis;
      expect(numWeapons, f).toBeLessThanOrEqual(10);
      expect(m.weapons.length, f).toBe(numWeapons);
      expect(m.ammo.length, f).toBe(numAmmo);
      expect(MEK_HEADER_SIZE + (numWeapons + numAmmo) * MEK_MOUNT_SIZE + MEK_TRAILER_SIZE, f).toBe(c.length);
      expect(tons, f).toBeGreaterThan(0);
      // every mount's code names a weapon, and every bin feeds a mounted weapon
      for (const w of m.weapons) expect(Math.floor(w.slotCode / 100), f).toBeLessThan(weapons.length);
      const codes = new Set(m.weapons.map((w) => w.slotCode));
      for (const a of m.ammo) expect(codes.has(a.weaponCode), `${f} bin ${a.binCode}`).toBe(true);
      expect(m.trailerText, f).toMatch(/^User Variant #\d+$/);
    }
  });
});
