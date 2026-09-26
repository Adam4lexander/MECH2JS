/**
 * The HUD's widgets and the player's per-frame cockpit driver.
 *
 * 24 HudWidgets (hudWidgets, 0xfe140) are built when the player's mech is
 * created (hud_widgets_install). Each has a pane from the CPIT layout, a
 * text position, an optional pane transition and four hook slots; every
 * frame player_cockpit_frame (the player's hook 4, after the frame's render)
 * calls one slot of all 24 by the player's status - hooks[0] while powering
 * up (1), hooks[1] while running (2), hooks[2] otherwise - and in status 2
 * the overlay (compass, altitude, reticle, target marker).
 *
 * The widgets by index, from their hooks and panes: 0 the radar (the radar
 * code takes its pane over), 1 no hooks and no reader found, 2 the damage display,
 * 3..12 the weapon list, 13 the target display, 14 the target readout, 15
 * the mission objectives, 16 autopilot, 17 speed and throttle, 18 MASC, 19
 * heat, 20 heat rate, 21 jump jets, 22 the altitude tape, 23 the compass.
 */
import { HudWidget, type MechLoadout, MechWeapon, type ViewWindow } from '../../generated/classes.gen.ts';
import { LABEL } from '../../generated/labels.gen.ts';
import { mulr16 } from '../../core/int/fx16.ts';
import { cmod } from '../../core/int/cint.ts';
import { sdivShl } from '../../core/int/i64.ts';
import { registerCode } from '../../engine/codePtr.ts';
import { clock } from '../../engine/clock.ts';
import { registerGlobals } from '../../engine/globals.ts';
import { imageI32, imageI32s } from '../../engine/image.ts';
import { cacheLoadResource, cacheUnlock } from '../../engine/resources/cache.ts';
import { vfxShapeDraw } from '../../engine/vfx/vfx.ts';
import { cam } from '../camera/cameraUpdate.ts';
import { cameraGlobals } from '../camera/viewer.ts';
import { display } from '../display/video.ts';
import { damageGlobals } from '../mech/damage.ts';
import { loadoutAmmo, loadoutWeapons } from '../mech/loadout.ts';
import { mechs } from '../mech/mechGlobals.ts';
import { engineNoteMute, engineNoteStart, engineNoteStop, engineNoteUpdate, soundCuePlay, soundPlay } from '../sound/sound.ts';
import { commandGlobals } from '../ui/commands.ts';
import { weaponTypes } from '../mech/config.ts';
import { paletteStartFade } from '../world/palettes.ts';
import { anim2dFreeSlotOrAll } from '../world/anim2d.ts';
import { cockpit, type PaneTransition } from './resources.ts';
import { hudWidgetTable } from './hudWidgetTable.ts';
import {
  hudDamageDisplayInit,
  hudDamageDisplayPowerdown,
  hudDamageDisplayPowerup,
  damageSub030fc0,
  hudWidget02Hook3,
  hudWidget02Tick,
} from './damageDisplay.ts';
import { hudTargetDisplayPowerdown, hudTargetDisplayPowerup, hudTargetReadoutTick, hudWidget13Hook3, hudWidget13Tick } from './targetDisplay.ts';
import { hudObjectivesDraw } from './objectivesHud.ts';
import { hudAutopilotTick, hudHeatRateTick, hudHeatTick, hudJetsTick, hudMascTick, hudSpeedTick } from './gauges.ts';
import { hudWeaponWidgetPowerup, hudWeaponWidgetTick } from './weaponList.ts';
import { hudOverlayDraw, hudTapesInit } from './overlay.ts';
import { radarDisplayInit, radarDisplayRunning, radarDisplayPowerup, radarDisplayOther, radarDisplayRelease } from './radar.ts';

export const HUD_WIDGET_COUNT = 0x18;

