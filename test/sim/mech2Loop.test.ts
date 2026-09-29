// Phase S1's exit check: MECH2's loop with the shell's handoff code and the
// sim, headless. The shell (its screens stubbed) writes mw2prm.cfg and the
// star files; MECH2 passes the prm's command line to the sim, which reads
// the star and the shell's options through check_launched_by_shell, plays,
// and leaves mw2msn.cfg / MW2CAR.CFG; the shell comes back with 'sim' and
// resumes at the state it parked.
import { beforeAll, describe, expect, it } from 'vitest';
import { ExeImage } from '../../src/data/exe/ExeImage.ts';
import { ProjectFile } from '../../src/data/prj/ProjectFile.ts';
import { ailTimerService } from '../../src/engine/miles/ail.ts';
import { dosFileLoad, setDosFiles, setOverlayFiles, setOwnFiles } from '../../src/engine/dosFiles.ts';
import { SHELL_LABEL } from '../../src/generated/shell/labels.gen.ts';
import { mech2Main } from '../../src/launcher/mech2.ts';
import { checkLaunchedByShell, launchArgs, splitCommandTail } from '../../src/mission/commandLine.ts';
import { missionEnd } from '../../src/mission/end.ts';
import { bootMission } from '../../src/mission/load.ts';
import { mainLoopFrame, mainLoopRunning } from '../../src/mission/mainLoop.ts';
import { mechAllegiance } from '../../src/sim/groups/groups.ts';
import { formations } from '../../src/sim/groups/formations.ts';
import { mechOnDestroyed } from '../../src/sim/mech/damage.ts';
import { mechs } from '../../src/sim/mech/mechGlobals.ts';
import { streams } from '../../src/mission/vm/streams.ts';
import { resetAllGlobals } from '../../src/engine/globals.ts';
import { startShellProcess } from '../../src/shell/boot.ts';
import { careerRegistryLoad, careerRegistrySave } from '../../src/shell/career/registry.ts';
import { prmLoad, prmSave } from '../../src/shell/handoff/prm.ts';
import { starConfigure, starSetMember } from '../../src/shell/handoff/stars.ts';
import { mem } from '../../src/shell/memory.ts';
import { firstRunDisk, gameSource, hasGameData, hasShellData } from '../support/env.ts';

describe('check_launched_by_shell', () => {
  it('takes the scenario and the shell options', () => {
    resetAllGlobals();
    const r = checkLaunchedByShell(splitCommandTail('mw2.exe', 'yellscn1 -b=ljftria -of=echelonl -oe=wedge -P -f=20'));
    expect(r).toEqual({ ok: true, args: 'yellscn1' });
    expect(launchArgs.launchAnimNameB).toBe('ljftria');
    expect([formations.formationOverridePlayer, formations.formationOverrideEnemy]).toEqual(['echelonl', 'wedge']);
    expect(streams.looseFilesFirst).toBe(1);
  });

  it('-V stops main; the last plain argument wins', () => {
    resetAllGlobals();
    expect(checkLaunchedByShell(['mw2.exe', 'a', 'b', '-v'])).toEqual({ ok: false, args: 'b' });
    expect(checkLaunchedByShell(['mw2.exe'])).toEqual({ ok: false, args: '' });
  });
});

describe.runIf(hasGameData && hasShellData)('MECH2 loop, headless', () => {
  let exe: ExeImage;
  let shellExe: ExeImage;
  let prj: ProjectFile;
  beforeAll(async () => {
    const src = gameSource();
    exe = ExeImage.fromExe(await src.read('MW2.EXE'));
    shellExe = ExeImage.fromExe(await src.read('MW2SHELL.EXE'));
    prj = new ProjectFile(await src.read('MW2.PRJ'));
  });

  it('shell -> mw2prm.cfg -> sim -> mw2msn.cfg -> shell resumes', async () => {
    // the read-only layer: the drivers and controls files the port has on a first run
    setDosFiles(firstRunDisk());
    setOwnFiles(new Map());
    setOverlayFiles(null);

    const seen: { argv?: string[]; player?: string; formation?: string | null; anim?: string; resumed?: number; runs: string[] } = { runs: [] };
    await mech2Main(
      {
        async shell(arg) {
          seen.runs.push(`shell ${arg}`);
          startShellProcess(shellExe, prj);
          careerRegistryLoad();
          if (arg === 'intro') {
            // what the screens would do: a pilot, a star, the briefing's SUPS, then state 10's prm_save
            mem().setI32(SHELL_LABEL.currentPilot, SHELL_LABEL.pilotRegistry);
            careerRegistrySave();
            starConfigure(0, 0, 3, 0, 100);
            starSetMember(0, 'tbr00std', 'ADAM');
            starConfigure(1, 0, 3, 0, 100);
            starConfigure(0, -1, -1, -1, -1);
            mem().strcpy(SHELL_LABEL.launchAnimName, 'supanm');
            prmSave(3, 0, 1, 'blonscn1');
            return 3;
          }
          seen.resumed = prmLoad()!.state;
          return 0xff;
        },
        async sim(argv) {
          seen.runs.push('sim');
          seen.argv = argv;
          expect(bootMission({ exe, prj, argv })).toBe(true);
          seen.player = mechs.mechTable[mechs.playerMechIndex]!.name;
          seen.formation = formations.formationOverridePlayer;
          seen.anim = launchArgs.launchAnimNameB;
          for (let f = 0; f < 3000 && mainLoopRunning(); f++) {
            for (let i = 0; i < 7; i++) ailTimerService();
            mainLoopFrame();
            if (f === 200) for (let i = 0; i < mechs.mechCount; i++) if (mechAllegiance(i) === 1) mechOnDestroyed(mechs.mechTable[i]!.loadout!);
          }
          return missionEnd().exitStatus;
        },
      },
      splitCommandTail,
    );

    expect(seen.runs).toEqual(['shell intro', 'sim', 'shell sim']);
    expect(seen.argv).toEqual(['mw2.exe', 'blonscn1', '-b=supanm', '-of=echelonl']);
    expect(seen.anim).toBe('supanm');
    expect(seen.formation).toBe('echelonl');
    expect(seen.resumed).toBe(3);
    const msn = dosFileLoad('mw2msn.cfg')!;
    expect(msn.length).toBe(0x9d4);
    expect(String.fromCharCode(...msn.slice(0, 4))).toBe('MW2M');
    expect(new DataView(msn.buffer).getUint32(0x10, true)).toBe(2);
    expect(dosFileLoad('MW2CAR.CFG')!.length).toBe(0x50);
    expect(dosFileLoad('mw2snd.cfg')!.length).toBe(0x3c);
    expect(dosFileLoad('USERSTAR.BWD')).not.toBeNull();
    // BLONSCN1 includes USERSTAR.BWD: the player is the pilot the shell wrote
    expect(seen.player).toBe('ADAM');
  });
});
