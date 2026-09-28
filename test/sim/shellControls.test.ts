// COCKPIT CONTROLS, opened from the Esc menu over the title screen and
// driven headless with the mouse: the device panel, CUSTOM CONFIGURATION,
// a rebinding on the GAME CONTROLS panel, ACCEPT CONFIG AND EXIT - and
// MW2.EXE booted on the disk it leaves binds the new key. Also ABORT, and
// Save Custom 1 -> Load Custom 1. The disk starts as the port's first run
// leaves it (shell/controls/seed.ts).
import fs from 'node:fs';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { ExeImage } from '../../src/data/exe/ExeImage.ts';
import { ProjectFile } from '../../src/data/prj/ProjectFile.ts';
import { dosFileLoad, dosFiles, setCdDrive, setDosFiles, setOverlayFiles, setOwnFiles } from '../../src/engine/dosFiles.ts';
import { SHELL_LABEL } from '../../src/generated/shell/labels.gen.ts';
import { bootMission } from '../../src/mission/load.ts';
import { startShellProcess } from '../../src/shell/boot.ts';
import { bindingAt, bindingField, CONTROLS, controlsConfigName } from '../../src/shell/controls/config.ts';
import { inputDeviceGet } from '../../src/shell/controls/devices.ts';
import { controlsDeviceRow, findRow } from '../../src/shell/controls/panel.ts';
import { seedControlFiles } from '../../src/shell/controls/seed.ts';
import { ShellPump } from '../../src/shell/host/pump.ts';
import { hardware, hwMouseButtons, hwMouseMove } from '../../src/shell/host/hardware.ts';
import { shellMain } from '../../src/shell/main.ts';
import { mem } from '../../src/shell/memory.ts';
import '../../src/shell/screens/controls.ts';
import { widgetField, widgetLabel, widgetRow, widgets } from '../../src/shell/ui/widgets.ts';
import { KeyboardDriver } from '../../src/sim/controls/giddi.ts';
import { input, inputPollControls } from '../../src/sim/controls/input.ts';
import { mechs } from '../../src/sim/mech/mechGlobals.ts';
import { gameSource, hasGameData, hasShellData, installFiles, MW2_ROOT } from '../support/env.ts';

const DEVICE_PANEL = SHELL_LABEL.controlsDevicePanel;
const BINDING_PANEL = SHELL_LABEL.controlsBindingPanel;
/** Fire Weapon: control 17 (controlNames / controlMapNames 'weapon_fire') */
const FIRE = 17;

/** the first row of a table with this clickFn and extra */
function rowByExtra(table: number, clickFn: number, extra: number): number {
  for (let k = 0; ; k++) {
    const row = widgetRow(table, k);
    if (widgetField(row, 'x') === -1) throw new Error(`no row with clickFn 0x${clickFn.toString(16)} extra ${extra}`);
    if (widgetField(row, 'clickFn') >>> 0 === clickFn && widgetField(row, 'extra') === extra) return row;
  }
}

const hex = (b: Uint8Array | null | undefined) => (b ? Array.from(b, (x) => x.toString(16).padStart(2, '0')).join(' ') : 'null');

