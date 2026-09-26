/**
 * The radar and the overhead map (hudWidgets[0]'s display), laid out by the
 * DISP resource RADAR (MW2.PRJ DISP 1) - an LX module whose mode table
 * describes each display (decompiled/tools/dump_radar.py prints it).
 *
 * The display runs as a small state machine over a byte of modes (0xa4c48):
 * 0 off, 1 the small radar, 2 the large one, 4 the overhead map; 3 and 5
 * are requests that open and close the map. A requested mode (0xa4c44) is
 * taken up by radar_mode_step once a frame. Every frame the player's
 * cockpit calls one of three drivers by the player's status - powering up
 * (012890), running (011660) or otherwise (012b50) - and the radar draws
 * itself (radar_draw) as an ORTHOGRAPHIC view from `range`
 * centimetres straight above the player: nav points, seen mechs and
 * gamethings as blips, the target, the view cone of the cockpit camera, a
 * frame and the range readout. Opening the map swaps main's render hook for
 * map_view_render_hook, which draws the whole screen as the map instead of
 * the 3D view.
 */
import { Viewer, ViewWindow } from '../../generated/classes.gen.ts';
import { cdiv, cmod } from '../../core/int/cint.ts';
import { mulr16 } from '../../core/int/fx16.ts';
import { sdivShl } from '../../core/int/i64.ts';
import { fixedAtan2, fixedCos, fixedSin } from '../../core/angle/trig.ts';
import { quirk, unestablished } from '../../core/provenance.ts';
import { randomRange } from '../../core/random.ts';
import { systemError } from '../../core/systemError.ts';
import { lxModuleLoad } from '../../data/exe/tables/menus.ts';
import { registerCode, type CodeFn } from '../../engine/codePtr.ts';
import { clock } from '../../engine/clock.ts';
import { registerGlobals } from '../../engine/globals.ts';
import { imageI32 } from '../../engine/image.ts';
import { cacheLoadResource, cacheUnlock } from '../../engine/resources/cache.ts';
import { sceneNodeGetWorldPos } from '../../engine/scene/sceneGraph.ts';
import type { VfxWindow } from '../../engine/vfx/vfx.ts';
import { vfxLineDraw, vfxPaneWipe, vfxShapeDraw, vfxStringDraw } from '../../engine/vfx/vfx.ts';
import { mainLoop, type RenderHook } from '../../mission/mainLoop.ts';
import { worldRootNode } from '../../engine/scene/objectLists.ts';
import { HOOK, newRenderBlock, renderBlockRestore, renderBlockSave, renderOptions } from '../display/renderState.ts';
import { renderPort } from '../display/renderPort.ts';
import { cam } from '../camera/cameraUpdate.ts';
import { viewerBuildTransform, viewerUpdateProjection } from '../camera/projection.ts';
import { cameraGetMode, cameraGlobals } from '../camera/viewer.ts';
import {
  layoutPaneCentreInWindow,
  layoutPaneInPane,
  layoutPaneToDesignAspect,
  layoutPaneToWindow,
  layoutPointInPane,
  vfxFontSub014020,
  vfxFontSub014240,
  vfxPaneFrame,
} from '../display/layout.ts';
import { defaultCanvas, display, viewportSelect } from '../display/video.ts';
import { mechAllegiance } from '../groups/groups.ts';
import { mechs } from '../mech/mechGlobals.ts';
import { mechRuntime } from '../mech/mechRuntime.ts';
import { cameraSetMode } from '../mech/mechTickAi.ts';
import { soundCuePlay, soundPlay } from '../sound/sound.ts';
import { gamethingAllegiance } from '../things/gameThingDamage.ts';
import { things } from '../things/gameThings.ts';
import { trackedGlobals } from '../ai/tracked.ts';
import { uiContextActive } from '../ui/uiContext.ts';
import { lighting } from '../world/environment.ts';
import { mechLodUpdate } from '../world/detailRecords.ts';
import { worldObjectGetPos } from '../world/worldRecords.ts';
import { anim2dDraw } from '../world/anim2d.ts';
import { palettes } from '../world/palettes.ts';
import { hud, paneTransitionRestart, paneTransitionStep } from './hud.ts';
import { cockpit, type PaneTransition } from './resources.ts';

const TURN = 0x1680000;

// ---- the RADAR module ----------------------------------------------------------

/** A pane transition's state record, which two of the module's transitions share. */
interface TransitionState {
  now: number;
  before: number;
  elapsed: number;
}

/** A pane transition whose state lives in a record other transitions may share. @portOnly */
class RadarTransition implements PaneTransition {
  constructor(
    readonly state: TransitionState,
    public duration: number,
    public from: ViewWindow,
    public to: ViewWindow,
    public out: ViewWindow,
    /** block offsets of the {state, params} record, the state and the params (for the listing) */
    readonly at: { rec: number; state: number; params: number },
  ) {}
  get now(): number {
    return this.state.now;
  }
  set now(v: number) {
    this.state.now = v & 0xff;
  }
  get before(): number {
    return this.state.before;
  }
  set before(v: number) {
    this.state.before = v & 0xff;
  }
  get elapsed(): number {
    return this.state.elapsed;
  }
  set elapsed(v: number) {
    this.state.elapsed = v | 0;
  }
}

/** A char buffer in the module; the bearing buffer is one all three modes point at. @portOnly */
export interface TextBuffer {
  at: number;
  text: string;
}

/** A frame hook, clip test, clamp and edge-point hook - the four the function table at 0x955c4 supplies. */
type FrameHook = (pane: ViewWindow, colour: number) => void;
type ClipHook = (pane: ViewWindow, x: number, y: number) => number;
type ClampHook = (pane: ViewWindow, p: Int32Array, out: Int32Array) => Int32Array;
type EdgeHook = (pane: ViewWindow, angle: number, out: Int32Array) => Int32Array;

/** One mode's descriptor (radar_mode_install's reading; see dump_radar.py). */
export interface RadarMode {
  /** @portOnly block offset */
  at: number;
  /** +0x00 */
  pane: ViewWindow;
  /** +0x04: where radar_draw_transition keeps +0x00 while a transition draws */
  savePane: ViewWindow;
  /** +0x08: the viewportModes index the pane is copied to */
  viewportIndex: number;
  /** +0x0c / +0x10: SNDS ids on opening / closing the map, -1 none */
  openSound: number;
  closeSound: number;
  /** +0x14 */
  transition: RadarTransition | null;
  /** +0x18: the orthographic view's width, cm */
  range: number;
  /** +0x1c: the range the readout last printed */
  shownRange: number;
  /** +0x20 / +0x24 / +0x28: zoom's default, least and most */
  defaultRange: number;
  leastRange: number;
  mostRange: number;
  /** +0x2c: (default << 16) / range */
  zoomScale: number;
  /** +0x30: FONT id of the readouts (plus assetVariant) */
  fontId: number;
  /** +0x34 / +0x38: no reader found */
  unread34: TextBuffer;
  unread38: TextBuffer;
  /** +0x3c / +0x40 */
  rangeLabel: TextBuffer;
  rangeText: TextBuffer;
  /** +0x44 / +0x48 / +0x4c */
  bearingLabel: TextBuffer;
  bearingText: TextBuffer;
  shownHeading: number;
  /** +0x50 / +0x54 */
  metres: TextBuffer;
  km: TextBuffer;
  /** +0x58: three {x, y} - unread, the range readout's place, the bearing readout's */
  points: Int32Array;
  /** +0x70 (21), +0x74 (14), +0x78 (5): see dump_radar.py */
  shapes: Int32Array;
  shapesAt: number;
  colours: Int32Array;
  coloursAt: number;
  anim: Int32Array;
  animAt: number;
  /** +0x7c..+0x88 as the module stores them: indices into the table at 0x955c4 */
  hookIndex: number[];
  /** the same after radar_mode_install: frame, clip test, clamp, edge point */
  frameHook: FrameHook | null;
  clipHook: ClipHook | null;
  clampHook: ClampHook | null;
  edgeHook: EdgeHook | null;
}

