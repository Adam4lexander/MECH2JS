/**
 * render_sky_and_ground for a headset: the same fill as passes/skyGround.ts
 * (skyColour above the horizon, groundColour below it, the horizon haze band
 * dithered from groundColour - 1 up to skyColour), but on a sphere about the
 * eye instead of a plane over the screen. skyGround's split is a plane in
 * the pixel coordinates of one screen; each eye of a headset has its own, so
 * here the split is the world direction's up component, per fragment.
 *
 * The band's height is pixels of the game's screen above the horizon line,
 * which at the screen's centre column is tan(elevation) * focal. So the band
 * ends at the elevation whose tangent is bandHeight / focal, focal the
 * game's (screenWidth / 2 / tanH). On a screen the band is measured straight
 * up the column and scaled by cos(roll); in a headset the horizon is simply
 * where it is.
 *
 * @portOnly
 */
import * as THREE from 'three';
import type { IndexedUniforms } from '../materials/indexedMaterial.ts';
import type { SkyGroundState } from '../passes/skyGround.ts';
import { SKY_DETAIL_GLSL, type SkyChoice } from '../enhance/skyDetail.ts';

const vertexShader = /* glsl */ `
out vec3 vDir;
void main() {
  vDir = position;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const fragmentShader = /* glsl */ `
precision highp float;
precision highp int;
uniform sampler2D uPalette;
uniform float uBandTan;    // tan of the band's top elevation; 0: no band
uniform int uSky;
uniform int uGround;
uniform int uSkyOn;
uniform int uGroundOn;
in vec3 vDir;
out vec4 outColor;
${SKY_DETAIL_GLSL}
void main() {
  vec3 d = normalize(vDir);
  float starR = skyStarRadius(d);
  bool inBand = false;
  bool below = d.y < 0.0;
  if ((below && uGroundOn == 0) || (!below && uSkyOn == 0)) discard;
  int idx = below ? uGround : uSky;
  if (!below && uBandTan > 0.0) {
    float tanE = d.y / max(length(d.xz), 1e-6);
    inBand = tanE <= uBandTan;
    if (tanE <= uBandTan) {
      float t = tanE / uBandTan;   // 0 on the horizon, 1 at the band's top
      int v = int(floor((float((uGround - 1) << 16) + t * float((uSky - (uGround - 1)) << 16)) + 0.5));
      ivec2 px = ivec2(gl_FragCoord.xy);
      bool upStep = ((px.x + px.y) & 1) == 1;
      idx = (v + 0x8000 + (upStep ? 0x7fff : -0x8000)) >> 16;
    }
  }
  if (!below && !inBand && uSkyEnh != 0) idx = skyDetail(d, uSky, ivec2(gl_FragCoord.xy), starR);
  outColor = vec4(texelFetch(uPalette, ivec2(idx & 255, 0), 0).rgb, 1.0);
}
`;

export class XrSky {
  readonly mesh: THREE.Mesh;
  private readonly u = {
    uPalette: { value: null as unknown as THREE.DataTexture },
    uBandTan: { value: 0 },
    uSky: { value: 0 },
    uGround: { value: 0 },
    uSkyOn: { value: 1 },
    uGroundOn: { value: 1 },
    uSkyEnh: { value: 0 },
    uSkyTop: { value: 0 },
    uStar: { value: -1 },
  };

  constructor(indexed: IndexedUniforms) {
    this.u.uPalette = indexed.uPalette;
    const mat = new THREE.ShaderMaterial({ glslVersion: THREE.GLSL3, uniforms: this.u, vertexShader, fragmentShader, depthTest: false, depthWrite: false, side: THREE.BackSide });
    this.mesh = new THREE.Mesh(new THREE.SphereGeometry(1000, 48, 24), mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = -1000;
    this.mesh.visible = false;
  }

  /** Centres the sphere on `eye` (world position); `tanH` is the game's half field of view. */
  update(eye: THREE.Vector3, tanH: number, s: SkyGroundState): void {
    this.mesh.position.copy(eye);
    this.mesh.updateMatrixWorld();
    const focal = s.screenWidth / 2 / tanH;
    this.u.uBandTan.value = s.bandOn ? Math.max(0, s.bandHeight / focal) : 0;
    this.u.uSky.value = s.sky;
    this.u.uGround.value = s.ground;
    this.u.uSkyOn.value = s.skyOn ? 1 : 0;
    this.u.uGroundOn.value = s.groundOn ? 1 : 0;
  }

  /** The sky enhancement (render/enhance/skyDetail.ts): off with null. */
  setDetail(choice: SkyChoice | null): void {
    this.u.uSkyEnh.value = choice ? 1 : 0;
    if (choice) {
      this.u.uSkyTop.value = choice.top;
      this.u.uStar.value = choice.star;
    }
  }
}
