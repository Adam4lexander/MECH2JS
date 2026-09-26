/**
 * The render-state block at 0x97020: 26 dwords (0x97020..0x97087) that
 * decide how the next 3D view is drawn. ortho_view_begin and
 * render_state_save_for_inset copy all 26 aside with one rep movsd, change
 * what their view needs, and copy them back afterwards, so the block is a
 * unit in the original even though its dwords mean unrelated things.
 *
 * In the port its dwords live where their other readers are - cam, lighting,
 * mainLoop.renderHook - and the rest here, in renderOptions. The four draw
 * hooks (0x97078..0x97084) hold original code addresses; the render layer
 * runs its port of the function at that address (render/pipeline/hooks.ts).
 *
 * The block, by dword:
 *   0x97020  cam.dat00097020          set: the frame's 3D view is skipped (the viewport wiped instead)
 *   0x97024  shadedFillEnabled        mode 0x4000 filled per vertex (else flat)
 *   0x97028  dat00097028              written 0 by render_state_save_for_inset; no reader read
 *   0x9702c  dat0009702c              written 1 by render_state_save_for_inset; no reader read
 *   0x97030  dat00097030              bit 0 gates mode 0x3000 sprites
 *   0x97034  dat00097034              set: a 2-vertex polygon is a vfx_line_draw (poly_fill_dispatch)
 *   0x97038  dat00097038              set: a 1-vertex polygon is a point (poly_fill_dispatch)
 *   0x9703c  lighting.skyEnabled
 *   0x97040  lighting.groundEnabled
 *   0x97044  lighting.horizonBandEnabled
 *   0x97048  dat00097048              no reader read
 *   0x9704c  dat0009704c              no reader read
 *   0x97050  dat00097050              set: the main view wipes its viewport instead of sky and ground
 *   0x97054  wireframeMode            1 hidden-line wireframe, 2 see-through (poly_fill_dispatch)
 *   0x97058  wireframeColourScheme
 *   0x9705c  lighting.lightDimFlag
 *   0x97060  polygonRampOverride
 *   0x97064  lighting.lightDimDistance
 *   0x97068  dat00097068              no reader read
 *   0x9706c  textureAffine
 *   0x97070  textureOffTypeMask
 *   0x97074  mainLoop.renderHook      DAT_00097074, main's render call
 *   0x97078  objectCullHook
 *   0x9707c  clipProjectHook
 *   0x97080  polygonDrawHook
 *   0x97084  polygonFillHook
 */
import { LABEL } from '../../generated/labels.gen.ts';
import type { CodePtr } from '../../engine/codePtr.ts';
import { registerGlobals } from '../../engine/globals.ts';
import { imageI32 } from '../../engine/image.ts';
import { mainLoop, type RenderHook } from '../../mission/mainLoop.ts';
import { cam } from '../camera/cameraUpdate.ts';
import { lighting } from '../world/environment.ts';

/** The code addresses the hooks are set to (see render/pipeline/hooks.ts for the ports behind them). */
export const HOOK = {
  objectCullMainView: 0x3f500,
  objectViewCull: 0x12e40,
  mapObjectCull: 0x124a0,
  clipProjectPerspective: 0x3dfb7,
  orthoClipProject: 0x12ff0,
  polygonResolveColour: 0x38ae0,
  mapPolygonColour: 0x12520,
  polyFillByMode: 0x3bb80,
  mapFillPolygon: 0x12690,
} as const;

