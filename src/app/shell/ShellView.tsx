/**
 * The shell's display and input: a 640x480 canvas showing what the video
 * driver blitted (through the DAC), or a full-screen movie while one plays,
 * with the mouse pointer drawn over it; the pointer and keyboard fed to the
 * shell's int 33h mouse and BIOS keyboard. Each animation frame runs the
 * shell's pump. With a headset (app/xrHost.ts) the frames are its loop's and
 * the canvas is also its panel; there, where the page's pointer cannot be
 * seen, a click locks the mouse to the screen and its motion moves the
 * shell's.
 *
 * @portOnly the monitor, mouse and keyboard of the shell's PC
 */
import { useEffect, useRef } from 'react';
import { hardware, hwKey, hwMouseButtons, hwMouseMove, SCREEN_H, SCREEN_W } from '../../shell/host/hardware.ts';
import type { ShellPump } from '../../shell/host/pump.ts';
import { vfxShapeBounds, vfxShapeDraw, VfxWindow, vfxWindowAllocate } from '../../engine/vfx/vfx.ts';
import { ViewWindow } from '../../generated/classes.gen.ts';
import { biosKey } from './keymap.ts';
import { everyFrame, type XrHost } from '../xrHost.ts';

/** 6-bit DAC values to 8-bit (the VGA's 63 is full brightness). */
const dac8 = (v: number) => (v << 2) | (v >> 4);

/**
 * The pointer shape rendered to indices once. The VFX mouse draws the shape
 * at the pointer's position, so its hotspot is the shape's own (0, 0): the
 * picture's top-left is its minimum x and y (shape +8, +0xc - what
 * vfx_lib_sub_04840c hands shell_input_sub_01b010).
 */
function pointerImage(shapes: Uint8Array, n: number): { w: number; h: number; ox: number; oy: number; pixels: Uint8Array; drawn: Uint8Array } {
  const dv = new DataView(shapes.buffer, shapes.byteOffset, shapes.byteLength);
  const at = dv.getInt32(8 + n * 8, true);
  const x0 = dv.getInt32(at + 8, true);
  const y0 = dv.getInt32(at + 0xc, true);
  const b = vfxShapeBounds(shapes, n);
  const w = (b >> 16) + 1;
  const h = (b & 0xffff) + 1;
  const win = new VfxWindow();
  vfxWindowAllocate(win, w, h);
  const pane = new ViewWindow();
  pane.canvas = win;
  pane.right = w - 1;
  pane.bottom = h - 1;
  vfxShapeDraw(pane, shapes, n, -x0, -y0);
  return { w, h, ox: -x0, oy: -y0, pixels: win.buffer, drawn: win.drawn };
}

