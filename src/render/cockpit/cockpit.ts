/**
 * The hand-built cockpits (the "cockpits" enhancement): a chassis's design
 * (cockpit/designs) drawn in the cockpit view in place of the original
 * shell's mesh, with the game's displays on its screens.
 *
 * GEOMETRY is the design's kit (kit.ts), built once per design: faces carry a
 * material and a shade, resolved here to palette indices - hull and trim to
 * the ramps the original shell is drawn in (its words, commonRamps), the
 * lamps to the palette indices nearest their colours - so the palette on
 * screen colours it.
 *
 * SCREENS show pieces of their widgets' panes of the game's window (the HUD
 * pass's (index, drawn) texture, passes/hudOverlay.ts), each fitted whole
 * inside its slot (fitRect) with the unlit glass - the palette's darkest
 * colour - round it (kit.ts SCREENS says which pieces, and why not whole
 * panes). The floating HUD leaves each shown screen's panes out (shown). The
 * panes are the widgets' own windows, so the power-up transitions, the
 * damage display's F1/F5-F9 modes and the target display's F4 modes all land
 * on their screens.
 *
 * MOVING PARTS: the throttle lever leans with ControlState.throttle (back
 * in reverse), the stick with the turn and torso-tilt inputs.
 *
 * @portOnly
 */
import * as THREE from 'three';
import { cropRect, fitRect, MAT_COUNT, Mat, PANE_WIDGETS, type CockpitDesign, type Kit, type PaneName, type Slot } from './kit.ts';
import { WINDOW_GLSL, type InsetUniforms } from '../passes/hudOverlay.ts';

/** A rectangle of the game's window, pixels. */
export interface Pane {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Each pane: the union of its widgets' rectangles (null where none of them has one). */
export function slotPanes(widgetRect: (i: number) => Pane | null): Record<PaneName, Pane | null> {
  const out = {} as Record<PaneName, Pane | null>;
  for (const name of Object.keys(PANE_WIDGETS) as PaneName[]) {
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (const i of PANE_WIDGETS[name]) {
      const r = widgetRect(i);
      if (!r || r.w <= 0 || r.h <= 0) continue;
      x0 = Math.min(x0, r.x);
      y0 = Math.min(y0, r.y);
      x1 = Math.max(x1, r.x + r.w);
      y1 = Math.max(y1, r.y + r.h);
    }
    out[name] = x1 > x0 ? { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } : null;
  }
  return out;
}

/** The ramps (index & 0xf0) the flat-lit and per-vertex-shaded words in `draws` are in, most used first. */
export function commonRamps(draws: Iterable<number>): number[] {
  const count = new Map<number, number>();
  for (const w of draws) {
    const mode = w & 0x7000;
    if (w < 0 || (mode !== 0x1000 && mode !== 0x4000)) continue;
    const r = w & 0xf0;
    count.set(r, (count.get(r) ?? 0) + 1);
  }
  return [...count].sort((a, b) => b[1] - a[1]).map(([r]) => r);
}

/** The palette index (6-bit DAC values, 256 x 3) nearest a colour. */
export function nearestIndex(rgb: Uint8Array, r: number, g: number, b: number): number {
  let best = 0;
  let be = Infinity;
  for (let i = 0; i < 255; i++) {
    const e = 0.3 * (rgb[i * 3]! - r) ** 2 + 0.59 * (rgb[i * 3 + 1]! - g) ** 2 + 0.11 * (rgb[i * 3 + 2]! - b) ** 2;
    if (e < be) {
      be = e;
      best = i;
    }
  }
  return best;
}

/** The palette's darkest index: an unlit screen's glass. */
export function darkestIndex(rgb: Uint8Array): number {
  let best = 0;
  let bl = Infinity;
  for (let i = 0; i < 256; i++) {
    const l = 0.3 * rgb[i * 3]! + 0.59 * rgb[i * 3 + 1]! + 0.11 * rgb[i * 3 + 2]!;
    if (l < bl) {
      bl = l;
      best = i;
    }
  }
  return best;
}

const solidVertex = /* glsl */ `
in float aMat;
in float aShade;
uniform vec4 uMats[${MAT_COUNT}];   // x: ramp (index & 0xf0), y: shade offset, z: fixed index (< 0: lit)
flat out int vIdx;
void main() {
  vec4 d = uMats[int(aMat + 0.5)];
  int s = clamp(int(aShade + 0.5) + int(d.y), 0, 15);
  vIdx = d.z >= 0.0 ? int(d.z + 0.5) : ((int(d.x + 0.5) & 0xf0) | s);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;
const solidFragment = /* glsl */ `
precision highp float;
precision highp int;
uniform sampler2D uPalette;
flat in int vIdx;
out vec4 outColor;
void main() { outColor = vec4(texelFetch(uPalette, ivec2(vIdx & 255, 0), 0).rgb, 1.0); }
`;
const screenVertex = /* glsl */ `
out vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;
const screenFragment = /* glsl */ `
precision highp float;
precision highp int;
uniform sampler2D uPalette;
${WINDOW_GLSL}
uniform vec2 uWindowSize;
uniform vec4 uRect;          // the piece of the pane: x, y, w, h in window pixels
uniform vec4 uFit;           // where it sits in the slot: u0, v0, u1, v1 (v down)
uniform int uBlank;          // the unlit glass
in vec2 vUv;
out vec4 outColor;
void main() {
  vec2 t = (vUv - uFit.xy) / (uFit.zw - uFit.xy);
  int i = uBlank;
  if (t.x >= 0.0 && t.y >= 0.0 && t.x < 1.0 && t.y < 1.0) {
    ivec2 p = clamp(ivec2(floor(uRect.xy + t * uRect.zw)), ivec2(0), ivec2(uWindowSize) - 1);
    // the window's pixel, or an inset view's where one stands over it (the target display's view)
    int layer;
    int w = windowPixel(p, layer);
    if (w >= 0) i = w;
  }
  outColor = vec4(texelFetch(uPalette, ivec2(i & 255, 0), 0).rgb, 1.0);
}
`;

interface ScreenMesh {
  slot: Slot;
  mesh: THREE.Mesh;
  mat: THREE.ShaderMaterial;
  /** width / height of the slot */
  aspect: number;
}

export interface CockpitColours {
  hull: number;
  trim: number;
  red: number;
  amber: number;
  green: number;
  blank: number;
}

export interface CockpitControls {
  /** -1..1, negative in reverse */
  throttle: number;
  turn: number;
  tilt: number;
}

type HudUniforms = { uPalette: { value: unknown }; uWindow: { value: unknown }; uWindowSize: { value: THREE.Vector2 } } & InsetUniforms;

export class CockpitRenderer {
  /** drawn after the cockpit pass, against its depth */
  readonly scene = new THREE.Scene();
  /** the panes on screens this frame, for the HUD to leave out */
  readonly shown: Pane[] = [];
  private readonly anchor = new THREE.Object3D();
  private readonly solid: THREE.ShaderMaterial;
  private readonly mats = Array.from({ length: MAT_COUNT }, () => new THREE.Vector4(0x40, 0, -1, 0));
  private design: CockpitDesign | null = null;
  private screens: ScreenMesh[] = [];
  private parts = new Map<string, THREE.Object3D>();

