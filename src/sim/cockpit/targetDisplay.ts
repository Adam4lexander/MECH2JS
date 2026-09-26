/**
 * The target display (hudWidgets[13]) and the target readout (hudWidgets[14]).
 *
 * The display shows the player's target in its pane: a navpoint as its SHP
 * marker (0x100, or 0x103 once reached), a mech or gamething as a 3D view
 * from three radii in front of it (render_view_from_pose, wireframe in
 * targetDisplayMode 1), an empty frame without a target. A damaged display
 * (HudWidget.field_0x6) shows static. The readout under it names the target
 * and gives its range.
 */
import type { HudWidget, SceneNode, ViewWindow } from '../../generated/classes.gen.ts';
import { fixedCos, fixedSin } from '../../core/angle/trig.ts';
import { cdiv } from '../../core/int/cint.ts';
import { mulr16 } from '../../core/int/fx16.ts';
import { mulr29 } from '../../core/int/i64.ts';
import { registerCode } from '../../engine/codePtr.ts';
import { clock } from '../../engine/clock.ts';
import { registerGlobals } from '../../engine/globals.ts';
import { imageI32 } from '../../engine/image.ts';
import { cacheLoadResource, cacheUnlock } from '../../engine/resources/cache.ts';
import { objectGetPosRadius } from '../../engine/scene/worldObject.ts';
import { vfxCharacterWidth, vfxFontHeight, vfxPaneWipe, vfxShapeDraw, vfxStringDraw } from '../../engine/vfx/vfx.ts';
import { targeting, playerTargetNode } from '../ai/targeting.ts';
import { trackedGlobals } from '../ai/tracked.ts';
import { cameraGlobals } from '../camera/viewer.ts';
import { vfxPaneFrame } from '../display/layout.ts';
import { display } from '../display/video.ts';
import { mechAllegiance } from '../groups/groups.ts';
import { mechs } from '../mech/mechGlobals.ts';
import { soundCuePlay, soundPlay } from '../sound/sound.ts';
import { gamethingAllegiance } from '../things/gameThingDamage.ts';
import { things } from '../things/gameThings.ts';
import { anim2dDrawThunk } from '../world/anim2d.ts';
import { mechApplyDetailLevel } from '../world/detailRecords.ts';
import { lighting } from '../world/environment.ts';
import { randomRange } from '../../core/random.ts';
import { newRenderBlock, renderBlockRestore, renderOptions } from '../display/renderState.ts';
import { renderStateSaveForInset, renderViewFromPose, viewerPoseSave } from '../display/insetView.ts';
import { hud, hudFont, hudFontUnlock, hudShapeDrawInPane, paneTransitionRestart, paneTransitionStepSplit, widgetPane } from './hud.ts';
import type { PaneTransition } from './resources.ts';

export const targetDisplay = registerGlobals(
  'targetDisplay',
  {
    /** 0x96850: the damaged display (field_0x6 == 1) is showing static; cleared by a roll of 7 in 10, set by 3 in 10 */
    staticOn: 0,
    /** 0x96848: the tick until which the readout keeps an inspection message (Out of range, a name), 0 for none */
    readoutHoldUntil: 0,
    /** 0x9684c: the target handle the readout last drew for */
    readoutLastHandle: 0,
    /**
     * 0x96844: when set, naming a mech or gamething plays its allegiance cue
     * (0xf friendly, 0xe enemy, 0x10 neutral) and clears it. Nothing in
     * MW2.EXE sets it: its four references are two compares and two stores
     * of 0, so the cues never play.
     */
    allegianceCuePending: 0,
    /** 0x95748, 0x9574c: the text box's margins, 16.16 fractions of the pane (655 = 1%) */
    textMarginX: 655,
    textMarginY: 655,
  },
  () => {
    const t = targetDisplay;
    t.staticOn = imageI32(0x96850, 0);
    t.readoutHoldUntil = imageI32(0x96848, 0);
    t.readoutLastHandle = imageI32(0x9684c, 0);
    t.allegianceCuePending = imageI32(0x96844, 0);
    t.textMarginX = imageI32(0x95748, 655);
    t.textMarginY = imageI32(0x9574c, 655);
  },
);