export const renderOptions = registerGlobals(
  'renderOptions',
  {
    /** 0x97024: the per-vertex-shade filler for mode 0x4000 (else flat); 1 in the image */
    shadedFillEnabled: 1,
    /** 0x97028: render_state_save_for_inset writes 0; no reader has been read */
    dat00097028: 0,
    /** 0x9702c: render_state_save_for_inset writes 1; no reader has been read */
    dat0009702c: 0,
    /**
     * 0x97030, unlabelled: bit 0 gates the mode 0x3000 sprites
     * (render_asm_sub_03b950); vfx_video_sub_010320 sets bit 3 and
     * render_state_save_for_inset clears bit 2, which are not read here. 1 in the image.
     */
    dat00097030: 1,
    /** 0x97034: poly_fill_dispatch draws a 2-vertex polygon with vfx_line_draw while set */
    dat00097034: 0,
    /** 0x97038: poly_fill_dispatch draws a 1-vertex polygon as a point while set */
    dat00097038: 0,
    /** 0x97048: no reader has been read */
    dat00097048: 0,
    /** 0x9704c: no reader has been read */
    dat0009704c: 0,
    /** 0x97050: the main view wipes its viewport (to 0x96ea4) instead of drawing sky and ground; vfx_video_sub_010320 clears it when either is enabled */
    dat00097050: 0,
    wireframeMode: 0,
    wireframeColourScheme: 0,
    polygonRampOverride: 0,
    /** 0x97068: no reader has been read */
    dat00097068: 0,
    textureAffine: 0,
    /** bits 0x100 mechs, 0x200 gamethings, 0x400 ?, 0x800 terrain: textures off for that class */
    textureOffTypeMask: 0,
    /** 0x97078: render_object_list's per-object cull */
    objectCullHook: 0 as CodePtr,
    /** 0x9707c: the clipper's per-vertex projection */
    clipProjectHook: 0 as CodePtr,
    /** 0x97080: the clipper's polygon colour */
    polygonDrawHook: 0 as CodePtr,
    /** 0x97084: poly_fill_dispatch's filler */
    polygonFillHook: 0 as CodePtr,
    /** 0x96ea4: the palette index vfx_video_sub_010490 wipes its viewport with, when it does not draw sky and ground */
    dat00096ea4: 0,
    /** 0x96eb8: vfx_video_sub_010320 sets 0xff; no reader has been read */
    dat00096eb8: 0,
  },
  () => {
    const r = renderOptions;
    r.shadedFillEnabled = imageI32(LABEL.shadedFillEnabled, 1);
    r.dat00097028 = imageI32(0x97028, 0);
    r.dat0009702c = imageI32(0x9702c, 0);
    r.dat00097030 = imageI32(0x97030, 1);
    r.dat00097034 = imageI32(0x97034, 0);
    r.dat00097038 = imageI32(0x97038, 0);
    r.dat00097048 = imageI32(0x97048, 0);
    r.dat0009704c = imageI32(0x9704c, 0);
    r.dat00097050 = imageI32(0x97050, 0);
    r.wireframeMode = imageI32(LABEL.wireframeMode, 0);
    r.wireframeColourScheme = imageI32(LABEL.wireframeColourScheme, 0);
    r.polygonRampOverride = imageI32(LABEL.polygonRampOverride, 0);
    r.dat00097068 = imageI32(0x97068, 0);
    r.textureAffine = imageI32(LABEL.textureAffine, 0);
    r.textureOffTypeMask = imageI32(LABEL.textureOffTypeMask, 0);
    r.objectCullHook = imageI32(LABEL.objectCullHook, 0);
    r.clipProjectHook = imageI32(LABEL.clipProjectHook, 0);
    r.polygonDrawHook = imageI32(LABEL.polygonDrawHook, 0);
    r.polygonFillHook = imageI32(LABEL.polygonFillHook, 0);
    r.dat00096ea4 = imageI32(0x96ea4, 0);
    r.dat00096eb8 = imageI32(0x96eb8, 0);
  },
);

/** The 26 dwords of 0x97020, as one rep movsd copies them (the render hook as the port's function). @portOnly */
export interface RenderBlock {
  words: Int32Array;
  renderHook: RenderHook | null;
}

export function newRenderBlock(): RenderBlock {
  return { words: new Int32Array(26), renderHook: null };
}

/** The block copied out of its homes into `into`. @portOnly the rep movsd from 0x97020 */
export function renderBlockSave(into: RenderBlock): RenderBlock {
  const r = renderOptions;
  const l = lighting;
  into.words.set([
    cam.dat00097020,
    r.shadedFillEnabled,
    r.dat00097028,
    r.dat0009702c,
    r.dat00097030,
    r.dat00097034,
    r.dat00097038,
    l.skyEnabled,
    l.groundEnabled,
    l.horizonBandEnabled,
    r.dat00097048,
    r.dat0009704c,
    r.dat00097050,
    r.wireframeMode,
    r.wireframeColourScheme,
    l.lightDimFlag,
    r.polygonRampOverride,
    l.lightDimDistance,
    r.dat00097068,
    r.textureAffine,
    r.textureOffTypeMask,
    0,
    r.objectCullHook,
    r.clipProjectHook,
    r.polygonDrawHook,
    r.polygonFillHook,
  ]);
  into.renderHook = mainLoop.renderHook;
  return into;
}

/** The block copied back over its homes. @portOnly the rep movsd to 0x97020 */
export function renderBlockRestore(from: RenderBlock): void {
  const r = renderOptions;
  const l = lighting;
  const w = from.words;
  cam.dat00097020 = w[0]!;
  r.shadedFillEnabled = w[1]!;
  r.dat00097028 = w[2]!;
  r.dat0009702c = w[3]!;
  r.dat00097030 = w[4]!;
  r.dat00097034 = w[5]!;
  r.dat00097038 = w[6]!;
  l.skyEnabled = w[7]!;
  l.groundEnabled = w[8]!;
  l.horizonBandEnabled = w[9]!;
  r.dat00097048 = w[10]!;
  r.dat0009704c = w[11]!;
  r.dat00097050 = w[12]!;
  r.wireframeMode = w[13]!;
  r.wireframeColourScheme = w[14]!;
  l.lightDimFlag = w[15]!;
  r.polygonRampOverride = w[16]!;
  l.lightDimDistance = w[17]!;
  r.dat00097068 = w[18]!;
  r.textureAffine = w[19]!;
  r.textureOffTypeMask = w[20]!;
  mainLoop.renderHook = from.renderHook;
  r.objectCullHook = w[22]!;
  r.clipProjectHook = w[23]!;
  r.polygonDrawHook = w[24]!;
  r.polygonFillHook = w[25]!;
}