export interface RadarModule {
  /** @portOnly the loaded block and its relocations */
  block: Uint8Array;
  fixups: Map<number, number>;
  root: number;
  modesAt: number;
  modes: (RadarMode | null)[];
  /** root[1], 0xa4c38: {1, 0, -1, ptr, ptr, point, ...} - only its point at +0x14 is read (radar_init) */
  auxAt: number;
  aux: Int32Array;
}

/**
 * Reads the mode table out of a loaded RADAR module: every pointer followed
 * only where the loader relocated it, and a record reached twice is the same
 * object (modes 1 and 2 share a transition state, all three the colour table
 * and the bearing buffer).
 *
 * @portOnly the data half of radar_module_load and radar_mode_install
 */
export function readRadarModule(block: Uint8Array, fixups: Map<number, number>): RadarModule {
  const dv = new DataView(block.buffer, block.byteOffset, block.byteLength);
  const i32 = (o: number) => dv.getInt32(o, true);
  const ptr = (o: number) => (fixups.has(o) ? i32(o) : 0);
  const panes = new Map<number, ViewWindow>();
  const pane = (o: number): ViewWindow => {
    let p = panes.get(o);
    if (!p) {
      p = new ViewWindow();
      p.canvas = null;
      p.left = i32(o + 4);
      p.top = i32(o + 8);
      p.right = i32(o + 0xc);
      p.bottom = i32(o + 0x10);
      panes.set(o, p);
    }
    return p;
  };
  const states = new Map<number, TransitionState>();
  const ints = new Map<number, Int32Array>();
  const table = (o: number, n: number): Int32Array => {
    let t = ints.get(o);
    if (!t) {
      t = Int32Array.from({ length: n }, (_, k) => i32(o + 4 * k));
      ints.set(o, t);
    }
    return t;
  };
  const texts = new Map<number, TextBuffer>();
  const text = (o: number): TextBuffer => {
    let t = texts.get(o);
    if (!t) {
      let s = '';
      for (let k = o; k < block.length && block[k] !== 0; k++) s += String.fromCharCode(block[k]!);
      t = { at: o, text: s };
      texts.set(o, t);
    }
    return t;
  };
  const root = ptr(0);
  const modesAt = ptr(root);
  const auxAt = ptr(root + 4);
  const modes: (RadarMode | null)[] = [];
  for (let m = 0; m < 6; m++) {
    const d = ptr(modesAt + 4 * m);
    if (d === 0) {
      modes.push(null);
      continue;
    }
    const tr = ptr(d + 0x14);
    let transition: RadarTransition | null = null;
    if (tr !== 0) {
      const st = ptr(tr);
      const pa = ptr(tr + 4);
      let state = states.get(st);
      if (!state) {
        state = { now: block[st]!, before: block[st + 1]!, elapsed: i32(st + 2) };
        states.set(st, state);
      }
      transition = new RadarTransition(state, i32(pa), pane(ptr(pa + 4)), pane(ptr(pa + 8)), pane(ptr(pa + 0xc)), { rec: tr, state: st, params: pa });
    }
    modes.push({
      at: d,
      pane: pane(ptr(d)),
      savePane: pane(ptr(d + 4)),
      viewportIndex: i32(d + 8),
      openSound: i32(d + 0xc),
      closeSound: i32(d + 0x10),
      transition,
      range: i32(d + 0x18),
      shownRange: i32(d + 0x1c),
      defaultRange: i32(d + 0x20),
      leastRange: i32(d + 0x24),
      mostRange: i32(d + 0x28),
      zoomScale: i32(d + 0x2c),
      fontId: i32(d + 0x30),
      unread34: text(ptr(d + 0x34)),
      unread38: text(ptr(d + 0x38)),
      rangeLabel: text(ptr(d + 0x3c)),
      rangeText: text(ptr(d + 0x40)),
      bearingLabel: text(ptr(d + 0x44)),
      bearingText: text(ptr(d + 0x48)),
      shownHeading: i32(d + 0x4c),
      metres: text(ptr(d + 0x50)),
      km: text(ptr(d + 0x54)),
      points: Int32Array.from({ length: 6 }, (_, k) => i32(d + 0x58 + 4 * k)),
      shapes: table(ptr(d + 0x70), 21),
      shapesAt: ptr(d + 0x70),
      colours: table(ptr(d + 0x74), 14),
      coloursAt: ptr(d + 0x74),
      anim: table(ptr(d + 0x78), 5),
      animAt: ptr(d + 0x78),
      hookIndex: [0, 1, 2, 3].map((k) => i32(d + 0x7c + 4 * k)),
      frameHook: null,
      clipHook: null,
      clampHook: null,
      edgeHook: null,
    });
  }
  return { block, fixups, root, modesAt, modes, auxAt, aux: Int32Array.from({ length: 8 }, (_, k) => i32(auxAt + 4 * k)) };
}

// ---- state ---------------------------------------------------------------------

function bootRadar() {
  return {
    /** 0xa4c34: the loaded module (freed by radar_release) */
    module: null as RadarModule | null,
    /** 0xa4c48: the display mode, 0..5 */
    mode: 0,
    /** 0xa4c44: the mode asked for; radar_mode_step takes it up */
    requested: 0,
    /** 0xa4c46: the mode before the last change */
    previous: 0,
    /** 0xa4c45: which cockpit driver ran last - 1 powering up, 3 otherwise, 4 running */
    phase: 0,
    /** 0xa4c47: phase as of the previous driver call */
    previousPhase: 0,
    /** 0xa4c3c: a cheat (cheats.c) sets it; the radar then centres on the viewer, not the player */
    freeEyeCentre: 0,
    /** 0xa4c40: set by nothing read; radar_map_static clears it and draws the map plainly once */
    mapStaticSkip: 0,
    /** 0xa4c4c / 0xa4c50: simTick when the damaged map's static starts and ends */
    staticStart: 0,
    staticEnd: 0,
    /** 0x955a0 (byte): the damaged map's static - 0 idle, 1 waiting to start, 2 running */
    mapStaticState: imageI32(0x955a0, 0) & 0xff,
    /** 0x95744: the damaged radar's static is showing */
    radarStaticOn: imageI32(0x95744, 0),
    /** 0x955a4: main's render hook while the map has it; vfx_video_sub_010490 (the 3D view) in the image */
    savedRenderHook: null as RenderHook | null,
    /** 0x955a8 / 0x955b0: hudReticleOn and hudTargetMarkerOn as they were before the map; 1 in the image */
    savedReticle: imageI32(0x955a8, 1),
    savedTargetMarker: imageI32(0x955b0, 1),
    /** 0x955ac: hudEnabled as it was when the map opened; 1 in the image */
    savedHudEnabled: imageI32(0x955ac, 1),
    /** 0x955b4: the reticle and marker are saved */
    mapSaved: imageI32(0x955b4, 0),
    /** 0x955c0: mapHeightHigh - mapHeightLow, as radar_init leaves it */
    mapHeightRange: imageI32(0x955c0, 0),
    /** 0xa46d0: radar_draw_transition moved currentViewport; the frame's flip puts it back (vfx_video_sub_0106d0) */
    viewportRestorePending: 0,
    /** 0xa4db8: world units per pixel of the orthographic view */
    orthoUnitsPerPixel: 0,
    /** 0xa4d9c / 0xa4da0 / 0xa4da8 / 0xa4da4: its half extents, world units */
    orthoLeft: 0,
    orthoRight: 0,
    orthoBottom: 0,
    orthoTop: 0,
    /** 0xa4db0: its far clip */
    orthoFarClip: 0,
    /** 0xa4db4: paletteRestorePending, saved over the orthographic view */
    savedPaletteRestore: 0,
    /** 0xa4cbc: the viewer, saved over the orthographic view */
    savedViewer: null as Record<string, unknown> | null,
    /** 0xa4dac: ortho_view_begin clears it; no reader has been read */
    datA4dac: 0,
    /** 0xa4c54: the 0x97020 block, saved over it */
    savedBlock: newRenderBlock(),
  };
}

export const radar = registerGlobals('radar', bootRadar(), () => {
  Object.assign(radar, bootRadar());
});

// ---- loading and laying out --------------------------------------------------------

/**
 * Loads DISP 1 as an LX module and takes its mode table and aux record.
 * Returns 1, or 0 after system_error(0x52).
 *
 * @mw2 radar_module_load 0x000113a0
 * @fidelity exact
 */
