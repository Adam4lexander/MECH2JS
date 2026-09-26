/**
 * The display: the VFX window everything 2D is drawn into (defaultCanvas),
 * the full-screen pane (currentViewport), the screen mode and what it selects
 * - the art variant (assetVariant) and the projection's aspect correction -
 * and the text colour table.
 *
 * The original gets the screen mode from its VFX driver (vfx_load_drivers
 * stores the driver's mode record at screenModeInfo). The port has no driver;
 * the mode is the host's choice among the three MW2 knows (screenModeSizes:
 * 320x200, 640x480, 1024x768), 640x480 by default - the SVGA mode, whose art
 * is the "6" variant of each SHP and FONT and whose pixels are square.
 */
import { ViewWindow } from '../../generated/classes.gen.ts';
import { LABEL } from '../../generated/labels.gen.ts';
import { registerGlobals } from '../../engine/globals.ts';
import { imageI32, imageI32s, imageU8 } from '../../engine/image.ts';
import { VfxWindow, vfxWindowAllocate } from '../../engine/vfx/vfx.ts';
import { cam } from '../camera/cameraUpdate.ts';
import { cameraGlobals } from '../camera/viewer.ts';
import { lighting } from '../world/environment.ts';

/**
 * 0xa46bc: the VFX window; video_init gives it the frame buffer. One object
 * for the life of the port, so the panes that point at it (their +0, set from
 * the image's &defaultCanvas) stay valid across a reset.
 */
export const defaultCanvas = new VfxWindow();

function bootDisplay() {
  defaultCanvas.buffer = new Uint8Array(0);
  defaultCanvas.drawn = new Uint8Array(0);
  defaultCanvas.xMax = -1;
  defaultCanvas.yMax = -1;
  const currentViewport = new ViewWindow();
  return {
    /** 0xa46bc (see the export) */
    defaultCanvas,
    /** 0xa46a8: {&defaultCanvas, 0, 0, width - 1, height - 1} after video_init; viewport_select copies records over it */
    currentViewport,
    /**
     * 0xa46d4 points at the driver's mode record, whose first two dwords are
     * width and height. @portOnly the host's choice, set before video_init
     */
    screenMode: { width: 640, height: 480 },
    /** 0x95768: {319, 199}, {639, 479}, {1023, 767} - the sizes of the three art variants */
    screenModeSizes: imageI32s(LABEL.screenModeSizes, 6, [319, 199, 639, 479, 1023, 767]),
    /** 0xa4dc0: 0..2, added to every SHP and FONT id - which of NAME, NAME6, NAMEK is drawn */
    assetVariant: imageU8(LABEL.assetVariant, 0),
    /** 0xa4dbc: height / width * 4/3, 16.16 */
    screenAspect: 0,
    /** 0xa4dc4: 256 bytes glyphs are mapped through; byte 14 is the ink colour */
    textColourTable: new Uint8Array(256),
    /** 0x954f8: width * height, the frame buffer's size */
    frameBytes: 0,
    /** 0x97098: the viewportModes index viewport_select last made current; -1 in the image */
    currentViewportMode: imageI32(LABEL.currentViewportMode, -1),
  };
}

export const display = registerGlobals('display', bootDisplay(), () => {
  const mode = display.screenMode;
  Object.assign(display, bootDisplay());
  display.screenMode = mode;
});

/**
 * Sets assetVariant to the index of the screenModeSizes entry nearest
 * {width - 1, height - 1} by L1 distance, accepting only a distance under 7.
 *
 * @mw2 screen_select_asset_variant 0x000148d0
 * @fidelity exact
 */
export function screenSelectAssetVariant(mode: { width: number; height: number }): void {
  let best = 7;
  for (let i = 0; i < 3; i++) {
    const d = Math.abs(display.screenModeSizes[i * 2]! - (mode.width - 1)) + Math.abs(display.screenModeSizes[i * 2 + 1]! - (mode.height - 1));
    if (d < best) {
      display.assetVariant = i;
      best = d;
    }
  }
}

