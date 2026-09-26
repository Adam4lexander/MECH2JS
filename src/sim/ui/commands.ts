/**
 * The player's keyboard commands: command_execute switches on the command
 * id GAMEKEY.MAP bound to the key pressed (commandNames, listing/commands.txt).
 * Most set a control latch or a request the tick hooks answer; the ones
 * that belong to the HUD, radar, menus and weapons are reported and
 * dropped until their phases.
 */
import { divergence } from '../../core/provenance.ts';
import { LABEL } from '../../generated/labels.gen.ts';
import { clock } from '../../engine/clock.ts';
import { registerGlobals } from '../../engine/globals.ts';
import { imageI32 } from '../../engine/image.ts';
import { timerSetPaused } from '../../engine/timer.ts';
import { cameraGetMode } from '../camera/viewer.ts';
import { cameraTrackCycle } from '../camera/cameraUpdate.ts';
import { messagePost } from '../cockpit/messages.ts';
import { mechEject } from '../mech/laterPhases.ts';
import { cameraSetMode } from '../mech/mechTickAi.ts';
import { mechs } from '../mech/mechGlobals.ts';
import { mechRuntime } from '../mech/mechRuntime.ts';
import { net } from '../net/netplay.ts';
import { soundPlay } from '../sound/sound.ts';
import { ui, uiContextActive } from './uiContext.ts';

export const commandGlobals = registerGlobals(
  'commands',
  {
    /** 0x96c24 */
    punchInAutoHeadingRequest: 0,
    /** 0x982e4 */
    shutdownOverrideRequest: 0,
    /** 0x982f8: the -H option (debug commands) */
    hangAround: 0,
    /** 0x982fc */
    crackModeEnabled: 0,
    /**
     * @portOnly PAUSE_GAME's wait (cheats_sub_046ac0): the original spins in
     * input_poll_controls until a key arrives; the port's host polls once a
     * frame while this is set (see mission/mainLoop.ts).
     */
    keyPauseActive: 0,
  },
  () => {
    const g = commandGlobals;
    g.punchInAutoHeadingRequest = imageI32(LABEL.punchInAutoHeadingRequest, 0);
    g.shutdownOverrideRequest = imageI32(LABEL.shutdownOverrideRequest, 0);
    g.hangAround = imageI32(LABEL.hangAround, 0);
    g.crackModeEnabled = imageI32(LABEL.crackModeEnabled, 0);
    g.keyPauseActive = 0;
  },
);

/**
 * PAUSE_GAME: unless the pause menu is up or this is a network game, stops
 * the sim clock and waits for a key.
 *
 * @mw2 cheats_sub_046ac0 0x00046ac0
 * @fidelity partial
 * @divergence the wait is split across host frames (keyPauseActive) instead of a blocking loop; the PAUSED shape is not drawn and the sounds are Phase 7
 */
export function cheatsSub046ac0(): void {
  if (uiContextActive(4) === 0 && net.netRole === 0) {
    timerSetPaused(0x80, 1);
    commandGlobals.keyPauseActive = 1;
  }
}

/** @portOnly the end of cheats_sub_046ac0's wait: a key arrived */
export function keyPauseEnd(): void {
  commandGlobals.keyPauseActive = 0;
  if (net.netRole === 0) timerSetPaused(0x80, 0);
}

/**
 * The player command dispatcher.
 *
 * @mw2 command_execute 0x00046060
 * @fidelity partial
 * @divergence the HUD, radar, menu, weapon-group, screenshot and vision commands are Phase 4 and reported, not run; debug commands (hangAround) are not ported
 */
