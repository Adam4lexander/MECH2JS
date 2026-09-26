/**
 * The damage display, hudWidgets[2]. damageDisplayMode (hud.ts) picks what it
 * shows: 0 nothing, 1 (and anything above 5) the damage diagram, 2 the
 * armour bars, 3 the rear view (or the torso's view under the "forward view
 * instead of rear" cheat), 4 a view straight down on the mech, 5 the missile
 * camera. A damaged display (widget +6, raised by sound_res_sub_032f70 when
 * a hit destroys sensors) shows static for the modes 3..5 now and then, and
 * all the time past 2.
 *
 * Modes 3..5 are 3D views drawn into viewportModes[5] by
 * render_view_from_pose (display/insetView.ts), with the player's own mech
 * set aside on the alt list for modes 3 and 4.
 *
 * hud_gauge_layout_init, run beside the display's set-up, lays out the gauges of
 * widgets 17, 19, 20 and 21 (gaugeLayout below); gauges.ts reads it.
 */
import { type HudWidget, type MechLoadout, ViewWindow } from '../../generated/classes.gen.ts';
import { cdiv } from '../../core/int/cint.ts';
import { unestablished } from '../../core/provenance.ts';
import { randomRange } from '../../core/random.ts';
import { registerCode } from '../../engine/codePtr.ts';
import { registerGlobals } from '../../engine/globals.ts';
import { imageI32, imageI32s } from '../../engine/image.ts';
import { cacheLoadResource, cacheUnlock } from '../../engine/resources/cache.ts';
import { sceneSubtreeMoveToAltList, sceneSubtreeMoveToWorldList } from '../../engine/scene/sceneGraph.ts';
import { vfxLineDraw, vfxPaneWipe, vfxShapeDraw, vfxShapeRemapDraw, vfxShapeRemapSet, vfxShapeSize, vfxStringDraw } from '../../engine/vfx/vfx.ts';
import { viewer } from '../camera/viewer.ts';
import { renderStateSaveForInset, renderViewFromPose } from '../display/insetView.ts';
import { newRenderBlock, renderBlockRestore, type RenderBlock } from '../display/renderState.ts';
import { layoutPointInPane, vfxPaneFrame } from '../display/layout.ts';
import { defaultCanvas, display, imageCanvas } from '../display/video.ts';
import { mechConfig } from '../mech/config.ts';
import { loadoutSections } from '../mech/loadout.ts';
import { mechs } from '../mech/mechGlobals.ts';
import { missileCamFollowLast, missileCamPose } from '../weapons/projectiles.ts';
import { lighting } from '../world/environment.ts';
import { anim2dDrawThunk } from '../world/anim2d.ts';
import { cockpit } from './resources.ts';
import { hud, hudFont, hudFontUnlock, hudShapeDrawInPane, paneTransitionRestart, paneTransitionStepSplit, widget, widgetPane } from './hud.ts';

function paneAt(addr: number): ViewWindow {
  const w = new ViewWindow();
  w.canvas = imageCanvas(addr);
  w.left = imageI32(addr + 4, 0);
  w.top = imageI32(addr + 8, 0);
  w.right = imageI32(addr + 0xc, 0);
  w.bottom = imageI32(addr + 0x10, 0);
  return w;
}