export function vfxVideoDispHandler(): number {
  const src = cacheLoadResource(1, 'DISP');
  if (!src) {
    systemError(0x52);
    return 0;
  }
  const m = lxModuleLoad(src);
  cacheUnlock(1, 'DISP');
  if (!m) {
    systemError(0x52);
    return 0;
  }
  radar.module = readRadarModule(m.block, m.fixups);
  return 1;
}

const fnByAddress = new Map<number, CodeFn>();

/** The function table at 0x955c4 entry i, as the port has it. */
function tableFn(i: number): CodeFn | null {
  const a = imageI32(0x955c4 + i * 4, 0) >>> 0;
  if (a === 0) return null;
  const f = fnByAddress.get(a);
  if (!f) unestablished(`radar function table: 0x${a.toString(16)} is not ported`, 'radar_mode_install');
  return f ?? null;
}

function copyPane(dst: ViewWindow, src: ViewWindow): void {
  dst.canvas = src.canvas;
  dst.left = src.left;
  dst.top = src.top;
  dst.right = src.right;
  dst.bottom = src.bottom;
}

/**
 * Lays out one mode: its pane from screen fractions to pixels (mode 1's also
 * becomes widget 0's pane at 0x968e0), copied to its viewportModes slot; its
 * three points placed in the pane; its transition's two panes placed in it
 * (mode 4's instead turned to design pixels by the aspect and centred on the
 * screen); its four hook indices resolved through the table at 0x955c4; and
 * the zoom reset.
 *
 * @mw2 radar_mode_install 0x00011440
 * @fidelity exact
 */
export function vfxVideoSub011440(m: number, d: RadarMode | null): void {
  if (!d) return;
  const pane = d.pane;
  radar.mode = m & 0xff;
  pane.canvas = defaultCanvas;
  layoutPaneToWindow(defaultCanvas, pane, pane);
  if (m === 1) copyPane(cockpit.dat000968e0[0]!, pane);
  copyPane(lighting.viewportModes[d.viewportIndex]!, pane);
  layoutPointInPane(pane, d.points, d.points, 0);
  layoutPointInPane(pane, d.points, d.points, 2);
  layoutPointInPane(pane, d.points, d.points, 4);
  const t = d.transition;
  if (t) {
    const v = cameraGlobals.viewerPosition ?? cameraGlobals.mainViewer;
    for (const p of [t.from, t.to]) {
      p.canvas = defaultCanvas;
      if (m === 4) {
        layoutPaneToDesignAspect(p, v.aspectScale);
        layoutPaneCentreInWindow(defaultCanvas, p, p);
      } else layoutPaneInPane(pane, p, p);
    }
    t.out.canvas = defaultCanvas;
  }
  d.frameHook = tableFn(d.hookIndex[0]!) as FrameHook | null;
  d.clipHook = tableFn(d.hookIndex[1]!) as ClipHook | null;
  d.clampHook = tableFn(d.hookIndex[2]!) as ClampHook | null;
  d.edgeHook = tableFn(d.hookIndex[3]!) as EdgeHook | null;
  vfxVideoSub012410(0);
}

/** The mode table entry for the current mode. @portOnly */
const currentMode = (): RadarMode | null => radar.module?.modes[radar.mode] ?? null;

/**
 * Loads RADAR and lays out all six modes, then starts off with the small
 * radar requested (mode 0 now, 1 asked for), places the aux record's point
 * in currentViewport, and lowers mapHeightLow by 1000 (the map's height
 * ramp, mapHeightRange = mapHeightHigh - mapHeightLow).
 *
 * @mw2 radar_init 0x000115e0
 * @fidelity exact
 */
export const radarDisplayInit = registerCode('radar_init', 0x115e0, (): void => {
  if (vfxVideoDispHandler() === 0) return;
  const mod = radar.module!;
  for (let m = 0; m < 6; m++) vfxVideoSub011440(m, mod.modes[m] ?? null);
  radar.mode = 0;
  radar.requested = 1;
  radar.previous = 0;
  layoutPointInPane(display.currentViewport, mod.aux, mod.aux, 5);
  lighting.mapHeightLow = (lighting.mapHeightLow - 1000) | 0;
  radar.mapHeightRange = (lighting.mapHeightHigh - lighting.mapHeightLow) | 0;
});

// ---- the mode machine ------------------------------------------------------------

/**
 * One step of the mode machine. Restores the reticle and target marker the
 * map hid once it has closed; forces the map shut (5) when the player is out
 * or its mech is dead; then, if the requested mode differs, takes it up: 0,
 * 1 and 2 directly; 3 swaps main's render hook for map_view_render_hook,
 * plays the map's open sound and cue 0x12 and asks for 4; 4 hides the
 * reticle and marker and saves hudEnabled; 5 gives the render hook back,
 * asks for the mode before the map, and plays the close sound (cue 0x11 when
 * the camera's previous mode was 1). Returns 1 when a change was made.
 *
 * @mw2 radar_mode_step 0x000116d0
 * @fidelity exact
 */
export function vfxVideoSub0116d0(): number {
  const r = radar;
  const h = hud;
  if (r.mode < 3 && r.previous === 4 && r.mapSaved !== 0) {
    h.hudReticleOn = r.savedReticle;
    r.mapSaved = 0;
    h.hudTargetMarkerOn = r.savedTargetMarker;
  }
  const saved = r.mapSaved;
  if (r.mode === 4) {
    const p = mechs.mechTable[mechs.playerMechIndex]!;
    if (mechRuntime.playerOut !== 0 || (p.flags & 6) !== 0) r.requested = 5;
  }
  if (r.mode === r.requested) return 0;
  const mapMode = r.module?.modes[4] ?? null;
  switch (r.requested) {
    case 0:
    case 1:
    case 2:
      r.previous = r.mode;
      r.mode = r.requested;
      return 1;
    case 3:
      r.savedRenderHook = mainLoop.renderHook;
      r.requested = 4;
      mainLoop.renderHook = mapViewRenderHook;
      if (mapMode && mapMode.openSound !== -1) soundPlay(mapMode.openSound, 100, 0x40, 5, 0x50);
      soundCuePlay(0x12, -1);
      return 1;
    case 4:
      r.previous = r.mode;
      r.mode = 4;
      if (r.mapSaved === 0) {
        r.mapSaved = 1;
        r.savedReticle = h.hudReticleOn;
        h.hudReticleOn = saved;
        r.savedTargetMarker = h.hudTargetMarkerOn;
        h.hudTargetMarkerOn = saved;
        r.savedHudEnabled = h.hudEnabled;
      }
      return 1;
    case 5:
      mainLoop.renderHook = r.savedRenderHook;
      r.requested = r.previous;
      if (mapMode && mapMode.closeSound !== -1) soundPlay(mapMode.closeSound, 100, 0x40, 5, 0x50);
      if (cam.cameraModePrev === 1) soundCuePlay(0x11, -1);
      return 1;
  }
  return 1;
}

/**
 * The render hook while the map is up: the mode step, then the map - with
 * the damaged-radar static when widget 0 has taken damage.
 *
 * @mw2 map_view_render_hook 0x000118e0
 * @fidelity exact
 */
export const mapViewRenderHook = registerCode('map_view_render_hook', 0x118e0, (): void => {
  vfxVideoSub0116d0();
  if (hud.hudWidgets[0]!.field_0x6 !== 0) vfxVideoSub012a70();
  else vfxVideoSub011910();
});

/**
 * The running-state driver: records the phase (4), and while a radar mode is
 * up steps the machine and draws it (radar_draw_damaged once widget 0 is
 * damaged). While the map is up the map draws itself through the render
 * hook; this only steps the machine when a radar mode is being asked for.
 *
 * @mw2 radar_frame_running 0x00011660
 * @fidelity exact
 */
export const radarDisplayRunning = registerCode('radar_frame_running', 0x11660, (_status: number): void => {
  const r = radar;
  r.previousPhase = r.phase;
  r.phase = 4;
  if (r.mode > 2) {
    if (r.mode === 4 && r.requested < 3) vfxVideoSub0116d0();
    return;
  }
  vfxVideoSub0116d0();
  if (hud.hudWidgets[0]!.field_0x6 !== 0) vfxVideoSub012a70();
  else vfxVideoSub011910();
});

