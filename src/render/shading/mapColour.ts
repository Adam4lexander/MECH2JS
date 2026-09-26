/**
 * The overhead map's colours: map_polygon_colour, its polygonDrawHook, which
 * colours a polygon by what owns it rather than by light, and the per-vertex
 * shade map_fill_polygon gives the height-shaded ones.
 *
 * Both read the current radar mode's record: its colour table (+0x74, 14 10 6
 * 15 11 245 2 3 249 255 240 1 2 0 in RADAR's map mode) and its range (+0x18,
 * the camera's altitude).
 */
import type { MeshPolygon } from '../../generated/classes.gen.ts';
import { radar, mapHeightShade } from '../../sim/cockpit/radar.ts';
import { mechAllegiance } from '../../sim/groups/groups.ts';
import { gamethingAllegiance } from '../../sim/things/gameThingDamage.ts';
import { renderOptions } from '../../sim/display/renderState.ts';

/**
 * A polygon's colour word on the map (code = the polygon's code): by the
 * owner's class - a mech t[mech_allegiance], a gamething t[3 +
 * gamething_allegiance], class 0x400 t[6], each with 0xf0 ORed in under
 * polygonRampOverride, mode 0 (map_fill_polygon fills them black and
 * outlines them); class 0x800 mode 0x4000 in palette row (code & 0xf00) >> 4,
 * or t[10] for a sprite code. Otherwise by family: 0x40 t[7], 0x50 t[8],
 * 0x80 t[9] (with the override bits); 0x10, 0x20 and 0x60 keep their own
 * code; the rest mode 0x4000 as class 0x800, with t[10] | 0x4000 for a
 * sprite. 0 when the current mode has no record.
 *
 * @mw2 map_polygon_colour 0x00012520
 * @fidelity exact
 */
export function mapPolygonColour(poly: MeshPolygon, code: number): number {
  const d = radar.module?.modes[radar.mode] ?? null;
  if (!d) return 0;
  const t = d.colours;
  const base = renderOptions.polygonRampOverride !== 0 ? 0xf0 : 0;
  const owner = poly.owner!;
  const cls = owner.type & 0xf00;
  const index = owner.index & 0xffff;
  if (cls === 0x100) return base | t[mechAllegiance(index) & 0xff]!;
  if (cls === 0x200) return base | t[3 + (gamethingAllegiance(index) & 0xff)]!;
  if (cls === 0x400) return base | t[6]!;
  if (cls === 0x800) return ((code & 0x7000) === 0x3000 ? t[10]! : (code & 0xf00) >> 4) | 0x4000;
  switch (owner.type & 0xf0) {
    case 0x40:
      return base | t[7]!;
    case 0x50:
      return base | t[8]!;
    case 0x80:
      return base | t[9]!;
    case 0x10:
    case 0x20:
    case 0x60:
      return code;
  }
  if ((code & 0x7000) === 0x3000) return t[10]! | 0x4000;
  return ((code & 0xf00) >> 4) | 0x4000;
}

/**
 * map_fill_polygon's per-vertex palette index for a mode 0x4000 word: the
 * word's row (& 0xf0) with map_height_shade of the vertex's depth (4 x cm)
 * against the current mode's altitude. -1 when the mode has no record (the
 * original then draws nothing).
 *
 * @portOnly the vertex loop of map_fill_polygon (0x126f6..0x12716)
 */
export function mapVertexIndex(word: number, depth: number): number {
  const d = radar.module?.modes[radar.mode] ?? null;
  if (!d) return -1;
  return (mapHeightShade(d.range, depth) | (word & 0xf0)) & 0xff;
}
