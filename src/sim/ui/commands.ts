/**
 * The player's keyboard commands: command_execute switches on the command
 * id GAMEKEY.MAP bound to the key pressed (commandNames, listing/commands.txt).
 * Most set a control latch or a request the tick hooks answer; the ones
 * that belong to the HUD, radar and menus are reported and
 * dropped until their phases.
 */
import { divergence } from '../../core/provenance.ts';
import { ViewWindow } from '../../generated/classes.gen.ts';
import { cacheLoadResource } from '../../engine/resources/cache.ts';
import { vfxShapeDraw } from '../../engine/vfx/vfx.ts';
import { layoutPaneFitShape, layoutPaneToWindow } from '../display/layout.ts';
import { defaultCanvas, display, imageCanvas } from '../display/video.ts';
import { LABEL } from '../../generated/labels.gen.ts';
import { clock } from '../../engine/clock.ts';
import { registerGlobals } from '../../engine/globals.ts';
import { imageI32 } from '../../engine/image.ts';
import { timerSetPaused } from '../../engine/timer.ts';
import { cameraGetMode } from '../camera/viewer.ts';
import { cameraTrackCycle } from '../camera/cameraUpdate.ts';
import { messagePost } from '../cockpit/messages.ts';
import { mechEject } from '../mech/damage.ts';
import { cameraSetMode } from '../mech/mechTickAi.ts';
import { mechs } from '../mech/mechGlobals.ts';
import { mechRuntime } from '../mech/mechRuntime.ts';
import { missileCamFollowLast } from '../weapons/projectiles.ts';
import { playerWeaponSetFireGroup } from '../weapons/weapons.ts';
import { net } from '../net/netplay.ts';
import { soundRandomRate, soundSfxSub040b50 } from '../sound/mixer.ts';
import { soundPause, soundResume } from '../sound/music.ts';
import { soundCuePlay, soundPlay } from '../sound/sound.ts';
import { dayCycle, vfxFontSub0150f0 } from '../world/dayCycle.ts';
import { renderOptions } from '../display/renderState.ts';
import { hud } from '../cockpit/hud.ts';
import { damageDisplayModeCycle } from '../cockpit/damageDisplay.ts';
import { objectivesHud } from '../cockpit/objectivesHud.ts';
import { vfxVideoSub012330, vfxVideoSub012370, vfxVideoSub012390, vfxVideoSub0123d0, vfxVideoSub012410 } from '../cockpit/radar.ts';
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
    /** 0x9832c: the pane the PAUSE shape is drawn in - {0, 0, 0.2, 1.0, 0.4} as fractions in the image */
    pausePane: bootPausePane(),
    /** 0x98340: 1 until the first pause lays pausePane out */
    pausePaneStale: 1,
  },
  () => {
    const g = commandGlobals;
    g.punchInAutoHeadingRequest = imageI32(LABEL.punchInAutoHeadingRequest, 0);
    g.shutdownOverrideRequest = imageI32(LABEL.shutdownOverrideRequest, 0);
    g.hangAround = imageI32(LABEL.hangAround, 0);
    g.crackModeEnabled = imageI32(LABEL.crackModeEnabled, 0);
    g.keyPauseActive = 0;
    g.pausePane = bootPausePane();
    g.pausePaneStale = imageI32(LABEL.pausePaneStale, 1);
  },
);

function bootPausePane(): ViewWindow {
  const w = new ViewWindow();
  const at = LABEL.pausePane;
  w.canvas = imageCanvas(at);
  w.left = imageI32(at + 4, 0);
  w.top = imageI32(at + 8, 0x3333);
  w.right = imageI32(at + 0xc, 0x10000);
  w.bottom = imageI32(at + 0x10, 0x6666);
  return w;
}

/**
 * PAUSE_GAME: unless the pause menu is up or this is a network game, stops
 * the sim clock and waits for a key.
 *
 * @mw2 cheats_sub_046ac0 0x00046ac0
 * @fidelity partial
 * @divergence the wait is split across host frames (keyPauseActive) instead of a blocking loop
 */
export function cheatsSub046ac0(): void {
  if (uiContextActive(4) === 0 && net.netRole === 0) {
    timerSetPaused(0x80, 1);
    soundPause();
    soundSfxSub040b50(0xc6, 100, 0x40, soundRandomRate());
    const g = commandGlobals;
    const shp = cacheLoadResource((display.assetVariant + 0x5e) | 0, 'SHP');
    if (shp) {
      if (g.pausePaneStale !== 0) {
        g.pausePane.canvas = defaultCanvas;
        layoutPaneToWindow(defaultCanvas, g.pausePane, g.pausePane);
        layoutPaneFitShape(g.pausePane, g.pausePane, shp, 0);
        g.pausePaneStale = 0;
      }
      vfxShapeDraw(g.pausePane, shp, 0, 0, 0);
      // then the driver's flip of pausePane (DAT_0009fd74): the host shows the window as it is
    }
    g.keyPauseActive = 1;
  }
}