function bootHud() {
  return {
    /** 0xfe140: the 24 widgets, null until hud_widgets_install */
    hudWidgets: hudWidgetTable.fill(null),
    /** 0x9626c: the HUD is drawn at all; 1 in the image */
    hudEnabled: imageI32(LABEL.hudEnabled, 1),
    /** 0x96270: hud_overlay_draw draws the reticle; 1 in the image. The map view clears it while it is up */
    hudReticleOn: imageI32(0x96270, 1),
    /** 0x96274: hud_overlay_draw draws the target marker; 1 in the image. The map view clears it while it is up */
    hudTargetMarkerOn: imageI32(0x96274, 1),
    /** 0x96278: hud_overlay_draw draws the compass; 1 in the image */
    hudCompassOn: imageI32(0x96278, 1),
    /** 0x9627c: 1 in the image; no reader read yet */
    dat0009627c: imageI32(0x9627c, 1),
    /** 0x96280: hud_overlay_draw draws the altitude tape; 1 in the image */
    hudAltitudeOn: imageI32(0x96280, 1),
    /** 0xfe1a4: the player's MechLoadout.status, copied each frame by player_cockpit_frame */
    playerStatusCopy: 0,
    /** 0xfe1a8: the player's leg heading in whole degrees, 0..359 */
    legsHeadingDeg: 0,
    /** 0xfe1ac: the torso twist in whole degrees, (ramps[0].current >> 16) % 360 */
    torsoTwistDeg: 0,
    /** 0x982f0: the damage display's mode (widget 2); 1 in the image */
    damageDisplayMode: imageI32(LABEL.damageDisplayMode, 1),
    /** 0x96840: the target display's mode (widget 13); 1 in the image */
    targetDisplayMode: imageI32(LABEL.targetDisplayMode, 1),
    /** 0x96c2c: the status cockpit_status_sounds last saw */
    cockpitLastStatus: imageI32(LABEL.cockpitLastStatus, 0),
    /** 0x96c30: the LOCKED tone has sounded for this lock */
    lockedToneLatch: imageI32(LABEL.lockedToneLatch, 0),
    /** 0x96c34: the lock-countdown tone has sounded for this countdown */
    lockToneLatch: imageI32(LABEL.lockToneLatch, 0),
    /** 0x96c38: severe hits so far; each flash lasts longer */
    playerHitFlashCount: imageI32(LABEL.playerHitFlashCount, 0),
  };
}

export const hud = registerGlobals('hud', bootHud(), () => {
  Object.assign(hud, bootHud());
});

// ---- HudWidget and its twelve methods --------------------------------------

/**
 * @mw2 hud_widget_nop 0x0002f090
 * @fidelity exact
 */
export const hudWidgetNop = registerCode('hud_widget_nop', 0x2f090, (_w: HudWidget): void => {});

/**
 * @mw2 hud_widget_set_show_after_tick 0x0002f0a0
 * @fidelity exact
 */
export const hudWidgetSetShowAfterTick = registerCode('hud_widget_set_show_after_tick', 0x2f0a0, (w: HudWidget, tick: number): void => {
  w.showAfterTick = tick | 0;
});

/**
 * @mw2 hud_widget_set_weapon_index 0x0002f0b0
 * @fidelity exact
 */
export const hudWidgetSetWeaponIndex = registerCode('hud_widget_set_weapon_index', 0x2f0b0, (w: HudWidget, i: number): void => {
  w.weaponIndex = i | 0;
});

/**
 * strncpy(label, text, 0x20), then a NUL at +0x2f: at most 31 characters.
 *
 * @mw2 hud_widget_set_label 0x0002f0c0
 * @fidelity exact
 */
export const hudWidgetSetLabel = registerCode('hud_widget_set_label', 0x2f0c0, (w: HudWidget, text: string): void => {
  const nul = text.indexOf('\0');
  w.label = (nul >= 0 ? text.slice(0, nul) : text).slice(0, 0x1f);
});

/**
 * The pane, and left, top, width, height from its rectangle.
 *
 * @mw2 hud_widget_set_window 0x0002f0e0
 * @fidelity exact
 */
export const hudWidgetSetWindow = registerCode('hud_widget_set_window', 0x2f0e0, (w: HudWidget, pane: ViewWindow): void => {
  w.window = pane;
  w.left = (pane.left << 16) >> 16;
  w.top = (pane.top << 16) >> 16;
  w.width = ((pane.right - pane.left + 1) << 16) >> 16;
  w.height = ((pane.bottom - pane.top + 1) << 16) >> 16;
});

