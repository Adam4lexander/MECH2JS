/**
 * Putting a DATABASE.MW2 PCX screen up: every screen starts by loading its
 * background (screen_load_background), and the pop-up menus paint a
 * picture over the screen without making it the background.
 */
import type { ViewWindow } from '../../generated/classes.gen.ts';
import type { VfxWindow } from '../../engine/vfx/vfx.ts';
import { mpackDbGetItemUnpacked, type MPackDb } from '../../data/formats/mpack.ts';
import { pcxDecode, pcxPalette } from '../../data/formats/pcx.ts';
import { dirtyAdd, type VideoDriver } from './driver.ts';
import { database } from '../state.ts';

/** The PCX palette scratch (0xa7e7c): 256 x RGB, 6-bit. */
const pcxPaletteScratch = new Uint8Array(0x300);

/** The row copier (vfx_lib_sub_047b2d): each decoded row into the pane, clipped. */
function pcxToPane(pcx: Uint8Array, pane: ViewWindow): void {
  const img = pcxDecode(pcx);
  const w = pane.canvas as VfxWindow;
  const pitch = w.xMax + 1;
  const width = Math.min(img.bytesPerLine, pane.right - pane.left + 1);
  for (let row = 0; row < img.height; row++) {
    const y = pane.top + row;
    if (y < 0 || y > Math.min(w.yMax, pane.bottom)) continue;
    for (let x = 0; x < width; x++) {
      const X = pane.left + x;
      if (X >= 0 && X <= w.xMax) w.buffer[y * pitch + X] = img.pixels[row * img.bytesPerLine + x]!;
    }
  }
}

/**
 * (driver, db, item): the PCX unpacked, its palette taken (into the driver
 * only when it differs - else the next present keeps the DAC as it is),
 * decoded onto the screen, and the screen copied whole to the background;
 * the palette marked dirty and the whole screen dirty.
 *
 * @mw2shell screen_load_background 0x0003e500
 * @fidelity exact
 */
export function screenLoadBackground(d: VideoDriver, db: MPackDb, item: number): void {
  const pcx = mpackDbGetItemUnpacked(db, item);
  if (!pcx) return;
  pcxPalette(pcx, pcxPaletteScratch);
  let same = true;
  for (let i = 0; i < 0x300; i++) {
    if (pcxPaletteScratch[i] !== d.palette[i]) {
      same = false;
      break;
    }
  }
  if (same) d.paletteUnchanged = 1;
  else d.palette.set(pcxPaletteScratch);
  pcxToPane(pcx, d.screenPane);
  d.background.buffer.set(d.screen.buffer.subarray(0, d.width * d.height));
  d.paletteDirty = 1;
  dirtyAdd(d, d.screenPane.left, d.screenPane.top, d.screenPane.right, d.screenPane.bottom);
}

/**
 * A DATABASE picture painted over the screen (not the background), its
 * palette straight into the driver's and marked dirty - the pop-up menus'
 * backdrop.
 *
 * @mw2shell video_driver_sub_03ea60 0x0003ea60
 * @fidelity exact
 */
export function screenPaintPicture(d: VideoDriver, item: number): void {
  const pcx = mpackDbGetItemUnpacked(database(), item);
  if (!pcx) return;
  pcxPalette(pcx, d.palette);
  pcxToPane(pcx, d.screenPane);
  d.paletteDirty = 1;
}