function bootDamageDisplay() {
  return {
    /** 0xfdfa0: 256 bytes; hud_damage_display_init makes it the identity and the diagram rewrites entry 6 per region */
    damageColourRemap: new Uint8Array(256),
    /** 0x96604: per diagram region, the 1-based section it shows (region 15 has 0) */
    damageDiagramSections: Int32Array.from(imageI32s(0x96604, 16, new Array<number>(16).fill(0))),
    /** 0x96668: the whole diagram, centred in widget 2's box */
    diagramPane: paneAt(0x96668),
    /**
     * 0x967bc: per region {-x, -y}, the diagram's origin relative to the
     * region's pane - where the diagram is redrawn through the remap so that
     * only the region's part of it lands
     */
    regionOrigins: Int32Array.from(imageI32s(0x967bc, 32, new Array<number>(32).fill(0))),
    /** 0x96644: the four armour-bar labels' {x, y} (H, T, A, L), fractions of widget 2's pane until set-up */
    labelPoints: Int32Array.from(imageI32s(0x96644, 8, new Array<number>(8).fill(0))),
    /** 0xfdf60: per section, the armour bar's {x, top} in widget 2's pane */
    barOrigins: Int32Array.from(imageI32s(0xfdf60, 16, new Array<number>(16).fill(0))),
    /** 0xfe0a0: {bar width, bar length at full armour} in pixels after set-up */
    barScale: Int32Array.from(imageI32s(0xfe0a0, 2, [0, 0])),
    /** 0xfe0a8: per section {armorFront, armorRear} at set-up - the full-health values the bars are scaled against */
    fullArmour: Int32Array.from(imageI32s(0xfe0a8, 16, new Array<number>(16).fill(0))),
    /** 0x96664: the largest armorFront at set-up */
    fullArmourMax: imageI32(0x96664, 0),
    /** 0x9683c: outlines each diagram region; toggled by the same cheat as the bounding spheres (0x954e0); 0 in the image */
    diagramRegionFrames: imageI32(0x9683c, 0),
    /** 0x96854: the display is showing static this frame (a damaged display, widget +6 == 1) */
    staticShowing: imageI32(0x96854, 0),
    /** 0xfe110: the "forward view instead of rear" cheat: mode 3 looks along the torso, not behind */
    rearViewForward: imageI32(0xfe110, 0),
    /**
     * 0x96888..0x968d4: the gauges' layout hud_gauge_layout_init derives from the
     * panes of widgets 17, 19, 20 and 21 (see there for each entry)
     */
    gaugeLayout: Int32Array.from(imageI32s(0x96888, 20, new Array<number>(20).fill(0))),
  };
}

export const damageDisplay = registerGlobals('damageDisplay', bootDamageDisplay(), () => {
  Object.assign(damageDisplay, bootDamageDisplay());
});

/** trunc(v * 65536 / size + 0.5), computed on the x87 in the original (see hudDamageDisplayInit). */
function regionFraction(v: number, size: number): number {
  if (size === 0) {
    unestablished('hud_damage_display_init: a diagram of size 0 divides by zero on the x87');
    return 0;
  }
  // the exact value is never within 1/(2 size) of an integer boundary, so a double is exact here
  return Math.trunc((v * 131072 + size) / (2 * size)) | 0;
}

/**
 * The damage display's set-up, once from hud_widgets_install: the remap as
 * the identity; the diagram (SHP id cockpit.dat000fe0e8[0] + assetVariant)
 * centred in widget 2's box; the 16 region panes the HDI resource gave in
 * the base diagram's pixels ({x, y, w, h}, 0..100) turned into fractions -
 * trunc(v * 65536 / size + 0.5), size being the BASE (320x200) diagram's
 * width or height, then + w - 1 and + h - 1 for the far edges - and placed
 * in the drawn diagram; the armour bars' labels, origins and scale; and the
 * player's armour at full health.
 *
 * @mw2 hud_damage_display_init 0x0002f190
 * @fidelity exact
 */