/**
 * Draws the display through its transition, in `direction`: the pane is
 * swapped for the transition's current rectangle (or, with keep and the
 * transition over, for its end) while radar_draw draws, then put
 * back; with keep, currentViewport is left as the rectangle until the frame's
 * flip restores it. Returns 1 while the transition runs.
 *
 * @mw2 radar_draw_transition 0x000127e0
 * @fidelity exact
 */
export function vfxVideoSub0127e0(direction: number, d: RadarMode, t: RadarTransition, keep: number): number {
  let running = 1;
  let rect = paneTransitionStep(direction, t);
  if (!rect) {
    running = 0;
    if (keep !== 0) rect = direction === 0 ? t.to : t.from;
  }
  if (rect) {
    copyPane(d.savePane, d.pane);
    copyPane(d.pane, rect);
    vfxVideoSub011910();
    copyPane(d.pane, d.savePane);
    if (keep !== 0) {
      copyPane(display.currentViewport, rect);
      radar.viewportRestorePending = 1;
    }
  }
  return running;
}

/**
 * The powering-up driver: steps the machine; for a radar mode, records the
 * phase (1), restarts the mode's transition when the phase changed, and draws
 * it opening - plainly once the transition is over.
 *
 * @mw2 radar_frame_powerup 0x00012890
 * @fidelity exact
 */
export const radarDisplayPowerup = registerCode('radar_frame_powerup', 0x12890, (_status: number): void => {
  const r = radar;
  if (r.mode < 3) {
    vfxVideoSub0116d0();
    if (r.mode < 3) {
      if (r.mode !== 0) {
        r.previousPhase = r.phase;
        r.phase = 1;
      }
      const d = currentMode();
      const t = d?.transition;
      if (d && t) {
        if (r.previousPhase !== r.phase) paneTransitionRestart(t);
        if (vfxVideoSub0127e0(0, d, t, 0) === 0) {
          vfxVideoSub0116d0();
          if (hud.hudWidgets[0]!.field_0x6 !== 0) vfxVideoSub012a70();
          else vfxVideoSub011910();
        }
      }
    }
  } else if (r.mode === 4 && r.requested < 3) vfxVideoSub0116d0();
});

/**
 * The driver for any other status (shut down, just spawned): steps the
 * machine; for a radar mode, records the phase (3), restarts the transition
 * when the phase changed and draws the display closing.
 *
 * @mw2 radar_frame_other 0x00012b50
 * @fidelity exact
 */
export const radarDisplayOther = registerCode('radar_frame_other', 0x12b50, (_status: number): void => {
  const r = radar;
  if (r.mode < 3) {
    vfxVideoSub0116d0();
    if (r.mode < 3) {
      if (r.mode !== 0) {
        r.previousPhase = r.phase;
        r.phase = 3;
      }
      const d = currentMode();
      const t = d?.transition;
      if (d && t) {
        if (r.previousPhase !== r.phase) paneTransitionRestart(t);
        vfxVideoSub0127e0(1, d, t, 0);
      }
    }
  } else if (r.mode === 4 && r.requested < 3) vfxVideoSub0116d0();
});

/**
 * The map with a damaged radar: at random intervals (up to the transition's
 * duration) the map closes and reopens with its pane transition while the
 * HUD is switched off; a menu up (ui context 4) or the flag at 0xa4c40 draws
 * it plainly.
 *
 * @mw2 radar_map_static 0x00012950
 * @fidelity exact
 */
export function vfxVideoSub012950(): void {
  const r = radar;
  const d = currentMode();
  if (!d) return;
  const t = d.transition;
  if (!t) return;
  if ((uiContextActive(4) & 0xff) !== 0 || r.mapStaticSkip !== 0) {
    r.mapStaticSkip = 0;
    vfxVideoSub011910();
    return;
  }
  if (r.mapStaticState === 0) {
    r.staticStart = (randomRange(t.duration) + clock.simTick) | 0;
    r.mapStaticState = 1;
  } else if (r.mapStaticState > 1) {
    if (r.mapStaticState !== 2) return;
    staticStep(d, t);
    return;
  }
  if (clock.simTick < r.staticStart) {
    vfxVideoSub011910();
    return;
  }
  r.mapStaticState = 2;
  r.staticEnd = (randomRange(t.duration) + clock.simTick) | 0;
  paneTransitionRestart(t);
  staticStep(d, t);
}

function staticStep(d: RadarMode, t: RadarTransition): void {
  const r = radar;
  hud.hudEnabled = 0;
  t.elapsed = randomRange((t.duration - clock.tickDelta - 1) | 0);
  vfxVideoSub0127e0(1, d, t, 1);
  if (r.staticEnd < clock.simTick) r.mapStaticState = 0;
}

/**
 * Draws the display with a damaged radar (widget 0's +6 non-zero): the map's
 * static; for a radar mode with an anim2d slot in its record (+8), static
 * over the radar at random (at +6 = 1, 3 in 10 to start and 7 in 10 to stay)
 * or always (+6 = 2), redrawing the frame over it. The shipped RADAR has -1
 * in every mode's slot, so the radar is always drawn plainly.
 *
 * @mw2 radar_draw_damaged 0x00012a70
 * @fidelity exact
 */
export function vfxVideoSub012a70(): void {
  const r = radar;
  const d = currentMode();
  if (!d) return;
  if (r.mode === 4) {
    vfxVideoSub012950();
    return;
  }
  const slot = d.anim[2]!;
  if (slot === -1) {
    vfxVideoSub011910();
    return;
  }
  const dmg = hud.hudWidgets[0]!.field_0x6;
  if (dmg === 1) {
    const odds = r.radarStaticOn !== 0 ? 7 : 3;
    r.radarStaticOn = randomRange(10) < odds ? 1 : 0;
  } else if (dmg === 2) r.radarStaticOn = 1;
  vfxVideoSub011910();
  if (r.radarStaticOn !== 0) {
    anim2dDraw(d.pane, slot, 0, 0);
    if (d.frameHook) d.frameHook(d.pane, d.colours[12]!);
  }
}

/**
 * The radar's clean-up: phase 0 and the module freed.
 *
 * @mw2 radar_release 0x00012bf0
 * @fidelity exact
 */
export const radarDisplayRelease = registerCode('radar_release', 0x12bf0, (): void => {
  radar.previousPhase = 0;
  radar.phase = 0;
  radar.module = null;
});

/**
 * RADAR_MODE (command 0x2e): steps the radar 0 -> 1 -> 2 -> 0, only while
 * neither the display nor the request is in the map's range.
 *
 * @mw2 radar_cycle_mode 0x00012330
 * @fidelity exact
 */
export function vfxVideoSub012330(): void {
  if (radar.mode < 3 && radar.requested < 3) radar.requested = ((radar.mode + 1) & 0xff) % 3;
}

/**
 * The map is up (mode 4).
 *
 * @mw2 radar_map_up 0x00012370
 * @fidelity exact
 */
export function vfxVideoSub012370(): boolean {
  return radar.mode === 4;
}

/**
 * Closes the map if it is up and nothing else is asked for.
 *
 * @mw2 radar_map_close_request 0x00012390
 * @fidelity exact
 */
export function vfxVideoSub012390(): void {
  if (radar.mode === 4 && radar.requested === 4) {
    radar.requested = 5;
    radar.mode = 4;
  }
}

/**
 * The map key (command 0x32): closes the map when it is up, asks for it
 * (3) when a radar mode is.
 *
 * @mw2 radar_map_toggle 0x000123d0
 * @fidelity exact
 */
export function vfxVideoSub0123d0(): void {
  if (radar.mode === 4 && radar.requested === 4) radar.requested = 5;
  else if (radar.mode < 3 && radar.requested < 3) radar.requested = 3;
}

/**
 * Zoom for the current mode: 0 resets the range to the default, 1 halves it
 * (below the least it wraps to the most), 2 doubles it (above the most it
 * wraps to the least); then zoomScale = (default << 16) / range. Commands
 * 0x2f (1), 0x30 (2), 0x31 (0).
 *
 * @mw2 radar_zoom 0x00012410
 * @fidelity exact
 */
