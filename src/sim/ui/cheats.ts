/**
 * MW2.EXE's cheat codes: every typed key goes into a 15-key ring
 * (cheatKeyHistory, 0x152984) and the ring's tail is compared with each
 * stored code (XOR 0x1a; data/exe/tables/cheats.ts). decompiled/mw2/src/ui/
 * cheats.c.
 */
import { registerGlobals } from '../../engine/globals.ts';
import { bootImage } from '../../engine/image.ts';
import { clock } from '../../engine/clock.ts';
import { unestablished } from '../../core/provenance.ts';
import { CHEAT_CODE_ADDRESSES, cheatMatch } from '../../data/exe/tables/cheats.ts';
import { results } from '../../mission/results.ts';
import { ai } from '../ai/aiGlobals.ts';
import { damageDisplay } from '../cockpit/damageDisplay.ts';
import { messagePost } from '../cockpit/messages.ts';
import { radar } from '../cockpit/radar.ts';
import { renderOptions } from '../display/renderState.ts';
import { mainView } from '../display/mainView.ts';
import { nukeDetonate } from '../effects/effects.ts';
import { mechOnDestroyed } from '../mech/damage.ts';
import { mechs } from '../mech/mechGlobals.ts';
import { mechRuntime } from '../mech/mechRuntime.ts';
import { cameraSetMode } from '../mech/mechTickAi.ts';
import { commandExecute, commandGlobals } from './commands.ts';

export const cheats = registerGlobals(
  'cheats',
  {
    /** 0x152984..0x152992: the last 15 keys typed, oldest first */
    cheatKeyHistory: new Uint8Array(15),
  },
  () => {
    cheats.cheatKeyHistory = new Uint8Array(15);
  },
);

/** A message string of the image's (its address is in the code). */
function text(addr: number): string {
  return bootImage()?.cstrAt(addr) ?? '';
}

/** The stored codes, in the order cheat_handle_command tests them. */
function code(i: number): string {
  return bootImage()?.cstrAt(CHEAT_CODE_ADDRESSES[i]!) ?? 'ÿ';
}

/**
 * The player's targeted mech: the index half of its targetHandle when the
 * type half is a mech (0x200), else -1.
 *
 * @mw2 player_target_mech_index 0x0002a930
 * @fidelity exact
 */
export function playerTargetMechIndex(): number {
  const h = mechs.mechTable[mechs.playerMechIndex]!.targetHandle;
  return (h & 0xf00) !== 0x200 ? -1 : h & 0xff;
}

/**
 * A typed key (0x07xx) goes into the ring; the ring's tail is matched
 * against the 21 codes, in order: invulnerability, unlimited ammo, heat
 * tracking, 'F E I F', the "You asked for it" hook swap, the nuke on the
 * targeted mech, jumpjets, forward rear view, a refusal, destroy the
 * target, hangAround, win the mission, "This ain't DOOM" (command 0x3b),
 * friendly allies, the time-compression key, bounding spheres, infinite
 * jumpjet fuel, a refusal, free eye, X-ray, time expansion. Each toggles or
 * sets its flag and posts its message.
 *
 * @mw2 cheat_handle_command 0x00045780
 * @fidelity partial
 * @divergence code 4's hook swap (ui_callbacks_sub_01a820) is not established and not done; free eye's message font is a register the export lost (1 is used)
 */
export function cheatHandleCommand(key: number): number {
  if ((key & 0xff00) !== 0x700) return 0;
  const h = cheats.cheatKeyHistory;
  h.copyWithin(0, 1);
  h[14] = key & 0xff;
  const is = (i: number) => cheatMatch(code(i), h);
  const opts = mechs.simOptions;
  const post = (addr: number, ticks = 0x16c, prio = 0x32) => messagePost(text(addr), 1, ticks, prio);
  if (is(0)) {
    if (opts.invulnerability === 0) {
      opts.invulnerability = 1;
      return post(0x91800);
    }
    opts.invulnerability = 0;
    return post(0x91814);
  }
  if (is(1)) {
    if (opts.unlimitedAmmo !== 0) {
      opts.unlimitedAmmo = 0;
      return post(0x91840);
    }
    opts.unlimitedAmmo = 1;
    return post(0x9182c);
  }
  if (is(2)) {
    if (opts.heatTracking !== 0) {
      opts.heatTracking = 0;
      return post(0x91874);
    }
    opts.heatTracking = 1;
    return post(0x91860);
  }
  if (is(3)) return post(0x9188c);
  if (is(4)) {
    unestablished('cheat 4: ui_callbacks_sub_01a820 swaps the main-view hook (0x959b8) for LAB_00019f40 - not read', 'cheat_handle_command');
    return post(0x9189c);
  }
  if (is(5)) {
    const t = playerTargetMechIndex();
    if (t >= 0) nukeDetonate(mechs.mechTable[t]!);
    return t;
  }
  if (is(6)) {
    mechs.playerControls.cheatJumpjets = 1;
    return post(0x918c4);
  }
  if (is(7)) {
    if (damageDisplay.rearViewForward !== 0) {
      damageDisplay.rearViewForward = 0;
      return post(0x918f8);
    }
    damageDisplay.rearViewForward = 1;
    return post(0x918d8);
  }
  if (is(8)) return post(0x91924);
  if (is(9)) {
    const t = playerTargetMechIndex();
    if (t >= 0) mechOnDestroyed(mechs.mechTable[t]!.loadout!);
    return t;
  }
  if (is(10)) {
    commandGlobals.hangAround = commandGlobals.hangAround === 0 ? 1 : 0;
    return commandGlobals.hangAround !== 0 ? post(0x9197c, 0xb6) : post(0x91964, 0xb6);
  }
  if (is(11)) {
    results.cheatWinMission = 1;
    return 1;
  }
  if (is(12)) {
    post(0x919a4, 0x16c, 0x50);
    commandExecute(0x3b);
    return 0;
  }
  if (is(13)) {
    ai.cheatFriendlyAllies = ai.cheatFriendlyAllies === 0 ? 1 : 0;
    return post(0x919c4, 0xb6);
  }
  if (is(14)) {
    commandGlobals.crackModeEnabled = commandGlobals.crackModeEnabled === 0 ? 1 : 0;
    return commandGlobals.crackModeEnabled !== 0 ? post(0x91a20, 0xb6) : post(0x91a00, 0xb6);
  }
  if (is(15)) {
    damageDisplay.diagramRegionFrames = damageDisplay.diagramRegionFrames === 0 ? 1 : 0;
    mainView.dat000954e0 = mainView.dat000954e0 === 0 ? 1 : 0;
    return post(0x91a4c);
  }
  if (is(16)) {
    if (mechRuntime.cheatInfiniteJumpjets !== 0) {
      mechRuntime.cheatInfiniteJumpjets = 0;
      return post(0x91a88);
    }
    mechRuntime.cheatInfiniteJumpjets = 1;
    return post(0x91a6c);
  }
  if (is(17)) return post(0x91aac);
  if (is(18)) {
    cameraSetMode(2);
    radar.freeEyeCentre = 1;
    return post(0x91ae4);
  }
  if (is(19)) {
    renderOptions.wireframeMode = 2;
    renderOptions.wireframeColourScheme = 0;
    return post(0x91b00);
  }
  if (!is(20)) return 0;
  clock.timeExpansion = clock.timeExpansion === 0 ? 1 : 0;
  return clock.timeExpansion !== 0 ? post(0x91b20) : post(0x91b38);
}