export const hudDamageDisplayInit = registerCode('hud_damage_display_init', 0x2f190, (): void => {
  const d = damageDisplay;
  const w = widget(2);
  for (let i = 0xff; i >= 0; i--) d.damageColourRemap[i] = i;
  const id = cockpit.dat000fe0e8[0]!;
  let baseW = 0;
  let baseH = 0;
  let t = cacheLoadResource(id, 'SHP');
  if (t) {
    const s0 = vfxShapeSize(t, 0);
    cacheUnlock(id, 'SHP');
    baseW = s0 >> 16;
    baseH = s0 & 0xffff;
    t = cacheLoadResource((display.assetVariant + id) | 0, 'SHP');
  }
  if (t) {
    const s = vfxShapeSize(t, 0);
    cacheUnlock((display.assetVariant + id) | 0, 'SHP');
    const sw = s >> 16;
    const sh = s & 0xffff;
    const p = d.diagramPane;
    p.canvas = defaultCanvas;
    p.left = (w.left + cdiv((w.width - sw) | 0, 2)) | 0;
    p.top = (w.top + cdiv((w.height - sh) | 0, 2)) | 0;
    p.right = (sw + p.left - 1) | 0;
    p.bottom = (sh + p.top - 1) | 0;
    const a = new Int32Array(2);
    const b = new Int32Array(2);
    for (let i = 15; i >= 0; i--) {
      const r = cockpit.dat0009667c[i]!;
      const xl = regionFraction(r.left, baseW);
      const yt = regionFraction(r.top, baseH);
      const xr = regionFraction(r.right, baseW);
      const yb = regionFraction(r.bottom, baseH);
      r.canvas = defaultCanvas;
      a[0] = xl;
      a[1] = yt;
      b[0] = (xr + xl - 1) | 0;
      b[1] = (yb + yt - 1) | 0;
      layoutPointInPane(p, a, a);
      layoutPointInPane(p, b, b);
      r.left = (p.left + a[0]!) | 0;
      r.top = (p.top + a[1]!) | 0;
      r.right = (p.left + b[0]!) | 0;
      d.regionOrigins[i * 2] = -a[0]! | 0;
      r.bottom = (p.top + b[1]!) | 0;
      d.regionOrigins[i * 2 + 1] = -a[1]! | 0;
    }
  }
  const o = d.barOrigins;
  o[0] = 0x2323;
  o[2] = 0x7373;
  o[4] = 0x5a5a;
  o[6] = 0x4141;
  o[8] = 0xaaab;
  o[10] = 0x9192;
  o[14] = 0xc8c9;
  o[12] = 0xe1e2;
  const pane = widgetPane(w);
  layoutPointInPane(pane, d.labelPoints, d.labelPoints, 0);
  layoutPointInPane(pane, d.labelPoints, d.labelPoints, 2);
  layoutPointInPane(pane, d.labelPoints, d.labelPoints, 4);
  layoutPointInPane(pane, d.labelPoints, d.labelPoints, 6);
  for (let i = 7; i >= 0; i--) {
    o[i * 2 + 1] = 0x5555;
    layoutPointInPane(pane, o, o, i * 2);
  }
  d.barScale[0] = 0x1414;
  d.barScale[1] = 0x8000;
  const l = mechs.mechTable[mechs.playerMechIndex]!.loadout!;
  layoutPointInPane(pane, d.barScale, d.barScale, 0);
  const sec = loadoutSections(l);
  for (let i = 0; i < 8; i++) {
    d.fullArmour[i * 2] = sec[i]!.armorFront;
    d.fullArmour[i * 2 + 1] = sec[i]!.armorRear;
    // the same test twice in the original
    if (d.fullArmourMax < d.fullArmour[i * 2]!) d.fullArmourMax = d.fullArmour[i * 2]!;
    if (d.fullArmourMax < d.fullArmour[i * 2]!) d.fullArmourMax = d.fullArmour[i * 2]!;
  }
});

/**
 * The damage diagram (mode 1): the diagram shape whole, then per region the
 * section's damage level - 15 - 3 * (internal + armour / playerArmorScale) /
 * (nibble << 16) for the rear (flags high nibble) and the front (low nibble),
 * clamped to 0..15, the larger taken - becomes a colour for palette index 6
 * of the diagram: 0 when the section is gone (0x2000), 0xb at 12..15, 3 at
 * 1..11; at 0 the region is left as drawn. The diagram is drawn again
 * through that remap, clipped to the region's pane.
 *
 * @mw2 hud_damage_diagram_draw 0x0002f560
 * @fidelity exact
 * @divergence region 15 shows section 0, which reads sections[-1] - the tail of the last weapon record, including half of a pointer; what the original draws there depends on its memory layout (the region is a 1x1 pane at the diagram's corner), so the port skips it
 */