/**
 * aspectScale = (height << 16) * 0x15555 / (width << 16) into screenAspect and
 * viewerPosition->aspectScale: 0xd555 at 320x200, 0x10000 at 640x480.
 *
 * @mw2 viewer_set_aspect_from_screen 0x000148a0
 * @fidelity exact
 */
export function viewerSetAspectFromScreen(mode: { width: number; height: number }): void {
  const n = BigInt((mode.height << 16) | 0) * 0x15555n;
  const d = BigInt((mode.width << 16) | 0);
  display.screenAspect = Number(BigInt.asIntN(32, n / d));
  const v = cameraGlobals.viewerPosition ?? cameraGlobals.mainViewer;
  v.aspectScale = display.screenAspect;
}

/**
 * The text colour table as the identity.
 *
 * @mw2 vfx_colour_table_identity 0x00014a80
 * @fidelity exact
 */
export function vfxColourTableIdentity(): void {
  for (let i = 0; i < 256; i++) display.textColourTable[i] = i;
}

/**
 * Copies the pane into all 11 viewportModes, so every window starts as the
 * whole screen until the VWSP chunk overrides some; the original also zeroes
 * 0x14 bytes of paletteResourceIds, which are already zero at start-up.
 *
 * @mw2 viewport_windows_reset 0x0003e5b0
 * @fidelity exact
 */
export function viewportWindowsReset(pane: ViewWindow): void {
  for (const w of lighting.viewportModes) {
    w.canvas = pane.canvas;
    w.left = pane.left;
    w.top = pane.top;
    w.right = pane.right;
    w.bottom = pane.bottom;
  }
}

/**
 * Brings the display up in the host's screen mode: the art variant and
 * aspect, a frame buffer of width x height, currentViewport as the whole
 * screen and every viewportModes record with it, and the text colour table.
 * Returns 1.
 *
 * @mw2 video_init 0x00010210
 * @fidelity partial
 * @divergence vfx_load_drivers and the driver's set-up call (DAT_0009fd4c) are the host's; the mode is display.screenMode rather than the driver's record; the VGA/data selectors and the copy of the pane at 0xa4694 are not kept
 */
export function videoInit(): number {
  const mode = display.screenMode;
  screenSelectAssetVariant(mode);
  viewerSetAspectFromScreen(mode);
  display.frameBytes = Math.imul(mode.width, mode.height);
  vfxWindowAllocate(display.defaultCanvas, mode.width, mode.height);
  const p = display.currentViewport;
  p.canvas = display.defaultCanvas;
  p.left = 0;
  p.top = 0;
  p.right = mode.width - 1;
  p.bottom = mode.height - 1;
  viewportWindowsReset(p);
  vfxColourTableIdentity();
  return 1;
}

/**
 * The canvas a pane record in the image points at: &defaultCanvas (0xa46bc)
 * becomes the port's window, anything else stays null. @portOnly
 */
export function imageCanvas(addr: number): VfxWindow | null {
  return imageI32(addr, 0) === 0xa46bc ? defaultCanvas : null;
}

/**
 * Makes viewportModes[i] current: the viewer's rect becomes (0, 0, width,
 * height) of the record (x1 - x0, y1 - y0), its centre offsets zero, and the
 * record is copied to currentViewport. Refuses an index outside 0..10 or the
 * one already current.
 *
 * @mw2 viewport_select 0x0003e600
 * @fidelity exact
 */
export function viewportSelect(i: number): void {
  const d = display;
  if (i < 0 || i >= 0xb || i === d.currentViewportMode) return;
  const v = cameraGlobals.viewerPosition ?? cameraGlobals.mainViewer;
  const w = lighting.viewportModes[i]!;
  v.left = 0;
  v.top = 0;
  v.right = (w.right - w.left) | 0;
  d.currentViewportMode = i;
  v.centreOffsetX = 0;
  v.centreOffsetY = 0;
  v.bottom = (w.bottom - w.top) | 0;
  const c = d.currentViewport;
  c.canvas = w.canvas;
  c.left = w.left;
  c.top = w.top;
  c.right = w.right;
  c.bottom = w.bottom;
  cam.dat000954ec = 1;
}
