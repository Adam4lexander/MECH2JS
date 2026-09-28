/**
 * An archive picture (decompiled/mw2shell/src/ui/picture.c): a VFX shape
 * table ("1.10") from ARCHWO.MW2 / ARCHJF.MW2 whose shape 0 is drawn into
 * the BACKGROUND at the screen's centre, with the background it covers
 * saved first so it can be put back. A page (text/page.ts) owns at most
 * one; page_restart shows it, page_hide takes it down.
 */
import { ViewWindow } from '../../generated/classes.gen.ts';
import { VfxWindow, vfxShapeBounds, vfxShapeDraw, vfxWindowAllocate } from '../../engine/vfx/vfx.ts';
import { vfxPaneCopy, videoDriverErase, type VideoDriver } from '../video/driver.ts';
import { labelsRedraw } from './labels.ts';
import { soundSamplePlay, type Sample } from '../sound/samples.ts';

/** @portOnly the 0x35c-byte picture as a live object */
export class Picture {
  /** +0x00 the shape table */
  shapes: Uint8Array = new Uint8Array(0);
  /** +0x04 its size */
  size = 0;
  /** +0x08 */
  driver: VideoDriver | null = null;
  /** +0x0c / +0x10 the box's top-left: centred on 640 x 480 */
  x = 0;
  y = 0;
  /** +0x14 / +0x18 shape 0's bounds + 2 each way */
  width = 0;
  height = 0;
  /** +0x1c a pane over the saved-background window (+0x44: buffer, +0x48 xMax, +0x4c yMax) */
  savedPane = new ViewWindow();
  /** +0x44 */
  saved = new VfxWindow();
  /** +0x30 a pane over the driver's background window at the box */
  backgroundPane = new ViewWindow();
  /** +0x358 the sound picture_show starts (page_set_picture passes sound77) */
  sound: Sample | null = null;
}

/**
 * (pic, shapes, size, driver, x, y, sound): the box is shape 0's bounds + 2
 * each way, centred on the 640 x 480 screen whatever x and y say; the
 * background under it is copied into a buffer of its own.
 *
 * @mw2shell picture_init 0x00028ef0
 * @fidelity exact
 */
export function pictureInit(pic: Picture, shapes: Uint8Array, size: number, driver: VideoDriver, x: number, y: number, sound: Sample | null): Picture {
  pic.shapes = shapes;
  pic.size = size;
  pic.driver = driver;
  pic.sound = sound;
  // video_driver_sub_03e380(driver, &w, &h, shapes, size, 2) reads the table's
  // resolution (vfx_shape_resolution, a pure header read) into w and h, which the
  // next lines overwrite: nothing of it survives
  const b = vfxShapeBounds(shapes, 0);
  pic.width = (b >> 16) + 2;
  pic.height = (b & 0xffff) + 2;
  pic.x = x;
  pic.y = y;
  pic.x = ((0x280 - pic.width) / 2) | 0;
  pic.y = ((0x1e0 - pic.height) / 2) | 0;
  vfxWindowAllocate(pic.saved, pic.width, pic.height);
  pic.savedPane.canvas = pic.saved;
  pic.savedPane.left = 0;
  pic.savedPane.top = 0;
  pic.savedPane.right = pic.saved.xMax;
  pic.savedPane.bottom = pic.saved.yMax;
  pic.backgroundPane.canvas = driver.background;
  pic.backgroundPane.left = pic.x;
  pic.backgroundPane.top = pic.y;
  pic.backgroundPane.right = pic.x + pic.width - 1;
  pic.backgroundPane.bottom = pic.y + pic.height - 1;
  vfxPaneCopy(pic.backgroundPane, 0, 0, pic.savedPane, 0, 0, -1);
  return pic;
}

/** The box copied to the screen and both label lists redrawn over it: the tail picture_show, _redraw and _destroy share. */
function pictureRefresh(pic: Picture): void {
  const d = pic.driver!;
  videoDriverErase(d, pic.x, pic.y, pic.width, pic.height);
  labelsRedraw(d, 0);
  labelsRedraw(d, 1);
}

/**
 * Puts the saved background back, refreshes the box, and frees the shape
 * table (the caller frees the picture).
 *
 * @mw2shell picture_destroy 0x00029020
 * @fidelity exact
 */
export function pictureDestroy(pic: Picture): Picture {
  vfxPaneCopy(pic.savedPane, 0, 0, pic.backgroundPane, 0, 0, -1);
  pictureRefresh(pic);
  return pic;
}

/**
 * Starts the picture's sound, draws shape 0 into the BACKGROUND at the
 * screen's centre (319, 239) - so erasing anything over it keeps it - and
 * refreshes the box.
 *
 * @mw2shell picture_show 0x00029080
 * @fidelity exact
 */
export function pictureShow(pic: Picture): void {
  if (pic.sound) soundSamplePlay(pic.sound);
  vfxShapeDraw(pic.driver!.backgroundPane, pic.shapes, 0, 0x13f, 0xef);
  pictureRefresh(pic);
}

/**
 * Puts the saved background back and refreshes the box: the picture is
 * taken DOWN, not drawn again (page_hide, which calls it, is the page's
 * hide).
 *
 * @mw2shell picture_hide 0x000290f0
 * @fidelity exact
 */
export function pictureHide(pic: Picture): void {
  vfxPaneCopy(pic.savedPane, 0, 0, pic.backgroundPane, 0, 0, -1);
  pictureRefresh(pic);
}
