/**
 * The running-state overlay player_cockpit_frame draws after the widget
 * hooks: the compass tape and its markers (hudWidgets[23]), the altitude
 * tape (hudWidgets[22]), the reticle at the selected weapon's aim point and
 * the marker or brackets on the player's target.
 *
 * Shape ids are SHP resource ids before assetVariant is added (see
 * decompiled/mw2/listing/shapes.txt): 1 ALTMKR1, 4 ALTMKR2, 7 ALTTAPE, 0xd
 * CMPMKR1, 0x10 CMPMKR2, 0x13 CMPMKR3, 0x16 CMPMKR4, 0x19 COMPASS, 0x1c
 * CRTDOWN, 0x1f CRTLFT, 0x22 CRTRGHT, 0x25 CRTUP, 0x61 RCLGLOC, 0x67
 * RCLINOP, 0x6a RCLLOCK, 0x6d RCLNOLK, 0x70 RCLPLOC, 0x73 RCLTGT, 0x76
 * RETICLE, 0xb8.. the bracket corners, 0xe5 TGTNP, 0xe8/0xeb/0xee the
 * off-screen markers, 0x115 ALTTOP.
 *
 * Several calls pass their pane in ECX or take register arguments the
 * decompiled C does not show; those are read from the disassembly.
 */
import type { MechEntity, MechLoadout, SceneNode, Viewer } from '../../generated/classes.gen.ts';
import { cdiv, cmod } from '../../core/int/cint.ts';
import { mulr16 } from '../../core/int/fx16.ts';
import { sdivShl } from '../../core/int/i64.ts';
import { quirk } from '../../core/provenance.ts';
import { registerCode } from '../../engine/codePtr.ts';
import { registerGlobals } from '../../engine/globals.ts';
import { imageI32s } from '../../engine/image.ts';
import { cacheLoadResource, cacheUnlock } from '../../engine/resources/cache.ts';
import { objectGetPosRadius } from '../../engine/scene/worldObject.ts';
import { DRAWN_AFTER, DRAWN_ANCHORED, vfxShapeOrigin, vfxShapeSize, vfxWindowClear, type VfxWindow } from '../../engine/vfx/vfx.ts';
import { present, presentLerp, presenting } from '../../engine/scene/present.ts';
import { viewerProjectPoint } from '../camera/projection.ts';
import { passView, type DrawView } from '../camera/viewerPresent.ts';
import { viewer } from '../camera/viewer.ts';
import { display } from '../display/video.ts';
import { layoutPointInPane, vfxFontSub014020 } from '../display/layout.ts';
import { mechAllegiance } from '../groups/groups.ts';
import { weaponTypes } from '../mech/config.ts';
import { loadoutWeapons } from '../mech/loadout.ts';
import { mechs } from '../mech/mechGlobals.ts';
import { playerTargetNode } from '../ai/targeting.ts';
import { trackedGlobals } from '../ai/tracked.ts';
import { gamethingAllegiance } from '../things/gameThingDamage.ts';
import { things } from '../things/gameThings.ts';
import { aimPointToScreen } from '../weapons/weapons.ts';
import { worldObjectGetPos } from '../world/worldRecords.ts';
import { hudDrawBar } from './gauges.ts';
import { hud, hudShapeDraw, hudShapeDrawInPane, widget, widgetPane } from './hud.ts';