export function commandExecute(cmd: number): void {
  const pc = mechs.playerControls;
  const r = mechRuntime;
  const g = commandGlobals;
  let throttle = -1;
  const later = (what: string) => divergence(`command 0x${cmd.toString(16)} (${what}) is not ported yet`, 'command_execute');
  switch (cmd) {
    case 0:
      break;
    case 1:
      pc.torso_tilt_reset = 1;
      pc.torso_pan_reset = 1;
      pc.pilot_tilt_reset = 1;
      pc.pilot_pan_reset = 1;
      pc.eyepoint_tilt_reset = 1;
      pc.eyepoint_pan_reset = 1;
      break;
    case 9:
      // vfx_video_sub_012370 (video state 4) is never true in the port
      if (cameraGetMode() === 0) {
        cameraSetMode(1);
        cameraTrackCycle(0, 1);
      } else {
        cameraSetMode(0);
        pc.pilot_tilt_reset = 1;
        pc.pilot_pan_reset = 1;
        pc.zoom_factor_reset = 1;
      }
      break;
    case 0x11:
      r.alignLegsToTorso = 1;
      break;
    case 0x12:
      pc.inspect_target = 1;
      break;
    case 0x14:
      r.jettisonAmmoRequest = 1;
      break;
    case 0x17:
      pc.zoom_factor_reset = 1;
      break;
    case 0x1a:
    case 0x1b:
    case 0x1c:
    case 0x1d:
    case 0x1e:
    case 0x1f:
    case 0x20:
    case 0x21:
    case 0x22:
    case 0x23:
      throttle = cmd - 0x1a;
      break;
    case 0x24:
      pc.advance_gamething = 1;
      break;
    case 0x25:
      pc.previous_gamething = 1;
      break;
    case 0x26:
      pc.reset_gamething = 1;
      break;
    case 0x28:
      pc.advance_nav = 1;
      break;
    case 0x29:
      pc.previous_nav = 1;
      break;
    case 0x2a:
      pc.reset_nav = 1;
      break;
    case 0x2b:
      pc.advance_gamepiece = 1;
      break;
    case 0x2c:
      pc.previous_gamepiece = 1;
      break;
    case 0x2d:
      pc.reset_gamepiece = 1;
      break;
    case 0x3b:
      mechEject(mechs.mechTable[mechs.playerMechIndex]!.loadout!, 1);
      break;
    case 0x3c:
      if (((mechs.mechTable[mechs.playerMechIndex]!.flags >> 8) & 0x20) !== 0) {
        if (r.autoEjectEnabled === 0) {
          r.autoEjectEnabled = 1;
          messagePost('Automatic ejection ON', 1, 0x16c);
        } else {
          r.autoEjectEnabled = 0;
          messagePost('Automatic ejection OFF', 1, 0x16c);
        }
      }
      break;
    case 0x3d:
    case 0x3e:
      r.reactorRequest = mechs.mechTable[mechs.playerMechIndex]!.loadout!.status === 3 ? 1 : -1;
      break;
    case 0x3f:
      pc.reverseDirection = pc.reverseDirection === 0 ? 1 : 0;
      break;
    case 0x40:
      g.shutdownOverrideRequest = 1;
      break;
    case 0x42:
      pc.autopilot = 1;
      break;
    case 0x43:
      pc.toggle_group_fire = 1;
      break;
    case 0x44:
      pc.advance_target = 1;
      break;
    case 0x45:
      pc.previous_target = 1;
      break;
    case 0x46:
      pc.reset_target = 1;
      break;
    case 0x47:
      pc.nearest_enemy = 1;
      break;
    case 0x48:
      pc.target_friendly = 1;
      break;
    case 0x49:
      pc.target_reticle = 1;
      break;
    case 0x4a:
      pc.target_last_shot = 1;
      break;
    case 0x4b:
      pc.nextObjective = 1;
      break;
    case 0x4c:
      g.punchInAutoHeadingRequest = 1;
      break;
    case 0x4d:
      r.mascToggleRequest = 1;
      break;
    case 0x4e:
      pc.self_destruct = 1;
      break;
    case 0x4f:
      cheatsSub046ac0();
      break;
    case 0x50:
      ui.quitCountdown = (ui.quitCountdown + 2) | 0;
      ui.quitRequested = 1;
      break;
    case 0x89:
      if (g.crackModeEnabled !== 0) {
        const on = clock.timeCompression === 0;
        clock.timeCompression = on ? 1 : 0;
        messagePost(on ? 'Time compression enabled' : 'Time compression disabled', 1, on ? 0xb60 : 0x16c);
      }
      break;
    case 0x91:
      pc.weapon_cycle_group = 1;
      break;
    case 0x92:
      pc.weapon_fire_group = 1;
      break;
    case 0x93:
      pc.weapon_fire_group_1 = 1;
      break;
    case 0x94:
      pc.weapon_fire_group_2 = 1;
      break;
    case 0x95:
      pc.weapon_fire_group_3 = 1;
      break;
    case 2:
    case 3:
    case 4:
    case 5:
    case 6:
    case 7:
    case 8:
      later('MFD and damage display, Phase 4');
      if (((mechs.mechTable[mechs.playerMechIndex]!.flags >> 8) & 0x20) !== 0) soundPlay(0xdc, 100, 0x40, cmd - 2, 0x32);
      break;
    case 0xe:
      later('missile camera, Phase 3');
      break;
    case 0x13:
      later('HUD toggle, Phase 4');
      break;
    case 0x27:
    case 0x2e:
    case 0x2f:
    case 0x30:
    case 0x31:
    case 0x32:
      later('targeting and radar, Phase 4');
      break;
    case 0x33:
    case 0x34:
    case 0x35:
    case 0x36:
    case 0x37:
      later('menus, Phase 4');
      break;
    case 0x41:
      later('objectives display, Phase 4');
      break;
    case 0x52:
      later('screenshot');
      break;
    case 0x8e:
    case 0x8f:
    case 0x90:
      later('weapon groups, Phase 3');
      break;
    case 0x9d:
    case 0x9e:
      later('vision modes, Phase 4');
      break;
    default:
      if (g.hangAround !== 0) later('debug commands');
      break;
  }
  if (throttle !== -1) {
    pc.throttle_set = 1;
    pc.throttle = Math.imul(throttle, 0x71);
  }
}