  constructor(private readonly hud: HudUniforms) {
    this.anchor.matrixAutoUpdate = false;
    this.scene.add(this.anchor);
    this.solid = new THREE.ShaderMaterial({ glslVersion: THREE.GLSL3, uniforms: { uPalette: hud.uPalette, uMats: { value: this.mats } }, vertexShader: solidVertex, fragmentShader: solidFragment, side: THREE.DoubleSide });
    this.scene.visible = false;
  }

  get current(): CockpitDesign | null {
    return this.design;
  }

  /** Builds `design` (null: none), replacing the last. */
  setDesign(design: CockpitDesign | null, build: (d: CockpitDesign) => Kit): void {
    if (design === this.design) return;
    this.clear();
    this.design = design;
    if (!design) return;
    const k = build(design);
    this.anchor.add(this.meshOf(k));
    for (const s of k.slots) this.addScreen(s, this.anchor);
    for (const [name, p] of k.parts) {
      const g = new THREE.Group();
      g.position.set(...p.pivot);
      g.add(this.meshOf(p.kit));
      for (const s of p.kit.slots) this.addScreen(s, g);
      this.anchor.add(g);
      this.parts.set(name, g);
    }
  }

  /** The colours the materials resolve to (see CockpitColours; ramps as index & 0xf0). */
  setColours(c: CockpitColours): void {
    const lit = (m: number, ramp: number, offset: number) => this.mats[m]!.set(ramp, offset, -1, 0);
    lit(Mat.hull, c.hull, 0);
    lit(Mat.panel, c.hull, -3);
    lit(Mat.trim, c.trim, c.trim === c.hull ? 2 : 0);
    lit(Mat.dark, c.hull, -7);
    lit(Mat.frame, c.hull, -1);
    this.mats[Mat.lampRed]!.set(0, 0, c.red, 0);
    this.mats[Mat.lampAmber]!.set(0, 0, c.amber, 0);
    this.mats[Mat.lampGreen]!.set(0, 0, c.green, 0);
    for (const s of this.screens) s.mat.uniforms.uBlank!.value = c.blank;
  }

