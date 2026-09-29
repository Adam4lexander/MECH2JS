// Phase S5's career screens, headless, driven by the int 33h mouse and the
// BIOS keyboard the way a player would: title -> WOLF CLAN HALL -> the
// Clan hall (no pilot accepted: straight to the register) -> a new pilot
// typed into slot 1 -> ACCEPT -> the hall -> READY ROOM -> MISSION
// BRIEFING, which returns state 0 to main; and the Trial of Grievance:
// the next scenario, LAUNCH, and main's state 10 writing mw2prm.cfg, the
// star files and instmap1.bwd. There is no CD and no loose smk\ files, so
// every movie and animation fails to open, as it would without them.
import { beforeAll, describe, expect, it } from 'vitest';
import { ExeImage } from '../../src/data/exe/ExeImage.ts';
import { ProjectFile } from '../../src/data/prj/ProjectFile.ts';
import { dosFileLoad, setCdDrive, setDosFiles, setOverlayFiles, setOwnFiles } from '../../src/engine/dosFiles.ts';
import { startShellProcess } from '../../src/shell/boot.ts';
import { shellMain } from '../../src/shell/main.ts';
import { ShellPump } from '../../src/shell/host/pump.ts';
import { hardware, hwMouseButtons, hwMouseMove } from '../../src/shell/host/hardware.ts';
import { shellScreens, type Screen } from '../../src/shell/screens/registry.ts';
import { prmCommandLine } from '../../src/shell/handoff/prm.ts';
import { SHELL_LABEL } from '../../src/generated/shell/labels.gen.ts';
import { mem } from '../../src/shell/memory.ts';
import { codeInfo, resolveCode } from '../../src/engine/codePtr.ts';
import { shell } from '../../src/shell/state.ts';
import { WIDGET, WIDGET_ROW } from '../../src/shell/ui/widgets.ts';
import { gameSource, hasGameData, hasShellData } from '../support/env.ts';

/** One action of a script: taken `after` frames once `until` holds. */
interface Step {
  until?: () => boolean;
  after?: number;
  act: () => void;
}

/** Runs the pump a frame at a time (letting file reads settle), taking the script's steps in order. */
async function runSteps(pump: ShellPump, steps: Step[], maxFrames = 6000): Promise<{ status: number | null; done: number }> {
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
  return { status: pump.status, done: i };
}

/**
 * A left click at (x, y): move, press two frames later, release fifteen
 * after that. The button is held for several frames because a screen whose
 * animations are missing retries opening them every pass, and each try
 * waits on the disk: a pass then spans several host frames.
 */
function click(x: number, y: number, until?: () => boolean, after = 20): Step[] {
  return [
    { until, after, act: () => hwMouseMove(x, y) },
    { after: 2, act: () => hwMouseButtons(1) },
    { after: 15, act: () => hwMouseButtons(0) },
  ];
}

/** Every state main enters, in order, recorded by wrapping the registered screens. */
function recordStates(): number[] {
  const seen: number[] = [];
  for (const state of [1, 5, 7, 0xb, 0xc, 0xd, 0xe]) {
    const screen = shellScreens.get(state);
    if (!screen) continue;
    shellScreens.register(state, function* (l) {
      seen.push(state);
      return yield* screen(l);
    });
  }
  return seen;
}

/** The PilotRecord at slot i of MW2REG.CFG (README "Careers"). */
function pilotAt(reg: Uint8Array, i: number) {
  const dv = new DataView(reg.buffer, reg.byteOffset + i * 0x3c, 0x3c);
  let name = '';
  for (let k = 0; k < 16 && reg[i * 0x3c + 0x28 + k] !== 0; k++) name += String.fromCharCode(reg[i * 0x3c + 0x28 + k]!);
  return {
    inUse: dv.getInt32(0, true),
    selected: dv.getInt32(4, true),
    career: dv.getInt32(8, true),
    missionIndex: dv.getInt32(0xc, true),
    rank: dv.getInt32(0x10, true),
    careerHonor: dv.getInt32(0x14, true),
    killTally: dv.getInt32(0x18, true),
    name,
  };
}