/**
 * @mw2 hud_widget_store_34 0x0002f120
 * @fidelity exact
 */
export const hudWidgetStore34 = registerCode('hud_widget_store_34', 0x2f120, (w: HudWidget, p: Int32Array): void => {
  w.textPos = p;
});

/**
 * @mw2 hud_widget_store_38 0x0002f130
 * @fidelity exact
 */
export const hudWidgetStore38 = registerCode('hud_widget_store_38', 0x2f130, (w: HudWidget, t: PaneTransition | null): void => {
  w.paneTransition = t;
});

/**
 * @mw2 hud_widget_set_rect 0x0002f140
 * @fidelity exact
 */
export const hudWidgetSetRect = registerCode('hud_widget_set_rect', 0x2f140, (w: HudWidget, left: number, top: number, width: number, height: number): void => {
  w.left = (left << 16) >> 16;
  w.top = (top << 16) >> 16;
  w.width = (width << 16) >> 16;
  w.height = (height << 16) >> 16;
});

/**
 * @mw2 hud_widget_store_06 0x0002f160
 * @fidelity exact
 */
export const hudWidgetStore06 = registerCode('hud_widget_store_06', 0x2f160, (w: HudWidget, v: number): void => {
  w.field_0x6 = (v << 16) >> 16;
});

/**
 * @mw2 hud_widget_show 0x0002f170
 * @fidelity exact
 */
export const hudWidgetShow = registerCode('hud_widget_show', 0x2f170, (w: HudWidget): void => {
  w.visible = 1;
});

/**
 * @mw2 hud_widget_hide 0x0002f180
 * @fidelity exact
 */
export const hudWidgetHide = registerCode('hud_widget_hide', 0x2f180, (w: HudWidget): void => {
  w.visible = 0;
});

/**
 * The constructor: self-pointer, cleared fields (weaponIndex -1), the twelve
 * methods and four null hooks.
 *
 * @mw2 hud_widget_init 0x0002efd0
 * @fidelity exact
 */
export const hudWidgetInit = registerCode('hud_widget_init', 0x2efd0, (w: HudWidget): void => {
  w.self = w;
  w.field_0x6 = 0;
  w.showAfterTick = 0;
  w.weaponIndex = -1;
  w.label = '';
  w.left = 0;
  w.top = 0;
  w.width = 0;
  w.height = 0;
  w.methods[0] = hudWidgetInit;
  w.methods[1] = hudWidgetNop;
  w.methods[2] = hudWidgetSetShowAfterTick;
  w.methods[3] = hudWidgetSetWeaponIndex;
  w.methods[4] = hudWidgetSetLabel;
  w.methods[5] = hudWidgetSetWindow;
  w.methods[6] = hudWidgetStore34;
  w.methods[7] = hudWidgetStore38;
  w.methods[8] = hudWidgetSetRect;
  w.methods[9] = hudWidgetStore06;
  w.methods[10] = hudWidgetShow;
  w.methods[11] = hudWidgetHide;
  w.hooks[0] = null;
  w.hooks[1] = null;
  w.hooks[2] = null;
  w.hooks[3] = null;
});

/** hudWidgets[i], which hud_widgets_install has made. @portOnly */
export function widget(i: number): HudWidget {
  return hud.hudWidgets[i]!;
}

/** The pane a widget draws in (HudWidget.window). @portOnly */
export const widgetPane = (w: HudWidget): ViewWindow => w.window as ViewWindow;

// ---- pane transitions --------------------------------------------------------

/**
 * @mw2 pane_transition_restart 0x00014aa0
 * @fidelity exact
 */
export function paneTransitionRestart(t: PaneTransition): void {
  t.now = 1;
  t.before = 0;
}

/** round(a + t * (b - a)), t 16.16 - pane_lerp's per-edge step. */
const lerp = (a: number, b: number, t: number): number => (a + mulr16(t, (b - a) | 0)) | 0;

/**
 * out = from + t * (to - from) per edge; axes 1 moves only left and right,
 * 2 only top and bottom, anything else all four.
 *
 * @mw2 pane_lerp 0x00014ae0
 * @fidelity exact
 */
