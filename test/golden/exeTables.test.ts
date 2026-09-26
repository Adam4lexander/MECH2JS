// Static tables read out of MW2.EXE by the port, printed the way the
// decompilation's dump tools print them, compared line by line.
import { beforeAll, describe, it } from 'vitest';
import { ExeImage } from '../../src/data/exe/ExeImage.ts';
import { readWeaponTypes, WEAPON_COUNT, WEAPON_TABLE } from '../../src/data/exe/tables/weaponTypes.ts';
import { PROJECT_KEYWORDS, PROJECT_TAG_COUNT, PROJECT_TAGS, readProjectTags } from '../../src/data/exe/tables/projectTags.ts';
import { gameSource, hasDecompiled, hasGameData, readListing } from '../support/env.ts';
import { expectSameLines, lines, padL, padR } from '../support/listing.ts';

const hex8 = (v: number) => v.toString(16).padStart(8, '0');

describe.runIf(hasGameData && hasDecompiled)('EXE tables', () => {
  let exe: ExeImage;
  beforeAll(async () => {
    exe = ExeImage.fromExe(await gameSource().read('MW2.EXE'));
  });

  it('weapons.txt (tools/dump_weapon_table.py)', () => {
    const w = readWeaponTypes(exe);
    // [field offset, heading, render] in the dump tool's column order.
    type Row = (typeof w)[number];
    const F: [string, (r: Row) => string][] = [
      ['shots', (r) => String(r.shots)],
      ['ammo/ton', (r) => (r.ammoPerTon < 0 ? '-' : String(r.ammoPerTon))],
      ['speed', (r) => String(r.projectileSpeed)],
      ['m/s', (r) => (r.projectileSpeed * 1.82).toFixed(1)],
      ['damage', (r) => String(r.damage)],
      ['heat', (r) => (r.heat / 65536).toFixed(3)],
      ['minRange', (r) => String(r.minRange)],
      ['maxRange', (r) => String(r.maxRange)],
      ['max m', (r) => (r.maxRange / 100).toFixed(1)],
      ['reload', (r) => String(r.reload)],
      ['guided', (r) => (r.guided ? 'yes' : '')],
      ['projKind', (r) => String(r.projectileKind)],
      ['impactFx', (r) => String(r.impactEffect)],
      ['muzzleFx0', (r) => String(r.muzzleEffects[0])],
      ['muzzleFx1', (r) => String(r.muzzleEffects[1])],
      ['launches', (r) => (r.launchesProjectile ? 'yes' : '')],
      ['gravScale', (r) => String(r.gravityScale)],
      ['heatOnHit', (r) => (r.heatOnHit / 65536).toFixed(3)],
      ['flight', (r) => String(r.flightTime)],
      ['shotGap', (r) => String(r.shotGap)],
      ['fireSound', (r) => String(r.fireSound)],
      ['autoRep', (r) => (r.autoRepeat ? 'yes' : '')],
    ];
    const out: string[] = [];
    out.push(`MW2 weapon table - ${WEAPON_COUNT} entries at ${hex8(WEAPON_TABLE)}, stride 0x58`);
    out.push('');
    let head = padR('id', 3) + ' ' + padR('name', 8);
    for (const [h] of F) head += padL(h, 10);
    out.push(head);
    out.push('-'.repeat(head.length));
    w.forEach((r, i) => {
      let line = padR(i, 3) + ' ' + padR(r.name, 8);
      for (const [, f] of F) line += padL(f(r), 10);
      out.push(line);
    });
    // The dump tool's first table only; the "not yet identified" section
    // prints the WeaponType offsets the schema now names, so it is skipped.
    const want = lines(readListing('weapons.txt'));
    expectSameLines('weapons.txt', want.slice(0, out.length), out);
  });

  it('project_tags.txt (tools/dump_project_tags.py)', () => {
    const tags = readProjectTags(exe);
    const out = [
      `MW2 project-file vocabulary - ${PROJECT_TAG_COUNT} entries`,
      `tags at ${hex8(PROJECT_TAGS)}, keywords at ${hex8(PROJECT_KEYWORDS)}, paired by project_tag_to_keyword`,
      '',
      `${padR('id', 3)} ${padR('tag', 6)} keyword`,
      '-'.repeat(40),
      ...tags.map((t) => `${padR(t.id, 3)} ${padR(t.tag, 6)} ${t.keyword}`),
    ];
    expectSameLines('project_tags.txt', lines(readListing('project_tags.txt')), out);
  });
});