describe.runIf(hasGameData && hasShellData)('shell career screens', () => {
  let shellExe: ExeImage;
  let prj: ProjectFile;
  let db: Uint8Array;
  beforeAll(async () => {
    shellExe = ExeImage.fromExe(await gameSource().read('MW2SHELL.EXE'));
    prj = new ProjectFile(await gameSource().read('MW2.PRJ'));
    db = await gameSource().read('DATABASE.MW2');
  });

  function start(): ShellPump {
    hwMouseMove(320, 240);
    hwMouseButtons(0);
    hardware.keys.length = 0;
    setDosFiles(new Map([['DATABASE.MW2', db]]));
    setOwnFiles(new Map());
    setOverlayFiles(null);
    setCdDrive(null);
    startShellProcess(shellExe, prj);
    return new ShellPump(shellMain(['mw2shell.exe', 'intro']));
  }

  it('title -> Clan hall -> register a new pilot -> ACCEPT -> hall -> READY ROOM -> MISSION BRIEFING reaches state 0', async () => {
    const seen = recordStates();
    const briefing = shellScreens.get(0);
    let reachedBriefing = false;
    // state 0 (the briefing) is another phase's screen: a probe stands in, and quits
    // eslint-disable-next-line require-yield -- a screen that returns at once
    const probe: Screen = function* () {
      reachedBriefing = true;
      return -3;
    };
    shellScreens.register(0, probe);
    const at = (state: number, n = 1) => () => seen.filter((s) => s === state).length >= n;
    try {
      const pump = start();
      const { status, done } = await runSteps(pump, [
        // the title: WOLF CLAN HALL (button 1, 427..634 x 245..373)
        ...click(530, 300, undefined, 30),
        // the hall sends a pilotless player to the register; slot 1 (32..297 x 83..116) is empty: type a name
        ...click(100, 100, at(0xc), 30),
        { after: 10, act: () => hardware.keys.push(0x74, 0x65, 0x73, 0x74, 0x0d) }, // 'test' Enter
        // ACCEPT (294..393 x 450..474)
        ...click(344, 462, undefined, 30),
        // the hall again, with a pilot: READY ROOM (20..90 x 245..411)
        ...click(55, 330, at(1, 2), 30),
        // the ready room: MISSION BRIEFING (140..399 x 90..313)
        ...click(270, 200, at(0xb), 30),
      ]);
      // the last release comes after the program has ended
      expect(done).toBe(15);
      expect(seen).toEqual([1, 0xc, 1, 0xb]);
      expect(reachedBriefing).toBe(true);
      // the probe's -3: main quits through prm_save(-3, ..., 'exittos')
      expect(status).toBe(0xff);
      expect(prmCommandLine(dosFileLoad('mw2prm.cfg')!).startsWith('exittos -b=')).toBe(true);
      // MW2REG.CFG: 20 records of 0x3c; slot 0 is the new Wolf pilot, upper-cased, selected, mission 0
      const reg = dosFileLoad('MW2REG.CFG')!;
      expect(reg.length).toBe(0x3c * 20);
      const p = pilotAt(reg, 0);
      expect(p).toMatchObject({ inUse: 1, selected: 1, career: 0, missionIndex: 0, rank: 0, killTally: 0, name: 'TEST' });
      expect(p.careerHonor).toBeGreaterThanOrEqual(1000);
      expect(p.careerHonor).toBeLessThanOrEqual(2000);
      // PILOT INFO was laid out in place: its relative rows now hold absolute y's - the RANK
      // heading at y 209 and its value (y 0x80000013) one heading line (font28, 16 px) plus 3 px
      // below it; then HONOR (0x80000022) two value lines (font27) plus 2 px below that
      const rowY = (i: number) => mem().i32(SHELL_LABEL.registerPilotInfoPanel + i * WIDGET_ROW + WIDGET.y);
      const rowH = (i: number) => mem().i32(SHELL_LABEL.registerPilotInfoPanel + i * WIDGET_ROW + WIDGET.h);
      expect(shell.font28!.height).toBe(16);
      expect(rowY(1)).toBe(209);
      expect(rowH(1)).toBe(shell.font28!.height);
      expect(rowY(2)).toBe(209 + 16 + 3);
      expect(rowH(2)).toBe(shell.font27!.height);
      expect(rowY(3)).toBe(rowY(2) + 2 * shell.font27!.height + 2);
      for (let i = 0; i < 7; i++) expect(rowY(i)).toBeGreaterThan(0);
      // the rest are the fresh registry: empty, slots 10..19 Jade Falcon
      for (let i = 1; i < 20; i++) expect(pilotAt(reg, i)).toMatchObject({ inUse: 0, career: i > 9 ? 1 : 0, name: '' });
    } finally {
      if (briefing) shellScreens.register(0, briefing);
    }
  });

  it('FREEBIRTHTOAD: the ready room offers every mission; SABLE sets missionIndex 5 and briefs sablSCN1', async () => {
    const seen = recordStates();
    const briefing = shellScreens.get(0);
    let briefed: string | null = null;
    // eslint-disable-next-line require-yield -- a screen that returns at once
    const probe: Screen = function* (l) {
      briefed = l.commandLine.value;
      return -3;
    };
    shellScreens.register(0, probe);
    try {
      const pump = start();
      // a registry whose slot 0 is the selected Wolf pilot FREEBIRTHTOAD
      const reg = new Uint8Array(0x3c * 20);
      const dv = new DataView(reg.buffer);
      for (let i = 10; i < 20; i++) dv.setInt32(i * 0x3c + 8, 1, true);
      dv.setInt32(0, 1, true);
      dv.setInt32(4, 1, true);
      reg.set(Array.from('FREEBIRTHTOAD', (c) => c.charCodeAt(0)), 0x28);
      setOwnFiles(new Map([['MW2REG.CFG', reg]]));
      const { status } = await runSteps(pump, [
        ...click(530, 300, undefined, 30),
        // the register comes up with FREEBIRTHTOAD selected: ACCEPT
        ...click(344, 462, () => seen.includes(0xc), 30),
        ...click(55, 330, () => seen.filter((s) => s === 1).length >= 2, 30),
        // SABLE, button 9 (400..519 x 175..199)
        ...click(460, 187, () => seen.includes(0xb), 30),
      ]);
      expect(seen).toEqual([1, 0xc, 1, 0xb]);
      expect(briefed).toBe('sablSCN1');
      expect(status).toBe(0xff);
      expect(pilotAt(dosFileLoad('MW2REG.CFG')!, 0)).toMatchObject({ inUse: 1, selected: 1, missionIndex: 5, name: 'FREEBIRTHTOAD' });
    } finally {
      if (briefing) shellScreens.register(0, briefing);
    }
  });

  it("every row of the register's panels has its draw and click functions ported", () => {
    startShellProcess(shellExe, prj);
    for (const [table, rows] of [
      [SHELL_LABEL.registerPilotInfoPanel, 7],
      [SHELL_LABEL.registerMissionListPanel, 18],
    ] as const) {
      for (let i = 0; i < rows; i++) {
        const row = table + i * WIDGET_ROW;
        for (const f of ['drawFn', 'clickFn'] as const) {
          const addr = mem().u32(row + WIDGET[f]);
          if (addr !== 0) expect(codeInfo(resolveCode(addr, 'mw2shell'))?.address).toBe(addr);
        }
      }
      expect(mem().i32(table + rows * WIDGET_ROW + WIDGET.x)).toBe(-1);
    }
  });

  it('Trial of Grievance: the next scenario, then LAUNCH writes mw2prm.cfg, the star files and instmap1.bwd', async () => {
    const seen = recordStates();
    const pump = start();
    const { status, done } = await runSteps(pump, [
      // the title: TRIALS OF GRIEVANCE (button 0, 219..426 x 294..419)
      ...click(320, 350, undefined, 30),
      // the scenario button (238..400 x 67..102): jackscn1 -> chedscn1
      ...click(300, 85, () => seen.includes(7), 30),
      // LAUNCH (209..420 x 371..452)
      ...click(300, 400, undefined, 20),
    ]);
    // the release after LAUNCH comes after the program has ended
    expect(done).toBe(8);
    expect(seen).toEqual([7]);
    // state 10 saves the state to come back to (7) and exits with 3 for MECH2 to run the mission
    expect(status).toBe(3);
    const prm = dosFileLoad('mw2prm.cfg')!;
    const line = prmCommandLine(prm);
    expect(line.startsWith('chedscn1 -b=')).toBe(true);
    expect(line).toMatch(/ -of=\S+ -oe=\S+$/);
    const dv = new DataView(prm.buffer, prm.byteOffset);
    expect(dv.getInt32(0, true)).toBe(7); // resumeState
    expect(dv.getInt32(4, true)).toBe(2); // career: the Trial of Grievance
    const tag = (b: Uint8Array | null) => (b ? String.fromCharCode(b[0]!, b[1]!, b[2]!) : null);
    expect(tag(dosFileLoad('INSTMAP1.BWD'))).toBe('BWD');
    expect(tag(dosFileLoad('USERSTAR.BWD'))).toBe('BWD');
    for (let i = 1; i <= 5; i++) expect(tag(dosFileLoad(`EN0${i}STAR.BWD`))).toBe('BWD');
  });
});