  /**
   * Poses the cockpit at `anchor` (pilot space to world) and shows on each
   * slot its piece of its pane (null: unlit glass, and not left out of the
   * HUD).
   */
  update(anchor: THREE.Matrix4, panes: Record<PaneName, Pane | null>, controls: CockpitControls): void {
    if (!this.design) return this.hide();
    this.scene.visible = true;
    this.anchor.matrix.copy(anchor);
    this.anchor.matrixWorldNeedsUpdate = true;
    this.shown.length = 0;
    // each screen's shown panes, as one rectangle: what the HUD leaves out
    const cut = new Map<number, Pane>();
    for (const s of this.screens) {
      const p = panes[s.slot.part.pane];
      const rect = s.mat.uniforms.uRect!.value as THREE.Vector4;
      const fit = s.mat.uniforms.uFit!.value as THREE.Vector4;
      if (p) {
        const c = cropRect(p, s.slot.part.crop);
        rect.set(c.x, c.y, c.w, c.h);
        fit.set(...fitRect(c.w / c.h, s.aspect, s.slot.part.align));
        const q = cut.get(s.slot.screen);
        if (!q) cut.set(s.slot.screen, { ...p });
        else {
          const x1 = Math.max(q.x + q.w, p.x + p.w);
          const y1 = Math.max(q.y + q.h, p.y + p.h);
          q.x = Math.min(q.x, p.x);
          q.y = Math.min(q.y, p.y);
          q.w = x1 - q.x;
          q.h = y1 - q.y;
        }
      } else fit.set(0, 0, 0, 0);
    }
    for (const p of cut.values()) if (!this.shown.some((q) => q.x === p.x && q.y === p.y && q.w === p.w && q.h === p.h)) this.shown.push(p);
    const clamp = (v: number) => Math.max(-1, Math.min(1, v));
    const lever = this.parts.get('throttle');
    if (lever) lever.rotation.set(-0.45 * clamp(controls.throttle), 0, 0);
    const stick = this.parts.get('stick');
    if (stick) stick.rotation.set(-0.3 * clamp(controls.tilt), 0, -0.3 * clamp(controls.turn));
  }

  hide(): void {
    this.scene.visible = false;
    this.shown.length = 0;
  }

  dispose(): void {
    this.clear();
    this.solid.dispose();
  }

  private meshOf(k: Kit): THREE.Mesh {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(k.pos, 3));
    g.setAttribute('aMat', new THREE.Float32BufferAttribute(k.mat, 1));
    g.setAttribute('aShade', new THREE.Float32BufferAttribute(k.shade, 1));
    const m = new THREE.Mesh(g, this.solid);
    m.frustumCulled = false;
    return m;
  }

  private addScreen(slot: Slot, parent: THREE.Object3D): void {
    const [tl, tr, br, bl] = slot.corners;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute([...tl!, ...tr!, ...br!, ...tl!, ...br!, ...bl!], 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 1, 0, 1, 1, 0, 0, 1, 1, 0, 1], 2));
    const mat = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      uniforms: {
        uPalette: this.hud.uPalette,
        uWindow: this.hud.uWindow,
        uWindowSize: this.hud.uWindowSize,
        uInset0: this.hud.uInset0,
        uInset1: this.hud.uInset1,
        uInset2: this.hud.uInset2,
        uInset3: this.hud.uInset3,
        uInsetRect: this.hud.uInsetRect,
        uRect: { value: new THREE.Vector4(0, 0, 1, 1) },
        uFit: { value: new THREE.Vector4(0, 0, 0, 0) },
        uBlank: { value: 0 },
      },
      vertexShader: screenVertex,
      fragmentShader: screenFragment,
      side: THREE.DoubleSide,
    });
    const mesh = new THREE.Mesh(g, mat);
    mesh.frustumCulled = false;
    parent.add(mesh);
    const d = (a: number[], b: number[]) => Math.hypot(a[0]! - b[0]!, a[1]! - b[1]!, a[2]! - b[2]!);
    this.screens.push({ slot, mesh, mat, aspect: d(tl!, tr!) / Math.max(1e-6, d(tl!, bl!)) });
  }

  private clear(): void {
    for (const o of [...this.anchor.children]) {
      this.anchor.remove(o);
      o.traverse((x) => {
        const m = x as THREE.Mesh;
        if (m.isMesh) {
          m.geometry.dispose();
          if (m.material !== this.solid) (m.material as THREE.Material).dispose();
        }
      });
    }
    this.screens = [];
    this.parts.clear();
    this.design = null;
  }
}
