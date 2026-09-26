/**
 * The MW2.EXE image the engine booted from. Globals whose initial values are
 * baked into the executable (rather than zeroed) are reset from here, so the
 * port starts from exactly the values the original did.
 *
 * @portOnly
 */
import type { ExeImage } from '../data/exe/ExeImage.ts';

let image: ExeImage | null = null;

export function setBootImage(exe: ExeImage): void {
  image = exe;
}

export function bootImage(): ExeImage | null {
  return image;
}

/** The int32 at `addr` in the image, or `fallback` before an image is loaded (unit tests). */
export function imageI32(addr: number, fallback: number): number {
  return image ? image.i32(addr) : fallback;
}

/** The byte at `addr`, or `fallback` before an image is loaded. */
export function imageU8(addr: number, fallback: number): number {
  return image ? image.u8(addr) : fallback;
}

/** `count` int32s from `addr`, or `fallback` before an image is loaded. */
export function imageI32s(addr: number, count: number, fallback: number[]): number[] {
  return image ? Array.from({ length: count }, (_, i) => image!.i32(addr + i * 4)) : fallback.slice();
}

/** The double at `addr`, or `fallback` before an image is loaded. */
export function imageF64(addr: number, fallback: number): number {
  return image ? image.f64(addr) : fallback;
}
