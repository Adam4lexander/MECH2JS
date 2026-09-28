// COMBAT VARIABLES (the shell's options panel) and the two files it edits,
// MW2SND.CFG and MW2DIF.CFG. The install's copies are read here only as
// fixtures (the port never reads them at run time): the shell's reader and
// writer must hand them back byte for byte, and a headless session through
// the Esc menu must leave exactly the edited bytes on the port's disk, which
// MW2.EXE's start-up then reads.
import { beforeAll, describe, expect, it } from 'vitest';
import { ExeImage } from '../../src/data/exe/ExeImage.ts';
import { ProjectFile } from '../../src/data/prj/ProjectFile.ts';
import { dosFileLoad, setCdDrive, setDosFiles, setOverlayFiles, setOwnFiles } from '../../src/engine/dosFiles.ts';
import { SHELL_LABEL } from '../../src/generated/shell/labels.gen.ts';
import { startShellProcess } from '../../src/shell/boot.ts';
import { shellMain } from '../../src/shell/main.ts';
import { ShellPump } from '../../src/shell/host/pump.ts';
import { hardware, hwMouseButtons, hwMouseMove } from '../../src/shell/host/hardware.ts';
import { mem } from '../../src/shell/memory.ts';
import { widgetLabel, widgetRow } from '../../src/shell/ui/widgets.ts';
import { simOptionsRead, simOptionsWrite } from '../../src/shell/options/simOptions.ts';
import { soundConfigRead, soundConfigWrite } from '../../src/shell/options/soundConfig.ts';
import '../../src/shell/screens/options.ts';
import { bootMission } from '../../src/mission/load.ts';
import { mechs } from '../../src/sim/mech/mechGlobals.ts';
import { sound } from '../../src/sim/sound/mixer.ts';
import { DEFAULT_RULES, rulesToBytes } from '../../src/sim/mech/simOptions.ts';
import { DEFAULT_SOUND_CONFIG, soundConfigFromBytes, soundConfigToBytes } from '../../src/sim/sound/soundConfigFile.ts';
import { gameSource, hasGameData, hasShellData, installFiles, installShellFixtures } from '../support/env.ts';

const TABLE = SHELL_LABEL.optionsWidgets;
/** optionsWidgets rows, by what they edit */
const ROW = { difficulty: 0, objectTextures: 2, resolution: 7, invulnerability: 8, collisionDamage: 10, musicSlider: 12 } as const;

const hex = (b: Uint8Array | null) => (b ? Buffer.from(b).toString('hex') : 'null');