export function ShellView({ pump, onExit, host }: { pump: ShellPump; onExit: (status: number) => void; host?: XrHost | null }) {
  const canvas = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const cv = canvas.current!;
    const ctx = cv.getContext('2d')!;
    const img = ctx.createImageData(SCREEN_W, SCREEN_H);
    const px = new Uint32Array(img.data.buffer);
    const lut = new Uint32Array(256);
    let dacSeen = -1;
    let pointer: ReturnType<typeof pointerImage> | null = null;
    let pointerFor: unknown = null;
    let last = performance.now();
    let ended = false;

    const paint = () => {
      if (hardware.dacVersion !== dacSeen) {
        dacSeen = hardware.dacVersion;
        for (let i = 0; i < 256; i++) lut[i] = 0xff000000 | (dac8(hardware.dac[i * 3 + 2]!) << 16) | (dac8(hardware.dac[i * 3 + 1]!) << 8) | dac8(hardware.dac[i * 3]!);
      }
      const mv = hardware.movie;
      if (mv) {
        // the movie fills the screen, scaled with its aspect kept
        const s = Math.min(SCREEN_W / mv.width, SCREEN_H / mv.height);
        const w = Math.floor(mv.width * s);
        const h = Math.floor(mv.height * s);
        const x0 = (SCREEN_W - w) >> 1;
        const y0 = (SCREEN_H - h) >> 1;
        px.fill(0xff000000);
        for (let y = 0; y < h; y++) {
          const sy = Math.floor(y / s) * mv.width;
          for (let x = 0; x < w; x++) px[(y0 + y) * SCREEN_W + x0 + x] = lut[mv.pixels[sy + Math.floor(x / s)]!]!;
        }
      } else {
        const scr = hardware.screen;
        for (let i = 0; i < scr.length; i++) px[i] = lut[scr[i]!]!;
        const c = hardware.cursor;
        if (c && hardware.cursorShown) {
          if (pointerFor !== c) {
            pointer = pointerImage(c.shapes, c.shape);
            pointerFor = c;
          }
          const p = pointer!;
          for (let y = 0; y < p.h; y++) {
            const Y = hardware.mouseY - p.oy + y;
            if (Y < 0 || Y >= SCREEN_H) continue;
            for (let x = 0; x < p.w; x++) {
              const X = hardware.mouseX - p.ox + x;
              if (X < 0 || X >= SCREEN_W || !p.drawn[y * p.w + x]) continue;
              px[Y * SCREEN_W + X] = lut[p.pixels[y * p.w + x]!]!;
            }
          }
        }
      }
      ctx.putImageData(img, 0, 0);
    };

    const tick = (now: number) => {
      if (ended) return;
      // the headset's frame times and the window's are one clock, but a frame can arrive stamped before the last
      const ms = Math.max(0, Math.min(100, now - last));
      last = now;
      const running = pump.frame(ms);
      paint();
      if (!running) {
        ended = true;
        stop();
        if (pump.error) console.error('[shell]', pump.error);
        onExit(pump.status ?? 1);
      }
    };
    // the frames: the window's, or the headset's while it shows the screen (app/xrHost.ts)
    const stop = everyFrame(host, tick);
    host?.showScreen(cv);
    // debug: run frames by hand (a hidden tab gets no animation frames)
    (window as unknown as { mw2shell?: Record<string, unknown> }).mw2shell!.step = (n = 1, ms = 1000 / 60) => {
      for (let i = 0; i < n && pump.frame(ms); i++);
      paint();
      return pump.status;
    };

    const locked = () => document.pointerLockElement === cv;
    const toScreen = (e: PointerEvent) => {
      // locked (in the headset): the mouse's motion, as a mouse driver takes its mickeys
      if (locked()) {
        hwMouseMove(hardware.mouseX + e.movementX, hardware.mouseY + e.movementY);
        return;
      }
      const r = cv.getBoundingClientRect();
      hwMouseMove(((e.clientX - r.left) / r.width) * SCREEN_W, ((e.clientY - r.top) / r.height) * SCREEN_H);
    };
    const buttons = (e: PointerEvent) => {
      // DOM buttons: 1 left, 2 right, 4 middle; int 33h: bit 0 left, bit 1 right, bit 2 middle
      hwMouseButtons((e.buttons & 1) | ((e.buttons & 2) ? 2 : 0) | ((e.buttons & 4) ? 4 : 0));
    };
    const onMove = (e: PointerEvent) => {
      toScreen(e);
      buttons(e);
    };
    const onDown = (e: PointerEvent) => {
      // in the headset the page's pointer cannot be seen, so the first click locks the mouse to the
      // screen (the shell draws its own pointer, on the headset's panel too)
      if (host?.presenting && !locked()) {
        void cv.requestPointerLock();
        e.preventDefault();
        return;
      }
      if (!locked()) cv.setPointerCapture(e.pointerId);
      toScreen(e);
      buttons(e);
      e.preventDefault();
    };
    const onKey = (e: KeyboardEvent) => {
      const k = biosKey(e);
      if (k) {
        hwKey(k.ascii, k.scan);
        e.preventDefault();
      }
    };
    const noMenu = (e: Event) => e.preventDefault();
    cv.addEventListener('pointermove', onMove);
    cv.addEventListener('pointerdown', onDown);
    cv.addEventListener('pointerup', onMove);
    cv.addEventListener('contextmenu', noMenu);
    window.addEventListener('keydown', onKey);
    return () => {
      stop();
      host?.hideScreen(cv);
      // the next view (a mission) takes the mouse with a click of its own
      if (locked()) document.exitPointerLock();
      cv.removeEventListener('pointermove', onMove);
      cv.removeEventListener('pointerdown', onDown);
      cv.removeEventListener('pointerup', onMove);
      cv.removeEventListener('contextmenu', noMenu);
      window.removeEventListener('keydown', onKey);
    };
  }, [pump, onExit, host]);

  return <canvas ref={canvas} className="shell-screen" width={SCREEN_W} height={SCREEN_H} />;
}
