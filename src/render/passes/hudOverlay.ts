/**
 * The 2D the game draws into its VFX window - the HUD, the cockpit text, the
 * radar - painted over the 3D view through the game's palette.
 *
 * The original draws everything into one indexed frame buffer: the frame's
 * render hook paints the 3D viewport, then the player's hook 4 draws the HUD
 * on top, and the page flip shows the result. The port's 3D is drawn by the
 * GPU, so the window's pixels travel as a texture of (index, drawn) pairs and
 * this pass lays the drawn ones over the rendered frame, each window pixel
 * covering its share of the render target (nearest, no filtering).
 *
 * In a headset a quad glued over each eye cannot be read, so worldMesh is the
 * same window on a plane in the world (the VR rig places it, render/xr/xrRig.ts
 * placeHud): a pilot-tuned share of the game's field of view wide, just ahead
 * of the cockpit, centred on the torso's aim (render/xr/xrSettings.ts).
 * The HUD's layers that mark the world - the reticle and the target marker
 * (engine/vfx/vfx.ts HUD_LAYER) - get planes of their own, which the rig
 * places across the game's whole field of view far out, so they register
 * with what they mark (the pixel's layer rides in the texture's second
 * channel as 255 - layer).
 *
 * @portOnly
 */
import * as THREE from 'three';
import { HUD_LAYER, type VfxWindow } from '../../engine/vfx/vfx.ts';
import type { IndexedUniforms } from '../materials/indexedMaterial.ts';

const vertexShader = /* glsl */ `
void main() { gl_Position = vec4(position.xy, 0.0, 1.0); }
`;

const fragmentShader = /* glsl */ `
precision highp float;
precision highp int;
uniform sampler2D uPalette;
uniform sampler2D uWindow;   // RG8: index, drawn
uniform vec2 uWindowSize;    // window width, height
uniform vec2 uTarget;        // render target width, height
uniform vec4 uExclude[8];    // window rectangles (x, y, w, h) shown elsewhere (the cockpit's screens)
uniform int uExcludeN;
out vec4 fragColour;
void main() {
  // window row 0 is the top of the screen
  ivec2 p = ivec2(floor(gl_FragCoord.x * uWindowSize.x / uTarget.x), int(uWindowSize.y) - 1 - int(floor(gl_FragCoord.y * uWindowSize.y / uTarget.y)));
  for (int k = 0; k < 8; k++) {
    if (k >= uExcludeN) break;
    vec4 r = uExclude[k];
    if (float(p.x) >= r.x && float(p.y) >= r.y && float(p.x) < r.x + r.z && float(p.y) < r.y + r.w) discard;
  }
  vec2 t = texelFetch(uWindow, p, 0).rg;
  if (t.g < 0.5) discard;
  int i = int(t.r * 255.0 + 0.5);
  fragColour = vec4(texelFetch(uPalette, ivec2(i, 0), 0).rgb, 1.0);
}
`;