export function paneLerp(from: ViewWindow, to: ViewWindow, out: ViewWindow, t: number, axes: number): ViewWindow {
  if (axes !== 2) {
    out.left = lerp(from.left, to.left, t);
    out.right = lerp(from.right, to.right, t);
  }
  if (axes !== 1) {
    out.top = lerp(from.top, to.top, t);
    out.bottom = lerp(from.bottom, to.bottom, t);
  }
  return out;
}

function copyPane(dst: ViewWindow, src: ViewWindow): void {
  dst.canvas = src.canvas;
  dst.left = src.left;
  dst.top = src.top;
  dst.right = src.right;
  dst.bottom = src.bottom;
}

/**
 * One step of a pane transition by tickDelta: direction 0 runs from the
 * params' first pane to the second, 1 back. Returns the out pane, or null
 * when the transition is not running.
 *
 * @mw2 pane_transition_step 0x00014b80
 * @fidelity exact
 */
export function paneTransitionStep(direction: number, t: PaneTransition): ViewWindow | null {
  let running = t.now;
  let out: ViewWindow | null = null;
  if (running === 1) {
    out = t.out;
    const from = direction === 0 ? t.from : t.to;
    const to = direction === 0 ? t.to : t.from;
    if (t.before === 0) {
      copyPane(out, from);
      t.elapsed = 0;
    } else {
      t.elapsed = (t.elapsed + clock.tickDelta) | 0;
      const f = sdivShl(t.elapsed, 16, t.duration);
      if (f < 0x10000) paneLerp(from, to, out, f, 0);
      else {
        copyPane(out, to);
        running = 0;
        t.elapsed = 0;
      }
    }
  }
  t.before = t.now;
  t.now = running;
  return out;
}

/**
 * pane_transition_step in two halves: the first half moves one pair of edges
 * (left and right when opening, direction 0), the second the other, each at
 * double speed - the pane opens as a line, then to full height.
 *
 * @mw2 pane_transition_step_split 0x00014c50
 * @fidelity exact
 */
export function paneTransitionStepSplit(direction: number, t: PaneTransition): ViewWindow | null {
  let running = t.now;
  let out: ViewWindow | null = null;
  if (running === 1) {
    out = t.out;
    const from = direction === 0 ? t.from : t.to;
    const to = direction === 0 ? t.to : t.from;
    let axesFirst = direction === 0 ? 1 : 2;
    const axesSecond = direction === 0 ? 2 : 1;
    if (t.before === 0) {
      copyPane(out, from);
      t.elapsed = 0;
    } else {
      t.elapsed = (t.elapsed + clock.tickDelta) | 0;
      const f = sdivShl(t.elapsed, 16, t.duration);
      if (f < 0x10000) {
        let k: number;
        if (f < 0x8001) {
          copyPane(out, from);
          k = mulr16Trunc(f, 0x20000);
        } else {
          copyPane(out, to);
          k = mulr16Trunc((f - 0x8000) | 0, 0x20000);
          axesFirst = axesSecond;
        }
        paneLerp(from, to, out, k, axesFirst);
      } else {
        copyPane(out, to);
        running = 0;
        t.elapsed = 0;
      }
    }
  }
  t.before = t.now;
  t.now = running;
  return out;
}

/** (int64)a * b >> 16, not rounded - pane_transition_step_split's doubling. */
function mulr16Trunc(a: number, b: number): number {
  return Number(BigInt.asIntN(32, (BigInt(a | 0) * BigInt(b | 0)) >> 16n));
}

// ---- drawing shapes and text -------------------------------------------------

/**
 * Shape 0 of SHP resource assetVariant + id at (x, y) in currentViewport.
 *
 * @mw2 hud_shape_draw 0x00029bb0
 * @fidelity exact
 */
export function hudShapeDraw(x: number, y: number, shapeId: number): void {
  const id = (display.assetVariant + shapeId) | 0;
  const t = cacheLoadResource(id, 'SHP');
  if (t) {
    vfxShapeDraw(display.currentViewport, t, 0, x, y);
    cacheUnlock(id, 'SHP');
  }
}

/**
 * hud_shape_draw into the given pane.
 *
 * @mw2 hud_shape_draw_in_pane 0x00029c10
 * @fidelity exact
 */
