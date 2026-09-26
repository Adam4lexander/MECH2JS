/**
 * The camera state: mainViewer (a Viewer in initialised data at 0x96f3c) and
 * viewerPosition, the pointer everything reads the camera through.
 */
import { Viewer, type MechLoadout } from '../../generated/classes.gen.ts';
import { LABEL } from '../../generated/labels.gen.ts';
import { registerGlobals } from '../../engine/globals.ts';
import { bootImage, imageI32 } from '../../engine/image.ts';
import { assignFromMemory } from '../../engine/schema/assign.ts';

export const cameraGlobals = registerGlobals(
  'camera',
  {
    mainViewer: new Viewer(),
    viewerPosition: null as Viewer | null,
    /** 0x96ee8 */
    cameraMode: 0,
    /**
     * 0x96ef4: set while the view is the cockpit; object_cull_main_view then
     * skips every object of type family 0xa0, and the sim's sounds and
     * effects check it.
     */
    cockpitViewActive: 0,
    /** 0x96ef8: the camera mode an ejected player is locked to (-1: not chosen yet; see camera_set_mode) */
    ejectCameraMode: -1,
    /**
     * 0x96f04: &loadout->eyeOffsetY of the player's mech (hud_widgets_install);
     * the port keeps the loadout. camera_subject_eye_pose raises the eye by
     * it whoever the subject is.
     */
    playerEyeOffsetY: null as MechLoadout | null,
    /** 0x96f08: &loadout->ramps[0].current of the player's mech (hud_widgets_install); the port keeps the loadout */
    playerTorsoPanPtr: null as MechLoadout | null,
  },
  () => {
    const c = cameraGlobals;
    c.mainViewer = new Viewer();
    const img = bootImage();
    if (img) assignFromMemory(c.mainViewer, 'Viewer', img, LABEL.mainViewer);
    c.viewerPosition = c.mainViewer;
    c.cameraMode = imageI32(LABEL.cameraMode, 0);
    c.cockpitViewActive = imageI32(LABEL.cockpitViewActive, 0);
    c.ejectCameraMode = imageI32(LABEL.ejectCameraMode, -1);
    c.playerEyeOffsetY = null;
    c.playerTorsoPanPtr = null;
  },
);
cameraGlobals.viewerPosition = cameraGlobals.mainViewer;

export function viewer(): Viewer {
  return cameraGlobals.viewerPosition ?? cameraGlobals.mainViewer;
}

/**
 * @mw2 camera_get_mode 0x00039430
 * @fidelity exact
 */
export function cameraGetMode(): number {
  return cameraGlobals.cameraMode;
}