const worldVertexShader = /* glsl */ `
out vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const worldFragmentShader = /* glsl */ `
precision highp float;
precision highp int;
uniform sampler2D uPalette;
uniform sampler2D uWindow;
uniform vec2 uWindowSize;
uniform int uLayers;   // bit n: draw the pixels of HUD layer n
uniform vec4 uExclude[8];   // window rectangles (x, y, w, h) shown elsewhere (the VR cockpit's screens)
uniform int uExcludeN;
in vec2 vUv;
out vec4 fragColour;
void main() {
  ivec2 size = ivec2(uWindowSize);
  ivec2 p = clamp(ivec2(floor(vUv.x * uWindowSize.x), size.y - 1 - int(floor(vUv.y * uWindowSize.y))), ivec2(0), size - 1);
  for (int k = 0; k < 8; k++) {
    if (k >= uExcludeN) break;
    vec4 r = uExclude[k];
    if (float(p.x) >= r.x && float(p.y) >= r.y && float(p.x) < r.x + r.z && float(p.y) < r.y + r.w) discard;
  }
  vec2 t = texelFetch(uWindow, p, 0).rg;
  if (t.g < 0.5) discard;
  int layer = 255 - int(t.g * 255.0 + 0.5);
  if (((uLayers >> layer) & 1) == 0) discard;
  int i = int(t.r * 255.0 + 0.5);
  fragColour = vec4(texelFetch(uPalette, ivec2(i, 0), 0).rgb, 1.0);
}
`;

/** A material's own rectangles to leave out (setExcluded), none at first. */
function excludeUniforms(): { uExclude: { value: THREE.Vector4[] }; uExcludeN: { value: number } } {
  return { uExclude: { value: Array.from({ length: 8 }, () => new THREE.Vector4()) }, uExcludeN: { value: 0 } };
}

export class HudOverlay {
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private tex: THREE.DataTexture | null = null;
  private data = new Uint8Array(0);
  private readonly u = {
    uPalette: { value: null as THREE.DataTexture | null },
    uWindow: { value: null as THREE.DataTexture | null },
    uWindowSize: { value: new THREE.Vector2(1, 1) },
    uTarget: { value: new THREE.Vector2(1, 1) },
  };

  constructor(shared: IndexedUniforms) {
    this.u.uPalette.value = shared.uPalette.value;
    const mat = new THREE.ShaderMaterial({ glslVersion: THREE.GLSL3, uniforms: { ...this.u, ...excludeUniforms() }, vertexShader, fragmentShader, depthTest: false, depthWrite: false, transparent: false });
    this.screenMaterial = mat;
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), mat);
    mesh.frustumCulled = false;
    this.scene.add(mesh);
    this.worldMesh = this.worldPlane(1 << HUD_LAYER.rest);
    this.reticleMesh = this.worldPlane(1 << HUD_LAYER.reticle);
    this.markerMesh = this.worldPlane(1 << HUD_LAYER.targetMarker);
  }

  /** the window on a unit plane facing +z, for a headset (placed by the VR rig): HUD_LAYER.rest, and any layer setWorldLayers adds */
  readonly worldMesh: THREE.Mesh;
  /** the reticle's layer alone, and the target marker's, on planes of their own */
  readonly reticleMesh: THREE.Mesh;
  readonly markerMesh: THREE.Mesh;

  /** the centre of the reticle layer's pixels in window pixels (x, y down), or null when it drew none */
  get reticleCentre(): THREE.Vector2 | null {
    return this.reticleCount > 0 ? this.reticleAt : null;
  }
  private readonly reticleAt = new THREE.Vector2();
  private reticleCount = 0;

  /** Which HUD layers worldMesh draws (bit n: layer n) - the ones not drawn apart this frame. */
  setWorldLayers(mask: number): void {
    (this.worldMesh.material as THREE.ShaderMaterial).uniforms.uLayers!.value = mask;
  }

  /** Rectangles of the window the HUD leaves out, on the screen and on worldMesh (up to eight: they are on the cockpit's screens). */
  setExcluded(rects: ReadonlyArray<{ x: number; y: number; w: number; h: number }>): void {
    for (const m of [this.worldMesh.material as THREE.ShaderMaterial, this.screenMaterial]) {
      const u = m.uniforms;
      const arr = u.uExclude!.value as THREE.Vector4[];
      const n = Math.min(8, rects.length);
      for (let i = 0; i < n; i++) arr[i]!.set(rects[i]!.x, rects[i]!.y, rects[i]!.w, rects[i]!.h);
      u.uExcludeN!.value = n;
    }
  }
  /** the flat pass's material (screen space) */
  private readonly screenMaterial: THREE.ShaderMaterial;

  /** The palette and window-texture uniform holders, for other surfaces that show the window (the VR cockpit's screens). */
  get windowUniforms(): { uPalette: { value: THREE.DataTexture | null }; uWindow: { value: THREE.DataTexture | null }; uWindowSize: { value: THREE.Vector2 } } {
    return this.u;
  }

  private worldPlane(layers: number): THREE.Mesh {
    const uniforms = { ...this.u, uLayers: { value: layers }, ...excludeUniforms() };
    const mat = new THREE.ShaderMaterial({ glslVersion: THREE.GLSL3, uniforms, vertexShader: worldVertexShader, fragmentShader: worldFragmentShader, depthTest: false, depthWrite: false });
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), mat);
    mesh.frustumCulled = false;
    return mesh;
  }

  /** the window's height / width, once it has pixels */
  get aspect(): number {
    const s = this.u.uWindowSize.value;
    return s.x > 0 ? s.y / s.x : 0.75;
  }

  /** Uploads the window's pixels; false when it has none yet (before video_init). */
  update(win: VfxWindow, targetWidth: number, targetHeight: number): boolean {
    const w = win.xMax + 1;
    const h = win.yMax + 1;
    if (w <= 0 || h <= 0 || win.buffer.length < w * h) return false;
    if (!this.tex || this.tex.image.width !== w || this.tex.image.height !== h) {
      this.tex?.dispose();
      this.data = new Uint8Array(w * h * 2);
      this.tex = new THREE.DataTexture(this.data, w, h, THREE.RGFormat, THREE.UnsignedByteType);
      this.tex.magFilter = THREE.NearestFilter;
      this.tex.minFilter = THREE.NearestFilter;
      this.u.uWindow.value = this.tex;
      this.u.uWindowSize.value.set(w, h);
    }
    const d = this.data;
    const b = win.buffer;
    const m = win.drawn;
    const l = win.layer;
    const reticle = HUD_LAYER.reticle;
    let rx = 0;
    let ry = 0;
    let rn = 0;
    // drawn: 255 - its layer (every drawn pixel stays >= 0.5 for the screen pass); not drawn: 0
    for (let i = 0, n = w * h; i < n; i++) {
      d[i * 2] = b[i]!;
      d[i * 2 + 1] = m[i] ? 255 - l[i]! : 0;
      if (m[i] && l[i] === reticle) {
        rx += i % w;
        ry += (i / w) | 0;
        rn++;
      }
    }
    this.reticleCount = rn;
    if (rn > 0) this.reticleAt.set(rx / rn + 0.5, ry / rn + 0.5);
    this.tex.needsUpdate = true;
    this.u.uTarget.value.set(targetWidth, targetHeight);
    return true;
  }

  dispose(): void {
    this.tex?.dispose();
  }
}