function wipeAndFrame(pane: ViewWindow): void {
  vfxPaneWipe(pane, 0);
  vfxPaneFrame(pane, 8);
}

/**
 * The target display's running-state hook: records the status, shows static
 * for a damaged display (field_0x6 1: static on 3 frames in 10 until a roll
 * of 7 in 10 clears it; above 2: always), then by target type - none: an
 * empty frame; a tracked object: its marker; a mech or gamething: the view
 * from three radii in front of it, or SHP 0x5b / 0x58 when it has no node /
 * no userData. The view draws only the target's own scene tree
 * (render_view_from_pose's root is player_target_node's result, ECX at
 * 0x30607), over the pane wiped black, with sky and ground off and the
 * render options render_state_save_for_inset sets - in hidden-line wireframe
 * while targetDisplayMode is 1 - and the block is copied back afterwards.
 * The SHP 0x5b / 0x58 returns leave the block as the inset set it (a quirk
 * of the original, kept).
 *
 * @mw2 hud_widget13_tick 0x00030220
 * @fidelity exact
 */
export const hudWidget13Tick = registerCode('hud_widget13_tick', 0x30220, (w: HudWidget): void => {
  const h = hud;
  const td = targetDisplay;
  if (w.visible === 0 || h.targetDisplayMode === 0) return;
  w.lastStatus = h.playerStatusCopy;
  const pane = widgetPane(w);
  if (w.field_0x6 === 1) {
    if (td.staticOn !== 0) {
      if (randomRange(10) < 7) td.staticOn = 0;
      if (w.visible === 0) return;
      w.lastStatus = h.playerStatusCopy;
      anim2dDrawThunk(pane, 0, 0, 0);
      return;
    }
    if (randomRange(10) < 3) td.staticOn = 1;
  } else if (2 < w.field_0x6) {
    if (w.visible === 0) return;
    w.lastStatus = h.playerStatusCopy;
    anim2dDrawThunk(pane, 0, 0, 0);
    return;
  }
  const e = mechs.mechTable[mechs.playerMechIndex]!.loadout!.entity!;
  const type = e.targetHandle & 0xf00;
  if (type === 0 || (e.targetHandle & 0x1000) !== 0) {
    wipeAndFrame(pane);
    return;
  }
  if (type === 0x100) {
    const cx = cdiv((pane.right - pane.left) | 0, 2);
    const cy = cdiv((pane.bottom - pane.top) | 0, 2);
    const shape = (trackedGlobals.trackedObjects[e.targetHandle & 0xff]!.flags & 0x20) === 0 ? 0x100 : 0x103;
    vfxPaneWipe(pane, 0);
    hudShapeDrawInPane(cx, cy, shape, pane);
    vfxPaneFrame(pane, 8);
    return;
  }
  if (type === 0x200) mechApplyDetailLevel(mechs.mechTable[e.targetHandle & 0xff]!.index, 0);
  const pose = new Int32Array(7);
  viewerPoseSave(cameraGlobals.viewerPosition, pose);
  const block = newRenderBlock();
  renderStateSaveForInset(block);
  let tx = e.targetX;
  let ty = e.targetY;
  let tz = e.targetZ;
  const heading = e.desiredHeading;
  const node: SceneNode | null = playerTargetNode();
  const noView = (id: number): void => {
    // SHP 0x5b / 0x58 by id, without assetVariant
    const t = cacheLoadResource(id, 'SHP');
    if (t) {
      vfxPaneWipe(pane, 0);
      vfxShapeDraw(pane, t, 0, 1, 1);
      vfxPaneFrame(pane, 8);
      cacheUnlock(id, 'SHP');
    }
  };
  if (!node) {
    noView(0x5b);
    return;
  }
  if (!node.userData) {
    noView(0x58);
    return;
  }
  let radius: number;
  if (type === 0x400) {
    // object_get_pos_radius writes the object's position over the target's
    const r = objectGetPosRadius(node.userData);
    tx = r.x;
    ty = r.y;
    tz = r.z;
    radius = r.radius;
  } else radius = mechs.mechTable[e.targetHandle & 0xff]!.loadout!.radius;
  pose[1] = ty;
  const three = Math.imul(radius, 3);
  pose[0] = (tx - mulr29(fixedSin(heading), three)) | 0;
  pose[2] = (tz - mulr29(fixedCos(heading), three)) | 0;
  pose[3] = heading;
  pose[4] = 0;
  pose[5] = 0;
  if (h.targetDisplayMode === 1) {
    renderOptions.wireframeMode = h.targetDisplayMode;
    renderOptions.wireframeColourScheme = 0;
  } else renderOptions.wireframeMode = 0;
  lighting.groundEnabled = 0;
  lighting.skyEnabled = 0;
  vfxPaneWipe(pane, 0);
  if (h.playerStatusCopy === 2) renderViewFromPose(7, 0x20000, pose, node);
  vfxPaneFrame(pane, 8);
  renderBlockRestore(block);
});