describe.runIf(hasGameData && hasShellData)('COMBAT VARIABLES', () => {
  let exe: ExeImage;
  let shellExe: ExeImage;
  let prj: ProjectFile;
  let db: Uint8Array;
  let snd: Uint8Array;
  let dif: Uint8Array;
  beforeAll(async () => {
    exe = ExeImage.fromExe(await gameSource().read('MW2.EXE'));
    shellExe = ExeImage.fromExe(await gameSource().read('MW2SHELL.EXE'));
    prj = new ProjectFile(await gameSource().read('MW2.PRJ'));
    db = await gameSource().read('DATABASE.MW2');
    const fx = installShellFixtures(['MW2SND.CFG', 'MW2DIF.CFG']);
    snd = fx.get('MW2SND.CFG')!;
    dif = fx.get('MW2DIF.CFG')!;
    expect(snd.length).toBe(0x3c);
    expect(dif.length).toBe(8);
  });

  it("the port's defaults are the shell's boot values", () => {
    startShellProcess(shellExe, prj);
    expect(hex(rulesToBytes(DEFAULT_RULES))).toBe(hex(mem().view(SHELL_LABEL.simOptions, 8).slice()));
    expect(hex(soundConfigToBytes(DEFAULT_SOUND_CONFIG))).toBe(hex(mem().view(SHELL_LABEL.soundConfig, 0x3c).slice()));
    // the install's MW2DIF.CFG is the same record; its MW2SND.CFG differs only in the driver name
    expect(hex(rulesToBytes(DEFAULT_RULES))).toBe(hex(dif));
    expect({ ...soundConfigFromBytes(snd), videoDriver: '' }).toEqual(DEFAULT_SOUND_CONFIG);
    expect(hex(soundConfigToBytes(soundConfigFromBytes(snd)))).toBe(hex(snd));
  });

  it("the install's files load and save unchanged through the shell's reader and writer", () => {
    startShellProcess(shellExe, prj);
    setDosFiles(new Map());
    setOverlayFiles(null);
    setOwnFiles(new Map([['MW2SND.CFG', snd], ['MW2DIF.CFG', dif]]));
    // scribble over both records first, so a reader that read nothing cannot pass
    mem().fill(SHELL_LABEL.soundConfig, 0xa5, 0x3c);
    mem().fill(SHELL_LABEL.simOptions, 0xa5, 8);
    soundConfigRead();
    simOptionsRead();
    setOwnFiles(new Map());
    soundConfigWrite();
    simOptionsWrite();
    expect(hex(dosFileLoad('MW2SND.CFG'))).toBe(hex(snd));
    expect(hex(dosFileLoad('MW2DIF.CFG'))).toBe(hex(dif));
  });

  it('Esc menu -> COMBAT VARIABLES: rules, a slider and the resolution, written back and read by MW2.EXE', async () => {
    hwMouseMove(0, 0);
    hwMouseButtons(0);
    hardware.keys.length = 0;
    setDosFiles(new Map([['DATABASE.MW2', db]]));
    setOwnFiles(new Map([['MW2SND.CFG', snd], ['MW2DIF.CFG', dif]]));
    setOverlayFiles(null);
    setCdDrive(null);
    startShellProcess(shellExe, prj);
    const pump = new ShellPump(shellMain(['mw2shell.exe', 'intro']));
    const step = async (n = 1) => {
      for (let i = 0; i < n; i++) {
        if (!pump.frame(1000 / 60)) break;
        await new Promise((r) => setTimeout(r, 0));
      }
      if (pump.error) throw pump.error;
    };
    const until = async (what: string, pred: () => boolean) => {
      for (let i = 0; i < 600 && !pred(); i++) await step();
      if (!pred()) throw new Error(`timed out waiting for ${what}`);
    };
    const row = (i: number) => widgetRow(TABLE, i);
    // the label's text, as text_label_init keeps it (without the '~' the draw functions pass)
    const text = (i: number) => widgetLabel(row(i))?.text ?? null;
    const panelOpen = () => text(ROW.difficulty) !== null;
    const click = async (x: number, y: number) => {
      hwMouseMove(x, y);
      await step(2);
      hwMouseButtons(1);
      await step(2);
      hwMouseButtons(0);
      await step(2);
    };
    const openPanel = async () => {
      hardware.keys.push(0x1b);
      await step(10);
      // COMBAT VARIABLES is the second item
      hardware.keys.push(0, 0x50);
      await step(2);
      hardware.keys.push(0x0d);
      await until('the options panel', panelOpen);
      await step(2);
    };

    // the title screen centres the pointer; off the menu, it leaves the keys to pick
    await step(25);
    hwMouseMove(0, 0);
    await step(5);
    await openPanel();
    // the install's settings as the panel shows them
    expect(text(ROW.difficulty)).toBe('MEDIUM');
    expect(text(ROW.invulnerability)).toBe('OFF');
    expect(text(ROW.collisionDamage)).toBe('OFF');
    expect(text(ROW.objectTextures)).toBe('ON');
    expect(text(ROW.resolution)).toBe('640x480');
    // closed untouched (any key): both files written back as they were read
    hardware.keys.push(0x20);
    await until('the panel to close', () => !panelOpen());
    expect(hex(dosFileLoad('MW2SND.CFG'))).toBe(hex(snd));
    expect(hex(dosFileLoad('MW2DIF.CFG'))).toBe(hex(dif));

    // back in the menu, which starts again on its first item
    await step(10);
    hardware.keys.push(0, 0x50);
    await step(2);
    hardware.keys.push(0x0d);
    await until('the options panel again', panelOpen);
    await step(2);
    const cx = (i: number) => mem().i32(row(i)) + 50;
    const cy = (i: number) => mem().i32(row(i) + 4) + 4;
    await click(cx(ROW.invulnerability), cy(ROW.invulnerability));
    expect(text(ROW.invulnerability)).toBe('ON (Dishonorable)');
    await click(cx(ROW.collisionDamage), cy(ROW.collisionDamage));
    expect(text(ROW.collisionDamage)).toBe('ON (Dishonorable)');
    await click(cx(ROW.difficulty), cy(ROW.difficulty));
    expect(text(ROW.difficulty)).toBe('HARD');
    await click(cx(ROW.objectTextures), cy(ROW.objectTextures));
    expect(text(ROW.objectTextures)).toBe('OFF');
    await click(cx(ROW.resolution), cy(ROW.resolution));
    expect(text(ROW.resolution)).toBe('1024x768');
    // the music slider (x 335): pressed at 128 px of travel, dragged to 64, released
    const sx = mem().i32(row(ROW.musicSlider)) + 0xf;
    const sy = mem().i32(row(ROW.musicSlider) + 4) + 10;
    hwMouseMove(sx + 128, sy);
    await step(2);
    hwMouseButtons(1);
    await step(3);
    hwMouseMove(sx + 64, sy);
    await step(3);
    hwMouseButtons(0);
    await step(3);
    // accepted with a key
    hardware.keys.push(0x20);
    await until('the panel to close', () => !panelOpen());

    const wantDif = dif.slice();
    wantDif[1] = 1; // invulnerability
    wantDif[3] = 0; // collision damage off
    wantDif[5] = 2; // HARD
    expect(hex(dosFileLoad('MW2DIF.CFG'))).toBe(hex(wantDif));
    const wantSnd = soundConfigToBytes({ ...soundConfigFromBytes(snd), musicVolume: 64 << 8, objectTextures: 0, videoDriver: 'vesa768.dll' });
    expect(hex(dosFileLoad('MW2SND.CFG'))).toBe(hex(wantSnd));

    // FLEE TO DOS: Up from the first item wraps to it
    await step(10);
    hardware.keys.push(0, 0x48);
    await step(2);
    hardware.keys.push(0x0d);
    await step(4);
    hardware.keys.push(0x79);
    await step(20);
    expect(pump.status).toBe(0xff);

    // MW2.EXE's start-up reads the two files the panel left on the disk
    const assets = installFiles();
    assets.delete('MW2SND.CFG');
    setDosFiles(assets);
    expect(bootMission({ exe, prj, mission: 'AMY_SCN1' })).toBe(true);
    const o = mechs.simOptions!;
    expect([o.unlimitedAmmo, o.invulnerability, o.splashDamage, o.collisionDamage, o.heatTracking, o.difficulty]).toEqual([0, 1, 1, 0, 1, 2]);
    expect(sound.soundConfigBuffer![3]).toBe(0x4000);
    expect(sound.soundConfigBuffer![5]).toBe(0);
  });

  it("MW2.EXE on a disk without MW2DIF.CFG: the port's default is written and read", () => {
    const assets = installFiles();
    setDosFiles(assets);
    setOwnFiles(new Map());
    setOverlayFiles(null);
    expect(bootMission({ exe, prj, mission: 'AMY_SCN1' })).toBe(true);
    expect(hex(dosFileLoad('MW2DIF.CFG'))).toBe(hex(rulesToBytes(DEFAULT_RULES)));
    const o = mechs.simOptions!;
    expect([o.unlimitedAmmo, o.invulnerability, o.splashDamage, o.collisionDamage, o.heatTracking, o.difficulty]).toEqual([0, 0, 1, 1, 1, 1]);
  });
});
