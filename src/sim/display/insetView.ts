/**
 * The HUD's inset 3D views: render_view_from_pose draws the world from a
 * pose into one of the viewportModes panes, in the middle of the HUD's own
 * drawing, and render_state_save_for_inset sets the render options the
 * target display's view is drawn with. The drawing goes through the render
 * port (renderPort.ts), which paints the pane's pixels as the original's
 * renderer does; everything else - the viewer moved and put back, the
 * viewport selected and restored, the pose marked valid - is the game's.
 */
import type { SceneNode, Viewer } from '../../generated/classes.gen.ts';
import { worldRootNode } from '../../engine/scene/objectLists.ts';
import { cam } from '../camera/cameraUpdate.ts';
import { viewerBuildTransform, viewerUpdateProjection } from '../camera/projection.ts';
import { viewer } from '../camera/viewer.ts';
import { lighting } from '../world/environment.ts';
import { palettes } from '../world/palettes.ts';
import { renderBlockSave, renderOptions, type RenderBlock } from './renderState.ts';
import { renderPort } from './renderPort.ts';
import { viewportSelect } from './video.ts';

/**
 * The viewer's position and angles into pose[0..5], pose[6] = 1 (valid).
 * Returns 0 without writing when either is missing.
 *
 * @mw2 viewer_pose_save 0x000394c0
 * @fidelity exact
 */
export function viewerPoseSave(v: Viewer | null, pose: Int32Array | null): number {
  if (!pose || !v) return 0;
  pose[0] = v.posX;
  pose[1] = v.posY;
  pose[2] = v.posZ;
  pose[3] = v.yaw;
  pose[4] = v.pitch;
  pose[6] = 1;
  pose[5] = v.roll;
  return 1;
}

/**
 * The inverse of viewer_pose_save, only when pose[6] is set; returns 1 if it
 * copied.
 *
 * @mw2 viewer_pose_restore 0x00039510
 * @fidelity exact
 */
export function viewerPoseRestore(v: Viewer | null, pose: Int32Array | null): number {
  if (!pose || !v) return 0;
  if (pose[6] === 0) return 0;
  v.posX = pose[0]!;
  v.posY = pose[1]!;
  v.posZ = pose[2]!;
  v.yaw = pose[3]!;
  v.pitch = pose[4]!;
  v.roll = pose[5]!;
  return 1;
}

/**
 * Renders one extra view into viewportModes[viewportMode] and puts the main
 * one back: the viewer's zoom, pose and paletteRestorePending saved, the
 * viewport selected, the zoom set, the caller's pose marked valid and
 * applied, the projection and transform derived; sky and ground when either
 * is enabled, then the world list (or the scene tree under `root`); then
 * everything restored, main's viewport selected, and the projection and
 * transform derived again with 0x954ec set around them.
 *
 * @mw2 render_view_from_pose 0x00028810
 * @fidelity exact
 * @divergence viewer_latch_globals (before and after the draw) is the render layer's, which latches the viewer itself when it draws; empty_stub_37e70 is empty
 */
export function renderViewFromPose(viewportMode: number, zoom: number, pose: Int32Array, root: SceneNode | null): void {
  const v = viewer();
  const savedZoom = v.zoom;
  const savedPalette = palettes.paletteRestorePending;
  const saved = new Int32Array(7);
  viewerPoseSave(v, saved);
  viewportSelect(viewportMode);
  v.zoom = zoom;
  pose[6] = 1;
  viewerPoseRestore(v, pose);
  viewerUpdateProjection(v);
  viewerBuildTransform(v);
  const port = renderPort.current;
  if (lighting.skyEnabled !== 0 || lighting.groundEnabled !== 0) port?.skyAndGround();
  if (root === null) port?.objectList(worldRootNode);
  else port?.sceneTreeSorted(root);
  palettes.paletteRestorePending = savedPalette;
  viewportSelect(0);
  v.zoom = savedZoom;
  cam.dat000954ec = 1;
  viewerPoseRestore(v, saved);
  viewerUpdateProjection(v);
  viewerBuildTransform(v);
  cam.dat000954ec = 0;
}

/**
 * Saves the render-state block (0x97020, 26 dwords) into `save` and sets it
 * up for an inset view: 0x97038 = 0 (no points), 0x97028 = 0, 0x9702c = 1,
 * shadedFillEnabled = 1, textureOffTypeMask = 0xb00 (mechs, gamethings and
 * terrain flat), textureAffine = 1, 0x97030 bit 2 cleared.
 *
 * @mw2 render_state_save_for_inset 0x00030d30
 * @fidelity exact
 */
export function renderStateSaveForInset(save: RenderBlock): void {
  renderBlockSave(save);
  const r = renderOptions;
  r.dat00097038 = 0;
  r.dat00097028 = 0;
  r.dat0009702c = 1;
  r.shadedFillEnabled = 1;
  r.textureOffTypeMask = 0xb00;
  r.textureAffine = 1;
  r.dat00097030 &= 0xfb;
}