export function hudShapeDrawInPane(x: number, y: number, shapeId: number, pane: ViewWindow): void {
  const id = (display.assetVariant + shapeId) | 0;
  const t = cacheLoadResource(id, 'SHP');
  if (t) {
    vfxShapeDraw(pane, t, 0, x, y);
    cacheUnlock(id, 'SHP');
  }
}

/** The HUD's font, FONT assetVariant + 1, as the widgets load it. @portOnly */
export function hudFont(): Uint8Array | null {
  return cacheLoadResource((display.assetVariant + 1) | 0, 'FONT');
}

/** cache_unlock of the HUD's font. @portOnly */
export function hudFontUnlock(): void {
  cacheUnlock((display.assetVariant + 1) | 0, 'FONT');
}

// ---- installing the widgets ----------------------------------------------------

/** weaponTypes[type].name - what 0x9eea8 + type * 0x58 points at. */
const weaponName = (type: number): string => weaponTypes()[type]?.name ?? '';

function copyWeapon(dst: MechWeapon, src: MechWeapon): void {
  dst.slotState = src.slotState;
  dst.type = src.type;
  dst.fireState = src.fireState;
  dst.fireGroup = src.fireGroup;
  dst.stateTick = src.stateTick;
  dst.lockIndex = src.lockIndex;
  dst.lockType = src.lockType;
  dst.ammo = src.ammo;
  dst.shotsLeft = src.shotsLeft;
  dst.sectionIndex = src.sectionIndex;
  dst.slotCode = src.slotCode;
  dst.numBins = src.numBins;
  dst.binIndices.set(src.binIndices);
  dst.originalIndex = src.originalIndex;
  dst.binCursor = src.binCursor;
  dst.bin = src.bin;
}

/**
 * Hands the player's weapons to the weapon widgets and reorders the weapon
 * array to match. Left-side weapons (sectionIndex 5, 3, 7: arm, torso, leg)
 * go to widgets 3..7, right-side ones (4, 1, 6) to 8..12, each side
 * overflowing into the other's free slots; centre-torso and head weapons (2,
 * 0) alternate between the sides. The array is then rebuilt from a zeroed
 * buffer - the left widgets' weapons at even positions, the right's at odd -
 * the ammo bins and the widgets renumbered to the new positions, and any
 * record left with type 0 and ammo 0 marked empty (type -1).
 *
 * @mw2 loadout_regroup_weapons 0x00032580
 * @fidelity exact
 * @divergence the +0x14 dword of each MechWeapon (no port field) is not carried over
 */
