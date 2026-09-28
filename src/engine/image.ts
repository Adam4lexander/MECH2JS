/**
 * The EXE images the engine booted from. Globals whose initial values are
 * baked into the executable (rather than zeroed) are reset from here, so the
 * port starts from exactly the values the original did.
 *
 * MW2.EXE's accessors are the plain exports (imageI32, ...); MW2SHELL.EXE's
 * come from imageReader('mw2shell'). The two images overlap in address, so a
 * shell global must never be read through MW2's accessors.
 *
 * @portOnly
 */
import type { ExeImage } from '../data/exe/ExeImage.ts';
import type { ExeTarget } from './exeTarget.ts';

const images: Record<ExeTarget, ExeImage | null> = { mw2: null, mw2shell: null };

export function setBootImage(exe: ExeImage, target: ExeTarget = 'mw2'): void {
  images[target] = exe;
}

export function bootImage(target: ExeTarget = 'mw2'): ExeImage | null {
  return images[target];
}

/** Reads one executable's image, each read falling back before an image is loaded (unit tests). */
export interface ImageReader {
  i32(addr: number, fallback: number): number;
  u8(addr: number, fallback: number): number;
  i32s(addr: number, count: number, fallback: number[]): number[];
  f64(addr: number, fallback: number): number;
}

export function imageReader(target: ExeTarget): ImageReader {
  return {
    i32: (addr, fallback) => images[target]?.i32(addr) ?? fallback,
    u8: (addr, fallback) => images[target]?.u8(addr) ?? fallback,
    i32s: (addr, count, fallback) => {
      const img = images[target];
      return img ? Array.from({ length: count }, (_, i) => img.i32(addr + i * 4)) : fallback.slice();
    },
    f64: (addr, fallback) => images[target]?.f64(addr) ?? fallback,
  };
}

const mw2 = imageReader('mw2');

/** The int32 at `addr` in MW2.EXE's image, or `fallback` before an image is loaded (unit tests). */
export const imageI32 = mw2.i32;

/** The byte at `addr`, or `fallback` before an image is loaded. */
export const imageU8 = mw2.u8;

/** `count` int32s from `addr`, or `fallback` before an image is loaded. */
export const imageI32s = mw2.i32s;

/** The double at `addr`, or `fallback` before an image is loaded. */
export const imageF64 = mw2.f64;
