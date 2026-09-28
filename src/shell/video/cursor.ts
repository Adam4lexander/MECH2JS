/**
 * The shell's VFX mouse layer (shell_input 0x1a9e0..0x1c000): the blit of a
 * pane rectangle to the display with the pointer drawn in, the pointer's
 * shape, and showing and hiding it. In the original it saves and restores
 * the pixels under the pointer itself; the port's host draws the pointer
 * over the presented screen (hardware.cursor), so the shell's screen never
 * holds pointer pixels - which is also what the original guarantees to the
 * code above it.
 *
 * @portOnly the display side of the VFX mouse
 */
import type { ViewWindow } from '../../generated/classes.gen.ts';
import type { VfxWindow } from '../../engine/vfx/vfx.ts';
import { vfxShapeOrigin } from '../../engine/vfx/vfx.ts';
import { hardware, hwMouseButtonsRead, SCREEN_W } from '../host/hardware.ts';

/**
 * Copies x0..x1, y0..y1 of the pane's window to the display, with the
 * pointer drawn in.
 *
 * @mw2shell shell_input_sub_01b850 0x0001b850
 * @fidelity partial
 * @divergence the pointer is composited by the host over the displayed screen, not blitted into it
 */
export function screenBlit(pane: ViewWindow, x0: number, y0: number, x1: number, y1: number): void {
  const w = pane.canvas as VfxWindow;
  const pitch = w.xMax + 1;
  for (let y = Math.max(0, y0); y <= Math.min(y1, w.yMax); y++) {
    const s = y * pitch;
    hardware.screen.set(w.buffer.subarray(s + Math.max(0, x0), s + Math.min(x1, w.xMax) + 1), y * SCREEN_W + Math.max(0, x0));
  }
  hardware.screenVersion++;
}

/**
 * Redraws the pointer where the mouse now is (nothing else changed).
 *
 * @mw2shell shell_input_sub_01b1f0 0x0001b1f0
 * @fidelity partial
 * @divergence the host redraws its pointer overlay every frame
 */
export function cursorRefresh(): void {
  // the host composites the pointer each frame
}

/**
 * Sets the pointer to shape `n` of a VFX shape table; its hotspot is the
 * shape's origin.
 *
 * @mw2shell shell_input_sub_01b010 0x0001b010
 * @fidelity partial
 * @divergence the shape is handed to the host, which draws it at the mouse position less the origin
 */
export function cursorSetShape(shapes: Uint8Array, n: number): void {
  hardware.cursor = { shapes, shape: n };
  void vfxShapeOrigin;
}

/**
 * Shows the pointer (its hide count reaching zero).
 *
 * @mw2shell shell_input_sub_01af70 0x0001af70
 * @fidelity partial
 * @divergence the hide count is a flag: the shell shows it once and hides it only around movies
 */
export function cursorShow(): void {
  hardware.cursorShown = true;
}

/**
 * Shuts the VFX mouse down (frees the pointer buffers); the pointer goes.
 *
 * @mw2shell shell_input_sub_01c000 0x0001c000
 * @fidelity partial
 * @divergence the DPMI call and buffers are the original's; the port hides the host's pointer
 */
export function cursorShutdown(): void {
  hardware.cursorShown = false;
}

/**
 * Starts the VFX mouse over a w x h screen: int 33h reset, the range set to
 * (w - 1) * 8 by (h - 1) * 8, the event handler installed, the pointer
 * centred. Returns 0 with no mouse driver.
 *
 * @mw2shell shell_input_sub_01be20 0x0001be20
 * @fidelity partial
 * @divergence the host's pointer is the mouse; it is always present, and the range is the canvas
 */
export function mouseDriverStart(w: number, h: number): number {
  hardware.mouseX = (w / 2) | 0;
  hardware.mouseY = (h / 2) | 0;
  return 1;
}

/**
 * Moves the pointer to (x, y) (int 33h AX=4 with x * 8, y * 8).
 *
 * @mw2shell mouse_driver_set_position 0x0001b130
 * @fidelity exact
 */
export function mouseDriverSetPosition(x: number, y: number): void {
  hardware.mouseX = x;
  hardware.mouseY = y;
  cursorRefresh();
}

/**
 * The pointer state the event handler caches: x, y, left, right, middle.
 *
 * @mw2shell mouse_read_state 0x0001b0e0
 * @fidelity exact
 */
export function mouseReadState(): { x: number; y: number; left: number; right: number; middle: number } {
  const b = hwMouseButtonsRead();
  return { x: hardware.mouseX, y: hardware.mouseY, left: b & 1, right: (b >> 1) & 1, middle: (b >> 2) & 1 };
}
