/**
 * The camera state: mainViewer (a Viewer in initialised data at 0x96f3c) and
 * viewerPosition, the pointer everything reads the camera through.
 */
import { Viewer } from '../../generated/classes.gen.ts';
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
  },
  () => {
    const c = cameraGlobals;
    c.mainViewer = new Viewer();
    const img = bootImage();
    if (img) assignFromMemory(c.mainViewer, 'Viewer', img, LABEL.mainViewer);
    c.viewerPosition = c.mainViewer;
    c.cameraMode = imageI32(LABEL.cameraMode, 0);
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
