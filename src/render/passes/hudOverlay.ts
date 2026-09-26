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
 * @portOnly
 */
import * as THREE from 'three';
import type { VfxWindow } from '../../engine/vfx/vfx.ts';
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
out vec4 fragColour;
void main() {
  // window row 0 is the top of the screen
  ivec2 p = ivec2(floor(gl_FragCoord.x * uWindowSize.x / uTarget.x), int(uWindowSize.y) - 1 - int(floor(gl_FragCoord.y * uWindowSize.y / uTarget.y)));
  vec2 t = texelFetch(uWindow, p, 0).rg;
  if (t.g < 0.5) discard;
  int i = int(t.r * 255.0 + 0.5);
  fragColour = vec4(texelFetch(uPalette, ivec2(i, 0), 0).rgb, 1.0);
}
`;

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
    const mat = new THREE.ShaderMaterial({ glslVersion: THREE.GLSL3, uniforms: this.u, vertexShader, fragmentShader, depthTest: false, depthWrite: false, transparent: false });
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), mat);
    mesh.frustumCulled = false;
    this.scene.add(mesh);
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
    for (let i = 0, n = w * h; i < n; i++) {
      d[i * 2] = b[i]!;
      d[i * 2 + 1] = m[i] ? 255 : 0;
    }
    this.tex.needsUpdate = true;
    this.u.uTarget.value.set(targetWidth, targetHeight);
    return true;
  }

  dispose(): void {
    this.tex?.dispose();
  }
}