/**
 * The target display's hooks[3]: records the status and draws the static.
 *
 * @mw2 hud_widget13_hook3 0x00030660
 * @fidelity exact
 */
export const hudWidget13Hook3 = registerCode('hud_widget13_hook3', 0x30660, (w: HudWidget): void => {
  if (w.visible === 0) return;
  w.lastStatus = hud.playerStatusCopy;
  anim2dDrawThunk(widgetPane(w), 0, 0, 0);
});

function copyPane(dst: ViewWindow, src: ViewWindow): void {
  dst.canvas = src.canvas;
  dst.left = src.left;
  dst.top = src.top;
  dst.right = src.right;
  dst.bottom = src.bottom;
}

/** The body the power hooks share: hud_widget13_tick drawn into the transition's pane, viewportModes[7] and the widget's pane borrowed for it. */
function drawThroughTransition(w: HudWidget, out: ViewWindow): void {
  const vm = lighting.viewportModes[7]!;
  const pane = widgetPane(w);
  const savedVm = { canvas: vm.canvas, left: vm.left, top: vm.top, right: vm.right, bottom: vm.bottom } as ViewWindow;
  const savedPane = { canvas: pane.canvas, left: pane.left, top: pane.top, right: pane.right, bottom: pane.bottom } as ViewWindow;
  copyPane(vm, out);
  copyPane(pane, out);
  hudWidget13Tick(w);
  copyPane(vm, savedVm);
  copyPane(pane, savedPane);
}

/**
 * The target display while the mech powers up: restarts its pane
 * transition on the first such frame and draws through the opening pane;
 * once the transition has run, draws normally.
 *
 * @mw2 hud_target_display_powerup 0x00030690
 * @fidelity exact
 */
export const hudTargetDisplayPowerup = registerCode('hud_target_display_powerup', 0x30690, (w: HudWidget): void => {
  if (w.visible === 0 || hud.targetDisplayMode === 0) return;
  const t = w.paneTransition as PaneTransition | null;
  if (t) {
    if (w.lastStatus !== 1) paneTransitionRestart(t);
    const out = paneTransitionStepSplit(0, t);
    if (!out) hudWidget13Tick(w);
    else drawThroughTransition(w, out);
  }
  w.lastStatus = hud.playerStatusCopy;
});

/**
 * The target display when the status is neither 1 nor 2: the closing
 * transition, and nothing once it has run.
 *
 * @mw2 hud_target_display_powerdown 0x00030750
 * @fidelity exact
 */
export const hudTargetDisplayPowerdown = registerCode('hud_target_display_powerdown', 0x30750, (w: HudWidget): void => {
  if (w.visible === 0 || hud.targetDisplayMode === 0) return;
  const t = w.paneTransition as PaneTransition | null;
  if (t) {
    if (w.lastStatus !== 0 && w.lastStatus !== 3 && w.lastStatus !== 4) paneTransitionRestart(t);
    const out = paneTransitionStepSplit(1, t);
    if (out) drawThroughTransition(w, out);
  }
  w.lastStatus = hud.playerStatusCopy;
});

