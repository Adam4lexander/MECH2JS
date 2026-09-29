// Phase S6: the debriefing (state 3), headless. main is resumed by MECH2
// ('sim') with mw2prm.cfg parked at state 3 and the files a mission leaves
// on the disk. The golden case scores a won Jade Falcon mission (Trial 1:
// three objectives succeeded, 7 enemy 'Mechs down, 704 hits of 778 shots)
// for a registry pilot, and the expected text, honor, rank and missionIndex
// are the README's formula worked by hand below. A failed mission and
// dishonourable options (MW2DIF.CFG bytes) score nothing.
import { beforeAll, describe, expect, it } from 'vitest';
import { ExeImage } from '../../src/data/exe/ExeImage.ts';
import { ProjectFile } from '../../src/data/prj/ProjectFile.ts';
import { dosFileLoad, setCdDrive, setDosFiles, setOverlayFiles, setOwnFiles } from '../../src/engine/dosFiles.ts';
import { SHELL_LABEL } from '../../src/generated/shell/labels.gen.ts';
import { startShellProcess } from '../../src/shell/boot.ts';
import { shellMain } from '../../src/shell/main.ts';
import { ShellPump } from '../../src/shell/host/pump.ts';
import { hardware, hwMouseButtons, hwMouseMove } from '../../src/shell/host/hardware.ts';
import { shell } from '../../src/shell/state.ts';
import { fieldOffset, mem, structSize } from '../../src/shell/memory.ts';
import { careerRegistrySave, pilotRecord } from '../../src/shell/career/registry.ts';
import { PILOT, setCurrentPilot } from '../../src/shell/career/missions.ts';
import { prmCommandLine, prmSave } from '../../src/shell/handoff/prm.ts';
import { starConfigure, starSetMember } from '../../src/shell/handoff/stars.ts';
import { chassisEntry, chassisIndexOf } from '../../src/shell/handoff/starFiles.ts';
import { textWidth, type TextLabel } from '../../src/shell/ui/labels.ts';
import { shellScreens, type Screen } from '../../src/shell/screens/registry.ts';
import { readCheatCodes } from '../../src/data/exe/tables/cheats.ts';
import { ailTimerService } from '../../src/engine/miles/ail.ts';
import { mech2Main } from '../../src/launcher/mech2.ts';
import { splitCommandTail } from '../../src/mission/commandLine.ts';
import { missionEnd } from '../../src/mission/end.ts';
import { bootMission } from '../../src/mission/load.ts';
import { mainLoopFrame, mainLoopRunning } from '../../src/mission/mainLoop.ts';
import { cheatHandleCommand } from '../../src/sim/ui/cheats.ts';
import { firstRunDisk, gameSource, hasGameData, hasShellData } from '../support/env.ts';

/** Runs the pump a frame at a time, calling `script` before each frame. */
async function run(pump: ShellPump, script: (frame: number) => void, maxFrames = 1500): Promise<number> {
  for (let f = 0; f < maxFrames; f++) {
    script(f);
    if (!pump.frame(1000 / 60)) break;
    await new Promise((r) => setTimeout(r, 0));
  }
  if (pump.error) throw pump.error;
  return pump.status ?? -1;
}

/** A click at (x, y) starting at frame f. */
function click(frame: number, f: number, x: number, y: number): void {
  if (frame === f) hwMouseMove(x, y);
  if (frame === f + 2) hwMouseButtons(1);
  if (frame === f + 6) hwMouseButtons(0);
}

/** The PilotRecord at slot i of MW2REG.CFG. */
function pilotAt(reg: Uint8Array, i: number) {
  const dv = new DataView(reg.buffer, reg.byteOffset + i * 0x3c, 0x3c);
  return {
    career: dv.getInt32(8, true),
    missionIndex: dv.getInt32(0xc, true),
    rank: dv.getInt32(0x10, true),
    careerHonor: dv.getInt32(0x14, true),
    killTally: dv.getInt32(0x18, true),
    enemyMechHits: dv.getInt32(0x1c, true),
    shotsFired: dv.getInt32(0x20, true),
  };
}

