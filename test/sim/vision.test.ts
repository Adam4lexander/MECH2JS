// The two vision commands on AMY_SCN1, through command_execute and main's
// loop: INFRARED (0x9d) stops the day cycle and fades to palette slot 0xc,
// is refused while the sensors (hudWidgets[0]) are damaged, and ends - with
// a one-second fade back to the time of day - when they are damaged while it
// is on; ENHANCED_VISION (0x9e) toggles hidden-line wireframe while the
// player's mech runs.
import { beforeAll, describe, expect, it } from 'vitest';
import { ExeImage } from '../../src/data/exe/ExeImage.ts';
import { ProjectFile } from '../../src/data/prj/ProjectFile.ts';
import { ailTimerService } from '../../src/engine/miles/ail.ts';
import { bootMission } from '../../src/mission/load.ts';
import { mainLoopFrame } from '../../src/mission/mainLoop.ts';
import { hud } from '../../src/sim/cockpit/hud.ts';
import { renderOptions } from '../../src/sim/display/renderState.ts';
import { mechs } from '../../src/sim/mech/mechGlobals.ts';
import { commandExecute } from '../../src/sim/ui/commands.ts';
import { dayCycle } from '../../src/sim/world/dayCycle.ts';
import { palettes } from '../../src/sim/world/palettes.ts';
import { gameSource, hasGameData, installFiles } from '../support/env.ts';

let exe: ExeImage;
let prj: ProjectFile;
let files: Map<string, Uint8Array>;

function frame(ticks = 7) {
  for (let i = 0; i < ticks; i++) ailTimerService();
  mainLoopFrame();
}

describe.runIf(hasGameData)('vision modes', () => {
  beforeAll(async () => {
    const src = gameSource();
    exe = ExeImage.fromExe(await src.read('MW2.EXE'));
    prj = new ProjectFile(await src.read('MW2.PRJ'));
    files = installFiles();
  });

  it('infrared: slot 0xc with the day cycle stopped; off again goes back to the phase palette', () => {
    bootMission({ exe, prj, looseFiles: files, mission: 'AMY_SCN1' });
    for (let f = 0; f < 60; f++) frame();
    const phase = dayCycle.dayPhase;
    expect(phase).not.toBe(-1);
    commandExecute(0x9d);
    expect(dayCycle.infraredOn).toBe(1);
    expect(dayCycle.dayCycleEnabled).toBe(0);
    expect(palettes.paletteBaseSlot).toBe(0xc);
    for (let f = 0; f < 60; f++) frame();
    expect(palettes.paletteCurrentSlot).toBe(0xc);
    // off: the cycle restarts, and its next evaluation fades back in a second and clears the flag
    commandExecute(0x9d);
    expect(dayCycle.dayCycleEnabled).toBe(1);
    expect(dayCycle.infraredOn).toBe(1);
    frame();
    expect(dayCycle.infraredOn).toBe(0);
    expect(dayCycle.dayPhase).toBe(phase);
    expect(palettes.paletteBaseSlot).toBe(dayCycle.dayPhasePaletteSlot[phase]);
  });

  it('infrared needs undamaged sensors, and sensor damage ends it', () => {
    bootMission({ exe, prj, looseFiles: files, mission: 'AMY_SCN1' });
    for (let f = 0; f < 60; f++) frame();
    const sensors = hud.hudWidgets[0]!;
    sensors.field_0x6 = 1;
    commandExecute(0x9d);
    expect(dayCycle.infraredOn).toBe(0);
    sensors.field_0x6 = 0;
    commandExecute(0x9d);
    expect(dayCycle.infraredOn).toBe(1);
    sensors.field_0x6 = 1;
    frame();
    expect(dayCycle.infraredOn).toBe(0);
    expect(dayCycle.dayCycleEnabled).toBe(1);
  });

  it('enhanced vision toggles hidden-line wireframe, only while the mech runs', () => {
    bootMission({ exe, prj, looseFiles: files, mission: 'AMY_SCN1' });
    commandExecute(0x9e);
    expect(renderOptions.wireframeMode).toBe(0);
    const p = mechs.mechTable[mechs.playerMechIndex]!;
    for (let f = 0; f < 400 && (p.flags & 0x2000) === 0; f++) frame();
    expect(p.flags & 0x2000).toBe(0x2000);
    commandExecute(0x9e);
    expect(renderOptions.wireframeMode).toBe(1);
    expect(renderOptions.wireframeColourScheme).toBe(0);
    commandExecute(0x9e);
    expect(renderOptions.wireframeMode).toBe(0);
  });
});
