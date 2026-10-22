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
 * The inset 3D views the game draws into the window mid-frame - the damage
 * display's rear view, the target display, the satellite map - are the
 * GPU's too: each is drawn into a texture of palette indices of its own
 * (passes/indexedView.ts) and marked on the window's pixels it covers
 * (engine/vfx/vfx.ts vfxWindowMarkInset). Every surface that shows the
 * window resolves a pixel through WINDOW_GLSL's windowPixel: the view's
 * index where it drew, the window's own pixel elsewhere. Nothing is read
 * back from the GPU.
 *
 * @portOnly
 */
import * as THREE from 'three';
import { HUD_LAYER, type VfxWindow } from '../../engine/vfx/vfx.ts';
import type { IndexedUniforms } from '../materials/indexedMaterial.ts';

const vertexShader = /* glsl */ `
void main() { gl_Position = vec4(position.xy, 0.0, 1.0); }
`;

/** the inset views a window can hold at once (texture units in every shader that shows the window) */
export const INSET_SLOTS = 4;

/**
 * The window's pixels for a shader: uWindow (RGBA8: the palette index, 255 -
 * layer where drawn or 0, the inset view marked there as its id + 1 or 0),
 * the inset views' textures and where each stands (x, y, w, h in window
 * pixels), and windowPixel(p, layer) - the palette index to show at window
 * pixel p, or -1 for none, with the HUD layer it was drawn in (0 for an
 * inset view's pixel).
 */
export const WINDOW_GLSL = /* glsl */ `
uniform sampler2D uWindow;
uniform sampler2D uInset0;
uniform sampler2D uInset1;
uniform sampler2D uInset2;
uniform sampler2D uInset3;
uniform vec4 uInsetRect[${INSET_SLOTS}];
int windowPixel(ivec2 p, out int layer) {
  vec4 t = texelFetch(uWindow, p, 0);
  layer = 0;
  int id = int(t.b * 255.0 + 0.5) - 1;
  if (id >= 0 && id < ${INSET_SLOTS}) {
    vec4 r = uInsetRect[id];
    ivec2 q = p - ivec2(r.xy);
    if (q.x >= 0 && q.y >= 0 && q.x < int(r.z) && q.y < int(r.w)) {
      // the view's rows run up
      q.y = int(r.w) - 1 - q.y;
      vec4 s = id == 0 ? texelFetch(uInset0, q, 0) : id == 1 ? texelFetch(uInset1, q, 0) : id == 2 ? texelFetch(uInset2, q, 0) : texelFetch(uInset3, q, 0);
      if (s.a >= 0.5) return int(s.r * 255.0 + 0.5);
    }
  }
  if (t.g < 0.5) return -1;
  layer = 255 - int(t.g * 255.0 + 0.5);
  return int(t.r * 255.0 + 0.5);
}
`;

/** The inset views' uniforms, shared by every material that shows the window: filled in by passes/indexedView.ts. */
export interface InsetUniforms {
  uInset0: { value: THREE.Texture | null };
  uInset1: { value: THREE.Texture | null };
  uInset2: { value: THREE.Texture | null };
  uInset3: { value: THREE.Texture | null };
  uInsetRect: { value: THREE.Vector4[] };
}

function insetUniforms(): InsetUniforms {
  return {
    uInset0: { value: null },
    uInset1: { value: null },
    uInset2: { value: null },
    uInset3: { value: null },
    uInsetRect: { value: Array.from({ length: INSET_SLOTS }, () => new THREE.Vector4()) },
  };
}

const fragmentShader = /* glsl */ `
precision highp float;
precision highp int;
uniform sampler2D uPalette;
${WINDOW_GLSL}
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
  int layer;
  int i = windowPixel(p, layer);
  if (i < 0) discard;
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
${WINDOW_GLSL}
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
  int layer;
  int i = windowPixel(p, layer);
  if (i < 0) discard;
  if (((uLayers >> layer) & 1) == 0) discard;
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
    ...insetUniforms(),
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

  /** The palette, window-texture and inset uniform holders, for other surfaces that show the window (the cockpit's screens, through WINDOW_GLSL). */
  get windowUniforms(): { uPalette: { value: THREE.DataTexture | null }; uWindow: { value: THREE.DataTexture | null }; uWindowSize: { value: THREE.Vector2 } } & InsetUniforms {
    return this.u;
  }

  /** The inset views' textures and rectangles, which passes/indexedView.ts fills in. */
  get insetUniforms(): InsetUniforms {
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
      this.data = new Uint8Array(w * h * 4);
      this.tex = new THREE.DataTexture(this.data, w, h, THREE.RGBAFormat, THREE.UnsignedByteType);
      this.tex.magFilter = THREE.NearestFilter;
      this.tex.minFilter = THREE.NearestFilter;
      this.u.uWindow.value = this.tex;
      this.u.uWindowSize.value.set(w, h);
    }
    const d = this.data;
    const b = win.buffer;
    const m = win.drawn;
    const l = win.layer;
    const k = win.inset;
    const reticle = HUD_LAYER.reticle;
    let rx = 0;
    let ry = 0;
    let rn = 0;
    // drawn: 255 - its layer (every drawn pixel stays >= 0.5 for the screen pass); not drawn: 0; then the inset mark
    for (let i = 0, n = w * h; i < n; i++) {
      d[i * 4] = b[i]!;
      d[i * 4 + 1] = m[i] ? 255 - l[i]! : 0;
      d[i * 4 + 2] = k[i] ?? 0;
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