/**
 * What MW2.EXE leaves on the disk after the won Trial 1 the golden case
 * scores: MW2MSN.CFG (a MissionRecord: result 2 and the three objectives, as
 * mission_save_results writes them) and MW2CAR.CFG (the MissionTallies).
 * Only the fields the debriefing reads are set.
 */
function wonTrial(): { msn: Uint8Array; car: Uint8Array } {
  const msn = new Uint8Array(structSize('MissionRecord'));
  const m = new DataView(msn.buffer);
  msn.set([0x4d, 0x57, 0x32, 0x4d]); // 'MW2M'
  m.setInt32(fieldOffset('MissionRecord', 'result'), 2, true);
  const objectives: [number, number, string][] = [
    [1, 451, 'Defend Firebase At Nav Gamma'], // Primary
    [8, 505, 'Firebase: Nav Gamma'], // Return
    [2, 453, 'Destroy All Attacking Units'], // Secondary
  ];
  m.setInt32(fieldOffset('MissionRecord', 'objectiveCount'), objectives.length, true);
  objectives.forEach(([category, changedAt, text], i) => {
    const at = fieldOffset('MissionRecord', 'objectives') + i * structSize('MissionObjectiveRecord');
    m.setUint32(at + fieldOffset('MissionObjectiveRecord', 'succeeded'), 1, true);
    m.setUint32(at + fieldOffset('MissionObjectiveRecord', 'category'), category, true);
    m.setInt32(at + fieldOffset('MissionObjectiveRecord', 'changedAt'), changedAt, true);
    for (let k = 0; k < text.length; k++) msn[at + fieldOffset('MissionObjectiveRecord', 'text') + k] = text.charCodeAt(k);
  });
  const car = new Uint8Array(structSize('MissionTallies'));
  const c = new DataView(car.buffer);
  const tally = (f: string, v: number) => c.setInt32(fieldOffset('MissionTallies', f), v, true);
  tally('playerKillsEnemyMech', 5);
  tally('shotsFired', 778);
  tally('enemyMechHits', 704);
  tally('enemyMechsDestroyed', 7);
  return { msn, car };
}

/** MW2DIF.CFG: unlimitedAmmo, invulnerability, splashDamage, collisionDamage, heatTracking, difficulty, 2 unused. */
const dif = (o: Partial<{ ammo: number; invuln: number; collision: number; heat: number; difficulty: number }>) =>
  new Uint8Array([o.ammo ?? 0, o.invuln ?? 0, 1, o.collision ?? 1, o.heat ?? 1, o.difficulty ?? 1, 0, 0]);

