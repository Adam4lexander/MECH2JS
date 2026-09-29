/**
 * The frame's 3D view as main installs it: vfx_video_sub_010320 sets the
 * render hook (DAT_00097074) to vfx_video_sub_010490 and the draw hooks to
 * the main view's, and main's loop calls the render hook once a frame.
 */
import { LABEL } from '../../generated/labels.gen.ts';
import { registerCode } from '../../engine/codePtr.ts';
import { registerGlobals } from '../../engine/globals.ts';
import { imageI32 } from '../../engine/image.ts';
import { objectListsReset } from '../../engine/scene/objectLists.ts';
import { vfxPaneWipe, vfxWindowClearPane } from '../../engine/vfx/vfx.ts';
import { divergence, unestablished } from '../../core/provenance.ts';
import { mainLoop } from '../../mission/mainLoop.ts';
import { cam } from '../camera/cameraUpdate.ts';
import { viewerBuildTransform, viewerUpdateProjection } from '../camera/projection.ts';
import { viewer } from '../camera/viewer.ts';
import { viewerPresentLatch } from '../camera/viewerPresent.ts';
import { lighting } from '../world/environment.ts';
import { worldObjectGetPos } from '../world/worldRecords.ts';
import { HOOK, renderOptions } from './renderState.ts';
import { renderPort } from './renderPort.ts';
import { display, viewportSelect } from './video.ts';

export const mainView = registerGlobals(
  'mainView',
  {
    /** 0x954f4: the viewportModes window the main view is drawn in when non-zero; 0 in the data and never written by reachable code (see its label) */
    mainViewWindow: 0,
    /** 0x954e0: toggled by a cheat; vfx_video_sub_010490 then calls vfx_video_sub_010a50(worldRoot), which is not ported */
    dat000954e0: 0,
  },
  () => {
    mainView.mainViewWindow = imageI32(LABEL.mainViewWindow, 0);
    mainView.dat000954e0 = imageI32(0x954e0, 0);
  },
);

/**
 * The frame's 3D view. With 0x97020 clear: the transform built, sky and
 * ground drawn (or, with 0x97050 or wireframeMode set, the viewport wiped
 * to 0x96ea4), the light moved to its object while it follows one, then
 * the backdrop, the world list and, in the cockpit view, the cockpit shell;
 * main's viewport selected again. With 0x97020 set: only the wipe.
 *
 * @mw2 vfx_video_sub_010490 0x00010490
 * @fidelity partial
 * @divergence the drawing - sky and ground, backdrop, world, cockpit - is the host's, beneath the 2D window (renderPort.mainView): the viewport's window pixels are handed back to it (vfxWindowClearPane) where the original paints them, and a wipe instead of sky and ground becomes the host view's background rather than window pixels. viewer_latch_globals and the draw counter at 0x95510 are the render layer's. mainViewWindow's memset of the buffer at 0xa46fc (a window the shipped game never selects) and vfx_video_sub_010a50 (the cheat at 0x954e0) are not ported
 */
export const vfxVideoSub010490 = registerCode('vfx_video_sub_010490', 0x10490, (): void => {
  if (mainView.mainViewWindow !== 0) {
    unestablished('vfx_video_sub_010490: mainViewWindow is set - the memset of the buffer at 0xa46fc is not ported', 'vfx_video_sub_010490');
    viewportSelect(mainView.mainViewWindow);
  }
  const v = viewer();
  if (cam.dat000954ec !== 0) {
    viewerUpdateProjection(v);
    cam.dat000954ec = 0;
  }
  const r = renderOptions;
  if (cam.dat00097020 !== 0) {
    vfxPaneWipe(display.currentViewport, r.dat00096ea4);
    return;
  }
  viewerBuildTransform(v);
  // the pose this pass's view is drawn from, for the host to draw between passes (port-only; changes nothing the game reads)
  viewerPresentLatch(v);
  const wipe = r.dat00097050 !== 0 || r.wireframeMode !== 0 ? r.dat00096ea4 : null;
  const l = lighting;
  if (l.lightObjectFlag !== 0 && l.lightObjectFollow !== 0 && l.lightObjectRecord !== -1) {
    const [x, y, z] = worldObjectGetPos(l.lightObjectRecord);
    v.lightPos[0] = x;
    v.lightPos[1] = y;
    v.lightPos[2] = z;
  }
  if (mainView.dat000954e0 !== 0) unestablished('vfx_video_sub_010490: the 0x954e0 cheat draw (vfx_video_sub_010a50) is not ported', 'vfx_video_sub_010490');
  vfxWindowClearPane(display.currentViewport);
  renderPort.current?.mainView(wipe);
  viewportSelect(0);
});

/**
 * main's video setup: the render buffers, the polygon budget, the object
 * lists reset, the render hook and the main view's draw hooks installed,
 * 0x96eb8 = 0xff, 0x97050 cleared when sky or ground is enabled, and bit 3
 * of 0x97030 set.
 *
 * @mw2 vfx_video_sub_010320 0x00010320
 * @fidelity partial
 * @divergence render_buffers_init(0x80, 0x5dc) and polysDrawnLimit = 0x578 size the software renderer's arenas and draw budget, which the port's renderer does not have
 */
export function vfxVideoSub010320(): void {
  divergence('vfx_video_sub_010320: no render arenas or polygon budget (render_buffers_init, polysDrawnLimit)', 'vfx_video_sub_010320');
  objectListsReset();
  mainLoop.renderHook = vfxVideoSub010490;
  const r = renderOptions;
  r.objectCullHook = HOOK.objectCullMainView;
  r.clipProjectHook = HOOK.clipProjectPerspective;
  r.polygonDrawHook = HOOK.polygonResolveColour;
  r.polygonFillHook = HOOK.polyFillByMode;
  r.dat00096eb8 = 0xff;
  if (lighting.skyEnabled !== 0 || lighting.groundEnabled !== 0) r.dat00097050 = 0;
  r.dat00097030 |= 8;
}
