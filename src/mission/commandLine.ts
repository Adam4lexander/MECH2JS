/**
 * MW2.EXE's command line: what the shell put in mw2prm.cfg +0x118 and MECH2
 * passed on - the mission's scenario name and the shell's options (-b= the
 * launch animation, -of= / -oe= the formations). check_launched_by_shell
 * (decompiled/mw2/src/netplay/netplay.c) reads it for main.
 */
import { LABEL } from '../generated/labels.gen.ts';
import { registerGlobals } from '../engine/globals.ts';
import { bootImage, imageI32 } from '../engine/image.ts';
import { systemError } from '../core/systemError.ts';
import { divergence, unestablished } from '../core/provenance.ts';
import { commandGlobals } from '../sim/ui/commands.ts';
import { clock } from '../engine/clock.ts';
import { logGlobals } from '../engine/logWrite.ts';
import { mechs } from '../sim/mech/mechGlobals.ts';
import { formations } from '../sim/groups/formations.ts';
import { streams } from './vm/streams.ts';

/** The image's string at the pointer stored at `label`, or `fallback` before an image is loaded. */
function imageStrPtr(label: number, fallback: string): string {
  return bootImage()?.strPtr(label) ?? fallback;
}

export const launchArgs = registerGlobals(
  'launchArgs',
  {
    /** 0xa5608: the first launch animation's file stem (-B=), 'supanm' by default */
    launchAnimNameB: 'supanm',
    /** 0xa5604: the second launch file's stem (-G=), 'launch' by default */
    launchAnimNameG: 'launch',
    /** 0x95874: -D - main installs no crash handlers */
    noCrashHandlers: 0,
    /** 0x9e9cc: -J=path - the project file to open instead of MW2.PRJ; null for the default */
    projectOpenPath: null as string | null,
    /** 0x1528f0 bit 0 and 0x1528f4: -VG[=name], the video driver to load (the port draws with its own) */
    videoDriverFlags: 0,
    videoDriverName: '',
  },
  () => {
    const a = launchArgs;
    a.launchAnimNameB = imageStrPtr(LABEL.launchAnimNameB, 'supanm');
    a.launchAnimNameG = imageStrPtr(LABEL.launchAnimNameG, 'launch');
    a.noCrashHandlers = imageI32(LABEL.noCrashHandlers, 0);
    a.projectOpenPath = null;
    a.videoDriverFlags = 0;
    a.videoDriverName = '';
  },
);

/**
 * Splits a DOS command tail into argv the way the C runtime's startup does
 * for a spawned program: at runs of spaces and tabs.
 *
 * @portOnly the Watcom startup's argument split (not traced in the binary; see decompiled/mech2/README.md)
 */
export function splitCommandTail(program: string, tail: string): string[] {
  return [program, ...tail.split(/[ \t]+/).filter((s) => s.length > 0)];
}

/** The part of an option after its first '=', or null when it has none. */
function afterEquals(arg: string): string | null {
  const i = arg.indexOf('=');
  return i < 0 ? null : arg.slice(i + 1);
}

/**
 * Reads MW2.EXE's arguments. Each one starting '-' or '/' is an option,
 * dispatched on its upper-cased second letter; any other is copied over
 * `args` (so the last one wins) - the scenario main loads. With argc 1 it
 * prints "This program must be launched from MECH2.EXE". Returns ok false
 * only for -V (not -VG), and main then exits.
 *
 *   -B=name  launchAnimNameB     -G=name  launchAnimNameG
 *   -C       flags[0] = 1        -S       flags[1] = 0
 *   -D       noCrashHandlers, hangAround
 *   -E       projectTraceEnabled (and opens mw2debug.txt)
 *   -F[=n]   simFrameMinTicks = 182 / n (n 10 by default)
 *   -J=path  projectOpenPath, then falls into -L
 *   -L       logEnabled          -N       netGameEnabled
 *   -OE=f / -OF=f  formationOverrideEnemy / formationOverridePlayer
 *   -P       looseFilesFirst     -R       keepPlayerControls
 *   -M, -X   the mono debug display (and hangAround; -X falls into -S)
 *   -Q       disable_ground_quadtrees
 *   -VG[=n]  the video driver    -V       print_version, and exit
 *   anything else: system_error 10
 *
 * @mw2 check_launched_by_shell 0x00044290
 * @fidelity partial
 * @divergence -M / -X's mono display, -Q's quadtree switch-off, -E's mw2debug.txt and the version text are not ported; their flags are still set
 */