describe.runIf(hasGameData && hasShellData)('shell debriefing', () => {
  let exe: ExeImage;
  let prj: ProjectFile;
  let db: Uint8Array;
  let msn: Uint8Array;
  let car: Uint8Array;
  beforeAll(async () => {
    exe = ExeImage.fromExe(await gameSource().read('MW2SHELL.EXE'));
    prj = new ProjectFile(await gameSource().read('MW2.PRJ'));
    db = await gameSource().read('DATABASE.MW2');
    ({ msn, car } = wonTrial());
  });

  /**
   * The disk as MECH2 leaves it for 'mw2shell sim': the mission's two
   * files, MW2DIF.CFG, a registry whose slot 10 is the Jade Falcon pilot
   * ADAM at `missionIndex` (rank 0, 1500 honor), and mw2prm.cfg resuming
   * the debriefing for `scenario` with a one-Timber-Wolf star of 3 x 100.
   */
  function park(scenario: string, missionIndex: number, options: Uint8Array, result?: number): void {
    hwMouseMove(0, 0);
    hwMouseButtons(0);
    setDosFiles(new Map([['DATABASE.MW2', db]]));
    const m2 = msn.slice();
    if (result !== undefined) new DataView(m2.buffer).setInt32(0x10, result, true);
    setOwnFiles(
      new Map([
        ['MW2MSN.CFG', m2],
        ['MW2CAR.CFG', car.slice()],
        ['MW2DIF.CFG', options],
      ]),
    );
    setOverlayFiles(null);
    setCdDrive(null);
    startShellProcess(exe, prj);
    const m = mem();
    const pilot = pilotRecord(10);
    m.setI32(pilot + PILOT.inUse, 1);
    m.setI32(pilot + PILOT.selected, 1);
    m.setI32(pilot + PILOT.career, 1);
    m.setI32(pilot + PILOT.missionIndex, missionIndex);
    m.setI32(pilot + PILOT.careerHonor, 1500);
    m.strcpy(pilot + PILOT.pilotName, 'ADAM');
    setCurrentPilot(pilot);
    careerRegistrySave();
    starConfigure(0, 0, 3, 1, 100);
    starSetMember(0, 'tbr00std', 'ADAM');
    starConfigure(1, 0, 3, 0, 100);
    starConfigure(0, -1, -1, -1, -1);
    prmSave(3, 1, 1, scenario);
    startShellProcess(exe, prj);
  }

  /** Runs the debriefing, reads its text, then EXIT; the state it returns (0xb) is probed and quits. */
  async function debrief(): Promise<{ text: string; typed: number; next: string | null; status: number; registry: Uint8Array }> {
    const readyRoom = shellScreens.get(0xb);
    let next: string | null = null;
    // eslint-disable-next-line require-yield -- a screen that returns at once
    const probe: Screen = function* (l) {
      next = l.commandLine.value;
      return -3;
    };
    shellScreens.register(0xb, probe);
    let text = '';
    let typed = 0;
    try {
      const pump = new ShellPump(shellMain(['mw2shell.exe', 'sim']));
      const status = await run(pump, (f) => {
        if (f === 150) {
          text = mem().cstr(SHELL_LABEL.debriefingText);
          typed = (shell.videoDriver!.labelsOver as TextLabel[]).filter((l) => l.typewriter === 1 && l.charIndex > 0).length;
        }
        // EXIT: (270..369, 450..474)
        click(f, 160, 320, 462);
      });
      return { text, typed, next, status, registry: dosFileLoad('MW2REG.CFG')! };
    } finally {
      if (readyRoom) shellScreens.register(0xb, readyRoom);
    }
  }

  /** '\g350\b<width>n': a number right-aligned at x 350 (the width is the font's, not the formula's). */
  const at350 = (n: number) => `\\g350\\b${String(textWidth(shell.pageFont!, String(n))).padStart(3, '0')}${n}`;

  it("golden: a won Trial 1 (cindSCN1), HARD - the README's formula by hand", async () => {
    park('cindSCN1', 4, dif({ difficulty: 2 }));
    const tbr = chassisEntry(chassisIndexOf('tbr00std')).tonnage;
    const r = await debrief();

    // The files (wonTrial):
    //   MW2MSN.CFG: result 2, three objectives -
    //     0 succeeded, category 1 (Primary),   changedAt 451, 'Defend Firebase At Nav Gamma'
    //     1 succeeded, category 8 (Return),    changedAt 505, 'Firebase: Nav Gamma'
    //     2 succeeded, category 2 (Secondary), changedAt 453, 'Destroy All Attacking Units'
    //   MW2CAR.CFG: playerKillsEnemyMech 5, shotsFired 778, enemyMechHits 704,
    //     enemyMechsDestroyed 7, wingmenDestroyed 0, non-mechs 0 / 0
    expect(tbr).toBe(75);
    // Honor:
    //   Mission Completion   no primary failed                      5000
    //   Secondary            1 x 1500                               1500
    //   Tertiary             none (category 8 is not 4)                0
    //   Wingman Deaths       0 - no line                               0
    //   Enemy Mechs          7 x 250                                1750
    //   Enemy Vehicles       0 x 125                                   0
    //   Star Underweight     3 x 100 - 75 = 225 tons x 25           5625
    //   Hit Percentage       704 / 778 = 0.9049 >= 0.7               750
    //                                                         sum = 14625
    //   HARD: 14625 + trunc(14625 * 1.3 - 14625): the product (exactly 19012.50000000000065 with the
    //   image's 1.3) rounds to the double 19012.5; - 14625 = 4387.5, truncated 4387; total 19012
    const sum = 5000 + 1500 + 1750 + 0 + 25 * (3 * 100 - 75) + 750;
    expect(sum).toBe(14625);
    const total = 14625 + 4387;
    const lines = [
      'Time\\g050Type\\g170Objective\\g370Status\\n\\n',
      // sorted by changedAt: 451 (7:31), 453 (7:33), 505 (8:25)
      '07:31\\g050Primary Objective\\g170Defend Firebase At Nav Gamma\\g370Successful\\n',
      '07:33\\g050Secondary Objective\\g170Destroy All Attacking Units\\g370Successful\\n',
      '08:25\\g050Return Objective\\g170Firebase: Nav Gamma\\g370Successful\\n',
      `\\nMission Completion:${at350(5000)}\\n`,
      `Secondary Objective Completed:\\t\\t1500\\t(x1)${at350(1500)}\\n`,
      '\\t\\t\\t\\t\\t\\tdirect\\ttotal\\n',
      `Enemy Mechs Destroyed:\\t\\t\\t5\\t7${at350(1750)}\\n`,
      `Enemy Vehicles Destoyed:\\t\\t\\t0\\t0${at350(0)}\\n`,
      `Star Underweight Bonus:\\t\\t\\t25\\t(x225 tons)${at350(5625)}\\n`,
      // 704 / 778 * 100 = 90.488... -> '90.5'
      `Hit Percentage:\\t\\t\\t\\t90.5${at350(750)}\\n`,
      `\\nMission Honor:${at350(sum)}\\n`,
      `Difficulty Multiplier:\\t(HARD = 1.3)${at350(total)}\\n`,
      // careerHonor 1500 + 19012
      `\\nCareer Honor:${at350(1500 + total)}\\n`,
    ];
    expect(r.text.split('\\n')).toEqual(lines.join('').split('\\n'));
    // the DBFS page was typing
    expect(r.typed).toBeGreaterThan(0);
    // rank: Trial 1 won with clean options and heat tracking on: + 1 primary succeeded;
    // missionIndex 4 -> 5; killTally += 7 (mechs by anyone) + 0 (own non-mech kills)
    expect(pilotAt(r.registry, 10)).toEqual({ career: 1, missionIndex: 5, rank: 1, careerHonor: 1500 + total, killTally: 7, enemyMechHits: 704, shotsFired: 778 });
    // EXIT after a win: the ready room with the next mission, Jade Falcon 5
    expect(r.next).toBe('rustSCN1');
    expect(r.status).toBe(0xff);
  });

  it('EASY and MEDIUM: the multiplier as the x87 rounds it, at double precision', async () => {
    // not a Trial (fuchSCN1, mission 3): no promotion. sum as above, 14625.
    park('fuchSCN1', 3, dif({ difficulty: 0 }));
    let r = await debrief();
    // 14625 * 0.8 is exactly 11700.00000000000065 with the image's 0.8; the shell's FPU runs at 53
    // bits (control word 0x127f), which rounds it to 11700: - 14625 = -2925 -> 11700. At the x87's
    // 64 bits the excess would survive, -2924.99999999999935 would truncate to -2924, and give 11701.
    expect(r.text).toContain(`Difficulty Multiplier:\\t(EASY = 0.8)${at350(11700)}\\n`);
    expect(pilotAt(r.registry, 10)).toMatchObject({ missionIndex: 4, rank: 0, careerHonor: 1500 + 11700 });
    park('fuchSCN1', 3, dif({ difficulty: 1 }));
    r = await debrief();
    expect(r.text).toContain(`Difficulty Multiplier:\\t(MEDIUM = 1.0)${at350(14625)}\\n`);
    expect(pilotAt(r.registry, 10)).toMatchObject({ missionIndex: 4, careerHonor: 1500 + 14625 });
  });

  it('a failed mission: no honor, no promotion, no advancement - the tallies still count', async () => {
    park('cindSCN1', 4, dif({ difficulty: 2 }), 3);
    const r = await debrief();
    expect(r.text).toContain('\\n\\cMission Failed:  NO HONOR ACQUIRED\\n');
    // no Mission Honor lines without a win
    expect(r.text).not.toContain('Mission Honor:');
    expect(r.text).toContain(`\\nCareer Honor:${at350(1500)}\\n`);
    expect(pilotAt(r.registry, 10)).toEqual({ career: 1, missionIndex: 4, rank: 0, careerHonor: 1500, killTally: 7, enemyMechHits: 704, shotsFired: 778 });
    // EXIT without a win: the ready room, the same mission
    expect(r.next).toBe('cindSCN1');
  });

  it('unlimited ammo (altered reality): no honor, no promotion, no advancement', async () => {
    park('cindSCN1', 4, dif({ ammo: 1, difficulty: 2 }));
    const r = await debrief();
    // the Mission Honor lines are printed, then zeroed
    expect(r.text).toContain('Mission Honor:');
    expect(r.text).toContain('\\n\\cNo Career Advancement with Altered Reality Enabled\\n');
    expect(pilotAt(r.registry, 10)).toMatchObject({ missionIndex: 4, rank: 0, careerHonor: 1500 });
    // a win all the same: EXIT names the pilot's mission, which did not advance
    expect(r.next).toBe('cindSCN1');
  });

  it('heat tracking off: dishonorable - no honor and no promotion, but the mission still advances', async () => {
    park('cindSCN1', 4, dif({ heat: 0, difficulty: 2 }));
    const r = await debrief();
    expect(r.text).toContain('\\n\\cThe Keshik deems it Dishonorable to Alter Heat Tracking\\n');
    expect(r.text).not.toContain('Mission Honor:');
    expect(pilotAt(r.registry, 10)).toMatchObject({ missionIndex: 5, rank: 0, careerHonor: 1500 });
    expect(r.next).toBe('rustSCN1');
  });
});