export function loadoutRegroupWeapons(l: MechLoadout): void {
  const weapons = loadoutWeapons(l);
  const w = hud.hudWidgets as HudWidget[];
  const give = (slot: number, i: number) => {
    w[slot]!.methods[4]!(w[slot], weaponName(weapons[i]!.type));
    w[slot]!.methods[3]!(w[slot], i);
    w[slot]!.hooks[0] = hudWeaponWidgetPowerup;
    w[slot]!.hooks[1] = hudWeaponWidgetTick;
  };
  for (let i = 0; i < 10; i++) weapons[i]!.originalIndex = i;
  let rightEnd = 8;
  for (let i = 0; i < 10; i++) {
    const s = weapons[i]!.sectionIndex;
    if (s === 4 || s === 1 || s === 6) rightEnd++;
  }
  let left = 3;
  for (let i = 0; i < 10; i++) {
    const s = weapons[i]!.sectionIndex;
    if (s === 5 || s === 3 || s === 7) give(left++, i);
    if (left === 8) left = rightEnd;
  }
  let right = 8;
  for (let i = 0; i < 10; i++) {
    const s = weapons[i]!.sectionIndex;
    if (s === 4 || s === 1 || s === 6) give(right++, i);
    if (right > 0xc) right = left;
  }
  let toLeft = true;
  for (let i = 0; i < 10; i++) {
    let next = right;
    const s = weapons[i]!.sectionIndex;
    if (s === 2 || s === 0) {
      if (toLeft && left < right) {
        if (right === 0xd) {
          right = left;
          left++;
        } else next = right + 1;
        toLeft = false;
      } else {
        if (left === 8) next = right + 1;
        else {
          right = left;
          left++;
        }
        toLeft = true;
      }
      give(right, i);
    }
    right = next;
  }
  // the zeroed buffer: left widgets' weapons at 0, 2, 4 ..., right's at 1, 3, 5 ...
  const buffer = Array.from({ length: 10 }, () => new MechWeapon());
  let at = 0;
  for (let k = 3; k < 8; k++) {
    if (w[k]!.weaponIndex !== -1) {
      copyWeapon(buffer[at]!, weapons[w[k]!.weaponIndex]!);
      if (k !== 7) at += 2;
    }
  }
  at = 1;
  for (let k = 8; k < 0xd; k++) {
    if (w[k]!.weaponIndex !== -1) {
      copyWeapon(buffer[at]!, weapons[w[k]!.weaponIndex]!);
      if (k !== 0xc) at += 2;
    }
  }
  const ammo = loadoutAmmo(l);
  let n = 0;
  for (let k = 3; k < 8; k++) {
    const wi = w[k]!.weaponIndex;
    if (wi !== -1) {
      const wp = weapons[wi]!;
      for (let b = 0; b < wp.numBins; b++) ammo[wp.binIndices[b]!]!.weaponIndex = (n << 16) >> 16;
    }
    // unconditional: an empty left widget is numbered too
    w[k]!.weaponIndex = n;
    n += 2;
  }
  n = 1;
  for (let k = 8; k < 0xd; k++) {
    const wi = w[k]!.weaponIndex;
    if (wi !== -1) {
      const wp = weapons[wi]!;
      for (let b = 0; b < wp.numBins; b++) ammo[wp.binIndices[b]!]!.weaponIndex = (n << 16) >> 16;
      w[k]!.weaponIndex = n;
      n += 2;
    }
  }
  for (let i = 0; i < 10; i++) copyWeapon(weapons[i]!, buffer[i]!);
  for (let i = 0; i < 10; i++) {
    if (weapons[i]!.type === 0 && weapons[i]!.ammo === 0) weapons[i]!.type = -1;
  }
}

/**
 * Builds the player's 24 widgets - showAfterTick from the table at 0x32468,
 * pane i of the CPIT layout, text position i, pane transition i, shown when
 * the table at 0x324c8 says so - regroups the weapons onto them, installs
 * every widget's hooks, lays out the damage display, points the cockpit at
 * the loadout's eye offset and torso pan, and sets up the tapes and the radar.
 *
 * @mw2 hud_widgets_install 0x00032a70
 * @fidelity exact
 */
export function hudWidgetsInstall(): void {
  const showAfter = imageI32s(0x32468, HUD_WIDGET_COUNT, new Array<number>(HUD_WIDGET_COUNT).fill(0));
  const shown = imageI32s(0x324c8, HUD_WIDGET_COUNT, new Array<number>(HUD_WIDGET_COUNT).fill(0));
  const loadout = mechs.mechTable[mechs.playerMechIndex]!.loadout!;
  const c = cockpit;
  for (let i = 0; i < HUD_WIDGET_COUNT; i++) {
    const w = new HudWidget(); // malloc(0x88)
    hud.hudWidgets[i] = w;
    hudWidgetInit(w);
    w.methods[2]!(w, showAfter[i]);
    w.methods[5]!(w, c.dat000968e0[i]);
    w.methods[6]!(w, c.dat00096ac0.subarray(i * 2, i * 2 + 2));
    w.methods[7]!(w, c.paneTransitions[i] ?? null);
    if (shown[i] !== 0) w.methods[10]!(w);
  }
  loadoutRegroupWeapons(loadout);
  const w = hud.hudWidgets as HudWidget[];
  w[2]!.hooks[1] = hudWidget02Tick;
  w[2]!.hooks[3] = hudWidget02Hook3;
  w[2]!.hooks[0] = hudDamageDisplayPowerup;
  w[2]!.hooks[2] = hudDamageDisplayPowerdown;
  w[0xd]!.hooks[1] = hudWidget13Tick;
  w[0xd]!.hooks[3] = hudWidget13Hook3;
  w[0xe]!.hooks[1] = hudTargetReadoutTick;
  w[0xd]!.hooks[0] = hudTargetDisplayPowerup;
  w[0xd]!.hooks[2] = hudTargetDisplayPowerdown;
  w[0xf]!.hooks[1] = hudObjectivesDraw;
  w[0x10]!.hooks[1] = hudAutopilotTick;
  w[0x11]!.hooks[1] = hudSpeedTick;
  w[0x12]!.hooks[1] = hudMascTick;
  w[0x13]!.hooks[1] = hudHeatTick;
  w[0x14]!.hooks[1] = hudHeatRateTick;
  w[0x15]!.hooks[1] = hudJetsTick;
  damageSub030fc0();
  hudDamageDisplayInit();
  cameraGlobals.playerEyeOffsetY = loadout;
  cameraGlobals.playerTorsoPanPtr = loadout;
  hudTapesInit();
  radarDisplayInit();
}

