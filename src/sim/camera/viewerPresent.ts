/**
 * The viewer between passes (see engine/scene/present.ts for the model).
 *
 * The main view is drawn from the viewer's pose - posX/Y/Z and yaw, pitch,
 * roll, which viewer_build_transform turns into the view transform. Each pass
 * that draws the main view records that pose (viewerPresentLatch, from
 * vfx_video_sub_010490 just after the transform is built), keeping the one
 * before it. The presented viewer is a copy of the viewer with the pose
 * interpolated between the two and the transform built from it by
 * viewer_build_transform, so projection, culling and the clipper see a
 * viewer of the game's own kind.
 *
 * A cut - the camera changed mode or subject, or the last pass drew no main
 * view - has nothing to move from, and is presented where it is.
 *
 * @portOnly the host draws between passes; the original drew once a pass
 */
import { Viewer, type MechEntity } from '../../generated/classes.gen.ts';
import { registerGlobals } from '../../engine/globals.ts';
import { present, presentLerp, presentLerpAngle, presenting } from '../../engine/scene/present.ts';
import { FULL_TURN } from '../../core/angle/angle.ts';
import { cam } from './cameraUpdate.ts';
import { viewerBuildTransform } from './projection.ts';
import { cameraGlobals, viewer } from './viewer.ts';

export const viewerPresent = registerGlobals(
  'viewerPresent',
  {
    /** the camera's mode (cameraModePrev: the one camera_update ran), subject and cockpit flag at the last latch */
    shotMode: -2,
    shotSubject: null as MechEntity | null,
    shotCockpit: 0,
    /** the presented viewer (a copy, never viewerPosition) */
    presented: new Viewer(),
  },
  () => {
    const s = viewerPresent;
    s.shotMode = -2;
    s.shotSubject = null;
    s.shotCockpit = 0;
    s.presented = new Viewer();
  },
);

/**
 * The main view of this pass is drawn from `v`'s pose: it becomes the
 * latest, the latest before it the previous - or, after a cut, the previous
 * too.
 */
export function viewerPresentLatch(v: Viewer): void {
  const s = viewerPresent;
  const p = v.presentPose;
  const g = cameraGlobals;
  const sameShot = s.shotMode === cam.cameraModePrev && s.shotSubject === cam.cameraSubject && s.shotCockpit === g.cockpitViewActive;
  if (v.presentGen !== present.generation) {
    const continuous = sameShot && v.presentGen === ((present.generation - 1) | 0);
    p.copyWithin(0, 6, 12);
    p[6] = v.posX;
    p[7] = v.posY;
    p[8] = v.posZ;
    p[9] = v.yaw;
    p[10] = v.pitch;
    p[11] = v.roll;
    if (!continuous) p.copyWithin(0, 6, 12);
  } else {
    // drawn twice in one pass: the later pose is the latest, the previous stays
    p[6] = v.posX;
    p[7] = v.posY;
    p[8] = v.posZ;
    p[9] = v.yaw;
    p[10] = v.pitch;
    p[11] = v.roll;
    if (!sameShot) p.copyWithin(0, 6, 12);
  }
  v.presentGen = present.generation;
  s.shotMode = cam.cameraModePrev;
  s.shotSubject = cam.cameraSubject;
  s.shotCockpit = g.cockpitViewActive;
}

function copyViewer(dst: Viewer, src: Viewer): void {
  const s = src as unknown as Record<string, unknown>;
  const d = dst as unknown as Record<string, unknown>;
  for (const k of Object.keys(s)) {
    const x = s[k];
    if (x instanceof Int32Array) (d[k] as Int32Array).set(x);
    else d[k] = x;
  }
}

/**
 * The viewer to draw from now: viewerPosition itself at the last pass (or
 * when the last pass drew no main view); between passes, a copy with the
 * pose interpolated and the view transform built from it.
 */
export function presentedViewer(): Viewer {
  const v = viewer();
  if (!presenting() || v.presentGen !== present.generation) return v;
  const out = viewerPresent.presented;
  copyViewer(out, v);
  const p = v.presentPose;
  out.posX = presentLerp(p[0]!, p[6]!);
  out.posY = presentLerp(p[1]!, p[7]!);
  out.posZ = presentLerp(p[2]!, p[8]!);
  out.yaw = presentLerpAngle(p[3]!, p[9]!, FULL_TURN);
  out.pitch = presentLerpAngle(p[4]!, p[10]!, FULL_TURN);
  out.roll = presentLerpAngle(p[5]!, p[11]!, FULL_TURN);
  viewerBuildTransform(out);
  return out;
}

/**
 * What a draw of world-anchored 2D (the HUD's reticle and target marker)
 * projects through: the viewer, and `anchor`, which the draw hands each world
 * point it stands on - under a key naming that point from pass to pass (the
 * reticle, a mech, a node) - so the view can record it (the pass) or move it
 * to where it is presented (between passes: from the point the pass before
 * drew with to this pass's, sim/cockpit/overlay.ts).
 */
export interface DrawView {
  viewer: Viewer;
  anchor: (key: unknown, p: number[]) => void;
}

const stay = (): void => {};

/** The pass's own view: viewerPosition, points where the simulation put them. */
export function passView(): DrawView {
  return { viewer: viewer(), anchor: stay };
}