export function hudDamageDiagramDraw(l: MechLoadout): void {
  const d = damageDisplay;
  const id = (display.assetVariant + cockpit.dat000fe0e8[0]!) | 0;
  const t = cacheLoadResource(id, 'SHP');
  if (!t) return;
  // initialised once, before the loop: a section whose nibble is 0 keeps the previous region's level
  let front = 0;
  let rear = 0;
  const sections = loadoutSections(l);
  const scale = mechConfig.playerArmorScale;
  vfxShapeDraw(d.diagramPane, t, 0, 0, 0);
  for (let region = 0; region < 0x10; region++) {
    const r = cockpit.dat0009667c[region]!;
    if (r.right - r.left + 1 <= 0) continue;
    if (d.diagramRegionFrames !== 0) vfxPaneFrame(r, 0xe);
    const n = d.damageDiagramSections[region]! - 1;
    if (n < 0) {
      quirkSectionsMinusOne();
      continue;
    }
    const s = sections[n]!;
    let colour = 6;
    let nib = (s.flags & 0xf0) >> 4;
    if (nib !== 0) rear = (0xf - cdiv(Math.imul((s.internal + cdiv(s.armorRear, scale)) | 0, 3), nib << 16)) | 0;
    if (rear < 1) rear = 0;
    else if (rear > 0xf) rear = 0xf;
    nib = s.flags & 0xf;
    if (nib !== 0) front = (0xf - cdiv(Math.imul((cdiv(s.armorFront, scale) + s.internal) | 0, 3), nib << 16)) | 0;
    if (front < 1) front = 0;
    else if (front > 0xf) front = 0xf;
    const level = rear < front ? front : rear;
    if ((s.flags & 0x2000) === 0) {
      if (level < 0xc) {
        if (level > 0) colour = 3;
      } else colour = 0xb;
    } else colour = 0;
    if (colour !== 6) {
      d.damageColourRemap[6] = colour;
      vfxShapeRemapSet(d.damageColourRemap);
      vfxShapeRemapDraw(r, t, 0, d.regionOrigins[region * 2]!, d.regionOrigins[region * 2 + 1]!);
    }
  }
  cacheUnlock(id, 'SHP');
}

function quirkSectionsMinusOne(): void {
  unestablished('hud_damage_diagram_draw: region 15 reads sections[-1] (loadout bytes before the section array); skipped', 'hud_damage_diagram_draw');
}

/**
 * A bar of vertical lines from y up to y - height, width wide, shaded: the
 * left quarter in colour - 1, up to the middle in colour, the next quarter
 * in colour - 1 and the rest in colour - 2. Nothing when height <= 0.
 * (pane EAX, x EDX, y EBX, width ECX, height and colour on the stack.)
 *
 * @mw2 hud_draw_bar_vertical 0x00031520
 * @fidelity exact
 */
export function damageSub031520(pane: ViewWindow, x: number, y: number, width: number, height: number, colour: number): void {
  const half = cdiv(width, 2);
  let k = cdiv(half, 2);
  const y1 = (y - height) | 0;
  if (height <= 0) return;
  for (let i = 0; i < k; i++) vfxLineDraw(pane, (x + i) | 0, y, (x + i) | 0, y1, 0, (colour - 1) | 0);
  for (; k < half; k++) vfxLineDraw(pane, (x + k) | 0, y, (x + k) | 0, y1, 0, colour);
  const e = (half + cdiv((width - half) | 0, 2)) | 0;
  for (let i = half; i < e; i++) vfxLineDraw(pane, (x + i) | 0, y, (x + i) | 0, y1, 0, (colour - 1) | 0);
  // when e <= half the original enters this last loop directly (e is then half or below)
  for (let i = e; i < width; i++) vfxLineDraw(pane, (x + i) | 0, y, (x + i) | 0, y1, 0, (colour - 2) | 0);
}

/**
 * The armour bars (mode 2): the labels H, T, A, L in ink 6, then per
 * section a bar of the armour left (colour 0xf, from the bar's top down by
 * armour * barLength / fullArmourMax) and below it the armour lost down to
 * the full-health length, coloured 3 while more than a quarter of the
 * section's full armour remains, 0xb once a quarter or less does, 0xf3 when
 * the section is gone. Side and centre torsos (sections 1..3) have two
 * half-width bars, front and rear side by side.
 *
 * @mw2 hud_armour_bars_draw 0x0002f790
 * @fidelity exact
 * @divergence the arguments (loadout EAX, pane EDX) and every call in the body are read from the disassembly (0x2f790..0x2fa7f); the exported C loses most of them
 */
