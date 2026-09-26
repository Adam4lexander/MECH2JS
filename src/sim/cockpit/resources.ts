/**
 * The player's cockpit layout resources: CPIT (the CPTF chunk, '.cpi') and
 * HUD (the HUDF chunk, '.hdi'). The interpreter calls both only for the
 * player's gamepiece (controlSource 0).
 *
 * Both loaders copy rectangles and numbers into fixed HUD tables. Which HUD
 * element each entry drives is NOT established - the HUD is not recovered -
 * so the tables keep their addresses as names, with what their readers do
 * noted where a reader has been read.
 *
 * CPIT (164 bytes, the one resource in MW2.PRJ): 20 records of four shorts
 * {x, y, width, height}, stored as inclusive rectangles {left x, top y,
 * right x + w - 1, bottom y + h - 1} - five into the ViewWindows at 0x955e8
 * and fifteen into those at 0x968e0 - then two shorts into the two ints the
 * pointer at 0x95740 names (0x9572c).
 *
 * HUD (292 bytes, 18 resources in MW2.PRJ): five pairs of ints into
 * 0x9623c..0x96263, three ints into 0xfe0e8..0xfe0f0, then fifteen records of
 * four ints into {left, top, right, bottom} of the ViewWindows at 0x9667c -
 * each record all four in 0..100 or it is stored as zeros.
 */
import { ViewWindow } from '../../generated/classes.gen.ts';
import { i16 } from '../../core/int/cint.ts';
import { divergence } from '../../core/provenance.ts';
import type { StreamRef } from '../../data/bwd/stream.ts';
import { registerGlobals } from '../../engine/globals.ts';
import { imageI32, imageI32s } from '../../engine/image.ts';
import { loadResourceRef } from '../../engine/resources/preload.ts';

function bootWindows(addr: number, count: number): ViewWindow[] {
  return Array.from({ length: count }, (_, i) => {
    const w = new ViewWindow();
    const at = addr + i * 0x14;
    // canvas (+0) is &defaultCanvas (0xa46bc) in the image - a pointer, left null
    w.left = imageI32(at + 4, 0);
    w.top = imageI32(at + 8, 0);
    w.right = imageI32(at + 0xc, 0);
    w.bottom = imageI32(at + 0x10, 0);
    return w;
  });
}

function bootCockpit() {
  return {
    /**
     * 0x955e8: ViewWindow[5] (the label in the C is PTR_defaultCanvas_000955e8).
     * res_load_cockpit writes the rectangles; vfx_font_sub_014950 rescales all
     * five exactly as it rescales viewportModes. Zero rectangles in the image.
     */
    dat000955e8: bootWindows(0x955e8, 5),
    /**
     * 0x968e0: ViewWindow[15]; res_load_cockpit writes the rectangles. The
     * image already holds a layout here ({13,10,80,60}, {260,145,312,197} ...).
     */
    dat000968e0: bootWindows(0x968e0, 15),
    /**
     * 0x9572c: two ints, reached through the pointer at 0x95740 -
     * res_load_cockpit's fourth argument. vfx_font_sub_014950 rescales them as
     * a point.
     */
    dat0009572c: Int32Array.from(imageI32s(0x9572c, 2, [0, 0])),
    /**
     * 0x9623c: five {int, int} pairs from res_load_hdi. vfx_font_sub_014950
     * rescales SIX pairs from here as points; the sixth (0x96264) is not
     * written by the loader. The image holds {277,22}, {8,116}, {4,64}, {4,116}, {0,0}.
     */
    dat0009623c: Int32Array.from(imageI32s(0x9623c, 10, new Array<number>(10).fill(0))),
    /**
     * 0xfe0e8: three ints from res_load_hdi. The first is an SHP resource id:
     * the damage diagram set-up (sim/damage.c) loads cache_load_resource(it +
     * assetVariant, SHP).
     */
    dat000fe0e8: Int32Array.from(imageI32s(0xfe0e8, 3, [0, 0, 0])),
    /**
     * 0x9667c: ViewWindow[16]. res_load_hdi writes records 0..14 with values
     * checked to 0..100; the damage diagram set-up then rewrites all sixteen
     * relative to the diagram's window at 0x96668.
     */
    dat0009667c: bootWindows(0x9667c, 16),
  };
}