function bootOverlay() {
  return {
    /**
     * 0x96224: {width, height} of ALTMKR1 once hud_tapes_init has measured it
     * (3855, 3449 in the image - fractions nobody reads before then)
     */
    altMarkerSize: Int32Array.from(imageI32s(0x96224, 2, [0, 0])),
    /**
     * 0x9622c: the altitude tape's anchor {x, y} in hudWidgets[22]'s pane -
     * the fraction (0.7, 0.5) in the image, pixels after hud_tapes_init, whose
     * x then moves left by the tape's width
     */
    altAnchor: Int32Array.from(imageI32s(0x9622c, 2, [45875, 32768])),
    /** 0x96234: the compass's anchor {x, y} in hudWidgets[23]'s pane, the fraction (0.5, 0.4) in the image */
    compassAnchor: Int32Array.from(imageI32s(0x96234, 2, [32768, 26214])),
    /** 0xfb538, 0xfb53c: CRTUP's width and height */
    crtUpWidth: 0,
    crtUpHeight: 0,
    /** 0xfb540, 0xfb544: CRTLFT's width and height */
    crtLeftWidth: 0,
    crtLeftHeight: 0,
    /** 0xfb548: x of ALTMKR2 (the ground marker): the anchor + one marker width */
    altGroundMarkerX: 0,
    /** 0xfb54c: altitude to tape pixels, 16.16 - ALTTAPE's height / 232 */
    altScale: 0,
    /** 0xfb550: CMPMKR3's origin y, the low word of vfx_shape_origin */
    compassMarkerOriginY: 0,
    /** 0xfb554: compass pixels per degree, 16.16 - COMPASS's width / 360 */
    compassScale: 0,
    /** 0xfb558: CMPMKR3's height below its origin */
    compassMarkerBelow: 0,
    /** 0xfb55c: x of ALTMKR1: the anchor as it was before the tape's width came off */
    altMarkerX: 0,
    /** 0xfb560: x of the target-height marker: the anchor + two marker widths */
    altTargetMarkerX: 0,
  };
}

/** The tapes' layout (0x96224..0x96238, 0xfb538..0xfb560). */
export const overlay = registerGlobals('overlay', bootOverlay(), () => {
  Object.assign(overlay, bootOverlay());
});

const entityOf = (l: MechLoadout): MechEntity => l.entity!;

/** Loads SHP id + assetVariant and measures shape 0; returns null when it is missing. */
function measure(id: number, f: (t: Uint8Array) => void): void {
  const t = cacheLoadResource((display.assetVariant + id) | 0, 'SHP');
  if (!t) return;
  const size = vfxShapeSize(t, 0);
  f(t);
  quirk('hud_tapes_init unlocks id vfx_shape_size() + base rather than assetVariant + base', 'hud_tapes_init');
  cacheUnlock((size + id) | 0, 'SHP');
}

/**
 * Lays out the tapes once, from hud_widgets_install: the altitude anchor in
 * hudWidgets[22]'s pane and the compass anchor in hudWidgets[23]'s
 * (layout_point_in_pane), then the sizes of the shapes they draw - ALTMKR1
 * (the marker columns at the anchor, + width, + 2 widths), ALTTAPE (the
 * anchor moves left by its width; its height / 232 is the altitude scale),
 * COMPASS (its width / 360 is the per-degree scale), CMPMKR3 (split at its
 * origin's y), CRTUP and CRTLFT.
 *
 * @mw2 hud_tapes_init 0x000290d0
 * @fidelity exact
 * @divergence each cache_unlock is passed vfx_shape_size's result + the base id - a wrong id the port's cache ignores (cache_unlock does nothing here)
 */
export function hudTapesInit(): void {
  const o = overlay;
  layoutPointInPane(widgetPane(widget(0x16)), o.altAnchor, o.altAnchor);
  measure(1, (t) => {
    const s = vfxShapeSize(t, 0);
    o.altMarkerSize[0] = s >> 16;
    o.altMarkerSize[1] = s & 0xffff;
  });
  o.altMarkerX = o.altAnchor[0]!;
  o.altGroundMarkerX = (o.altAnchor[0]! + o.altMarkerSize[0]!) | 0;
  o.altTargetMarkerX = (o.altGroundMarkerX + o.altMarkerSize[0]!) | 0;
  measure(7, (t) => {
    const s = vfxShapeSize(t, 0);
    o.altAnchor[0] = (o.altAnchor[0]! - (s >> 16)) | 0;
    o.altScale = sdivShl(s & 0xffff, 16, 0xe8);
  });
  layoutPointInPane(widgetPane(widget(0x17)), o.compassAnchor, o.compassAnchor);
  measure(0x19, (t) => {
    o.compassScale = sdivShl(vfxShapeSize(t, 0) >> 16, 16, 0x168);
  });
  measure(0x13, (t) => {
    const s = vfxShapeSize(t, 0);
    o.compassMarkerOriginY = vfxShapeOrigin(t, 0) & 0xffff;
    o.compassMarkerBelow = ((s & 0xffff) - o.compassMarkerOriginY) | 0;
  });
  measure(0x25, (t) => {
    const s = vfxShapeSize(t, 0);
    o.crtUpWidth = s >> 16;
    o.crtUpHeight = s & 0xffff;
  });
  measure(0x1f, (t) => {
    const s = vfxShapeSize(t, 0);
    o.crtLeftWidth = s >> 16;
    o.crtLeftHeight = s & 0xffff;
  });
}

