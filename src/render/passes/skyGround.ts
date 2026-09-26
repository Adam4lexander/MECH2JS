/**
 * The background, render_sky_and_ground (0x3c000): the viewport filled with
 * skyColour above the horizon and groundColour below it before the world is
 * drawn, each only when skyEnabled / groundEnabled, then the horizon haze
 * band over the sky.
 *
 * THE SPLIT. The original classifies the viewport corners with
 * viewer_point_above_horizon - the world-up component of the view ray
 * through a pixel, (x - cx) * rot[1] / focal + (cy - y) * rot[4] / focalY +
 * rot[7] >> 16, against 0 - and fills the sixteen polygon cases between
 * horizon_y_at_x / horizon_x_at_y crossings. That up component is linear in
 * the pixel coordinates, so the port evaluates the same plane per pixel:
 * the identical split, without the case table.
 *
 * THE BAND. While horizonBandEnabled (PLNT [19] == 0) and shadedFillEnabled
 * (0x97024), a quad from the horizon line up to band pixels above it, at the
 * two viewport edges, filled by the per-vertex-shade filler with the palette
 * index running from (groundColour - 1) on the line to skyColour at the top.
 * band = horizonBandHeight * cos(roll) (transform_point of (0, h, 0) by the
 * roll rows), horizonBandHeight having been rescaled once by main
 * (layout_rescale_all, sim/display/rescale.ts) from 320-wide design pixels
 * to the game's screen. The filler's pixels are the integer
 * part of the index plus 0x8000 and then +0x7fff or -0x8000 on alternate
 * pixels, swapped each scanline (see materials/indexedMaterial.ts, mode
 * 0x4000).
 *
 * DIVERGENCES: the band height is taken from the game's screen to the render
 * target's width (the same when both are 640); the dither's phase follows the
 * screen.
 *
 * @portOnly the result of render_sky_and_ground, computed per pixel
 */
import * as THREE from 'three';
import type { IndexedUniforms } from '../materials/indexedMaterial.ts';

const vertexShader = /* glsl */ `
void main() {
  gl_Position = vec4(position.xy, 1.0, 1.0);
}
`;

const fragmentShader = /* glsl */ `
precision highp float;
precision highp int;
uniform sampler2D uPalette;
uniform vec3 uUpPlane;     // world-up component of the view ray: a * x + b * y + c over gl_FragCoord (y up)
uniform float uBand;       // band height in pixels; 0: no band
uniform int uSky;
uniform int uGround;
uniform int uSkyOn;
uniform int uGroundOn;
out vec4 outColor;
void main() {
  float up = dot(uUpPlane, vec3(gl_FragCoord.xy, 1.0));
  bool below = up < 0.0;
  if ((below && uGroundOn == 0) || (!below && uSkyOn == 0)) discard;
  int idx = below ? uGround : uSky;
  if (!below && uBand > 0.0) {
    // pixels above the horizon, straight up this column
    float dist = up / uUpPlane.y;
    if (dist <= uBand) {
      float t = dist / uBand;   // 0 on the line, 1 at the top edge
      int v = int(floor((float((uGround - 1) << 16) + t * float((uSky - (uGround - 1)) << 16)) + 0.5));
      ivec2 px = ivec2(gl_FragCoord.xy);
      bool upStep = ((px.x + px.y) & 1) == 1;
      idx = (v + 0x8000 + (upStep ? 0x7fff : -0x8000)) >> 16;
    }
  }
  outColor = vec4(texelFetch(uPalette, ivec2(idx & 255, 0), 0).rgb, 1.0);
}
`;

export interface SkyGroundState {
  sky: number;
  ground: number;
  skyOn: boolean;
  groundOn: boolean;
  /** horizonBandHeight: game-screen pixels, after layout_rescale_all */
  bandHeight: number;
  /** the game's screen width (defaultCanvas xMax + 1) */
  screenWidth: number;
  /** horizonBandEnabled && shadedFillEnabled */
  bandOn: boolean;
}

const e = new THREE.Euler();

export class SkyGround {
  readonly mesh: THREE.Mesh;
  private readonly u = {
    uPalette: { value: null as unknown as THREE.DataTexture },
    uUpPlane: { value: new THREE.Vector3() },
    uBand: { value: 0 },
    uSky: { value: 0 },
    uGround: { value: 0 },
    uSkyOn: { value: 1 },
    uGroundOn: { value: 1 },
  };

  constructor(indexed: IndexedUniforms) {
    this.u.uPalette = indexed.uPalette;
    const geo = new THREE.PlaneGeometry(2, 2);
    const mat = new THREE.ShaderMaterial({ glslVersion: THREE.GLSL3, uniforms: this.u, vertexShader, fragmentShader, depthTest: false, depthWrite: false });
    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = -1000;
  }

  /** `width` and `height` are the render target's, in pixels. */
  update(camera: THREE.PerspectiveCamera, width: number, height: number, s: SkyGroundState): void {
    camera.updateMatrixWorld();
    const m = camera.matrixWorld.elements;
    // the ray through NDC (nx, ny) is R (nx tanX, ny tanY, -1); its world y is m1 nx tanX + m5 ny tanY - m9
    const tanY = Math.tan((camera.fov * Math.PI) / 360);
    const tanX = tanY * camera.aspect;
    const a = (m[1]! * tanX * 2) / width;
    const b = (m[5]! * tanY * 2) / height;
    const c = -m[1]! * tanX - m[5]! * tanY - m[9]!;
    this.u.uUpPlane.value.set(a, b, c);
    // screen pixels to render-target pixels, then transform_point's cos(roll)
    const scaled = (s.bandHeight * width) / s.screenWidth;
    e.setFromQuaternion(camera.quaternion, 'YXZ');
    this.u.uBand.value = s.bandOn ? Math.max(0, scaled * Math.cos(e.z)) : 0;
    this.u.uSky.value = s.sky;
    this.u.uGround.value = s.ground;
    this.u.uSkyOn.value = s.skyOn ? 1 : 0;
    this.u.uGroundOn.value = s.groundOn ? 1 : 0;
  }
}