export function damageFontHandler(l: MechLoadout, pane: ViewWindow): void {
  const d = damageDisplay;
  const table = display.textColourTable;
  table[14] = 6;
  const font = hudFont();
  if (font) {
    const p = d.labelPoints;
    vfxStringDraw(pane, p[0]!, p[1]!, font, 'H', table);
    vfxStringDraw(pane, p[2]!, p[3]!, font, 'T', table);
    vfxStringDraw(pane, p[4]!, p[5]!, font, 'A', table);
    // the fourth label takes the second's y (0x96650), not its own
    vfxStringDraw(pane, p[6]!, p[3]!, font, 'L', table);
    table[14] = 0xe;
    hudFontUnlock();
  }
  const sections = loadoutSections(l);
  const o = d.barOrigins;
  if (d.fullArmourMax === 0) {
    unestablished('hud_armour_bars_draw: fullArmourMax is 0 - the original divides by it (idiv), a fault', 'hud_armour_bars_draw');
    return;
  }
  const scaled = (v: number): number => Number(BigInt.asIntN(32, (BigInt(v | 0) * BigInt(d.barScale[1]! | 0)) / BigInt(d.fullArmourMax | 0)));
  for (let i = 0; i < 8; i++) {
    const s = sections[i]!;
    let width = d.barScale[0]!;
    if (i > 0 && i < 4) width = cdiv(width, 2);
    const bar = (armour: number, full: number, x: number) => {
      let now: number;
      let lost: number;
      if ((s.flags & 0x2000) !== 0) {
        now = 0;
        lost = 0xf3;
      } else {
        lost = full >> 2 < armour ? 3 : 0xb;
        now = scaled(armour);
      }
      const fullLen = scaled(full);
      if (now !== 0) damageSub031520(pane, x, (o[i * 2 + 1]! + now) | 0, width, now, 0xf);
      if (now < fullLen) damageSub031520(pane, x, (o[i * 2 + 1]! + fullLen) | 0, width, (fullLen - now) | 0, lost);
    };
    bar(s.armorFront, d.fullArmour[i * 2]!, o[i * 2]!);
    if (i > 0 && i < 4) bar(s.armorRear, d.fullArmour[i * 2 + 1]!, (o[i * 2]! + width) | 0);
  }
}

/**
 * The block saved and set for an inset view: the same writes as
 * render_state_save_for_inset, which modes 3..5 make inline (0x309e0..,
 * 0x30ae0.., 0x30c00..) around render_view_from_pose, copying the block back
 * after.
 */
function insetStateSet(): RenderBlock {
  const block = newRenderBlock();
  renderStateSaveForInset(block);
  return block;
}

/** Modes 3..5's frame and label: vfx_pane_frame in 6, then the label shape centred at the top. */
function frameAndLabel(w: HudWidget, shape: number): void {
  const pane = widgetPane(w);
  vfxPaneFrame(pane, 6);
  hudShapeDrawInPane(w.width >> 1, 2, shape, pane);
}

/**
 * The damage display's running-state hook: records the status, shows static
 * for a damaged display (field_0x6 1: static on 3 frames in 10 until a roll
 * of 7 in 10 clears it; above 2: always) in the modes 3..5, and otherwise
 * draws by damageDisplayMode.
 *
 * @mw2 hud_widget02_tick 0x00030860
 * @fidelity exact
 */