export function checkLaunchedByShell(argv: readonly string[], flags: [number, number] = [0, 1]): { ok: boolean; args: string } {
  let ok = argv.length !== 1;
  if (argv.length === 1) divergence('This program must be launched from MECH2.EXE', 'check_launched_by_shell');
  // args starts as the (empty) string at 0x91774
  let args = '';
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i]!;
    if (a[0] !== '/' && a[0] !== '-') {
      args = a;
      continue;
    }
    const letter = (a.charCodeAt(1) || 0) & 0xff;
    const up = letter >= 0x61 && letter <= 0x7a ? letter - 0x20 : letter;
    switch (up - 0x42) {
      case 0: {
        const v = afterEquals(a);
        if (v !== null) launchArgs.launchAnimNameB = v;
        break;
      }
      case 1:
        flags[0] = 1;
        break;
      case 2:
        launchArgs.noCrashHandlers = 1;
        commandGlobals.hangAround = 1;
        break;
      case 3:
        unestablished('-E: mw2debug.txt is not opened; the trace goes to the port log', 'check_launched_by_shell');
        streams.projectTraceEnabled = 1;
        break;
      case 4: {
        let n = 10;
        if (a[2] === '=') n = parseInt(a.slice(3), 10) || 0;
        // 0xb6 / n as a 64-bit division: n = 0 faults in the original
        if (n === 0) throw new RangeError('check_launched_by_shell: -F=0 divides by zero');
        clock.simFrameMinTicks = Math.trunc(0xb6 / n) | 0;
        break;
      }
      case 5: {
        const v = afterEquals(a);
        if (v !== null) launchArgs.launchAnimNameG = v;
        break;
      }
      case 8:
        if (a[2] === '=') launchArgs.projectOpenPath = a.slice(3);
        // the original falls through into -L: -J also turns on logging
        logGlobals.logEnabled = 1;
        break;
      case 10:
        logGlobals.logEnabled = 1;
        break;
      case 0xb:
        // input_sub_049050(.., 1): the mono debug display
        commandGlobals.hangAround = 1;
        break;
      case 0xc:
        mechs.netGameEnabled = 1;
        break;
      case 0xd: {
        const c3 = a.charCodeAt(3) || 0;
        const c2 = (a.charCodeAt(2) || 0) & 0xff;
        const u2 = c2 >= 0x61 && c2 <= 0x7a ? c2 - 0x20 : c2;
        if (c3 === 0x3d && u2 > 0x44) {
          if (u2 < 0x46) formations.formationOverrideEnemy = a.slice(4);
          else if (u2 === 0x46) formations.formationOverridePlayer = a.slice(4);
        }
        break;
      }
      case 0xe:
        streams.looseFilesFirst = 1;
        break;
      case 0xf:
        // disable_ground_quadtrees: a developer switch the port does not have
        break;
      case 0x10:
        mechs.keepPlayerControls = 1;
        break;
      case 0x14: {
        const c2 = (a.charCodeAt(2) || 0) & 0xff;
        if ((c2 >= 0x61 && c2 <= 0x7a ? c2 - 0x20 : c2) === 0x47) {
          launchArgs.videoDriverFlags |= 1;
          const v = afterEquals(a);
          launchArgs.videoDriverName = v === null ? '' : v.slice(0, 0xc);
        } else {
          // print_version
          ok = false;
        }
        break;
      }
      case 0x16:
        // input_sub_049050: the mono debug display
        commandGlobals.hangAround = 1;
        flags[1] = 0;
        break;
      case 0x11:
        flags[1] = 0;
        break;
      default:
        systemError(10, a);
    }
  }
  // hud_debug_sub_049900(args) shows them on the mono display
  return { ok, args };
}
