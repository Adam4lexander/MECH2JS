// Phase S8: the cockpit controls configuration and its INPUT.MAP writer,
// and the port's own controls files. The install's INPUT.MAP, GAMEKEY.MAP
// and giddi\*.CPC are read here only as expected output: at run time the
// port writes its own (shell/controls/seed.ts).
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { ExeImage } from '../../src/data/exe/ExeImage.ts';
import { ProjectFile } from '../../src/data/prj/ProjectFile.ts';
import { dosFileLoad, dosFileWrite, dosFiles, setDosFiles, setOverlayFiles, setOwnFiles } from '../../src/engine/dosFiles.ts';
import { resetAllGlobals } from '../../src/engine/globals.ts';
import { setBootImage } from '../../src/engine/image.ts';
import { SHELL_LABEL } from '../../src/generated/shell/labels.gen.ts';
import { startShellProcess } from '../../src/shell/boot.ts';
import { mem } from '../../src/shell/memory.ts';
import { inputDeviceGet, inputDeviceCount } from '../../src/shell/controls/devices.ts';
import {
  BINDING_COUNT,
  bindingAt,
  bindingField,
  configFileName,
  controlsConfigName,
  controlsDeviceChosen,
  controlsKeyboardDevice,
  controlsLoadConfig,
  controlsResetDefaults,
  controlsSaveConfigFile,
  controlsScreenSetup,
  CONTROLS,
  deviceRecord,
} from '../../src/shell/controls/config.ts';
import { controlMapName, controlsAcceptConfigFiles, controlsWriteTempMap } from '../../src/shell/controls/inputMap.ts';
import { controlsDeviceRow, controlsToggleDevice } from '../../src/shell/controls/panel.ts';
import { KEYBOARD_PROFILE, MOUSE_PROFILE, profileToCpc } from '../../src/shell/controls/profiles.ts';
import { seedControlFiles } from '../../src/shell/controls/seed.ts';
import { gamekeyBindings, gamekeyMapBytes } from '../../src/sim/controls/gamekeyMap.ts';
import { input, inputLoadGamekeys } from '../../src/sim/controls/input.ts';
import { gameSource, hasGameData, hasShellData, installShellFixtures, MW2_ROOT } from '../support/env.ts';

const hex = (b: Uint8Array | null | undefined) => (b ? Array.from(b, (x) => x.toString(16).padStart(2, '0')).join(' ') : 'null');
const text = (b: Uint8Array | null) => (b ? String.fromCharCode(...b) : 'null');

/** the drivers: the disk's read-only layer, as app/gameData.ts supplies it */
function giddiAssets(): Map<string, Uint8Array> {
  const m = new Map<string, Uint8Array>();
  const dir = path.join(MW2_ROOT, 'GIDDI');
  for (const f of fs.readdirSync(dir)) if (/\.(DLL|STD|CAL)$/i.test(f)) m.set('GIDDI/' + f.toUpperCase(), new Uint8Array(fs.readFileSync(path.join(dir, f))));
  return m;
}