/**
 * Word-wrapped text in a pane: from a margin (0x95748 / 0x9574c, fractions
 * of the pane's size) line by line in the font's height while inside the
 * pane; a line breaks at a newline, or at the last space or tab before the
 * character that would pass the pane's right edge - and when there is none,
 * that character is lost. Drawn in the text colour table.
 *
 * @mw2 vfx_text_box_draw 0x00013ad0
 * @fidelity exact
 */
export function vfxFontSub013ad0(pane: ViewWindow | null, text: string | null, font: Uint8Array | null): void {
  if (!pane || text === null || !font) return;
  const nul = text.indexOf('\0');
  const s = nul >= 0 ? text.slice(0, nul) : text;
  if (s.length === 0) return;
  // the malloc'd copy, NUL-terminated: end is the index of the NUL
  const b = new Uint8Array(s.length + 1);
  for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i) & 0xff;
  const end = s.length;
  const x = mulr16((pane.right - pane.left) | 0, targetDisplay.textMarginX);
  const td = targetDisplay;
  let y = mulr16((pane.bottom - pane.top) | 0, td.textMarginY);
  const width = (pane.right - pane.left) | 0;
  const height = (pane.bottom - pane.top) | 0;
  const lineHeight = vfxFontHeight(font);
  let p = 0;
  while (p <= end && y < height) {
    const start = p;
    let cx = x;
    for (; p <= end && b[p] !== 10; p++) {
      const cw = vfxCharacterWidth(font, b[p]!);
      if (width < cx + cw) break;
      cx += cw;
    }
    const stop = p;
    let cut = p;
    if (cut <= end) {
      let lost = false;
      if (b[cut] !== 10) {
        while (start <= cut && b[cut] !== 0x20 && b[cut] !== 9) cut--;
        if (cut < start) {
          b[stop] = 0;
          cut = stop;
          lost = true;
        }
      }
      if (!lost) b[cut] = 0;
    }
    if (b[start] !== 0) {
      let line = '';
      for (let i = start; b[i] !== 0 && i <= end; i++) line += String.fromCharCode(b[i]!);
      vfxStringDraw(pane, x, y, font, line, display.textColourTable);
    }
    p = cut + 1;
    y = (y + lineHeight) | 0;
  }
}

/** C's %2.2f for the readout's kilometres (non-negative). */
function fmtFixed2(v: number): string {
  // toFixed rounds the exact binary value; an exact tie resolves upward, which Watcom's printf is not established to share
  return v.toFixed(2).padStart(2);
}

/**
 * The target readout (hudWidgets[14]): with a live target, answers an
 * inspection (targetInspectResult: 2 'Out of range' with cue 0x14; 1 or 3
 * the target's second name, 'Contents unknown' when it has none) and holds
 * that for 0x16c ticks; otherwise names the target - 'Unknown' while
 * unidentified with flags 0x100, else its name or 'Nav Point' / 'Mech' /
 * 'Installation' when that is empty - then draws the label in its
 * allegiance's colour (0xe friendly, 0xa enemy, 6 neutral; a navpoint 1 once
 * reached, else 2) and under it the range: '\n%3ldm' up to 1000 m, else
 * '\n%2.2fk' of metres * 0.001.
 *
 * @mw2 hud_target_readout_tick 0x0002fc90
 * @fidelity exact
 */