/** (int64)a * b / 100 >> 16 - the altitude tape's pixel offset. */
const altPixels = (a: number, b: number): number => Number(BigInt.asIntN(32, (BigInt(a | 0) * BigInt(b | 0)) / 100n)) >> 16;

/**
 * The altitude tape in hudWidgets[22]: the tape (ALTTAPE) scrolled by the
 * mech's altitude (entity posY - rideHeight, less 0x4e84) times the scale,
 * ALTTOP above it when it has scrolled down, ALTMKR1 at the anchor and
 * ALTMKR2 at the height above the ground; with a live target (a mech, a
 * gamething or a tracked point) a marker at the target's height - CRTUP or
 * CRTDOWN clamped to the box, CRTLFT inside it - drawn through hud_shape_draw
 * at the pane's origin. Arguments (loadout EAX; the 8 and 0x4a the overlay
 * passes in EDX and EBX are not read), from the disassembly 0x28ed0..0x290cc.
 *
 * @mw2 hud_altitude_tape_draw 0x00028ed0
 * @fidelity exact
 */
export function hudAltitudeTapeDraw(l: MechLoadout): void {
  const o = overlay;
  const w = widget(0x16);
  const pane = widgetPane(w);
  const e = entityOf(l);
  const alt = (e.posY - l.rideHeight) | 0;
  const tapeY = (o.altAnchor[1]! + altPixels(o.altScale, (alt - 0x4e84) | 0)) | 0;
  if (tapeY > o.altAnchor[1]!) hudShapeDrawInPane(o.altAnchor[0]!, o.altAnchor[1]!, 0x115, pane);
  hudShapeDrawInPane(o.altAnchor[0]!, tapeY, 7, pane);
  hudShapeDrawInPane(o.altMarkerX, o.altAnchor[1]!, 1, pane);
  hudShapeDrawInPane(o.altGroundMarkerX, (o.altAnchor[1]! + altPixels(o.altScale, (alt - e.groundHeight) | 0)) | 0, 4, pane);
  const hb = (e.targetHandle >>> 8) & 0xff;
  if ((hb & 0xf) === 0 || (hb & 0x10) !== 0) return;
  const type = e.targetHandle & 0xf00;
  const index = e.targetHandle & 0xff;
  let d: number;
  if (type === 0x200) {
    const t = mechs.mechTable[index]!.loadout!;
    d = (alt - ((t.entity!.posY - t.rideHeight) | 0)) | 0;
  } else if (type === 0x400) {
    d = (alt - worldObjectGetPos(things.gameThings[index]!.geomIndex)[1]) | 0;
  } else if (type === 0x100) {
    d = (alt - trackedGlobals.trackedObjects[index]!.y) | 0;
  } else return;
  let y = (o.altAnchor[1]! + altPixels(o.altScale, d)) | 0;
  let x = o.altTargetMarkerX;
  let shape: number;
  if (y < 0) {
    shape = 0x25;
    y = 0;
    x = (o.altMarkerSize[0]! + o.altTargetMarkerX) | 0;
  } else if (w.height < y) {
    shape = 0x1c;
    y = w.height;
    x = (o.altMarkerSize[0]! + o.altTargetMarkerX) | 0;
  } else shape = 0x1f;
  hudShapeDraw((pane.left + x) | 0, (y + pane.top) | 0, shape);
}

/**
 * The compass tape in hudWidgets[23]: COMPASS twice, a whole turn of tape
 * apart (to the right unless the first copy starts past the box), at
 * anchor x + (legs + 360) % 360 degrees times the scale; with the torso
 * twisted, a bar in 0xf from the anchor as long as the twist in degrees
 * (unscaled) above the tape; then CMPMKR3 at the anchor. Arguments (EAX 0x73
 * and EDX 0x10 unread, legs EBX, torso ECX), from the disassembly
 * 0x29760..0x2985e.
 *
 * @mw2 hud_compass_tape_draw 0x00029760
 * @fidelity exact
 */