export const cockpit = registerGlobals('cockpitResources', bootCockpit(), () => {
  Object.assign(cockpit, bootCockpit());
});

/**
 * The CPTF handler: loads a CPIT layout (TABL 3 resolves a name; '.cpi' is
 * the loose-file extension) into the cockpit window tables. Returns 1, or 0
 * when the resource is missing.
 *
 * The original's three table arguments (0x955e8, 0x968e0, *0x95740) are
 * constants at its one call site, and it returns 0 when any is null; the port
 * writes the tables directly.
 *
 * @mw2 res_load_cockpit 0x0004bf70
 * @fidelity exact
 * @divergence the 'Couldn't load' line appended to symlog.txt is not written
 */
export function resLoadCockpit(ref: StreamRef): number {
  const { data } = loadResourceRef(ref, 'CPIT', '.cpi', 3);
  if (!data) {
    divergence(`res_load_cockpit: couldn't load ${ref.name} (symlog.txt not written)`);
    return 0;
  }
  if (data.length < 20 * 8 + 4) {
    divergence('res_load_cockpit: CPIT shorter than 164 bytes; the original reads past it');
    return 0;
  }
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const s = (o: number): number => dv.getInt16(o, true);
  const rect = (w: ViewWindow, o: number): void => {
    w.left = s(o);
    w.top = s(o + 2);
    w.right = (s(o) + s(o + 4) - 1) | 0;
    w.bottom = (s(o + 2) + s(o + 6) - 1) | 0;
  };
  const c = cockpit;
  for (let i = 0; i < 5; i++) rect(c.dat000955e8[i]!, i * 8);
  for (let i = 0; i < 15; i++) rect(c.dat000968e0[i]!, 40 + i * 8);
  // puVar4 is left on the fifteenth record; its shorts 4 and 5 follow it
  c.dat0009572c[0] = i16(s(160));
  c.dat0009572c[1] = i16(s(162));
  // id -1 after the load means a loose file, which the original frees; a
  // cached resource is unlocked - neither has anything to do in the port
  return 1;
}

/**
 * The HUDF handler: loads an HDI layout (TABL 4 resolves a name; '.hdi' is
 * the loose-file extension) into the HUD tables. Returns 1, or 0 when the
 * resource is missing.
 *
 * @mw2 res_load_hdi 0x0004be00
 * @fidelity exact
 * @divergence the 'Couldn't load' line appended to symlog.txt is not written
 */
export function resLoadHdi(ref: StreamRef): number {
  const { data } = loadResourceRef(ref, 'HUD', '.hdi', 4);
  if (!data) {
    divergence(`res_load_hdi: couldn't load ${ref.name} (symlog.txt not written)`);
    return 0;
  }
  if (data.length < 0x124) {
    divergence('res_load_hdi: HUD shorter than 292 bytes; the original reads past it');
    return 0;
  }
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const n = (o: number): number => dv.getInt32(o, true);
  const c = cockpit;
  for (let i = 0; i < 10; i++) c.dat0009623c[i] = n(i * 4);
  for (let i = 0; i < 3; i++) c.dat000fe0e8[i] = n(0x28 + i * 4);
  for (let r = 0; r < 15; r++) {
    const o = 0x34 + r * 16;
    let left = n(o);
    let top = n(o + 4);
    let right = n(o + 8);
    let bottom = n(o + 12);
    if (left < 0 || left > 100 || top < 0 || top > 100 || right < 0 || right > 100 || bottom < 0 || bottom > 100) {
      left = top = right = bottom = 0;
    }
    const w = c.dat0009667c[r]!;
    w.left = left;
    w.top = top;
    w.right = right;
    w.bottom = bottom;
  }
  return 1;
}