export function vfxVideoSub012410(how: number): void {
  const d = currentMode();
  if (!d) return;
  how &= 0xff;
  if (how === 0) d.range = d.defaultRange;
  else if (how < 2) {
    d.range = sdivShl(d.range, 16, 0x20000);
    if (d.range < d.leastRange) d.range = d.mostRange;
  } else if (how === 2) {
    d.range = Number(BigInt.asIntN(32, (BigInt(d.range) * 0x20000n) >> 16n));
    if (d.range > d.mostRange) d.range = d.leastRange;
  }
  d.zoomScale = sdivShl(d.defaultRange, 16, d.range);
}

// ---- drawing ------------------------------------------------------------------------

/**
 * Draws the current mode: an orthographic view from `range` above the
 * player's aim point, looking straight down, rotated to the legs' heading
 * (the map: north up, the torso's heading for the view cone). The map mode
 * first clears its pane to groundColour and draws the world under it; then
 * the view cone (not on the map while the player's mech is down), the blips,
 * the viewer restored, the frame and, while running, the range readout.
 *
 * @mw2 radar_draw 0x00011910
 * @fidelity exact
 */
export function vfxVideoSub011910(): void {
  const r = radar;
  const m = r.mode;
  if (m === 0) return;
  const d = currentMode();
  if (!d) return;
  const player = mechs.mechTable[mechs.playerMechIndex]!;
  const pane = d.pane;
  const vp = d.viewportIndex;
  copyPane(lighting.viewportModes[vp]!, pane);
  let torso = player.loadout!.ramps[0]!.current;
  let yaw: number;
  if (m < 3) yaw = player.heading;
  else if (m === 4) {
    yaw = 0;
    torso = (torso + player.heading) | 0;
  } else {
    torso = 0;
    yaw = 0;
  }
  let x: number;
  let z: number;
  if (r.freeEyeCentre === 0) {
    const p = player.aimNode ? sceneNodeGetWorldPos(player.aimNode) : [0, 0, 0];
    x = p[0]!;
    z = p[2]!;
  } else {
    const v = cameraGlobals.viewerPosition!;
    x = v.posX;
    z = v.posZ;
  }
  const alt = d.range;
  const far = lighting.mapHeightLow < 0 ? (alt - lighting.mapHeightLow) | 0 : alt;
  orthoViewBegin([x, alt, z, yaw, 0x5a0000, 0], vp, alt, far);
  if (m === 4) {
    renderOptions.objectCullHook = HOOK.mapObjectCull;
    renderOptions.polygonDrawHook = HOOK.mapPolygonColour;
    renderOptions.polygonFillHook = HOOK.mapFillPolygon;
    const prev = cameraGetMode();
    cameraSetMode(6);
    mechLodUpdate();
    cameraSetMode(prev);
    vfxPaneWipe(pane, lighting.groundColour);
    vfxFontSub012da0(0);
  }
  if (m !== 4 || (player.flags & 0x16) === 0) vfxVideoSub0120c0(d, torso);
  vfxVideoSub011b10(d);
  vfxFontSub012dd0();
  if (d.frameHook) d.frameHook(pane, d.colours[12]!);
  if (r.phase === 4 && !(m === 4 && r.mapStaticState > 1)) vfxVideoSub0121b0(d);
}

/**
 * The blips: nav points, then (not on the map) the player's marker at the
 * pane's centre and - once it is drawn - the seen mechs and gamethings, then
 * the target.
 *
 * @mw2 radar_draw_blips 0x00011b10
 * @fidelity exact
 */
export function vfxVideoSub011b10(d: RadarMode): void {
  const pane = d.pane;
  vfxVideoSub011f60(d);
  if (radar.mode !== 4) {
    const id = (d.shapes[0]! + display.assetVariant) | 0;
    const t = cacheLoadResource(id, 'SHP');
    if (t) {
      vfxShapeDraw(pane, t, 0, (pane.right - pane.left + 1) >> 1, (pane.bottom - pane.top + 1) >> 1);
      cacheUnlock(id, 'SHP');
      vfxVideoSub011c40(d);
    }
  }
  vfxVideoSub011d80(d);
}

/**
 * One blip: the world point projected into the orthographic view and, when
 * it lands inside (and inside the mode's clip test), SHP shapeId drawn there.
 * The point is passed on the stack by value (x, y, z); the ret 0x10 pops it
 * and the shape id.
 *
 * @mw2 radar_draw_blip 0x00011bb0
 * @fidelity exact
 */
export function vfxVideoSub011bb0(d: RadarMode, x: number, y: number, z: number, shapeId: number): void {
  const pane = d.pane;
  const p = Int32Array.of(x, y, z);
  let vis = vfxFontSub013130(p);
  if (vis !== 0 && d.clipHook) vis = d.clipHook(pane, p[0]!, p[1]!);
  if (vis === 0) return;
  const id = (display.assetVariant + shapeId) | 0;
  const t = cacheLoadResource(id, 'SHP');
  if (t) {
    vfxShapeDraw(pane, t, 0, p[0]!, p[1]!);
    cacheUnlock(id, 'SHP');
  }
}

/**
 * Every other mech the player's side has seen (flags & 0x1400) that is not
 * dead or down (flags & 0x16), and every seen gamething not destroyed
 * (flags & 0x1e), as a blip shapes[3 + allegiance].
 *
 * @mw2 radar_draw_contacts 0x00011c40
 * @fidelity exact
 */
export function vfxVideoSub011c40(d: RadarMode): void {
  const m = mechs;
  for (let i = 0; i < m.mechCount; i++) {
    if (i === m.playerMechIndex) continue;
    const e = m.mechTable[i]!;
    if ((e.flags & 0x1400) === 0 || (e.flags & 0x16) !== 0) continue;
    vfxVideoSub011bb0(d, e.posX, e.posY, e.posZ, d.shapes[3 + (mechAllegiance(i) & 0xff)]!);
  }
  const g = things;
  for (let i = 0; i < g.gameThingCount; i++) {
    const t = g.gameThings[i]!;
    if ((t.flags & 0x1400) === 0 || (t.flags & 0x1e) !== 0) continue;
    const [x, y, z] = worldObjectGetPos(t.geomIndex);
    vfxVideoSub011bb0(d, x, y, z, d.shapes[3 + (gamethingAllegiance(i) & 0xff)]!);
  }
}

/**
 * The player's target (entity +0xdc, unless its 0x1000 bit is set): a
 * tracked object as shapes[15 + reached], a mech or gamething as
 * shapes[6 + allegiance] when seen and [9 + allegiance] when not; off the
 * radar shapes[18 + allegiance], pinned to the pane's edge by the mode's
 * clamp hook (without one it is not drawn).
 *
 * @mw2 radar_draw_target 0x00011d80
 * @fidelity exact
 */
export function vfxVideoSub011d80(d: RadarMode): void {
  const player = mechs.mechTable[mechs.playerMechIndex]!;
  const pane = d.pane;
  const p = Int32Array.of(player.targetX, player.targetY, player.targetZ);
  let vis = vfxFontSub013130(p);
  if (vis !== 0 && d.clipHook) vis = d.clipHook(pane, p[0]!, p[1]!);
  const h = player.targetHandle >>> 0;
  if (h === 0 || (h & 0x1000) !== 0) return;
  const type = h & 0xf00;
  const idx = h & 0xff;
  let allegiance: number;
  let kind: number;
  if (type === 0x100) {
    allegiance = vis === 0 ? 0 : trackedReached(idx) ? 1 : 0;
    kind = 5;
  } else if (type === 0x200) {
    allegiance = mechAllegiance(idx) & 0xff;
    kind = (mechs.mechTable[idx]!.flags & 0x1400) === 0 ? 3 : 2;
  } else if (type === 0x400) {
    allegiance = gamethingAllegiance(idx) & 0xff;
    kind = (things.gameThings[idx]!.flags & 0x1400) === 0 ? 3 : 2;
  } else return;
  if (vis === 0) kind = 6;
  const shape = d.shapes[kind * 3 + allegiance]!;
  if (shape === 0) return;
  const id = (display.assetVariant + shape) | 0;
  const t = cacheLoadResource(id, 'SHP');
  if (!t) return;
  if (vis === 0) {
    if (!d.clampHook) {
      cacheUnlock(id, 'SHP');
      return;
    }
    d.clampHook(pane, p, p);
  }
  vfxShapeDraw(pane, t, 0, p[0]!, p[1]!);
  cacheUnlock(id, 'SHP');
}