describe.runIf(hasGameData && hasShellData)('COCKPIT CONTROLS', () => {
  let shellExe: ExeImage;
  let prj: ProjectFile;
  let db: Uint8Array;
  let reg: Uint8Array;
  const giddi = new Map<string, Uint8Array>();
  beforeAll(async () => {
    shellExe = ExeImage.fromExe(await gameSource().read('MW2SHELL.EXE'));
    prj = new ProjectFile(await gameSource().read('MW2.PRJ'));
    db = await gameSource().read('DATABASE.MW2');
    reg = await gameSource().read('MW2REG.CFG');
    const dir = path.join(MW2_ROOT, 'GIDDI');
    for (const f of fs.readdirSync(dir)) if (/\.(DLL|STD|CAL)$/i.test(f)) giddi.set('GIDDI/' + f.toUpperCase(), new Uint8Array(fs.readFileSync(path.join(dir, f))));
  });

  /** A first-run disk (the seed's files), the shell started at its title screen. */
  function boot(): ShellPump {
    hwMouseMove(0, 0);
    hwMouseButtons(0);
    hardware.keys.length = 0;
    setDosFiles(new Map([['DATABASE.MW2', db], ...giddi]));
    setOwnFiles(new Map([['MW2REG.CFG', reg]]));
    setOverlayFiles(null);
    setCdDrive(null);
    seedControlFiles(shellExe);
    startShellProcess(shellExe, prj);
    return new ShellPump(shellMain(['mw2shell.exe', 'intro']));
  }

  async function step(pump: ShellPump, n = 1): Promise<void> {
    for (let i = 0; i < n; i++) {
      if (!pump.frame(1000 / 60)) break;
      await new Promise((r) => setTimeout(r, 0));
    }
    if (pump.error) throw pump.error;
  }

  async function until(pump: ShellPump, what: string, pred: () => boolean, max = 600): Promise<void> {
    for (let i = 0; i < max; i++) {
      if (pred()) return;
      await step(pump);
    }
    throw new Error(`timed out waiting for ${what} (status ${pump.status}, devices ${mem().i32(SHELL_LABEL.inputDeviceCount)}, exit ${mem().i32(SHELL_LABEL.controlsExit)}, keys left ${hardware.keys.length}, kbd ${mem().i32(SHELL_LABEL.controlsKeyboardDevice)}, labels ${widgets.labels.size}, row ${controlsDeviceRow(0)})`);
  }

  /** a left click inside a row */
  async function clickRow(pump: ShellPump, row: number): Promise<void> {
    expect(row).not.toBe(0);
    hwMouseMove(widgetField(row, 'x') + 1, widgetField(row, 'y') + 1);
    await step(pump, 2);
    hwMouseButtons(1);
    await step(pump, 2);
    hwMouseButtons(0);
    await step(pump, 2);
  }

  async function key(pump: ShellPump, ...codes: number[]): Promise<void> {
    hardware.keys.push(...codes);
    await step(pump, 3);
  }

  const labelText = (row: number) => widgetLabel(row)?.text ?? null;
  const deviceRowsUp = () => labelText(controlsDeviceRow(0)) !== null;
  const bindingPanelUp = () => labelText(findRow(BINDING_PANEL, 0x0001ec10, FIRE)) !== null;
  const screenGone = () => labelText(controlsDeviceRow(0)) === null && labelText(findRow(BINDING_PANEL, 0x0001ec10, FIRE)) === null;
  /** control c of page 0 */
  const page0 = (c: number) => bindingAt(SHELL_LABEL.controlBindings, c);

  /** Esc, then COCKPIT CONTROLS - the third item - from the title screen; the device panel up. */
  async function openControls(pump: ShellPump): Promise<void> {
    await step(pump, 25);
    // the title screen centres the pointer, which would highlight a menu item
    hwMouseMove(0, 0);
    await step(pump, 5);
    await key(pump, 0x1b);
    await step(pump, 10);
    await key(pump, 0, 0x50);
    await key(pump, 0, 0x50);
    await key(pump, 0x0d);
    await until(pump, 'the device panel', deviceRowsUp);
  }

  /** CUSTOM CONFIGURATION; the binding panel up */
  async function customConfiguration(pump: ShellPump): Promise<void> {
    await clickRow(pump, rowByExtra(DEVICE_PANEL, 0x0001f810, 0));
    await until(pump, 'the binding panel', bindingPanelUp);
  }

  /**
   * Fire Weapon rebound: the Keyboard tab, Fire Weapon's binding cell, then
   * Scroll Lock in the Buttons list (the sim's keyboard driver reports button
   * i at scan code i + 1). Returns the key's button index.
   */
  async function rebindFire(pump: ShellPump): Promise<number> {
    await clickRow(pump, findRow(BINDING_PANEL, 0x0001f740, 0));
    expect(mem().i32(SHELL_LABEL.controlsDevice)).toBe(0);
    await clickRow(pump, findRow(BINDING_PANEL, 0x0001ec10, FIRE));
    expect(mem().i32(SHELL_LABEL.controlsSelectedControl)).toBe(FIRE);
    expect(mem().i32(SHELL_LABEL.controlsSelectedColumn)).toBe(0);
    const kb = inputDeviceGet(0)!;
    const space = kb.record.buttonNames!.indexOf('Space');
    expect(bindingField(page0(FIRE), 'input')).toBe(space);
    // the Buttons list scrolled to the selected cell's key
    const scroll = mem().i32(SHELL_LABEL.controlsButtonScroll);
    expect(scroll).toBe(space);
    // Scroll Lock: shown (a row below Space), not reserved ('*'), bound to nothing else, and a plain scan code (0x46)
    const pick = kb.record.buttonNames!.indexOf('ScrollLock') - scroll;
    expect(pick).toBeGreaterThan(0);
    await clickRow(pump, findRow(BINDING_PANEL, 0x0001f460, pick));
    expect(bindingField(page0(FIRE), 'input')).toBe(scroll + pick);
    expect(bindingField(page0(FIRE), 'device')).toBe(0);
    // the cell now reads 'key <name>'
    expect(labelText(findRow(BINDING_PANEL, 0x0001ec10, FIRE))).toBe(`key ${kb.record.buttonNames![scroll + pick]}`);
    return scroll + pick;
  }

  it('rebinds Fire Weapon; ACCEPT CONFIG AND EXIT writes INPUT.MAP, input.bak and config00.cpc; MW2.EXE fires on the new key', async () => {
    const pump = boot();
    const oldMap = dosFileLoad('input.map')!;
    const oldCpc = dosFileLoad('giddi\\config00.cpc')!;
    await openControls(pump);
    // the device panel lists the port's two drivers, both chosen (the seeded configuration binds the mouse)
    expect(labelText(controlsDeviceRow(0))).toBe('Keyboard');
    expect(labelText(controlsDeviceRow(1))).toBe('Mouse');
    expect(labelText(controlsDeviceRow(2))).toBeNull();
    expect(labelText(widgetRow(DEVICE_PANEL, 3))).toBe('Default Config');
    await customConfiguration(pump);
    expect(labelText(findRow(BINDING_PANEL, 0x0001ec10, FIRE))).toBe('key Space');
    const picked = await rebindFire(pump);
    const keyName = inputDeviceGet(0)!.record.buttonNames![picked]!;
    await clickRow(pump, rowByExtra(BINDING_PANEL, 0x00020e60, 0));
    // 'Cockpit Control Configured.#Ok'
    await key(pump, 0x0d);
    await until(pump, 'the screen to close', screenGone);
    const map = String.fromCharCode(...dosFileLoad('input.map')!);
    expect(map).toContain(`weapon_fire {\r\n\t+ keyboard\t${keyName}\r\n}`);
    expect(map).not.toContain('weapon_fire {\r\n\t+ keyboard\tSpace\r\n}');
    expect(hex(dosFileLoad('input.bak'))).toBe(hex(oldMap));
    expect(dosFileLoad('temp.map')).toBeNull();
    const cpc = dosFileLoad('giddi\\config00.cpc')!;
    expect(hex(cpc)).not.toBe(hex(oldCpc));
    const dv = new DataView(cpc.buffer, cpc.byteOffset);
    const at = 0x140 + FIRE * 0x18;
    expect([dv.getInt32(at, true), dv.getInt32(at + 4, true), dv.getInt32(at + 0x10, true)]).toEqual([1, 0, picked]);

    // MW2.EXE on that disk
    const own = new Map(dosFiles.own);
    const exe = ExeImage.fromExe(await gameSource().read('MW2.EXE'));
    const assets = installFiles();
    for (const k of [...assets.keys()]) if (/\.MAP$/.test(k)) assets.delete(k);
    bootMission({ exe, prj, looseFiles: new Map([...assets, ...own]), mission: 'AMY_SCN1' });
    const kb = input.devices[input.keyboardDevice]!.driver as KeyboardDriver;
    const pc = mechs.playerControls;
    kb.isr(picked + 1);
    inputPollControls();
    expect(pc.weapon_fire).toBe(1);
    kb.isr((picked + 1) | 0x80);
    inputPollControls();
    expect(pc.weapon_fire).toBe(0);
    kb.isr(0x39);
    inputPollControls();
    expect(pc.weapon_fire).toBe(0);
    kb.isr(0xb9);
  }, 60000);

  it('ABORT after a rebinding leaves the files as they were', async () => {
    const pump = boot();
    const before = new Map([...dosFiles.own].map(([k, v]) => [k, hex(v)]));
    await openControls(pump);
    await customConfiguration(pump);
    await rebindFire(pump);
    await clickRow(pump, rowByExtra(BINDING_PANEL, 0x0001eaf0, 0));
    await until(pump, 'the screen to close', screenGone);
    await step(pump, 5);
    const after = new Map([...dosFiles.own].map(([k, v]) => [k, hex(v)]));
    expect([...after.keys()].sort()).toEqual([...before.keys()].sort());
    for (const [k, v] of before) expect([k, after.get(k)]).toEqual([k, v]);
  }, 60000);

  it('the device panel\'s ABORT leaves at once', async () => {
    const pump = boot();
    const before = new Map([...dosFiles.own].map(([k, v]) => [k, hex(v)]));
    await openControls(pump);
    await clickRow(pump, rowByExtra(DEVICE_PANEL, 0x0001eaf0, 0));
    await until(pump, 'the screen to close', screenGone);
    expect(new Map([...dosFiles.own].map(([k, v]) => [k, hex(v)]))).toEqual(before);
  }, 60000);

  it('without KEYBOARD.DLL: "Error: keyboard.dll not found." and no panels', async () => {
    for (const k of [...giddi.keys()]) if (/KEYBOARD/.test(k)) giddi.delete(k);
    try {
      const pump = boot();
      await step(pump, 25);
      hwMouseMove(0, 0);
      await step(pump, 5);
      await key(pump, 0x1b);
      await step(pump, 10);
      await key(pump, 0, 0x50);
      await key(pump, 0, 0x50);
      await key(pump, 0x0d);
      await step(pump, 10);
      // the message box is up: the drivers are listed, the mouse alone, and no keyboard found
      expect(mem().i32(SHELL_LABEL.inputDeviceCount)).toBe(1);
      expect(mem().i32(SHELL_LABEL.controlsKeyboardDevice)).toBe(-1);
      expect(deviceRowsUp()).toBe(false);
      await key(pump, 0x0d);
      await step(pump, 5);
      // closed: the drivers freed, no panel was laid out
      expect(mem().i32(SHELL_LABEL.inputDeviceCount)).toBe(0);
      expect(deviceRowsUp()).toBe(false);
    } finally {
      const dir = path.join(MW2_ROOT, 'GIDDI');
      for (const f of fs.readdirSync(dir)) if (/^KEYBOARD\.(DLL|STD|CAL)$/i.test(f)) giddi.set('GIDDI/' + f.toUpperCase(), new Uint8Array(fs.readFileSync(path.join(dir, f))));
    }
  }, 60000);

  it('Save Custom 1, RESET DEFAULTS, Load Custom 1 round-trips', async () => {
    const pump = boot();
    await openControls(pump);
    await customConfiguration(pump);
    const picked = await rebindFire(pump);
    const saved = hex(mem().view(SHELL_LABEL.controlBindings, CONTROLS * 4 * 0x18));
    await clickRow(pump, rowByExtra(BINDING_PANEL, 0x00020b00, 1));
    // 'Configuration 1 Saved.#Ok'
    await key(pump, 0x0d);
    await step(pump, 5);
    const file = dosFileLoad('giddi\\config01.cpc')!;
    expect(file.length).toBe(0x40 + 0x100 + 0xde0);
    expect(controlsConfigName()).toBe('Custom Config #1');
    expect(mem().i32(SHELL_LABEL.controlsConfigSlot)).toBe(1);
    // RESET DEFAULTS puts Space back
    await clickRow(pump, rowByExtra(BINDING_PANEL, 0x00020c10, 0));
    expect(bindingField(page0(FIRE), 'input')).toBe(inputDeviceGet(0)!.record.buttonNames!.indexOf('Space'));
    expect(controlsConfigName()).toBe('Default Config');
    expect(mem().i32(SHELL_LABEL.controlsConfigSlot)).toBe(0);
    // Load Custom 1
    await clickRow(pump, rowByExtra(BINDING_PANEL, 0x00020a40, 1));
    expect(bindingField(page0(FIRE), 'input')).toBe(picked);
    expect(hex(mem().view(SHELL_LABEL.controlBindings, CONTROLS * 4 * 0x18))).toBe(saved);
    expect(controlsConfigName()).toBe('Custom Config #1');
    expect(mem().i32(SHELL_LABEL.controlsConfigSlot)).toBe(1);
    // the slot and name rows show it
    expect(labelText(findRow(BINDING_PANEL, 0x0001e350, SHELL_LABEL.controlsConfigName))).toBe('Custom Config #1');
    await clickRow(pump, rowByExtra(BINDING_PANEL, 0x0001eaf0, 0));
    await until(pump, 'the screen to close', screenGone);
  }, 60000);
});