export const hudWidget02Tick = registerCode('hud_widget02_tick', 0x30860, (w: HudWidget): void => {
  const h = hud;
  const d = damageDisplay;
  if (w.visible === 0 || h.damageDisplayMode === 0) return;
  w.lastStatus = h.playerStatusCopy;
  const mode = h.damageDisplayMode;
  if (w.field_0x6 === 1 && mode !== 1 && mode !== 2) {
    if (d.staticShowing !== 0) {
      if (randomRange(10) < 7) d.staticShowing = 0;
      if (w.visible === 0 || h.damageDisplayMode === 0) return;
      w.lastStatus = h.playerStatusCopy;
      anim2dDrawThunk(widgetPane(w), 0, 0, 0);
      return;
    }
    if (randomRange(10) < 3) d.staticShowing = 1;
  } else if (w.field_0x6 > 2 && mode !== 1 && mode !== 2) {
    if (w.visible === 0 || h.damageDisplayMode === 0) return;
    w.lastStatus = h.playerStatusCopy;
    anim2dDrawThunk(widgetPane(w), 0, 0, 0);
    return;
  }
  const l = mechs.mechTable[mechs.playerMechIndex]!.loadout!;
  switch (h.damageDisplayMode >>> 0 > 5 ? -1 : h.damageDisplayMode) {
    case 0:
      return;
    case 2:
      damageFontHandler(l, widgetPane(w));
      return;
    case 3: {
      const e = l.entity!;
      const pose = viewerPose();
      pose[3] = d.rearViewForward === 0 ? (e.heading + 0xb40000) | 0 : (e.aimAngle + e.heading) | 0;
      pose[4] = 0;
      const block = insetStateSet();
      sceneSubtreeMoveToAltList(e.node!);
      renderViewFromPose(5, 0x20000, pose, null);
      sceneSubtreeMoveToWorldList(e.node!);
      if (d.rearViewForward === 0) frameAndLabel(w, 0xfa);
      else vfxPaneFrame(widgetPane(w), 6);
      renderBlockRestore(block);
      return;
    }
    case 4: {
      const e = l.entity!;
      const pose = viewerPose();
      pose[0] = e.posX;
      pose[1] = e.posY;
      pose[2] = e.posZ;
      pose[4] = 0x5a0000;
      pose[5] = 0;
      const block = insetStateSet();
      sceneSubtreeMoveToAltList(e.node!);
      renderViewFromPose(5, 0x20000, pose, null);
      sceneSubtreeMoveToWorldList(e.node!);
      frameAndLabel(w, 0xf7);
      renderBlockRestore(block);
      return;
    }
    case 5: {
      let pose = missileCamPose();
      if (!pose) {
        missileCamFollowLast();
        pose = missileCamPose();
      }
      if (!pose) vfxPaneWipe(widgetPane(w), 0);
      else {
        const block = insetStateSet();
        pose[4] = 0;
        renderViewFromPose(5, 0x20000, pose, null);
        renderBlockRestore(block);
      }
      frameAndLabel(w, 0xfd);
      return;
    }
    default:
      hudDamageDiagramDraw(l);
  }
});

/** viewer_pose_save(viewerPosition, pose) into a fresh buffer: pos, yaw, pitch, roll, valid. */
function viewerPose(): Int32Array {
  const v = viewer();
  return Int32Array.of(v.posX, v.posY, v.posZ, v.yaw, v.pitch, v.roll, 1);
}

/**
 * The damage display's third hook, never called by player_cockpit_frame:
 * records the status and draws anim2dSlots[0] (the static) at the pane.
 *
 * @mw2 hud_widget02_hook3 0x00030da0
 * @fidelity exact
 */
export const hudWidget02Hook3 = registerCode('hud_widget02_hook3', 0x30da0, (w: HudWidget): void => {
  if (w.visible !== 0 && hud.damageDisplayMode !== 0) {
    w.lastStatus = hud.playerStatusCopy;
    anim2dDrawThunk(widgetPane(w), 0, 0, 0);
  }
});

function copyPane(dst: ViewWindow, src: ViewWindow): void {
  dst.canvas = src.canvas;
  dst.left = src.left;
  dst.top = src.top;
  dst.right = src.right;
  dst.bottom = src.bottom;
}

/** Runs hud_widget02_tick with viewportModes[5] and the widget's pane both set to the transition's pane, then puts them back. */
function tickThrough(w: HudWidget, out: ViewWindow): void {
  const vm5 = lighting.viewportModes[5]!;
  const pane = widgetPane(w);
  const savedVm = { ...vm5 } as ViewWindow;
  const savedPane = { ...pane } as ViewWindow;
  copyPane(vm5, out);
  copyPane(pane, out);
  hudWidget02Tick(w);
  copyPane(vm5, savedVm);
  copyPane(pane, savedPane);
}