/** One action of a script: taken `after` frames once `until` holds. */
interface Step {
  until?: () => boolean;
  after?: number;
  act: () => void;
}

/** Runs the pump a frame at a time, taking the script's steps in order. */
async function runSteps(pump: ShellPump, steps: Step[], maxFrames = 6000): Promise<{ status: number; done: number }> {
  let i = 0;
  let waited = 0;
  for (let f = 0; f < maxFrames; f++) {
    const s = steps[i];
    if (s && (!s.until || s.until())) {
      if (waited >= (s.after ?? 0)) {
        s.act();
        i++;
        waited = 0;
      } else waited++;
    }
    if (!pump.frame(1000 / 60)) break;
    await new Promise((r) => setTimeout(r, 0));
  }
  if (pump.error) throw pump.error;
  return { status: pump.status ?? -1, done: i };
}

/** A left click at (x, y), held for 15 frames (see test/sim/shellCareer.test.ts). */
function press(x: number, y: number, until?: () => boolean, after = 30): Step[] {
  return [
    { until, after, act: () => hwMouseMove(x, y) },
    { after: 2, act: () => hwMouseButtons(1) },
    { after: 15, act: () => hwMouseButtons(0) },
  ];
}

describe.runIf(hasGameData && hasShellData)('MECH2 loop through the debriefing, headless', () => {
  let shellExe: ExeImage;
  let simExe: ExeImage;
  let prj: ProjectFile;
  let db: Uint8Array;
  beforeAll(async () => {
    shellExe = ExeImage.fromExe(await gameSource().read('MW2SHELL.EXE'));
    simExe = ExeImage.fromExe(await gameSource().read('MW2.EXE'));
    prj = new ProjectFile(await gameSource().read('MW2.PRJ'));
    db = await gameSource().read('DATABASE.MW2');
  });

  it('register -> hall -> ready room -> briefing -> LAUNCH -> the sim, won -> debriefing -> EXIT -> the next mission launches', async () => {
    // the read-only layer: DATABASE.MW2, and the drivers and controls files the port has on a first run
    const assets = firstRunDisk();
    assets.set('DATABASE.MW2', db);
    setDosFiles(assets);
    setOwnFiles(new Map());
    setOverlayFiles(null);
    setCdDrive(null);
    hardware.keys.length = 0;
    hwMouseMove(320, 240);
    hwMouseButtons(0);
    const cheatWin = readCheatCodes(simExe)[11]!.typed;

    const pump = (arg: string) => new ShellPump(shellMain(['mw2shell.exe', arg]));
    const runs: string[] = [];
    const sims: string[][] = [];
    let result = -1;
    let debriefText = '';
    let reg: Uint8Array | null = null;
    let seen: number[] = [];
    await mech2Main(
      {
        async shell(arg) {
          runs.push(`shell ${arg}`);
          startShellProcess(shellExe, prj);
          // LAUNCH ended the last run with the button held: let go first
          hwMouseMove(0, 0);
          hwMouseButtons(0);
          seen = [];
          const saved = new Map<number, Screen>();
          for (const state of [0, 1, 3, 0xb, 0xc]) {
            const screen = shellScreens.get(state)!;
            saved.set(state, screen);
            shellScreens.register(state, function* (l) {
              seen.push(state);
              return yield* screen(l);
            });
          }
          const at = (state: number, n = 1) => () => seen.filter((s) => s === state).length >= n;
          const steps: Step[] =
            arg === 'intro'
              ? [
                  // the title: WOLF CLAN HALL; the hall sends a pilotless player to the register
                  ...press(530, 300),
                  // slot 1: type a name, Enter; ACCEPT
                  ...press(100, 100, at(0xc)),
                  { after: 10, act: () => hardware.keys.push(0x74, 0x65, 0x73, 0x74, 0x0d) }, // 'test'
                  ...press(344, 462),
                  // the hall: READY ROOM; the ready room: MISSION BRIEFING; the briefing: LAUNCH
                  ...press(55, 330, at(1, 2)),
                  ...press(270, 200, at(0xb)),
                  ...press(320, 462, at(0)),
                ]
              : [
                  // resumed at the debriefing: read it, then EXIT
                  {
                    until: at(3),
                    after: 150,
                    act: () => {
                      debriefText = mem().cstr(SHELL_LABEL.debriefingText);
                      reg = dosFileLoad('MW2REG.CFG');
                    },
                  },
                  ...press(320, 462, undefined, 5),
                  // the ready room, with the next mission: MISSION BRIEFING, then LAUNCH
                  ...press(270, 200, at(0xb)),
                  ...press(320, 462, at(0)),
                ];
          try {
            return (await runSteps(pump(arg), steps)).status;
          } finally {
            for (const [state, screen] of saved) shellScreens.register(state, screen);
          }
        },
        async sim(argv) {
          runs.push('sim');
          sims.push(argv);
          // the second launch is the next mission: stop there (the sim's Flee to DOS ends MECH2's loop)
          if (sims.length > 1) return 0xff;
          expect(bootMission({ exe: simExe, prj, argv })).toBe(true);
          for (let f = 0; f < 3000 && mainLoopRunning(); f++) {
            for (let i = 0; i < 7; i++) ailTimerService();
            mainLoopFrame();
            // the win-the-mission cheat, typed into cheat_handle_command
            if (f === 100) for (let i = 0; i < cheatWin.length; i++) cheatHandleCommand(0x700 | cheatWin.charCodeAt(i));
          }
          const end = missionEnd();
          result = new DataView(dosFileLoad('mw2msn.cfg')!.buffer).getInt32(0x10, true);
          return end.exitStatus;
        },
      },
      splitCommandTail,
    );
    expect(runs).toEqual(['shell intro', 'sim', 'shell sim', 'sim']);
    expect(sims[0]![1]).toBe('yellSCN1');
    // the cheat won it: MW2MSN.CFG's result 2
    expect(result).toBe(2);
    // the second shell run: the debriefing, then the ready room and the briefing
    expect(seen).toEqual([3, 0xb, 0]);
    expect(debriefText).toContain('\\nMission Completion:');
    expect(debriefText).toContain('\\nCareer Honor:');
    // TEST (slot 0, Wolf) advanced to mission 1, and it is what LAUNCH hands the sim next
    const p = pilotAt(reg!, 0);
    expect(p.missionIndex).toBe(1);
    expect(sims[1]![1]).toBe('oranSCN1');
    expect(prmCommandLine(dosFileLoad('mw2prm.cfg')!).startsWith('oranSCN1 -b=')).toBe(true);
  });
});
