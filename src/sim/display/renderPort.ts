/**
 * The sim's way to the 3D renderer. The original's HUD and map code call the
 * renderer in the middle of a frame - render_sky_and_ground,
 * render_object_list, render_scene_tree_sorted - and it paints straight into
 * the 8-bit frame buffer through currentViewport, under whatever 2D the
 * caller draws next. The port's renderer is the host's (three.js), which the
 * sim cannot import, so the host installs itself here; with none installed
 * (tests, Node) the calls draw nothing and the sim runs on unchanged.
 *
 * Every call draws from viewerPosition, with the render-state block
 * (sim/display/renderState.ts) and its hooks as they stand at the call,
 * into display.currentViewport.
 *
 * @portOnly
 */
import type { SceneNode, WorldObject } from '../../generated/classes.gen.ts';

export interface RenderPort {
  /** render_sky_and_ground(viewerPosition), into currentViewport's pixels */
  skyAndGround(): void;
  /** render_object_list(list): the objects on the list whose head object is `list` (worldRootNode) through objectCullHook, polygonDrawHook and polygonFillHook, into currentViewport's pixels */
  objectList(list: WorldObject | null): void;
  /** render_scene_tree_sorted(root), into currentViewport's pixels */
  sceneTreeSorted(root: SceneNode): void;
  /**
   * The main view's drawing in vfx_video_sub_010490 - sky and ground (or a
   * wipe to `wipeColour`), the backdrop, the world, the cockpit shell. The
   * host draws it beneath the 2D window after the frame; the window's
   * viewport pixels have been handed back to it (vfxWindowClearPane).
   */
  mainView(wipeColour: number | null): void;
}

export const renderPort: { current: RenderPort | null } = { current: null };