/** @portOnly the end of cheats_sub_046ac0's wait: a key arrived */
export function keyPauseEnd(): void {
  commandGlobals.keyPauseActive = 0;
  soundSfxSub040b50(0xf1, 0x32, 0x40, soundRandomRate());
  if (net.netRole === 0) {
    timerSetPaused(0x80, 0);
    soundResume();
  }
}

/**
 * The player command dispatcher.
 *
 * @mw2 command_execute 0x00046060
 * @fidelity partial
 * @divergence the menu (0x33..0x37) and screenshot (0x52) commands are reported, not run; debug commands (hangAround) are not ported
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
      // COCKPIT_VIEW: out to the tracking view, unless the map is up, which it closes
      if (cameraGetMode() === 0 && !vfxVideoSub012370()) {
        cameraSetMode(1);
        cameraTrackCycle(0, 1);
      } else {
        vfxVideoSub012390();
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
          messagePost('Automatic ejection ON', 1, 0x16c, 0x32);
        } else {
          r.autoEjectEnabled = 0;
          messagePost('Automatic ejection OFF', 1, 0x16c, 0x32);
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
        messagePost(on ? 'Time compression enabled' : 'Time compression disabled', 1, on ? 0xb60 : 0x16c, 0x32);
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
    case 8: {
      // MFD_CYCLE, then TOGGLE_HTAL / REAR_VIEW / DOWN_VIEW / WEAPON_DISPLAY
      // (damage display modes 2..5, each toggling with 0), TOGGLE_DAMAGE_DISPLAY
      // (0 <-> 1) and TOGGLE_TARGET_DISPLAY (0, 1, 2 round); each clicks with
      // sound 0xdc when the player's entity flags have bit 13
      const h = hud;
      if (cmd === 2) damageDisplayModeCycle();
      else if (cmd <= 6) h.damageDisplayMode = h.damageDisplayMode === cmd - 1 ? 0 : cmd - 1;
      else if (cmd === 7) h.damageDisplayMode = h.damageDisplayMode !== 1 ? 1 : 0;
      else {
        h.targetDisplayMode = (h.targetDisplayMode + 1) | 0;
        if (h.targetDisplayMode > 2) h.targetDisplayMode = 0;
      }
      if (((mechs.mechTable[mechs.playerMechIndex]!.flags >> 8) & 0x20) !== 0) soundPlay(0xdc, 100, 0x40, cmd < 7 ? cmd - 2 : cmd - 1, 0x32);
      break;
    }
    case 0xe:
      if (missileCamFollowLast() !== 0) cameraSetMode(3);
      break;
    case 0x13:
      // TOGGLE_HUD
      hud.hudEnabled = hud.hudEnabled === 0 ? 1 : 0;
      if (((mechs.mechTable[mechs.playerMechIndex]!.flags >> 8) & 0x20) !== 0) soundPlay(0xdc, 100, 0x40, 8, 0x32);
      break;
    case 0x27:
      aiGroupSub02a080();
      break;
    case 0x2e:
      vfxVideoSub012330();
      break;
    case 0x2f:
      vfxVideoSub012410(1);
      break;
    case 0x30:
      vfxVideoSub012410(2);
      break;
    case 0x31:
      vfxVideoSub012410(0);
      break;
    case 0x32:
      vfxVideoSub0123d0();
      break;
    case 0x33:
    case 0x34:
    case 0x35:
    case 0x36:
    case 0x37:
      later('menus, Phase 4');
      break;
    case 0x41:
      // DISPLAY_OBJECTIVES
      objectivesHud.objectivesDisplayOn = objectivesHud.objectivesDisplayOn === 0 ? 1 : 0;
      break;
    case 0x52:
      later('screenshot');
      break;
    case 0x8e:
      playerWeaponSetFireGroup(0);
      break;
    case 0x8f:
      playerWeaponSetFireGroup(1);
      break;
    case 0x90:
      playerWeaponSetFireGroup(2);
      break;
    case 0x9d:
      vfxFontSub0150f0(0, dayCycle.infraredOn === 0 ? 1 : 0);
      break;
    case 0x9e: {
      // ENHANCED_VISION: hidden-line wireframe for the whole view, only while the player's mech runs (flags 0x2000)
      const r = renderOptions;
      if (r.wireframeMode === 1 || (mechs.mechTable[mechs.playerMechIndex]!.flags & 0x2000) === 0) r.wireframeMode = 0;
      else {
        r.wireframeMode = 1;
        r.wireframeColourScheme = 0;
        soundCuePlay(0x1b, 1);
      }
      break;
    }
    default:
      if (g.hangAround !== 0) later('debug commands');
      break;
  }
  if (throttle !== -1) {
    pc.throttle_set = 1;
    pc.throttle = Math.imul(throttle, 0x71);
  }
}

/**
 * RESET_TARGETTING (command 0x27): sets bit 0x1000 of the player's
 * targetHandle, which hud_target_marker_draw tests and skips on - the
 * marker goes while the target stays.
 *
 * @mw2 target_marker_hide 0x0002a080
 * @fidelity exact
 */
export function aiGroupSub02a080(): void {
  const e = mechs.mechTable[mechs.playerMechIndex]!;
  e.targetHandle = (e.targetHandle | 0x1000) >>> 0;
}