export function hudCompassTapeDraw(_a: number, _b: number, legsDeg: number, torsoDeg: number): void {
  const o = overlay;
  const w = widget(0x17);
  const pane = widgetPane(w);
  const x = (o.compassAnchor[0]! + mulr16(o.compassScale, cmod((legsDeg + 0x168) | 0, 0x168))) | 0;
  const turn = mulr16(o.compassScale, 0x168);
  const x2 = w.width > x ? (x + turn) | 0 : (x - turn) | 0;
  const y = o.compassAnchor[1]!;
  hudShapeDrawInPane(x, y, 0x19, pane);
  hudShapeDrawInPane(x2, y, 0x19, pane);
  if (torsoDeg !== 0) {
    const by = (y - o.compassMarkerOriginY) | 0;
    if (torsoDeg < 0) hudDrawBar(pane, (o.compassAnchor[0]! + torsoDeg) | 0, by, -torsoDeg | 0, o.compassMarkerOriginY, 0xf);
    else hudDrawBar(pane, o.compassAnchor[0]!, by, torsoDeg, o.compassMarkerOriginY, 0xf);
  }
  hudShapeDrawInPane(o.compassAnchor[0]!, y, 0x13, pane);
}

/**
 * The compass markers: the bearing to the target (legs-relative for a
 * tracked point, handle bit 0x100; torso-relative otherwise). Unless the
 * autopilot is in mode 2, with a live target the elevation arrows CRTUP
 * (tilt above -3 degrees) and CRTDOWN (below +3) at the anchor, else nothing
 * more; then the bearing marker - CMPMKR1 at the bearing times the scale, or
 * CMPMKR2 and CMPMKR4 at the anchor on 0 - and the twist arrows, CRTRGHT past
 * the right edge while the bearing is above -3 (doubled beyond 90) and
 * CRTLFT before the left while below 3 (doubled below -90). Arguments
 * (loadout EAX, 0x73 EDX, 0x10 EBX, bearing ECX, then bearingTorso and tilt
 * on the stack; ret 8), from the disassembly 0x29570..0x29751.
 *
 * @mw2 hud_compass_markers_draw 0x00029570
 * @fidelity exact
 */
export function hudCompassMarkersDraw(l: MechLoadout, _a: number, _b: number, bearing: number, bearingTorso: number, tilt: number): void {
  const o = overlay;
  const w = widget(0x17);
  const pane = widgetPane(w);
  const e = entityOf(l);
  const hb = (e.targetHandle >>> 8) & 0xff;
  const b = (hb & 1) !== 0 ? bearing : bearingTorso;
  const ax = o.compassAnchor[0]!;
  const ay = o.compassAnchor[1]!;
  if (l.autopilotEngaged !== 2) {
    if ((hb & 0xf) === 0 || (hb & 0x10) !== 0) return;
    if (tilt > -0x30000) hudShapeDraw((pane.left + ax) | 0, (pane.top + ((ay - o.crtUpHeight - o.compassMarkerOriginY) | 0)) | 0, 0x25);
    if (tilt < 0x30000) hudShapeDraw((pane.left + ax) | 0, (pane.top + ((ay + o.crtUpHeight + o.compassMarkerBelow) | 0)) | 0, 0x1c);
  }
  if (b === 0) hudShapeDrawInPane(ax, ay, 0x10, pane);
  else hudShapeDrawInPane((mulr16(o.compassScale, b) + ax) | 0, ay, 0xd, pane);
  if (b === 0) hudShapeDrawInPane(ax, ay, 0x16, pane);
  const ay2 = (ay + cdiv(o.crtLeftHeight, 2)) | 0;
  if (b > -3) {
    const x = (w.width + o.crtLeftWidth - 1) | 0;
    hudShapeDraw((pane.left + x) | 0, (ay2 + pane.top) | 0, 0x22);
    if (b > 0x5a) hudShapeDraw((pane.left + x + 1) | 0, (ay2 + pane.top) | 0, 0x22);
  }
  if (b < 3) {
    const x = -o.crtLeftWidth | 0;
    hudShapeDraw((pane.left + x) | 0, (pane.top + ay2) | 0, 0x1f);
    if (b < -0x5a) hudShapeDraw((pane.left + x - 1) | 0, (pane.top + ay2) | 0, 0x1f);
  }
}

