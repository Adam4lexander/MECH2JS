/**
 * What colour a polygon is drawn in: the original's polygonDrawHook
 * (polygon_resolve_colour) with its two helpers. These run on the CPU, per
 * polygon per frame, exactly as in MW2.EXE; the GPU only does lookups with
 * the result.
 *
 * The polygon code (MeshPolygon.code, after poly_resolve_code):
 *   mode = code & 0x7000
 *   0x0000 flat unlit       palette index (code >> 4) & 0xff
 *   0x1000 flat lit         ramp = bits 8-11, base brightness = bits 0-7
 *                           -> palette index ramp * 16 + shade
 *   0x2000 outline          line loop in palette index (code >> 4) & 0xff
 *   0x3000 (unestablished draw; returned unchanged)
 *   0x4000 lit like 0x1000; the shade scales each vertex's own palette
 *                           index (MeshVertex.texU), filled per vertex
 *                           (render/materials/indexedMaterial.ts)
 *   0x5000/0x6000/0x7000    textured: bitmap3d slot = bits 0-7, base 0xff
 *                           -> mode | shade << 8 | slot
 *
 * The render "latch" (viewer_latch_globals) copies the viewer's ambient
 * light, directional flag and light position; lightDimDistance and
 * damageShadeRaises are globals the mission sets.
 */
import type { MeshPolygon, MeshVertex, Viewer } from '../../generated/classes.gen.ts';
import { LABEL } from '../../generated/labels.gen.ts';
import { cdiv } from '../../core/int/cint.ts';
import { registerGlobals } from '../../engine/globals.ts';
import { imageI32 } from '../../engine/image.ts';
import { sqrtTable } from '../../engine/scene/worldObject.ts';
import { lighting } from '../../sim/world/environment.ts';

export const renderOptions = registerGlobals(
  'renderOptions',
  {
    wireframeMode: 0,
    wireframeColourScheme: 0,
    polygonRampOverride: 0,
    textureAffine: 0,
    /** 0x97024: the per-vertex-shade filler for mode 0x4000 (else flat); 1 in the image, and every write found sets 1 */
    shadedFillEnabled: 1,
    /**
     * 0x97030, unlabelled: bit 0 gates the mode 0x3000 sprites
     * (render_asm_sub_03b950); vfx_video sets bit 3 and the HUD code clears
     * bit 2, which are not read here. 1 in the image.
     */
    dat00097030: 1,
    /** bits 0x100 mechs, 0x200 gamethings, 0x400 ?, 0x800 terrain: textures off for that class */
    textureOffTypeMask: 0,
  },
  () => {
    const r = renderOptions;
    r.wireframeMode = imageI32(LABEL.wireframeMode, 0);
    r.wireframeColourScheme = imageI32(LABEL.wireframeColourScheme, 0);
    r.polygonRampOverride = imageI32(LABEL.polygonRampOverride, 0);
    r.textureAffine = imageI32(LABEL.textureAffine, 0);
    r.shadedFillEnabled = imageI32(LABEL.shadedFillEnabled, 1);
    r.dat00097030 = imageI32(0x97030, 1);
    r.textureOffTypeMask = imageI32(LABEL.textureOffTypeMask, 0);
  },
);

/** The values viewer_latch_globals copies out for the shading code. */
export interface LightLatch {
  ambientLight: number; // 0x14fcbc
  lightDirectional: number; // 0x14fcb8
  lightX: number; // 0x14fec0
  lightY: number; // 0x14fec4
  lightZ: number; // 0x14feb8
}

export function latchLight(v: Viewer): LightLatch {
  return { ambientLight: v.ambientLight, lightDirectional: v.lightDirectional, lightX: v.lightPos[0]!, lightY: v.lightPos[1]!, lightZ: v.lightPos[2]! };
}

/**
 * Lambert term for one polygon from its FIRST vertex: the dot of its world
 * normal with the vector to the light (lightPos itself when directional),
 * divided by that vector's length through sqrtTable after both are shifted so
 * the vector's largest component fits a byte. About 0x7f when facing the
 * light full on; 0x7f outright when the vector is zero. Read from the
 * disassembly 0x3e086..0x3e1da.
 *
 * @mw2 poly_light_intensity 0x0003e086
 * @fidelity exact
 */
export function polyLightIntensity(poly: MeshPolygon, vertices: MeshVertex[], L: LightLatch): number {
  const v = vertices[poly.indices[0]!]!;
  let px = v.worldX, py = v.worldY, pz = v.worldZ;
  if (L.lightDirectional !== 0) px = py = pz = 0;
  const dx = (L.lightX - px) | 0;
  const dy = (L.lightY - py) | 0;
  const dz = (L.lightZ - pz) | 0;
  let ax = (dx < 0 ? -dx : dx) >>> 0;
  let ay = (dy < 0 ? -dy : dy) >>> 0;
  let az = (dz < 0 ? -dz : dz) >>> 0;
  const or = (ax | ay | az) >>> 0;
  if (or === 0) return 0x7f;
  let dot = (BigInt(dx) * BigInt(poly.normalX) + BigInt(dy) * BigInt(poly.normalY) + BigInt(dz) * BigInt(poly.normalZ)) >> 16n;
  const shift = 31 - Math.clz32(or) - 7;
  if (shift > 0) {
    ax >>>= shift;
    ay >>>= shift;
    az >>>= shift;
    dot >>= BigInt(shift);
  } else if (shift < 0) {
    ax = (ax << -shift) >>> 0;
    ay = (ay << -shift) >>> 0;
    az = (az << -shift) >>> 0;
    dot = BigInt.asIntN(64, dot << BigInt(-shift));
  }
  const sum = (ax & 0xff) * (ax & 0xff) + (ay & 0xff) * (ay & 0xff) + (az & 0xff) * (az & 0xff);
  const len = (sqrtTable[(sum >>> 7) >>> 1]! << 16) >> 16;
  const q = dot / BigInt(len);
  return (Number(BigInt.asIntN(16, q)) << 16) >> 16;
}

