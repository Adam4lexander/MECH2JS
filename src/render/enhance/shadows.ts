/**
 * The shadow enhancement: shadows from the mission's own light, in the
 * palette.
 *
 * THE LIGHT is the one the game shades with (the viewer's lightPos, latched
 * per pass into renderView.light): a direction when lightDirectional is set,
 * else a point, taken as its direction to the eye. Explosion lights (which
 * borrow the scene light for a moment) are not followed; a light below about
 * 8 degrees casts nothing.
 *
 * THE MAP is one orthographic depth render along the light, SIZE metres
 * square round the eye, snapped to its own texels so the edges do not crawl.
 * Casters are the meshes SceneRenderer puts on SHADOW_LAYER - everything but
 * the terrain, the backdrop, the flames and smoke, and the always-behind
 * decals (isShadowCaster) - and every face of them, including the ones the
 * clipper dropped as facing away from the camera (they may face the light).
 *
 * RECEIVING (materials/indexedMaterial.ts, uShadowOn): a fragment whose face
 * turns towards the light and lies behind a caster takes its index's shadow
 * index - the palette's nearest colour to its own at SHADOW_LEVEL of the
 * brightness, never brighter: how a LUMA table is made (shadowTable, from
 * the palette on screen, so a day, dusk or infrared palette makes its own).
 * The game's own LUMA tables would do, but they leave whole ramps -
 * AMY_SCN1's ground among them - mapped to themselves at every row. (A first
 * cut stayed within the colour's row of 16; a row can hold other hues -
 * PLUMSCN1's ground row holds the lakes' teal - so it now searches the
 * palette.) The edge is dithered: of four
 * map samples round it, the count in shadow against a 2x2 ordered
 * threshold, the checkerboard's cousin.
 *
 * @portOnly
 */
import * as THREE from 'three';
import type { WorldObject } from '../../generated/classes.gen.ts';
import type { LightLatch } from '../shading/polygonColour.ts';
import type { IndexedUniforms } from '../materials/indexedMaterial.ts';
import { toThree } from '../bridge/space.ts';

/** the three.js layer shadow casters are on */
export const SHADOW_LAYER = 5;
/** the map's side, metres, and texels */
const SIZE = 320;
const RES = 2048;
/** the light's distance back from the eye, and the depth range (metres) */
const BACK = 500;
const DEPTH = 1000;

/** how bright a shadowed colour is, of the lit one */
export const SHADOW_LEVEL = 0.55;

/**
 * Each index's shadow index for a palette (6-bit DAC values, 256 x 3): the
 * palette colour nearest (in RGB) to its own scaled by SHADOW_LEVEL, among
 * those no brighter than it; never 0xff, the transparent texel.
 */
export function shadowTable(rgb: Uint8Array, level = SHADOW_LEVEL): Uint8Array {
  const lum = (i: number) => 0.3 * rgb[i * 3]! + 0.59 * rgb[i * 3 + 1]! + 0.11 * rgb[i * 3 + 2]!;
  const out = new Uint8Array(256);
  for (let i = 0; i < 256; i++) {
    const r = rgb[i * 3]! * level;
    const g = rgb[i * 3 + 1]! * level;
    const b = rgb[i * 3 + 2]! * level;
    let best = i;
    let bestErr = Infinity;
    for (let j = 0; j < 255; j++) {
      if (lum(j) > lum(i)) continue;
      const dr = rgb[j * 3]! - r;
      const dg = rgb[j * 3 + 1]! - g;
      const db = rgb[j * 3 + 2]! - b;
      const err = 0.3 * dr * dr + 0.59 * dg * dg + 0.11 * db * db;
      if (err < bestErr) {
        bestErr = err;
        best = j;
      }
    }
    out[i] = i === 0xff ? 0xff : best;
  }
  return out;
}

/** Whether an object casts a shadow: not terrain (0x800), backdrop (0x90), cockpit heads (0xa0), flames and smoke (0x10, 0x60), or always-behind (flags bit 0). */
export function isShadowCaster(obj: WorldObject): boolean {
  if ((obj.type & 0x800) !== 0 || (obj.flags & 1) !== 0) return false;
  const family = obj.type & 0xf0;
  return family !== 0x10 && family !== 0x60 && family !== 0x90 && family !== 0xa0;
}

const depthVertex = /* glsl */ `
in float aDraw;
flat out int vDraw;
void main() {
  vDraw = aDraw < 0.0 ? -1 : int(aDraw + 0.5);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const depthFragment = /* glsl */ `
