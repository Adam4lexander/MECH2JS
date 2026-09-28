// MW2SHELL.EXE unpacked by the port against decompiled/mw2shell/build/image.bin,
// byte for byte, and the shell's generated labels and structs checked against
// that image and the decompilation (phase S0: a second target).
import fs from 'node:fs';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { ExeImage } from '../../src/data/exe/ExeImage.ts';
import { SHELL_LABEL } from '../../src/generated/shell/labels.gen.ts';
import { STRUCTS as SHELL_STRUCTS } from '../../src/generated/shell/structs.gen.ts';
import * as ShellClasses from '../../src/generated/shell/classes.gen.ts';
import * as Mw2Classes from '../../src/generated/classes.gen.ts';
import { imageReader, setBootImage, imageI32 } from '../../src/engine/image.ts';
import { MW2_DECOMPILED, gameSource, hasShellData, hasShellDecompiled, readShellListing, shellBuildPath } from '../support/env.ts';

describe.runIf(hasShellData && hasShellDecompiled)('MW2SHELL.EXE image', () => {
  let exe: ExeImage;
  let layout: { entry_point: number; initial_esp: number; fixups: { off32: number }; objects: { name: string; base: number; virtual_size: number }[] };
  beforeAll(async () => {
    exe = ExeImage.fromExe(await gameSource().read('MW2SHELL.EXE'));
    layout = JSON.parse(fs.readFileSync(shellBuildPath('layout.json'), 'utf8'));
  });

  it('is byte-identical to build/image.bin', () => {
    const want = new Uint8Array(fs.readFileSync(shellBuildPath('image.bin')));
    expect(exe.low).toBe(0x10000);
    expect(exe.bytes.length).toBe(want.length);
    let first = -1;
    let count = 0;
    for (let i = 0; i < want.length; i++) {
      if (want[i] !== exe.bytes[i]) {
        if (first < 0) first = i;
        count++;
      }
    }
    expect({ first: first < 0 ? -1 : (first + exe.low).toString(16), count }).toEqual({ first: -1, count: 0 });
  });

  it('matches layout.json', () => {
    expect(exe.image.entryPoint).toBe(layout.entry_point);
    expect(exe.image.initialEsp).toBe(layout.initial_esp);
    expect(exe.image.fixups.off32).toBe(layout.fixups.off32);
    expect(exe.image.objects.map((o) => o.base)).toEqual(layout.objects.map((o) => o.base));
  });

  it('holds every SHELL_LABEL in its data object', () => {
    const data = layout.objects.find((o) => o.name === 'DATA')!;
    const outside = Object.entries(SHELL_LABEL).filter(([, a]) => a < data.base || a >= data.base + data.virtual_size);
    expect(outside).toEqual([]);
  });

  it('reads through its own image, not MW2.EXE', () => {
    setBootImage(exe, 'mw2shell');
    // opponentStarSkill: the shell's int the star writer starts the opponents' skill rows from
    expect(imageReader('mw2shell').i32(SHELL_LABEL.opponentStarSkill, -1)).toBe(exe.i32(SHELL_LABEL.opponentStarSkill));
    // MW2's accessors are untouched by a shell image
    expect(imageI32(0x12345678, 77)).toBe(77);
  });
});

describe.runIf(hasShellDecompiled)('shell structs', () => {
  it('generates one schema per struct in mw2shell_types.h', () => {
    const header = fs.readFileSync(path.join(MW2_DECOMPILED, 'mw2shell', 'include', 'mw2shell_types.h'), 'utf8');
    const names = [...header.matchAll(/^struct (\w+) \{$/gm)].map((m) => m[1]);
    expect(Object.keys(SHELL_STRUCTS)).toEqual(names);
  });

  it('shares a class with MW2 exactly where the layouts are the same', () => {
    const shared = Object.keys(SHELL_STRUCTS).filter(
      (n) => (ShellClasses as Record<string, unknown>)[n] === (Mw2Classes as Record<string, unknown>)[n],
    );
    expect(shared.sort()).toEqual(['ProjectDirEntry', 'ProjectDirectory', 'ProjectFile', 'ProjectHeader', 'ProjectTypeEntry', 'ProjectTypeSlot', 'SimOptions']);
    // same name, different struct: the shell's own class
    for (const n of ['MenuItem', 'MechSection', 'MissionObjectiveRecord']) {
      expect((ShellClasses as Record<string, unknown>)[n]).not.toBe((Mw2Classes as Record<string, unknown>)[n]);
    }
  });

  it('lists every shell function under its module', () => {
    // the listing the porting map checks @mw2shell tags against
    const csv = readShellListing('functions.csv').trim().split('\n');
    expect(csv[0]).toBe('address,name,module,group,evidence,size_bytes,num_params,callers,callees,strings,source_file');
    expect(csv.length - 1).toBeGreaterThan(1000);
  });
});