/**
 * 0..15 from intensity, base brightness and distance:
 * ((base >> 1) * (amb + intensity * (128 - amb) >> 7)) / 0x440, minus one
 * level per lightDimDistance of depth, clamped.
 *
 * @mw2 light_shade_level 0x00038ee0
 * @fidelity exact
 */
export function lightShadeLevel(intensity: number, base: number, distance: number, ambient: number): number {
  let lvl = cdiv(Math.imul(base >> 1, ((Math.imul(intensity, (0x80 - ambient) | 0) >> 7) + ambient) | 0), 0x440);
  const dim = lighting.lightDimDistance;
  if (dim !== 0) lvl = (lvl - (cdiv(distance << 4, dim) >> 4)) | 0;
  if (lvl < 1) return 0;
  if (lvl > 0xf) return 0xf;
  return lvl;
}

/**
 * Turns a polygon's code into the draw word: palette index, ramp + shade, or
 * mode + shade + bitmap slot (see the module note). `depth` is the polygon's
 * view depth (4 x cm), used only by the distance dimming.
 *
 * @mw2 polygon_resolve_colour 0x00038ae0
 * @fidelity exact
 */
export function polygonResolveColour(poly: MeshPolygon, vertices: MeshVertex[], code: number, depth: number, L: LightLatch): number {
  const opt = renderOptions;
  const owner = poly.owner!;
  const type = owner.type;
  let mode = code & 0x7000;
  let slot = 0;
  if (opt.wireframeMode !== 0) return wireframeColour(owner.objectClass, owner.flags, type, opt.wireframeColourScheme);
  let base: number;
  if (mode < 0x3000) {
    if (mode === 0) {
      if (opt.polygonRampOverride === 0) return ((code & 0xff) >> 4) | ((code & 0xf00) >> 4);
      return ((code & 0xff) >> 6) | 0xf0;
    }
    if (mode === 0x2000) return ((code & 0xff0) >> 4) | 0x2000;
    base = code & 0xff;
  } else if (mode === 0x3000) {
    if (opt.textureOffTypeMask === 0 || (type & opt.textureOffTypeMask) === 0) return code;
    base = code & 0xf0;
    mode = 0x1000;
  } else if (mode === 0x5000 || mode === 0x6000 || mode === 0x7000) {
    base = 0xff;
    if (opt.textureOffTypeMask === 0) slot = code & 0xff;
    else if ((opt.textureOffTypeMask & 0x100) === 0 || ((type & 0x100) === 0 && (type & 0xf0) !== 0x50)) {
      if ((opt.textureOffTypeMask & type) === 0) slot = code & 0xff;
      else {
        mode = 0x1000;
        base = 0xd0;
      }
    } else {
      mode = 0x1000;
      base = 0xa0;
    }
  } else {
    base = code & 0xff;
  }
  const intensity = polyLightIntensity(poly, vertices, L);
  let shade = lightShadeLevel(intensity, base, depth, L.ambientLight);
  if (((type & 0x100) !== 0 || (type & 0xf0) === 0x50) && (owner.flags & 0xff) >> 4 !== 0) {
    const d = (owner.flags & 0xff) >> 4;
    if (lighting.damageShadeRaises === 0) {
      const s = Math.imul(Math.imul(0x10 - d, 0x1000), shade) >>> 0;
      shade = ((s >>> 16) + ((s >>> 15) & 1)) & 0xf;
    } else {
      const up = 0xf - shade;
      const q = Math.trunc((up * 0x10000) / 0xf) | 0;
      const p = BigInt(d) * BigInt(q);
      shade = (shade + Number(BigInt.asIntN(32, p >> 16n)) + Number((p >> 15n) & 1n)) | 0;
    }
  }
  let ramp: number;
  if (mode === 0x7000 || mode === 0x5000 || mode === 0x6000) {
    shade <<= 8;
    ramp = 0;
  } else {
    if (opt.polygonRampOverride !== 0) return mode | slot | 0xf0 | shade;
    ramp = (code & 0xf00) >> 4;
  }
  return ramp | mode | slot | shade;
}

function wireframeColour(objectClass: number, flags: number, type: number, scheme: number): number {
  if (scheme === 1) {
    switch (objectClass) {
      case 0:
        return 0xd;
      case 1:
        return 3;
      case 2:
        return 6;
      case 3:
        return 2;
      case 5:
        return 8;
      case 6:
        return 7;
      case 7:
        return 0xf;
      default:
        return 0xff;
    }
  }
  if (scheme === 2) {
    switch (flags & 0x10f) {
      case 0:
        return 0xd;
      case 1:
        return 6;
      case 2:
        return 8;
      case 4:
        return 1;
      case 0x100:
        return 0xf;
      case 0x101:
        return 7;
      case 0x102:
        return 0xb;
      case 0x104:
        return 3;
      default:
        return 0xff;
    }
  }
  if (type & 0x200) return 7;
  if (type & 0x400) return 0xb;
  if (type & 0x100) {
    const d = (flags & 0xff) >> 4;
    if (d === 0) return 7;
    return d < 0xc ? 3 : 0xb;
  }
  return 8;
}