/**
 * While the mech powers up, in modes 3..5 only: the display opens
 * (pane_transition_step_split direction 0, restarted on the first such
 * frame) with the running tick drawn through the opening pane; once the
 * transition is over, the plain tick.
 *
 * @mw2 hud_damage_display_powerup 0x00030e10
 * @fidelity exact
 */
export const hudDamageDisplayPowerup = registerCode('hud_damage_display_powerup', 0x30e10, (w: HudWidget): void => {
  const mode = hud.damageDisplayMode;
  if (w.visible === 0 || mode === 0 || mode === 2 || mode === 1) return;
  const t = w.paneTransition as Parameters<typeof paneTransitionStepSplit>[1] | null;
  if (t) {
    if (w.lastStatus !== 1) paneTransitionRestart(t);
    const out = paneTransitionStepSplit(0, t);
    if (!out) hudWidget02Tick(w);
    else tickThrough(w, out);
  }
  w.lastStatus = hud.playerStatusCopy;
});

/**
 * In any status but 1 and 2, modes 3..5: the display closes (direction 1,
 * restarted when the last status was not 0, 3 or 4), drawn through the
 * closing pane; nothing once it has closed.
 *
 * @mw2 hud_damage_display_powerdown 0x00030ee0
 * @fidelity exact
 */
export const hudDamageDisplayPowerdown = registerCode('hud_damage_display_powerdown', 0x30ee0, (w: HudWidget): void => {
  const mode = hud.damageDisplayMode;
  if (w.visible === 0 || mode === 0 || mode === 2 || mode === 1) return;
  const t = w.paneTransition as Parameters<typeof paneTransitionStepSplit>[1] | null;
  if (t) {
    const s = w.lastStatus;
    if (s !== 0 && s !== 3 && s !== 4) paneTransitionRestart(t);
    const out = paneTransitionStepSplit(1, t);
    if (out) tickThrough(w, out);
  }
  w.lastStatus = hud.playerStatusCopy;
});

/**
 * Lays out the gauges of widgets 17, 19, 20 and 21 in gaugeLayout
 * (0x96888..0x968d4), from their panes:
 *   [0], [1]   widget 17's anchor, a fraction of its pane made pixels
 *   [6]        width - [0];  [2] = [6] - 1
 *   [3]        height - ([1] + [1] / 2) - 3
 *   [4], [5]   width - 1, height - 1
 *   [7]        height - [1] / 2 - 2
 *   [10], [8]  widget 19's two points;  [14], [12] widget 20's;  [18], [16] widget 21's
 * (each a pair). What each gauge draws with them is gauges.ts'.
 *
 * @mw2 hud_gauge_layout_init 0x00030fc0
 * @fidelity exact
 */
export const damageSub030fc0 = registerCode('hud_gauge_layout_init', 0x30fc0, (): void => {
  const g = damageDisplay.gaugeLayout;
  const w17 = widget(0x11);
  layoutPointInPane(widgetPane(w17), g, g, 0);
  const width = w17.width;
  g[6] = (width - g[0]!) | 0;
  g[2] = (g[6]! - 1) | 0;
  const height = w17.height;
  g[3] = (height - (g[1]! + cdiv(g[1]!, 2)) - 3) | 0;
  g[5] = (height - 1) | 0;
  g[4] = (width - 1) | 0;
  g[7] = (height - cdiv(g[1]!, 2) - 2) | 0;
  const w19 = widgetPane(widget(0x13));
  layoutPointInPane(w19, g, g, 10);
  layoutPointInPane(w19, g, g, 8);
  const w20 = widgetPane(widget(0x14));
  layoutPointInPane(w20, g, g, 14);
  layoutPointInPane(w20, g, g, 12);
  const w21 = widgetPane(widget(0x15));
  layoutPointInPane(w21, g, g, 18);
  layoutPointInPane(w21, g, g, 16);
});

/**
 * The next damage display mode: 1..5, 5 wrapping to 1 (never 0, off).
 * command_execute case 2 calls it.
 *
 * @mw2 damage_display_mode_cycle 0x00030820
 * @fidelity exact
 */
export function damageDisplayModeCycle(): void {
  hud.damageDisplayMode = (hud.damageDisplayMode + 1) | 0;
  if (hud.damageDisplayMode === 6) hud.damageDisplayMode = 1;
}