export const hudTargetReadoutTick = registerCode('hud_target_readout_tick', 0x2fc90, (w: HudWidget): void => {
  let colour = 0xe;
  if (w.visible === 0) return;
  const td = targetDisplay;
  const l = mechs.mechTable[mechs.playerMechIndex]!.loadout!;
  const e = l.entity!;
  const type = e.targetHandle & 0xf00;
  const index = e.targetHandle & 0xff;
  if (type === 0) return;
  if ((e.targetHandle & 0x1000) !== 0) return;
  const setLabel = (text: string) => w.methods[4]!(w, text);
  if (td.readoutLastHandle !== e.targetHandle) td.readoutHoldUntil = 0;
  const hold = (clock.simTick + 0x16c) | 0;
  const inspect = targeting.targetInspectResult;
  if (inspect === 2) {
    td.readoutHoldUntil = hold;
    setLabel('Out of range');
    soundCuePlay(0x14, -1);
  } else if (inspect !== 0) {
    if (type === 0x100) {
      td.readoutHoldUntil = hold;
      setLabel(trackedGlobals.trackedObjects[index]!.field_0x3e);
      soundPlay(0xdc, 100, 0x40, 5, 0x32);
    } else if (type === 0x200) {
      td.readoutHoldUntil = hold;
      setLabel(mechs.mechTable[index]!.nameAlt);
      soundPlay(0xdc, 100, 0x40, 5, 0x32);
    } else if (type === 0x400) {
      td.readoutHoldUntil = hold;
      setLabel(things.gameThings[index]!.nameAlt);
      soundPlay(0xdc, 100, 0x40, 5, 0x32);
    } else {
      // 0x90b50: the zero padding after 'Out of range' - an empty string
      td.readoutHoldUntil = hold;
      setLabel('');
    }
    if (w.label.length === 0) setLabel('Contents unknown');
  }
  if (td.readoutHoldUntil === 0 || td.readoutHoldUntil < clock.simTick) {
    td.readoutHoldUntil = 0;
    if (type === 0x100) {
      const t = trackedGlobals.trackedObjects[index]!;
      if ((t.flags & 0x20) === 0 && ((t.flags >> 8) & 1) !== 0) setLabel('Unknown');
      else setLabel(t.name.length === 0 ? 'Nav Point' : t.name);
    } else if (type === 0x200) {
      const m = mechs.mechTable[index]!;
      if ((m.flags & 0x20) === 0 && ((m.flags >> 8) & 1) !== 0) setLabel('Unknown');
      else {
        setLabel(m.name.length === 0 ? 'Mech' : m.name);
        if (td.allegianceCuePending !== 0) {
          allegianceCue(mechAllegiance(index));
          td.allegianceCuePending = 0;
        }
      }
    } else if (type === 0x400) {
      const g = things.gameThings[index]!;
      if ((g.flags & 0x20) === 0 && ((g.flags >> 8) & 1) !== 0) {
        // hiddenText (0xfe100, the mission's HTXT text): 'Unknown' is copied in when it is empty
        if (lighting.hiddenText.length === 0) lighting.hiddenText = 'Unknown';
        setLabel(lighting.hiddenText);
      } else {
        setLabel(g.name.length === 0 ? 'Installation' : g.name);
        if (td.allegianceCuePending !== 0) {
          allegianceCue(gamethingAllegiance(index));
          td.allegianceCuePending = 0;
        }
      }
    } else setLabel('');
  }
  if (type === 0x400 || type === 0x200) {
    const a = type === 0x400 ? gamethingAllegiance(index) : mechAllegiance(index);
    if (a === 0) colour = 0xe;
    else if (a === 1) colour = 0xa;
    else if (a === 2) colour = 6;
  } else if (type === 0x100) {
    colour = (trackedGlobals.trackedObjects[index]!.flags & 0x20) === 0 ? 2 : 1;
  }
  const font = hudFont();
  if (font) {
    const table = display.textColourTable;
    table[14] = colour & 0xff;
    vfxStringDraw(widgetPane(w), 0, 0, font, w.label, table);
    table[14] = 0xe;
    const metres = cdiv(l.entity!.targetSlantRange, 100);
    const text = metres <= 1000 ? `\n${String(metres).padStart(3)}m` : `\n${fmtFixed2(metres * 0.001)}k`;
    vfxFontSub013ad0(widgetPane(w), text, font);
    hudFontUnlock();
    td.readoutLastHandle = l.entity!.targetHandle;
  }
});

function allegianceCue(a: number): void {
  if (a === 0) soundCuePlay(0xf, -1);
  else if (a === 1) soundCuePlay(0xe, -1);
  else if (a === 2) soundCuePlay(0x10, -1);
}