/**
 * The reticle at the selected weapon's aim point (aim_point_to_screen), when
 * it is on screen. Its shape: RCLINOP (0x67) unless the weapon is ready
 * (fireState 1); for a guided weapon RCLGLOC (0x61) with loadout flags bit 7,
 * RCLPLOC (0x70) with bit 15, else RCLNOLK (0x6d); for an unguided one
 * RETICLE (0x76; RCLNOLK for projectileKind 3), becoming RCLTGT (0x73;
 * RCLLOCK 0x6a) - and the result 1 - with a live target (not bits 0x1000 or
 * 0x100 of the handle) between minRange and maxRange, the tilt inside +/-3
 * degrees and the torso-relative bearing inside +/-3. Arguments (loadout EAX,
 * bearingTorso EDX, tilt EBX, range ECX).
 *
 * @mw2 hud_reticle_draw 0x00029360
 * @fidelity exact
 */
export function hudReticleDraw(l: MechLoadout, bearingTorso: number, tilt: number, range: number, view: DrawView = passView()): number {
  const sel = l.selectedWeapon;
  const wp = loadoutWeapons(l)[sel];
  let result = 0;
  let shape: number;
  // with no weapon selected the original reads weapons[-1], whose fireState
  // overlaps the loadout header (selectedWeapon's high half, 0xffff) and is never 1
  if (!wp || wp.fireState !== 1) shape = 0x67;
  else {
    const t = weaponTypes()[wp.type]!;
    const lock = t.projectileKind === 3 ? 0x6a : 0x73;
    const plain = t.projectileKind === 3 ? 0x6d : 0x76;
    if (t.guided === 0) {
      shape = plain;
      const h = entityOf(l).targetHandle;
      if (h !== 0 && ((h >>> 8) & 0x11) === 0 && t.minRange < range && range < t.maxRange && tilt < 0x30000 && tilt > -0x30000 && bearingTorso < 3 && bearingTorso > -3) {
        result = 1;
        shape = lock;
      }
    } else if ((l.flags & 0x80) !== 0) shape = 0x61;
    else if (((l.flags >>> 8) & 0x80) !== 0) shape = 0x70;
    else shape = 0x6d;
  }
  const p = aimPointToScreen(l, view);
  if (p.visible !== 0) hudShapeDraw(p.sx, p.sy, shape);
  return result;
}

/** ((int64)focalScale * r >> 8) / depth >> 6 - a bracket's half-size. */
function bracketSize(v: Viewer, r: number, depth: number): number {
  const q = ((BigInt(v.focalScale | 0) * BigInt(r | 0)) >> 8n) / BigInt(depth | 0);
  return Number(BigInt.asIntN(32, q)) >> 6;
}

/** The off-screen marker for an allegiance: 0xeb (0), 0xee (2), 0xe8 (anything else). */
const offScreenShape = (a: number): number => (a === 0 ? 0xeb : a === 2 ? 0xee : 0xe8);

/** The bracket corners {TL, TR, BL, BR} for an allegiance, or null past 2. */
function corners(a: number): number[] | null {
  if (a === 0) return [0xb8, 0xc1, 0xca, 0xd3];
  if (a === 1) return [0xbb, 0xc4, 0xcd, 0xd6];
  if (a === 2) return [0xbe, 0xc7, 0xd0, 0xd9];
  return null;
}

function drawBrackets(x: number, y: number, s: number, a: number, where: string): void {
  const c = corners(a);
  if (!c) {
    quirk(`${where}: an allegiance above 2 draws with uninitialised shape ids; the port draws nothing`, where);
    return;
  }
  hudShapeDraw((x - s) | 0, (y - s) | 0, c[0]!);
  hudShapeDraw((x + s) | 0, (y - s) | 0, c[1]!);
  hudShapeDraw((x - s) | 0, (y + s) | 0, c[2]!);
  hudShapeDraw((x + s) | 0, (y + s) | 0, c[3]!);
}

/**
 * Four corner brackets around a target mech, half-size from its loadout
 * radius and the projected depth; off screen, one marker pinned to the
 * viewport's edge (vfx_font_sub_014020). Arguments (mech EAX, allegiance DL).
 *
 * @mw2 hud_target_brackets_mech 0x000298c0
 * @fidelity exact
 */