describe.runIf(hasShellData && hasGameData)('cockpit controls configuration', () => {
  let shellExe: ExeImage;
  let prj: ProjectFile;
  let want: Map<string, Uint8Array>;
  beforeAll(async () => {
    shellExe = ExeImage.fromExe(await gameSource().read('MW2SHELL.EXE'));
    prj = new ProjectFile(await gameSource().read('MW2.PRJ'));
    want = installShellFixtures(['INPUT.MAP', 'INPUT.BAK', 'GAMEKEY.MAP', 'GIDDI/*.CPC']);
  });
  beforeEach(() => {
    startShellProcess(shellExe, prj);
    setDosFiles(giddiAssets());
    setOwnFiles(new Map());
    setOverlayFiles(null);
  });

  it('lists the drivers it has: keyboard and mouse, with the names the DLLs give', () => {
    expect(controlsScreenSetup()).toBe(0);
    expect(inputDeviceCount()).toBe(2);
    const kb = inputDeviceGet(0)!;
    const ms = inputDeviceGet(1)!;
    expect([kb.name, kb.record.displayName, kb.record.analogCount, kb.record.buttonCount]).toEqual(['keyboard', 'Keyboard', 0, 0x79]);
    expect([ms.name, ms.record.displayName, ms.record.analogCount, ms.record.buttonCount]).toEqual(['mouse', 'Mouse', 2, 3]);
    expect(ms.record.analogNames).toEqual(['Up/Down', 'Left/Right']);
    expect(ms.record.analogTitles?.every((t) => typeof t === 'string' && t.length > 0)).toBe(true);
    expect(kb.record.buttonNames![0x66]).toBe('GreyDelete');
    expect(kb.record.buttonNames![100]).toBe('GreyPageDown');
    expect(inputDeviceGet(2)).toBeNull();
    expect(deviceRecord(0)).toEqual({ number: 0, name: 'keyboard' });
    expect(deviceRecord(2)).toEqual({ number: -1, name: '' });
    expect(controlsKeyboardDevice()).toBe(0);
    // no config00: 'NO CONFIG', the keyboard alone chosen
    expect(controlsConfigName()).toBe('NO CONFIG');
    expect([controlsDeviceChosen(0), controlsDeviceChosen(1)]).toEqual([true, false]);
  });

  it('controlMapNames is the image table the README lists', () => {
    const names = Array.from({ length: CONTROLS }, (_, i) => controlMapName(i));
    expect(names.slice(0, 4)).toEqual(['throttle', 'legs_pan_delta', 'torso_pan', 'torso_tilt']);
    expect(names[30]).toBe('advance_nav');
    expect(names.slice(31)).toEqual([null, null, null, null, null, null]);
  });

  it('INPUT.MAP: the install\'s CONFIG00.CPC through controls_load_config and ACCEPT CONFIG AND EXIT reproduces it byte for byte', () => {
    // INPUT.MAP and CONFIG00.CPC are one save (2019-09-29 18:46:05); INPUT.BAK is the INPUT.MAP before it
    dosFileWrite('giddi\\config00.cpc', want.get('GIDDI/CONFIG00.CPC')!);
    dosFileWrite('input.map', want.get('INPUT.BAK')!);
    expect(controlsScreenSetup()).toBe(0);
    expect(controlsConfigName()).toBe('Custom Config #1');
    // keyboard 2 -> 0, mouse 3 -> 1; the mouse is bound, so chosen
    expect([controlsDeviceChosen(0), controlsDeviceChosen(1)]).toEqual([true, true]);
    expect(controlsAcceptConfigFiles()).toBe(true);
    expect(text(dosFileLoad('input.map'))).toBe(text(want.get('INPUT.MAP')!));
    expect(hex(dosFileLoad('input.map'))).toBe(hex(want.get('INPUT.MAP')!));
    // the old one kept as input.bak, temp.map gone
    expect(hex(dosFileLoad('input.bak'))).toBe(hex(want.get('INPUT.BAK')!));
    expect(dosFileLoad('temp.map')).toBeNull();
    expect(mem().i32(SHELL_LABEL.mapAnalogCount)).toBe(2);
    expect(mem().i32(SHELL_LABEL.mapDiscreteCount)).toBe(59);
  });

  it('config00.cpc saved by that ACCEPT: the install\'s, with this machine\'s device list', () => {
    const orig = want.get('GIDDI/CONFIG00.CPC')!;
    dosFileWrite('giddi\\config00.cpc', orig);
    controlsScreenSetup();
    controlsAcceptConfigFiles();
    const saved = dosFileLoad('giddi\\config00.cpc')!;
    expect(saved.length).toBe(orig.length);
    // name block identical; bindings identical once device numbers are mapped keyboard 2->0, mouse 3->1
    expect(hex(saved.subarray(0, 0x40))).toBe(hex(orig.subarray(0, 0x40)));
    const remap = new Map([
      [2, 0],
      [3, 1],
    ]);
    const o = new DataView(orig.buffer, orig.byteOffset);
    const s = new DataView(saved.buffer, saved.byteOffset);
    for (let i = 0; i < BINDING_COUNT; i++) {
      const at = 0x140 + i * 0x18;
      const d = o.getInt32(at + 4, true);
      expect([i, s.getInt32(at + 4, true)]).toEqual([i, d < 0 ? d : (remap.get(d) ?? -1)]);
      for (const f of [0, 8, 0xc, 0x10, 0x14]) expect([i, f, s.getInt32(at + f, true)]).toEqual([i, f, o.getInt32(at + f, true)]);
    }
    // device records: this machine's two, then the saved file's names with a NUL in the first byte (renumber leaves the rest)
    expect(hex(saved.subarray(0x40, 0x60))).toBe('00 00 00 00 6b 65 79 62 6f 61 72 64 00 00 00 00 01 00 00 00 6d 6f 75 73 65 00 00 00 00 00 00 00');
    expect(new DataView(saved.buffer).getInt32(0x60, true)).toBe(-1);
    expect(saved[0x64]).toBe(0);
  });

  it('.cpc load -> save is the identity for CONFIG01..04 (bindings on devices this machine has)', () => {
    for (const n of [1, 2, 3, 4]) {
      const key = `GIDDI/CONFIG0${n}.CPC`;
      const orig = want.get(key);
      if (!orig) continue;
      startShellProcess(shellExe, prj);
      dosFileWrite(configFileName(n), orig);
      controlsScreenSetup();
      const row = SHELL_LABEL.controlsBindingPanel; // any row: only its extra (+0x28) is read
      mem().setI32(row + 0x28, n);
      controlsLoadConfig(row);
      controlsSaveConfigFile(row);
      const saved = dosFileLoad(configFileName(n))!;
      // a save to Custom n names 'Custom Config #n' a configuration called Default Config / Custom Config #...
      const name = String.fromCharCode(...orig.subarray(0, 0x40)).split('\0')[0]!;
      if (!/^(Default Config|Custom Config #)/.test(name)) expect(hex(saved.subarray(0, 0x40))).toBe(hex(orig.subarray(0, 0x40)));
      // bindings: the same, except devices this machine lacks (joysticks) come back unbound (-1)
      const o = new DataView(orig.buffer, orig.byteOffset);
      const s = new DataView(saved.buffer, saved.byteOffset);
      const recName = (i: number) => String.fromCharCode(...orig.subarray(0x44 + i * 16, 0x50 + i * 16)).split('\0')[0];
      for (let i = 0; i < BINDING_COUNT; i++) {
        const at = 0x140 + i * 0x18;
        const d = o.getInt32(at + 4, true);
        const now = d < 0 ? -1 : recName(d) === 'keyboard' ? 0 : recName(d) === 'mouse' ? 1 : -1;
        expect([key, i, s.getInt32(at + 4, true)]).toEqual([key, i, now]);
        for (const f of [0, 8, 0xc, 0x10, 0x14]) expect([key, i, f, s.getInt32(at + f, true)]).toEqual([key, i, f, o.getInt32(at + f, true)]);
      }
    }
  });

  it('more than 90 discrete entries: controls_write_temp_map returns 0 and ACCEPT leaves input.map alone', () => {
    controlsScreenSetup();
    dosFileWrite('input.map', new Uint8Array([0x23]));
    // every control of pages 0..2 a keyboard button: 31 x 3 records plus the aliases and fixed lines
    for (let page = 0; page < 3; page++)
      for (let c = 0; c < 31; c++) {
        const b = bindingAt(SHELL_LABEL.controlBindings, page * CONTROLS + c);
        mem().setI32(b, 1);
        mem().setI32(b + 4, 0);
        mem().setI32(b + 0x10, 20 + c);
      }
    expect(controlsWriteTempMap()).toBe(0);
    expect(mem().i32(SHELL_LABEL.mapDiscreteCount)).toBeGreaterThan(90);
    expect(controlsAcceptConfigFiles()).toBe(false);
    expect(hex(dosFileLoad('input.map'))).toBe('23');
    expect(dosFileLoad('giddi\\config00.cpc')).toBeNull();
  });

  it('.cpc load -> save of the port\'s own save is byte-identical', () => {
    // the first save renumbers onto this machine's two drivers; loading and saving that again changes nothing
    dosFileWrite('giddi\\config00.cpc', want.get('GIDDI/CONFIG00.CPC')!);
    controlsScreenSetup();
    controlsSaveConfigFile(0);
    const once = dosFileLoad('giddi\\config00.cpc')!;
    startShellProcess(shellExe, prj);
    controlsScreenSetup();
    controlsSaveConfigFile(0);
    expect(hex(dosFileLoad('giddi\\config00.cpc'))).toBe(hex(once));
  });

  it('the port\'s KEYBOARD and MOUSE profiles are the install\'s GIDDI\\KEYBOARD.CPC and GIDDI\\MOUSE.CPC', () => {
    controlsScreenSetup();
    const names = Array.from({ length: CONTROLS }, (_, i) => controlMapName(i));
    expect(hex(profileToCpc(KEYBOARD_PROFILE, names, inputDeviceGet(0)!.record))).toBe(hex(want.get('GIDDI/KEYBOARD.CPC')!));
    expect(hex(profileToCpc(MOUSE_PROFILE, names, inputDeviceGet(1)!.record))).toBe(hex(want.get('GIDDI/MOUSE.CPC')!));
  });

  it('RESET DEFAULTS with the keyboard and mouse lays the profiles out as the install\'s CONFIG00 was before its edits', () => {
    dosFileWrite('giddi\\keyboard.cpc', want.get('GIDDI/KEYBOARD.CPC')!);
    dosFileWrite('giddi\\mouse.cpc', want.get('GIDDI/MOUSE.CPC')!);
    controlsScreenSetup();
    // a click on the mouse's row of the device panel
    controlsToggleDevice(controlsDeviceRow(1));
    expect(controlsDeviceChosen(1)).toBe(true);
    controlsResetDefaults();
    expect(controlsConfigName()).toBe('Default Config');
    // the mouse's torso and fire controls land on page 2 (pages 0 and 1 have the keyboard's), target_reticle on page 0
    const at = (page: number, c: number) => bindingAt(SHELL_LABEL.controlBindings, page * CONTROLS + c);
    for (const [page, c, dev] of [
      [2, 2, 1],
      [2, 3, 1],
      [2, 17, 1],
      [2, 18, 1],
      [0, 26, 1],
      [0, 0, 0],
      [1, 0, 0],
      [0, 17, 0],
      [1, 17, 0],
    ] as const)
      expect([page, c, bindingField(at(page, c), 'device')]).toEqual([page, c, dev]);
    expect(bindingField(at(3, 2), 'device')).toBe(-1);
  });

  it('first run: seeds GAMEKEY.MAP, the profiles, INPUT.MAP and config00.cpc; a second run changes nothing', () => {
    const r = seedControlFiles(shellExe);
    expect(r.written.sort()).toEqual(['GAMEKEY.MAP', 'GIDDI/CONFIG00.CPC', 'GIDDI/KEYBOARD.CPC', 'GIDDI/MOUSE.CPC', 'INPUT.MAP'].map((s) => s.replace('/', '\\')).sort());
    expect(hex(dosFileLoad('giddi\\keyboard.cpc'))).toBe(hex(want.get('GIDDI/KEYBOARD.CPC')!));
    expect(hex(dosFileLoad('giddi\\mouse.cpc'))).toBe(hex(want.get('GIDDI/MOUSE.CPC')!));
    const map = text(dosFileLoad('input.map'));
    expect(map.startsWith('# mw2shell CockPit Config generated map file\r\nthrottle_plus {\r\n\t+ keyboard\tEqual\r\n}\r\n')).toBe(true);
    expect(map).toContain('torso_pan {\r\n\t+ mouse\tLeft/Right\r\n}');
    expect(map).toContain('torso_tilt {\r\n\t- mouse\tUp/Down\r\n}');
    expect(map.endsWith('# analog count = 2\r\n# discrete count = 59\r\n')).toBe(true);
    expect(controlsConfigName()).toBe('Default Config');
    const before = new Map(dosFiles.own);
    expect(seedControlFiles(shellExe).written).toEqual([]);
    expect([...dosFiles.own.keys()].sort()).toEqual([...before.keys()].sort());
  });

  it('the seeded INPUT.MAP has the install\'s entries in the install\'s order (its player only changed keys and modifiers)', () => {
    seedControlFiles(shellExe);
    const heads = (b: Uint8Array | null) => text(b).split('\r\n').filter((l) => l.endsWith(' {'));
    expect(heads(dosFileLoad('input.map'))).toEqual(heads(want.get('INPUT.MAP')!));
  });
});

describe.runIf(hasGameData)('GAMEKEY.MAP', () => {
  it('the port\'s table has the install\'s bindings, in order', () => {
    const install = new TextDecoder('latin1')
      .decode(fs.readFileSync(path.join(MW2_ROOT, 'GAMEKEY.MAP')))
      .split(/\r?\n/)
      .filter((l) => l.trim() !== '' && !l.startsWith('#'))
      .map((l) => {
        const [cmd, ...rest] = l.trim().split(/\s+/);
        return [cmd, rest.join(' ')];
      });
    expect(gamekeyBindings()).toEqual(install);
  });

  it('input_load_gamekeys builds the same keystroke table from both', async () => {
    const exe = ExeImage.fromExe(await gameSource().read('MW2.EXE'));
    const load = (bytes: Uint8Array) => {
      setBootImage(exe);
      resetAllGlobals();
      setDosFiles(new Map([['GAMEKEY.MAP', bytes]]));
      setOwnFiles(new Map());
      setOverlayFiles(null);
      expect(inputLoadGamekeys()).toBe(1);
      return Array.from(input.keyCommands);
    };
    const port = load(gamekeyMapBytes());
    const install = load(new Uint8Array(fs.readFileSync(path.join(MW2_ROOT, 'GAMEKEY.MAP'))));
    expect(port.filter((c) => c !== 0).length).toBeGreaterThan(60);
    expect(port).toEqual(install);
  });
});