// ---- the per-frame driver ------------------------------------------------------

/**
 * The graded damage flash: palette slot 0x11 (ZAPPED) there and back over
 * min(steps, 15) / 15 of 0x16c ticks.
 *
 * @mw2 damage_flash 0x00028930
 * @fidelity exact
 */
export function damageFlash(steps: number): void {
  const f = steps >>> 0 < 0x10 ? sdivShl(steps, 16, 0xf) : 0x10000;
  paletteStartFade(0x11, mulr16(f, 0x16c), 1);
}

/**
 * The player's cockpit cues once a frame: the damage flash, the missile-lock
 * tones (in the cockpit view, while running) and the status-change cue.
 *
 * @mw2 cockpit_status_sounds 0x00032fc0
 * @fidelity exact
 */
export function cockpitStatusSounds(l: MechLoadout): void {
  const h = hud;
  if (damageGlobals.playerHitFlashPending !== 0) {
    h.playerHitFlashCount = (h.playerHitFlashCount + 1) | 0;
    damageFlash(Math.imul(h.playerHitFlashCount, 3));
    damageGlobals.playerHitFlashPending = 0;
  }
  if (cameraGlobals.cockpitViewActive !== 0) {
    let latch = h.lockToneLatch;
    if ((l.flags & 0x80) === 0) {
      h.lockedToneLatch = 0;
      latch = l.flags & 0x40;
      if ((l.flags & 0x40) !== 0) {
        latch = h.lockToneLatch;
        if (latch === 0 && l.status === 2) {
          h.lockToneLatch = 1;
          soundPlay(0xcf, 100, 0x1f, 5, 0x32);
          latch = h.lockToneLatch;
        }
      }
    } else if (h.lockedToneLatch === 0) {
      const fs = loadoutWeapons(l)[l.selectedWeapon]?.fireState ?? 0;
      if (fs === 1 && l.status === 2) {
        h.lockedToneLatch = fs;
        soundPlay(0xfe, 100, 0x5f, 5, 0x32);
        latch = h.lockToneLatch;
      }
    }
    h.lockToneLatch = latch;
    const s = l.status;
    if (h.cockpitLastStatus !== s) {
      if (s === 0 || s === 4) soundPlay(0xf6, 100, 0x40, 5, 0x32);
      else if (s === 2) soundPlay(0xce, 100, 0x2f, 5, 0x32);
    }
  }
  h.cockpitLastStatus = l.status;
}

/**
 * Unless the autopilot is engaged (1), the legs' desired heading becomes
 * where the torso points: (heading + torso twist + a turn) mod a turn.
 *
 * @mw2 mech_punch_in_auto_heading 0x00024e80
 * @fidelity exact
 */
export function mechPunchInAutoHeading(l: MechLoadout): void {
  if (l.autopilotEngaged !== 1) {
    const e = l.entity!;
    e.desiredHeading = cmod((e.heading + l.ramps[0]!.current + 0x1680000) | 0, 0x1680000);
  }
}

/** A degree difference wrapped into -180..180 as player_cockpit_frame does it. */
function wrap180(d: number): number {
  if (d >= 0xb5) return (d - 0x168) | 0;
  if (d < -0xb4) return (d + 0x168) | 0;
  return d;
}