export function hudTargetBracketsMech(m: MechEntity, allegiance: number, view: DrawView = passView()): void {
  const p = [m.posX, m.posY, m.posZ];
  view.anchor(m, p);
  if (viewerProjectPoint(view.viewer, p) === 0) {
    const q = Int32Array.of(p[0]!, p[1]!);
    vfxFontSub014020(display.currentViewport, q, q);
    hudShapeDraw(q[0]!, q[1]!, offScreenShape(allegiance & 0xff));
    return;
  }
  const s = bracketSize(view.viewer, m.loadout!.radius, p[2]!);
  drawBrackets(p[0]!, p[1]!, s, allegiance & 0xff, 'hud_target_brackets_mech');
}

/**
 * hud_target_brackets_mech for a gamething's node: the size from half its
 * world object's radius, capped at half the viewer's halfWidth. Nothing when
 * the node or its object is missing. (The corners are the same as the mech
 * version's.)
 *
 * @mw2 hud_target_brackets_object 0x00029a30
 * @fidelity exact
 */
export function hudTargetBracketsObject(node: SceneNode | null, allegiance: number, view: DrawView = passView()): void {
  if (!node || !node.userData) return;
  const o = objectGetPosRadius(node.userData);
  const p = [o.x, o.y, o.z];
  view.anchor(node, p);
  if (viewerProjectPoint(view.viewer, p) === 0) {
    const q = Int32Array.of(p[0]!, p[1]!);
    vfxFontSub014020(display.currentViewport, q, q);
    hudShapeDraw(q[0]!, q[1]!, offScreenShape(allegiance & 0xff));
    return;
  }
  let s = bracketSize(view.viewer, o.radius >> 1, p[2]!);
  const cap = view.viewer.halfWidth >> 1;
  if (cap < s) s = cap;
  drawBrackets(p[0]!, p[1]!, s, allegiance & 0xff, 'hud_target_brackets_object');
}

/**
 * The marker on the player's target, unless the handle is empty or carries
 * 0x1000: a tracked point (0x100) as TGTNP (0xe5) at the entity's target
 * position projected, or TGTOFFF (0xeb) pinned to the viewport's edge when
 * off screen; a mech (0x200) and a gamething (0x400) through the brackets,
 * with their allegiance.
 *
 * @mw2 hud_target_marker_draw 0x00029470
 * @fidelity exact
 */
export function hudTargetMarkerDraw(l: MechLoadout, view: DrawView = passView()): void {
  const e = entityOf(l);
  const h = e.targetHandle >>> 0;
  if (h === 0 || (h & 0x1000) !== 0) return;
  const type = h & 0xf00;
  const index = h & 0xff;
  if (type < 0x200) {
    if (type !== 0x100) return;
    const p = [e.targetX, e.targetY, e.targetZ];
    if (viewerProjectPoint(view.viewer, p) === 0) {
      const q = Int32Array.of(p[0]!, p[1]!);
      vfxFontSub014020(display.currentViewport, q, q);
      hudShapeDraw(q[0]!, q[1]!, 0xeb);
    } else hudShapeDraw(p[0]!, p[1]!, 0xe5);
  } else if (type === 0x200) hudTargetBracketsMech(mechs.mechTable[index]!, mechAllegiance(index) & 0xff, view);
  else if (type === 0x400) hudTargetBracketsObject(playerTargetNode(), gamethingAllegiance(index) & 0xff, view);
}

/**
 * The overlay, while the HUD is on: the compass (tape and markers) when
 * hudCompassOn, the reticle in the pilot's view when hudReticleOn, the
 * target marker when hudTargetMarkerOn, the altitude tape when hudAltitudeOn.
 * The reticle and target marker stand on points in the world; the window
 * marks their pixels (DRAWN_ANCHORED) and the port records the call, so the
 * host can redraw them between passes where the 3D is drawn
 * (hudAnchoredPresent).
 * Arguments (loadout EAX, legs EDX, torso EBX, bearing ECX, then
 * bearingTorso, tilt, range and pilotView on the stack; ret 0x10), from the
 * disassembly 0x28e30..0x28ec9.
 *
 * @mw2 hud_overlay_draw 0x00028e30
 * @fidelity exact
 */