/**
 * A tracked object counts as reached when its flags have 0x20. The original
 * tests (seenByGroups | 1 << playerGroupIndex) != 0 beside it - an OR where
 * an AND was surely meant - which is always true, so the group test does
 * nothing.
 */
function trackedReached(i: number): boolean {
  const t = trackedGlobals.trackedObjects[i]!;
  if ((t.flags & 0x20) === 0) return false;
  quirk('radar nav points: seenByGroups is ORed with the player group bit (0x1202a / 0x11e9e), so the reached test is flags & 0x20 alone', 'radar_draw_navpoints');
  return true;
}

/**
 * The player's group's nav points (tracked objects with its groupId, in
 * use, not temporary - flags bit 0 clear), at their follow node or their
 * position: shapes[13] once reached (flags 0x20), [12] before; -1 draws none.
 *
 * @mw2 radar_draw_navpoints 0x00011f60
 * @fidelity exact
 */
export function vfxVideoSub011f60(d: RadarMode): void {
  const pane = d.pane;
  const tg = trackedGlobals;
  for (let i = 0; i < tg.trackedObjectCount; i++) {
    const t = tg.trackedObjects[i]!;
    if (mechs.playerGroupIndex !== t.groupId || t.inUse === 0 || (t.flags & 1) !== 0) continue;
    const p = t.followNode ? Int32Array.from(sceneNodeGetWorldPos(t.followNode)) : Int32Array.of(t.x, t.y, t.z);
    let vis = vfxFontSub013130(p);
    if (vis !== 0 && d.clipHook) vis = d.clipHook(pane, p[0]!, p[1]!);
    if (vis === 0) continue;
    const shape = trackedReached(i) ? d.shapes[13]! : d.shapes[12]!;
    if (shape === -1) continue;
    const id = (display.assetVariant + shape) | 0;
    const tb = cacheLoadResource(id, 'SHP');
    if (tb) {
      vfxShapeDraw(pane, tb, 0, p[0]!, p[1]!);
      cacheUnlock(id, 'SHP');
    }
  }
}

/**
 * The view cone: two lines from the pane's centre to its edge, either side
 * of the torso's direction by half the camera's field of view
 * (atan2(1, zoom)), in colours[11].
 *
 * @mw2 radar_draw_view_cone 0x000120c0
 * @fidelity exact
 */
export function vfxVideoSub0120c0(d: RadarMode, torso: number): void {
  const pane = d.pane;
  const cx = (pane.right - pane.left + 1) >> 1;
  const cy = (pane.bottom - pane.top + 1) >> 1;
  const half = fixedAtan2(0x10000, (cameraGlobals.viewerPosition ?? cameraGlobals.mainViewer).zoom);
  const a = (0x5a0000 - cmod((cmod(torso, TURN) + TURN) | 0, TURN)) | 0;
  if (!d.edgeHook) return;
  const out = new Int32Array(2);
  d.edgeHook(pane, (a - half) | 0, out);
  vfxLineDraw(pane, cx, cy, out[0]!, out[1]!, 0, d.colours[11]!);
  d.edgeHook(pane, (half + a) | 0, out);
  vfxLineDraw(pane, cx, cy, out[0]!, out[1]!, 0, d.colours[11]!);
}

/** C's %3.1lf of a 16.16 value: one decimal, at least three characters. */
function fmt31(v: number): string {
  const s = (v * 1.52587890625e-5).toFixed(1);
  return s.length < 3 ? s.padStart(3, ' ') : s;
}

/**
 * The readouts: the range - half the view's width, "label 1.0km" at a
 * kilometre (100000 cm) or more, in metres below - reprinted only when it
 * changed; on the map also the heading, "Bearing: 123.4".
 *
 * @mw2 radar_draw_readouts 0x000121b0
 * @fidelity exact
 */
export function vfxVideoSub0121b0(d: RadarMode): void {
  const pane = d.pane;
  const player = mechs.mechTable[mechs.playerMechIndex]!;
  const id = (display.assetVariant + d.fontId) | 0;
  const font = cacheLoadResource(id, 'FONT');
  if (!font) return;
  if (d.range !== d.shownRange) {
    const half = cdiv(d.range, 2);
    let v: number;
    let suffix: TextBuffer;
    if (half < 100000) {
      v = sdivShl(half, 16, 100);
      suffix = d.metres;
    } else {
      v = sdivShl(half, 16, 100000);
      suffix = d.km;
    }
    d.rangeText.text = `${d.rangeLabel.text}${fmt31(v)}${suffix.text}`;
    d.shownRange = d.range;
  }
  vfxStringDraw(pane, d.points[2]!, d.points[3]!, font, d.rangeText.text, display.textColourTable);
  if (radar.mode === 4) {
    const hdg = cmod((cmod(player.heading, TURN) + TURN) | 0, TURN);
    if (hdg !== d.shownHeading) {
      d.bearingText.text = `${d.bearingLabel.text}${fmt31(hdg)}`;
      d.shownHeading = hdg;
    }
    vfxStringDraw(pane, d.points[4]!, d.points[5]!, font, d.bearingText.text, display.textColourTable);
  }
  cacheUnlock(id, 'FONT');
}

// ---- the orthographic view --------------------------------------------------------------

/** Every field of a Viewer, copied. @portOnly the 0x38-dword rep movsd */
function viewerCopy(dst: Viewer, src: Viewer): void {
  const s = src as unknown as Record<string, unknown>;
  const t = dst as unknown as Record<string, unknown>;
  for (const k of Object.keys(s)) {
    const v = s[k];
    if (v instanceof Int32Array) (t[k] as Int32Array).set(v);
    else t[k] = v;
  }
}

/**
 * Sets up an orthographic view: units per pixel = width / (viewport width +
 * 1), half extents in world units, the viewer saved and moved to the pose,
 * the viewport selected, the far clip set, the projection derived and then
 * overridden to a fixed scale (projScaleX 0x2000, shifts 3, projScaleY
 * aspect >> 3), and the transform built.
 *
 * The render-state block is saved over the view, and objectCullHook and
 * clipProjectHook become object_view_cull and ortho_clip_project.
 *
 * @mw2 ortho_view_begin 0x00012c20
 * @fidelity exact
 * @divergence viewer_latch_globals is the render layer's, which latches the viewer itself when it draws; the sim's projection (vfxFontSub013130) reads the viewer directly
 */
export function orthoViewBegin(pose: number[], vpIndex: number, width: number, far: number): void {
  const r = radar;
  const v = cameraGlobals.viewerPosition ?? cameraGlobals.mainViewer;
  const w = lighting.viewportModes[vpIndex]!;
  r.orthoUnitsPerPixel = cdiv(width, (w.right - w.left + 1) | 0);
  r.orthoTop = cdiv(Math.imul(r.orthoUnitsPerPixel, (w.bottom - w.top + 1) | 0), 2);
  r.orthoBottom = -r.orthoTop | 0;
  r.savedPaletteRestore = palettes.paletteRestorePending;
  r.datA4dac = 0;
  r.orthoLeft = cdiv(-width | 0, 2);
  r.orthoFarClip = far;
  const saved = new Viewer();
  viewerCopy(saved, v);
  r.savedViewer = saved as unknown as Record<string, unknown>;
  v.yaw = pose[3]!;
  v.pitch = pose[4]!;
  v.roll = pose[5]!;
  v.posX = pose[0]!;
  r.orthoRight = -r.orthoLeft | 0;
  v.posY = pose[1]!;
  v.posZ = pose[2]!;
  viewportSelect(vpIndex);
  v.farClip = r.orthoFarClip;
  renderBlockSave(r.savedBlock);
  renderOptions.objectCullHook = HOOK.objectViewCull;
  renderOptions.clipProjectHook = HOOK.orthoClipProject;
  viewerUpdateProjection(v);
  v.projScaleX = 0x2000;
  v.projShiftX = 3;
  v.projShiftY = 3;
  v.projScaleY = v.aspectScale >> 3;
  viewerBuildTransform(v);
  cam.dat000954ec = 0;
}

