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
 * Between passes (engine/scene/present.ts) the HUD's world-anchored 2D - the
 * reticle and target marker - is redrawn into a layer where the 3D is
 * presented (sim/cockpit/overlay.ts, hudAnchoredPresent). The window's own
 * draw of it is then lifted out: a pixel it drew (DRAWN_ANCHORED) shows what
 * was under it, the layer goes over what the pass drew before it (DRAWN), and
 * what the pass drew after it (DRAWN_AFTER) stays on top - the original's
 * order, with the anchored draw moved.
 *
 * @portOnly
 */
import * as THREE from 'three';
import { DRAWN, DRAWN_AFTER, DRAWN_ANCHORED, VfxWindow, vfxWindowAllocate } from '../../engine/vfx/vfx.ts';
import type { IndexedUniforms } from '../materials/indexedMaterial.ts';

const vertexShader = /* glsl */ `
void main() { gl_Position = vec4(position.xy, 0.0, 1.0); }
`;

const fragmentShader = /* glsl */ `
precision highp float;
precision highp int;
uniform sampler2D uPalette;
uniform sampler2D uWindow;   // RGBA8: index, drawn (a DRAWN_* value), the index under an anchored pixel, whether that was drawn
uniform sampler2D uLayer;    // RG8: the anchored 2D as presented: index, drawn
uniform bool uLift;          // whether the layer replaces the window's own anchored draw
uniform vec2 uWindowSize;    // window width, height
uniform vec2 uTarget;        // render target width, height
out vec4 fragColour;
int byteOf(float v) { return int(v * 255.0 + 0.5); }
void main() {
  // window row 0 is the top of the screen
  ivec2 p = ivec2(floor(gl_FragCoord.x * uWindowSize.x / uTarget.x), int(uWindowSize.y) - 1 - int(floor(gl_FragCoord.y * uWindowSize.y / uTarget.y)));
  vec4 w = texelFetch(uWindow, p, 0);
  int mark = byteOf(w.g);
  int i;
  if (!uLift) {
    if (mark == 0) discard;
    i = byteOf(w.r);
  } else {
    vec2 l = texelFetch(uLayer, p, 0).rg;
    if (mark == ${DRAWN_AFTER}) i = byteOf(w.r);
    else if (l.g > 0.5) i = byteOf(l.r);
    else if (mark == ${DRAWN_ANCHORED}) {
      if (w.a < 0.5) discard;
      i = byteOf(w.b);
    } else if (mark == ${DRAWN}) i = byteOf(w.r);
    else discard;
  }
  fragColour = vec4(texelFetch(uPalette, ivec2(i, 0), 0).rgb, 1.0);
}
`;

function dataTexture(data: Uint8Array, w: number, h: number, format: THREE.PixelFormat): THREE.DataTexture {
  const t = new THREE.DataTexture(data, w, h, format, THREE.UnsignedByteType);
  t.magFilter = THREE.NearestFilter;
  t.minFilter = THREE.NearestFilter;
  return t;
}

export class HudOverlay {
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  /** the world-anchored 2D as presented, redrawn every frame between passes */
  readonly layer = new VfxWindow();
  private tex: THREE.DataTexture | null = null;
  private data = new Uint8Array(0);
  private layerTex: THREE.DataTexture | null = null;
  private layerData = new Uint8Array(0);
  private readonly u = {
    uPalette: { value: null as THREE.DataTexture | null },
    uWindow: { value: null as THREE.DataTexture | null },
    uLayer: { value: null as THREE.DataTexture | null },
    uLift: { value: false },
    uWindowSize: { value: new THREE.Vector2(1, 1) },
    uTarget: { value: new THREE.Vector2(1, 1) },
  };

  constructor(shared: IndexedUniforms) {
    this.u.uPalette.value = shared.uPalette.value;
    const mat = new THREE.ShaderMaterial({ glslVersion: THREE.GLSL3, uniforms: this.u, vertexShader, fragmentShader, depthTest: false, depthWrite: false, transparent: false });
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), mat);
    mesh.frustumCulled = false;
    this.scene.add(mesh);
  }

  /** The layer, sized as `win`, for the anchored 2D to be redrawn into. */
  layerFor(win: VfxWindow): VfxWindow {
    const w = win.xMax + 1;
    const h = win.yMax + 1;
    if (this.layer.xMax + 1 !== w || this.layer.yMax + 1 !== h) vfxWindowAllocate(this.layer, Math.max(0, w), Math.max(0, h));
    return this.layer;
  }

  /**
   * Uploads the window's pixels, and with `lift` the layer's in place of the
   * window's anchored draw; false when the window has none yet (before
   * video_init).
   */
  update(win: VfxWindow, lift: boolean, targetWidth: number, targetHeight: number): boolean {
    const w = win.xMax + 1;
    const h = win.yMax + 1;
    if (w <= 0 || h <= 0 || win.buffer.length < w * h) return false;
    if (!this.tex || this.tex.image.width !== w || this.tex.image.height !== h) {
      this.tex?.dispose();
      this.layerTex?.dispose();
      this.data = new Uint8Array(w * h * 4);
      this.tex = dataTexture(this.data, w, h, THREE.RGBAFormat);
      this.layerData = new Uint8Array(w * h * 2);
      this.layerTex = dataTexture(this.layerData, w, h, THREE.RGFormat);
      this.u.uWindow.value = this.tex;
      this.u.uLayer.value = this.layerTex;
      this.u.uWindowSize.value.set(w, h);
    }
    const d = this.data;
    const b = win.buffer;
    const m = win.drawn;
    const n = w * h;
    const under = win.under.length === n ? win.under : null;
    for (let i = 0; i < n; i++) {
      d[i * 4] = b[i]!;
      d[i * 4 + 1] = m[i]!;
      if (m[i] === DRAWN_ANCHORED && under) {
        d[i * 4 + 2] = under[i]!;
        d[i * 4 + 3] = win.underDrawn[i] ? 255 : 0;
      }
    }
    this.tex.needsUpdate = true;
    const lifting = lift && this.layer.buffer.length === n;
    if (lifting) {
      const ld = this.layerData;
      const lb = this.layer.buffer;
      const lm = this.layer.drawn;
      for (let i = 0; i < n; i++) {
        ld[i * 2] = lb[i]!;
        ld[i * 2 + 1] = lm[i] ? 255 : 0;
      }
      this.layerTex!.needsUpdate = true;
    }
    this.u.uLift.value = lifting;
    this.u.uTarget.value.set(targetWidth, targetHeight);
    return true;
  }

  dispose(): void {
    this.tex?.dispose();
    this.layerTex?.dispose();
  }
}