precision highp float;
precision highp int;
flat in int vDraw;
out vec4 outColor;
void main() {
  // sprites and outlines cast nothing; faces the clipper dropped still do
  int mode = vDraw & 0x7000;
  if (vDraw >= 0 && (mode == 0x3000 || mode == 0x2000)) discard;
  outColor = vec4(1.0);
}
`;

/** The direction to the light (three.js, unit) for the latch and an eye (world cm), or null when it is too low to cast. */
export function lightDirection(L: LightLatch, eyeCm: [number, number, number]): THREE.Vector3 | null {
  const [x, y, z] = L.lightDirectional !== 0 ? [L.lightX, L.lightY, L.lightZ] : [L.lightX - eyeCm[0], L.lightY - eyeCm[1], L.lightZ - eyeCm[2]];
  const d = new THREE.Vector3(...toThree(x, y, z));
  if (d.lengthSq() === 0) return null;
  d.normalize();
  return d.y > 0.14 ? d : null;
}

export class Shadows {
  readonly target: THREE.WebGLRenderTarget;
  readonly camera = new THREE.OrthographicCamera(-SIZE / 2, SIZE / 2, SIZE / 2, -SIZE / 2, 0, DEPTH);
  private readonly depthMaterial: THREE.ShaderMaterial;
  private readonly bias = new THREE.Matrix4().set(0.5, 0, 0, 0.5, 0, 0.5, 0, 0.5, 0, 0, 0.5, 0.5, 0, 0, 0, 1);

  constructor() {
    this.target = new THREE.WebGLRenderTarget(RES, RES, { depthBuffer: true, depthTexture: new THREE.DepthTexture(RES, RES, THREE.UnsignedIntType) });
    this.target.depthTexture!.minFilter = THREE.NearestFilter;
    this.target.depthTexture!.magFilter = THREE.NearestFilter;
    this.depthMaterial = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader: depthVertex,
      fragmentShader: depthFragment,
      side: THREE.DoubleSide,
      colorWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: 2,
      polygonOffsetUnits: 2,
    });
    this.camera.layers.set(SHADOW_LAYER);
  }

  /**
   * Renders the casters in `scene` along `toLight` round `eye` (three.js
   * metres) and points the uniforms at the map; off when `toLight` is null.
   */
  render(renderer: THREE.WebGLRenderer, scene: THREE.Scene, eye: THREE.Vector3, toLight: THREE.Vector3 | null, u: IndexedUniforms): void {
    if (!toLight) {
      u.uShadowOn.value = 0;
      return;
    }
    const cam = this.camera;
    // light space: snap the eye to a texel so the map does not swim as it follows
    const up = Math.abs(toLight.y) > 0.99 ? new THREE.Vector3(0, 0, 1) : new THREE.Vector3(0, 1, 0);
    cam.position.set(0, 0, 0);
    cam.up.copy(up);
    cam.lookAt(toLight.clone().negate());
    cam.updateMatrixWorld(true);
    const inv = cam.matrixWorldInverse;
    const ls = eye.clone().applyMatrix4(inv);
    const texel = SIZE / RES;
    ls.x = Math.round(ls.x / texel) * texel;
    ls.y = Math.round(ls.y / texel) * texel;
    const centre = ls.applyMatrix4(cam.matrixWorld);
    cam.position.copy(centre).addScaledVector(toLight, BACK);
    cam.updateMatrixWorld(true);
    cam.updateProjectionMatrix();

    const prevTarget = renderer.getRenderTarget();
    const prevOverride = scene.overrideMaterial;
    const prevAuto = renderer.autoClear;
    const xr = renderer.xr.enabled;
    renderer.xr.enabled = false;
    scene.overrideMaterial = this.depthMaterial;
    renderer.setRenderTarget(this.target);
    renderer.autoClear = false;
    renderer.clear(false, true, false);
    renderer.render(scene, cam);
    renderer.setRenderTarget(prevTarget);
    scene.overrideMaterial = prevOverride;
    renderer.autoClear = prevAuto;
    renderer.xr.enabled = xr;

    u.uShadowOn.value = 1;
    u.uShadowMap.value = this.target.depthTexture;
    (u.uShadowMatrix.value as THREE.Matrix4).multiplyMatrices(this.bias, cam.projectionMatrix).multiply(cam.matrixWorldInverse);
    (u.uShadowDir.value as THREE.Vector3).copy(toLight);
    u.uShadowTexel.value = 1 / RES;
  }

  /** Rebuilds the shadow indices from the palette on screen (6-bit DAC values). */
  setPalette(rgb: Uint8Array, u: IndexedUniforms): void {
    const t = u.uShadowTable.value;
    (t.image.data as Uint8Array).set(shadowTable(rgb));
    t.needsUpdate = true;
  }

  dispose(): void {
    this.target.dispose();
    this.depthMaterial.dispose();
  }
}