export const hudOverlayDraw = registerCode(
  'hud_overlay_draw',
  0x28e30,
  (l: MechLoadout, legsDeg: number, torsoDeg: number, bearing: number, bearingTorso: number, tilt: number, range: number, pilotView: number): void => {
    const h = hud;
    if (h.hudEnabled === 0) return;
    if (h.hudCompassOn !== 0) {
      hudCompassTapeDraw(0x73, 0x10, legsDeg, torsoDeg);
      hudCompassMarkersDraw(l, 0x73, 0x10, bearing, bearingTorso, tilt);
    }
    const reticle = pilotView !== 0 && h.hudReticleOn !== 0;
    const marker = h.hudTargetMarkerOn !== 0;
    if (reticle || marker) {
      // the world-anchored part, drawn as the original draws it and recorded for the host to
      // redraw between passes (port-only; the window's pixels are the original's)
      const pane = display.currentViewport;
      const last = hudAnchored.call;
      hudAnchored.prev = last && last.generation === ((present.generation - 1) | 0) ? last : null;
      const call: AnchoredCall = { generation: present.generation, l, bearingTorso, tilt, range, reticle, marker, pane: [pane.left, pane.top, pane.right, pane.bottom], anchors: new Map() };
      hudAnchored.call = call;
      const win = pane.canvas as VfxWindow | null;
      if (win) win.drawnMark = DRAWN_ANCHORED;
      hudOverlayAnchoredDraw(call, { viewer: viewer(), anchor: (k, q) => call.anchors.set(k, [q[0]!, q[1]!, q[2]!]) });
      if (win) win.drawnMark = DRAWN_AFTER;
    }
    if (h.hudAltitudeOn !== 0) hudAltitudeTapeDraw(l);
  },
);

/** One pass's world-anchored HUD draw: hud_overlay_draw's arguments and switches, and the pane it drew in. @portOnly */
interface AnchoredCall {
  /** the pass (present.generation) that drew it */
  generation: number;
  l: MechLoadout;
  bearingTorso: number;
  tilt: number;
  range: number;
  reticle: boolean;
  marker: boolean;
  /** display.currentViewport's left, top, right, bottom as it drew */
  pane: [number, number, number, number];
  /** the world points it stood on, by anchor key (DrawView.anchor) */
  anchors: Map<unknown, number[]>;
}

/** The last world-anchored HUD draw, and the one the pass before made. @portOnly */
export const hudAnchored = registerGlobals('hudAnchored', { call: null as AnchoredCall | null, prev: null as AnchoredCall | null }, () => {
  hudAnchored.call = null;
  hudAnchored.prev = null;
});

/** hud_overlay_draw's reticle and target marker, through `view`. @portOnly */
function hudOverlayAnchoredDraw(c: AnchoredCall, view: DrawView): void {
  if (c.reticle) hudReticleDraw(c.l, c.bearingTorso, c.tilt, c.range, view);
  if (c.marker) hudTargetMarkerDraw(c.l, view);
}

/**
 * The host, between passes: redraws the last pass's reticle and target
 * marker into `layer` (cleared first) - the same ported draws, into the same
 * pane - through `v` (the presented viewer), each world point they stand on
 * moved from where the pass before drew it to where the last pass did. The
 * points themselves are interpolated, not carried with a node: the aim point
 * takes its pitch and range from ramps no node follows. A point the pass
 * before did not draw (a new target) is drawn where it is. Returns false when
 * the last pass drew none, and the window's own pixels then stand as they
 * are.
 *
 * @portOnly the host draws between passes (engine/scene/present.ts)
 */
export function hudAnchoredPresent(layer: VfxWindow, v: Viewer): boolean {
  vfxWindowClear(layer);
  const c = hudAnchored.call;
  if (!c || c.generation !== present.generation) return false;
  const before = hudAnchored.prev;
  const view: DrawView = {
    viewer: v,
    anchor: (k, p) => {
      const q = before?.anchors.get(k);
      if (!q || !presenting()) return;
      for (let i = 0; i < 3; i++) p[i] = presentLerp(q[i]!, p[i]!);
    },
  };
  const pane = display.currentViewport;
  const saved = [pane.canvas, pane.left, pane.top, pane.right, pane.bottom] as const;
  pane.canvas = layer;
  [pane.left, pane.top, pane.right, pane.bottom] = c.pane;
  try {
    hudOverlayAnchoredDraw(c, view);
  } finally {
    [pane.canvas, pane.left, pane.top, pane.right, pane.bottom] = saved;
  }
  return true;
}