/**
 * Draws the world into the current view: sky and ground with flags bit 0,
 * then the world list through the installed hooks - for the map,
 * map_object_cull, map_polygon_colour and map_fill_polygon.
 *
 * @mw2 ortho_view_draw_world 0x00012da0
 * @fidelity exact
 * @divergence empty_stub_37e70 is empty
 */
export function vfxFontSub012da0(flags: number): void {
  const port = renderPort.current;
  if ((flags & 1) !== 0) port?.skyAndGround();
  port?.objectList(worldRootNode);
}

/**
 * Ends the orthographic view: the block and paletteRestorePending put back,
 * the viewer restored, viewport 0 selected and the projection and transform
 * rebuilt.
 *
 * @mw2 ortho_view_end 0x00012dd0
 * @fidelity exact
 * @divergence viewer_latch_globals is the render layer's, which latches the viewer itself when it draws
 */
export function vfxFontSub012dd0(): void {
  const r = radar;
  renderBlockRestore(r.savedBlock);
  palettes.paletteRestorePending = r.savedPaletteRestore;
  const v = cameraGlobals.viewerPosition ?? cameraGlobals.mainViewer;
  if (r.savedViewer) viewerCopy(v, r.savedViewer as unknown as Viewer);
  vfxVideoSub0106c0();
  viewerUpdateProjection(v);
  viewerBuildTransform(v);
  cam.dat000954ec = 0;
}

/**
 * @mw2 viewport_select_main 0x000106c0
 * @fidelity exact
 */
export function vfxVideoSub0106c0(): void {
  viewportSelect(0);
}

/** low 32 bits of (a0*b0 + a1*b1 + a2*b2) >> 27, rounded by bit 26. */
function dot3r27(a0: number, b0: number, a1: number, b1: number, a2: number, b2: number): number {
  const s = BigInt(a0 | 0) * BigInt(b0 | 0) + BigInt(a1 | 0) * BigInt(b1 | 0) + BigInt(a2 | 0) * BigInt(b2 | 0);
  return Number(BigInt.asIntN(32, (s >> 27n) + ((s >> 26n) & 1n)));
}

/**
 * Projects a world point, in place, through the orthographic view: rows 0
 * and 1 of the view rotation premultiplied by projScaleX / projScaleY, dots
 * taken >> 27 rounded, shifted by projShift and divided by the units per
 * pixel (not by depth), + 2 >> 2, about the centre, y flipped within the
 * viewport; p[2] becomes the depth. Returns 1 when the depth is positive and
 * the point inside the viewport.
 *
 * @mw2 ortho_project_point 0x00013130
 * @fidelity exact
 * @divergence reads the viewer, which ortho_view_begin set up, instead of the globals viewer_latch_globals copies from it
 */
export function vfxFontSub013130(p: Int32Array): number {
  const v = cameraGlobals.viewerPosition ?? cameraGlobals.mainViewer;
  const r = v.rotation;
  const dx = (p[0]! - v.translationX) | 0;
  const dy = (p[1]! - v.translationY) | 0;
  const dz = (p[2]! - v.translationZ) | 0;
  const psx = v.projScaleX | 0;
  const psy = v.projScaleY | 0;
  const sx = dot3r27(dx, mulr16(psx, r[0]!), dy, mulr16(psx, r[1]!), mulr16(psx, r[2]!), dz);
  const sy = dot3r27(dx, mulr16(psy, r[3]!), dy, mulr16(psy, r[4]!), mulr16(psy, r[5]!), dz);
  const depth = dot3r27(dx, r[6]!, dy, r[7]!, r[8]!, dz);
  const upp = radar.orthoUnitsPerPixel;
  p[0] = (((sdivShl(sx, v.projShiftX & 0x1f, upp) + 2) >> 2) + v.centreX) | 0;
  p[1] = (v.bottom - v.top - ((((sdivShl(sy, v.projShiftY & 0x1f, upp) + 2) >> 2) + v.centreY) | 0)) | 0;
  p[2] = depth;
  if (depth > 0 && !(p[0]! < v.left || v.right < p[0]! || p[1]! < v.top || v.bottom < p[1]!)) return 1;
  return 0;
}

/**
 * The map's 0..15 shade of a vertex: ((altitude - depth / 4) - mapHeightLow)
 * * 16 / mapHeightRange, rounded, clamped at 15 (and at 0 below).
 *
 * @mw2 map_height_shade 0x00012790
 * @fidelity exact
 */
export function mapHeightShade(altitude: number, depth: number): number {
  const u = ((altitude - (depth >> 2)) | 0) - lighting.mapHeightLow;
  const f = sdivShl(u | 0, 16, radar.mapHeightRange);
  const s = Number(BigInt.asIntN(32, ((BigInt(f) * 16n) >> 16n) + (((BigInt(f) * 16n) >> 15n) & 1n)));
  if (s < 0) return 0;
  return s > 0xf ? 0xf : s;
}

// ---- the mode hooks (the function table at 0x955c4) -----------------------------------------

/**
 * Draws an ellipse outline centred at (xc, yc), pane-relative, midpoint
 * style, each point clipped to the pane and window; a zero radius draws the
 * line (xc - rx, yc - ry)..(xc + rx, yc + ry) instead.
 *
 * @mw2 vfx_ellipse_draw 0x00056868
 * @fidelity exact
 * @divergence returns 0 where the original's EAX holds the last value it computed (no caller reads it)
 */
export function vfxEllipseDraw(pane: ViewWindow, xc: number, yc: number, rx: number, ry: number, colour: number): number {
  if (rx === 0 || ry === 0) return vfxLineDraw(pane, xc - rx, yc - ry, xc + rx, yc + ry, 0, colour);
  const win = pane.canvas as VfxWindow | null;
  if (!win) return -1;
  const width = win.xMax + 1;
  const height = win.yMax + 1;
  if (width <= 0 || height <= 0) return -1;
  const cl = pane.left > 0 ? pane.left : 0;
  const ct = pane.top > 0 ? pane.top : 0;
  const cr = pane.right < width - 1 ? pane.right : width - 1;
  const cb = pane.bottom < height - 1 ? pane.bottom : height - 1;
  if (cr < cl || cb < ct) return -2;
  const c = colour & 0xff;
  const cx = (xc + pane.left) | 0;
  const cy = (yc + pane.top) | 0;
  const put = (x: number, y: number) => {
    if (x < cl || x > cr || y < ct || y > cb) return;
    const at = y * width + x;
    win.buffer[at] = c;
    win.drawn[at] = 1;
  };
  const four = (x: number, y: number) => {
    put(cx + x, cy + y);
    put(cx + x, cy - y);
    put(cx - x, cy + y);
    put(cx - x, cy - y);
  };
  let x = 0;
  let y = ry;
  const b2 = Math.imul(ry, ry);
  const twoB2 = (b2 << 1) | 0;
  const a2 = Math.imul(rx, rx);
  const twoA2 = (a2 << 1) | 0;
  let px = 0;
  let py = Math.imul(twoA2, ry);
  let p = ((((a2 >>> 2) + b2) | 0) - Math.imul(a2, ry)) | 0;
  let count = ry;
  while (((px - py) | 0) < 0) {
    four(x, y);
    if (p >= 0) {
      y--;
      count--;
      py = (py - twoA2) | 0;
      p = (p - py) | 0;
    }
    x++;
    px = (px + twoB2) | 0;
    p = (p + ((px + b2) | 0)) | 0;
  }
  const k = (a2 - b2) | 0;
  p = (p + ((((k >> 1) + k - px - py) | 0) >> 1)) | 0;
  for (;;) {
    four(x, y);
    if (p < 0) {
      x++;
      px = (px + twoB2) | 0;
      p = (p + px) | 0;
    }
    y--;
    py = (py - twoA2) | 0;
    p = (p - ((py - a2) | 0)) | 0;
    count--;
    if (count < 0) break;
  }
  return 0;
}