/**
 * The player's cockpit, once a frame (hook 4): for the player's mech with the
 * HUD on and status neither 4 nor 5, answers the punch-in auto-heading and
 * shutdown-override requests, runs the cockpit cues, then by status runs the
 * radar's state step and one hook slot of all 24 widgets, the overlay while
 * running, and the engine note.
 *
 * @mw2 player_cockpit_frame 0x00032c50
 * @fidelity exact
 */
export function playerCockpitFrame(l: MechLoadout): void {
  const e = l.entity!;
  const h = hud;
  if (mechs.playerMechIndex !== e.index || h.hudEnabled === 0) return;
  h.playerStatusCopy = l.status;
  if (h.playerStatusCopy === 5 || h.playerStatusCopy === 4) return;
  h.legsHeadingDeg = cmod(cmod(cmod(e.heading >> 16, 0x168), 0x168) + 0x168, 0x168);
  h.torsoTwistDeg = cmod(cmod(l.ramps[0]!.current >> 16, 0x168), 0x168);
  const tilt = e.torsoTilt;
  const pitch = l.ramps[1]!.current;
  const bearing = wrap180((cmod(e.desiredHeading >> 16, 0x168) - h.legsHeadingDeg) | 0);
  const bearingTorso = wrap180((bearing - h.torsoTwistDeg) | 0);
  let ax = Math.abs((e.targetX - e.posX) | 0);
  let ay = Math.abs((e.targetY - e.posY) | 0);
  let az = Math.abs((e.targetZ - e.posZ) | 0);
  let hi = ax;
  if (ax < ay) {
    hi = ay;
    ay = ax;
  }
  ax = hi;
  if (hi < az) {
    ax = az;
    az = hi;
  }
  const range = (Math.imul(ax, 4) + ay + az) >> 2;
  const cmds = commandGlobals;
  if (cmds.punchInAutoHeadingRequest !== 0) {
    if (h.playerStatusCopy === 2) mechPunchInAutoHeading(l);
    cmds.punchInAutoHeadingRequest = 0;
  }
  if (cmds.shutdownOverrideRequest !== 0 && h.playerStatusCopy !== 3 && (l.flags & 4) !== 0 && (l.flags & 8) === 0) {
    soundPlay(0xcd, 100, 0x40, 5, 0x32);
    soundCuePlay(2, -1);
    l.flags = (l.flags | 8) & 0xffff;
  }
  cmds.shutdownOverrideRequest = 0;
  cockpitStatusSounds(l);
  const w = h.hudWidgets as HudWidget[];
  switch (h.playerStatusCopy) {
    case 1:
      radarDisplayPowerup(h.playerStatusCopy);
      for (let i = 0; i < HUD_WIDGET_COUNT; i++) w[i]!.hooks[0]?.(w[i]);
      engineNoteStart();
      break;
    case 2:
      radarDisplayRunning(h.playerStatusCopy);
      for (let i = 0; i < HUD_WIDGET_COUNT; i++) w[i]!.hooks[1]?.(w[i]);
      hudOverlayDraw(l, h.legsHeadingDeg, h.torsoTwistDeg, bearing, bearingTorso, cmod((pitch + tilt) | 0, 0x1680000), range, cam.dat00096ef0);
      engineNoteUpdate();
      break;
    default:
      radarDisplayOther(h.playerStatusCopy);
      for (let i = 0; i < HUD_WIDGET_COUNT; i++) w[i]!.hooks[2]?.(w[i]);
      engineNoteStop();
  }
  if (cameraGlobals.cockpitViewActive === 0) engineNoteMute();
}

/**
 * Tears the cockpit down once the mission loop ends: the radar's clean-up,
 * every widget's methods[1] (hud_widget_nop), and all the 2D animations.
 *
 * @mw2 player_cockpit_release 0x00032f30
 * @fidelity exact
 */
export function playerCockpitRelease(): void {
  radarDisplayRelease();
  for (let i = 0; i < HUD_WIDGET_COUNT; i++) {
    const w = hud.hudWidgets[i];
    if (w?.methods[1]) w.methods[1](w);
  }
  anim2dFreeSlotOrAll(-1);
}