/**
 * The round radar's frame: an ellipse inscribed in the pane, radius
 * (width / 2 - 1) across and that times the aspect down.
 *
 * @mw2 radar_ellipse_frame 0x00014410
 * @fidelity exact
 */
export const vfxFontSub014410 = registerCode('radar_ellipse_frame', 0x14410, (pane: ViewWindow, colour: number): void => {
  const w = (pane.right - pane.left + 1) | 0;
  const cx = w >> 1;
  const cy = ((pane.bottom - pane.top + 1) | 0) >> 1;
  const r = (cdiv(w, 2) - 1) | 0;
  const v = cameraGlobals.viewerPosition ?? cameraGlobals.mainViewer;
  vfxEllipseDraw(pane, cx, cy, r, mulr16(r, v.aspectScale), colour);
});

/**
 * The round radar's clip test: (x, y), pane-relative, is inside the
 * inscribed ellipse (y scaled by 1 / aspect).
 *
 * @mw2 radar_ellipse_contains 0x00014530
 * @fidelity exact
 */
export const vfxFontSub014530 = registerCode('radar_ellipse_contains', 0x14530, (pane: ViewWindow, x: number, y: number): number => {
  const w = (pane.right - pane.left + 1) | 0;
  const r = (cdiv(w, 2) - 1) | 0;
  const dx = (x - (w >> 1)) | 0;
  const v = cameraGlobals.viewerPosition ?? cameraGlobals.mainViewer;
  const dy = sdivShl((y - (((pane.bottom - pane.top + 1) | 0) >> 1)) | 0, 16, v.aspectScale);
  return ((Math.imul(dx, dx) + Math.imul(dy, dy)) | 0) <= Math.imul(r, r) ? 1 : 0;
});

/**
 * A point on the inscribed ellipse: flags 0..3 at the angle (x by the
 * radius less two, y by the vertical radius), 5 the bottom, 7 the top, any
 * other the pane's origin.
 *
 * @mw2 ellipse_point 0x000147c0
 * @fidelity exact
 */
export function vfxFontSub0147c0(pane: ViewWindow, half: Int32Array, flags: number, angle: number, out: Int32Array): Int32Array {
  const cx = half[0]!;
  const cy = half[1]!;
  const r = cdiv((pane.right - pane.left + 1) | 0, 2);
  const v = cameraGlobals.viewerPosition ?? cameraGlobals.mainViewer;
  const ry = (mulr16((r - 1) | 0, v.aspectScale) - 1) | 0;
  let x: number;
  let y: number;
  switch (flags) {
    case 0:
    case 1:
    case 2:
    case 3:
      x = (cx - (mulr16((r - 2) | 0, fixedCos(angle)) >> 13)) | 0;
      y = (cy - (mulr16(ry, fixedSin(angle)) >> 13)) | 0;
      break;
    case 5:
      x = cx;
      y = (cy + ry) | 0;
      break;
    case 7:
      x = cx;
      y = (cy - ry) | 0;
      break;
    default:
      x = 0;
      y = 0;
  }
  out[0] = x;
  out[1] = y;
  return out;
}

/** The quadrant flags 014670 and 0140f0 build from an angle. */
function angleFlags(a: number): { flags: number; c: number; s: number } {
  let flags = a < 0x5a0000 || a > 0x10e0000 ? 0 : 1;
  if (a < 0xb40001) flags |= 2;
  const c = fixedCos(a) >> 13;
  const v = cameraGlobals.viewerPosition ?? cameraGlobals.mainViewer;
  const s = mulr16(fixedSin(a) >> 13, v.aspectScale);
  let steep: number;
  if (c === 0) steep = 1;
  else {
    const q = cdiv(s, c);
    steep = q > 0x7fff || q < -0x8000 ? 1 : 0;
  }
  flags = (flags & ~4) | (steep * 4);
  return { flags, c, s };
}

/**
 * The round radar's clamp: an off-radar point moved to the ellipse along the
 * ray from the centre.
 *
 * @mw2 radar_ellipse_clamp 0x000145a0
 * @fidelity exact
 */
export const vfxFontSub0145a0 = registerCode('radar_ellipse_clamp', 0x145a0, (pane: ViewWindow, p: Int32Array, out: Int32Array): Int32Array => {
  const half = new Int32Array(2);
  half[0] = ((pane.right - pane.left + 1) | 0) >> 1;
  half[1] = ((pane.bottom - pane.top + 1) | 0) >> 1;
  const dx = (half[0]! - p[0]!) | 0;
  let flags = dx >= 0 ? 1 : 0;
  const dy = (half[1]! - p[1]!) | 0;
  if (dy >= 0) flags |= 2;
  let steep: number;
  if (dx === 0) steep = 1;
  else {
    const q = cdiv(dy, dx);
    steep = q > 0x7fff || q < -0x8000 ? 1 : 0;
  }
  flags |= steep * 4;
  const v = cameraGlobals.viewerPosition ?? cameraGlobals.mainViewer;
  const ang = fixedAtan2(sdivShl(dy, 16, v.aspectScale), dx);
  return vfxFontSub0147c0(pane, half, flags, ang, out);
});

/**
 * The round radar's edge point at an angle (the view cone's ends).
 *
 * @mw2 radar_ellipse_edge_at 0x00014670
 * @fidelity exact
 */
export const vfxFontSub014670 = registerCode('radar_ellipse_edge_at', 0x14670, (pane: ViewWindow, angle: number, out: Int32Array): Int32Array => {
  const a = cmod((cmod(angle, TURN) + TURN) | 0, TURN);
  const half = new Int32Array(2);
  half[0] = ((pane.right - pane.left + 1) | 0) >> 1;
  half[1] = ((pane.bottom - pane.top + 1) | 0) >> 1;
  const { flags, c, s } = angleFlags(a);
  const ang = fixedAtan2(s, -c | 0);
  return vfxFontSub0147c0(pane, half, flags, ang, out);
});

/**
 * The map's edge point at an angle: where the ray from the pane's centre
 * meets its rectangle (vfx_font_sub_014240 with slope -sin / cos).
 *
 * @mw2 pane_edge_at_angle 0x000140f0
 * @fidelity exact
 * @divergence a steep ray leaves the original's slope uninitialised (and negates it); the port passes 0, which the steep cases (4..7) never read
 */
export const vfxFontSub0140f0 = registerCode('pane_edge_at_angle', 0x140f0, (pane: ViewWindow, angle: number, out: Int32Array): Int32Array => {
  const a = cmod((cmod(angle, TURN) + TURN) | 0, TURN);
  const half = new Int32Array(2);
  half[0] = ((pane.right - pane.left + 1) | 0) >> 1;
  half[1] = ((pane.bottom - pane.top + 1) | 0) >> 1;
  const { flags, c, s } = angleFlags(a);
  const slope = (flags & 4) === 0 ? -sdivShl(s, 16, c) | 0 : 0;
  return vfxFontSub014240(half, flags, slope, out);
});

fnByAddress.set(0x13960, vfxPaneFrame);
fnByAddress.set(0x14410, vfxFontSub014410);
fnByAddress.set(0x14530, vfxFontSub014530);
fnByAddress.set(0x14020, vfxFontSub014020);
fnByAddress.set(0x145a0, vfxFontSub0145a0);
fnByAddress.set(0x140f0, vfxFontSub0140f0);
fnByAddress.set(0x14670, vfxFontSub014670);

/**
 * The flip-time restore vfx_video_sub_0106d0 makes after a map transition
 * (0xa46d0 set by radar_draw_transition with keep): hudEnabled back from
 * 0x955ac and currentViewport back to the full-screen pane video_init copied
 * to 0xa4694.
 *
 * @portOnly the tail of vfx_video_sub_0106d0 (mission/mainLoop.ts calls it)
 */
export function radarFlipRestore(): void {
  if (radar.viewportRestorePending === 0) return;
  hud.hudEnabled = radar.savedHudEnabled;
  const c = display.currentViewport;
  c.canvas = defaultCanvas;
  c.left = 0;
  c.top = 0;
  c.right = defaultCanvas.xMax;
  c.bottom = defaultCanvas.yMax;
  radar.viewportRestorePending = 0;
}

