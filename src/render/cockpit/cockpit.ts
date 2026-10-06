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
 * in reverse), the stick with the turn and torso-tilt inputs - or with the
 * hand holding them (touch.ts).
 *
 * SWITCHES (controls.ts) are caps on the kit's recesses, each with its label
 * from a font texture drawn once. A cap sinks as it is pressed, brightens
 * while a fingertip hovers over it, and lights in its lamp's colour while
 * its lamp is on. A guarded switch has a cover, hinged along its top edge.
 *
 * HANDS: in a headset, a gauntlet at each controller with a finger out to
 * the tip that presses, and a thin ray to a switch picked out of reach.
 *
 * @portOnly
 */
import * as THREE from 'three';
import { PANELS } from './controls.ts';
import { CELL_H, CELL_W, labelAtlas } from './labelFont.ts';
import { CAP_HEIGHT, cropRect, fitRect, Kit, MAT_COUNT, Mat, PANE_WIDGETS, shadeOf, type CockpitDesign, type ControlSlot, type PaneName, type Slot, type V3 } from './kit.ts';
import { COVER_HEIGHT, type ControlLook, type GrabName, type GrabPoint } from './touch.ts';
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

const capVertex = /* glsl */ `
in float aTop;
flat out int vTop;
void main() {
  vTop = int(aTop + 0.5);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;
const capFragment = /* glsl */ `
precision highp float;
precision highp int;
uniform sampler2D uPalette;
uniform int uTop;
uniform int uSide;
flat in int vTop;
out vec4 outColor;
void main() { outColor = vec4(texelFetch(uPalette, ivec2((vTop == 1 ? uTop : uSide) & 255, 0), 0).rgb, 1.0); }
`;
const labelFragment = /* glsl */ `
precision highp float;
precision highp int;
uniform sampler2D uPalette;
uniform sampler2D uAtlas;
uniform vec4 uCell;
uniform int uIdx;
in vec2 vUv;
out vec4 outColor;
void main() {
  if (texture(uAtlas, mix(uCell.xy, uCell.zw, vUv)).r < 0.5) discard;
  outColor = vec4(texelFetch(uPalette, ivec2(uIdx & 255, 0), 0).rgb, 1.0);
}
`;

interface CapMesh {
  slot: ControlSlot;
  /** sinks as the cap is pressed */
  cap: THREE.Group;
  body: THREE.ShaderMaterial;
  label: THREE.ShaderMaterial;
  cover: THREE.Group | null;
  /** the cap's top's shade (0..15) from the interior light */
  shade: number;
}

/** A hand as the headset tracks it, pilot space. */
export interface HandLook {
  /** the grip pose */
  grip: THREE.Matrix4;
  /** the fingertip */
  tip: V3;
  /** the ray to a switch picked out of reach */
  ray: { from: V3; to: V3 } | null;
}

/** The switches and hands this frame. */
export interface CockpitLook {
  controls: ReadonlyMap<string, ControlLook>;
  /** the ids of switches whose lamps are on */
  lit: ReadonlySet<string>;
  hands: readonly [HandLook | null, HandLook | null];
}

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
  /** the lever, -1..1 of its swing, negative behind the stop (reverse shows half back, -0.5 at full) */
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
  private caps: CapMesh[] = [];
  private slots: ControlSlot[] = [];
  private grips = new Map<GrabName, V3>();
  private colours: CockpitColours = { hull: 0x40, trim: 0x40, red: 0, amber: 0, green: 0, blank: 0 };
  private atlas: { texture: THREE.Texture; cells: Map<string, THREE.Vector4> } | null = null;
  private readonly hands: Array<{ glove: THREE.Object3D; finger: THREE.Object3D; ray: THREE.Object3D }> = [];

  constructor(private readonly hud: HudUniforms) {
    this.anchor.matrixAutoUpdate = false;
    this.scene.add(this.anchor);
    this.solid = new THREE.ShaderMaterial({ glslVersion: THREE.GLSL3, uniforms: { uPalette: hud.uPalette, uMats: { value: this.mats } }, vertexShader: solidVertex, fragmentShader: solidFragment, side: THREE.DoubleSide });
    this.scene.visible = false;
    for (let i = 0; i < 2; i++) {
      const glove = this.meshOf(gloveKit());
      const finger = this.meshOf(beamKit(0.018, Mat.frame));
      const ray = this.meshOf(beamKit(0.003, Mat.lampAmber));
      for (const o of [glove, finger, ray]) {
        o.matrixAutoUpdate = false;
        o.visible = false;
        this.anchor.add(o);
      }
      this.hands.push({ glove, finger, ray });
    }
  }

  /** The switches, pilot space. */
  get controls(): readonly ControlSlot[] {
    return this.slots;
  }

  /** The parts a hand can hold, where their knobs stand now (pilot space). */
  grabPoints(): GrabPoint[] {
    const out: GrabPoint[] = [];
    for (const [name, at] of this.grips) {
      const part = this.parts.get(name);
      if (!part) continue;
      const knob = new THREE.Vector3(...at).applyEuler(part.rotation).add(part.position);
      out.push({ name, knob: [knob.x, knob.y, knob.z], pivot: [part.position.x, part.position.y, part.position.z] });
    }
    return out;
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
    for (const [name, at] of k.grips) if (name === 'throttle' || name === 'stick') this.grips.set(name, at);
    for (const c of k.controls) this.addCap(c);
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
    this.colours = c;
  }

  /**
   * Poses the cockpit at `anchor` (pilot space to world) and shows on each
   * slot its piece of its pane (null: unlit glass, and not left out of the
   * HUD).
   */
  update(anchor: THREE.Matrix4, panes: Record<PaneName, Pane | null>, controls: CockpitControls, look: CockpitLook | null = null): void {
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
    this.updateCaps(look);
    this.updateHands(look);
  }

  /** Each cap's depth, colour and cover. */
  private updateCaps(look: CockpitLook | null): void {
    const c = this.colours;
    const lamps = { red: c.red, amber: c.amber, green: c.green };
    for (const m of this.caps) {
      const l = look?.controls.get(m.slot.def.id);
      m.cap.position.z = -(l?.depth ?? 0);
      const lit = look?.lit.has(m.slot.def.id) ?? false;
      const shade = Math.min(15, m.shade + 2 + (l?.hover ? 3 : 0));
      const top = lit ? lamps[m.slot.def.colour ?? 'green'] : (c.trim & 0xf0) | shade;
      m.body.uniforms.uTop!.value = top;
      m.body.uniforms.uSide!.value = lit ? top : (c.hull & 0xf0) | Math.max(0, m.shade - 3);
      m.label.uniforms.uIdx!.value = lit ? c.blank : (c.trim & 0xf0) | Math.max(0, shade - 9);
      if (m.cover) m.cover.rotation.x = l?.coverOpen ? -1.9 : 0;
    }
  }

  /** The gauntlets at the controllers, each with its finger out to the tip, and the rays. */
  private updateHands(look: CockpitLook | null): void {
    this.hands.forEach((h, i) => {
      const hand = look?.hands[i] ?? null;
      h.glove.visible = !!hand;
      h.finger.visible = !!hand;
      h.ray.visible = !!hand?.ray;
      if (!hand) return;
      h.glove.matrix.copy(hand.grip);
      h.glove.matrixWorldNeedsUpdate = true;
      const root = new THREE.Vector3(0, -0.005, -0.05).applyMatrix4(hand.grip);
      poseBeam(h.finger, [root.x, root.y, root.z], hand.tip);
      if (hand.ray) poseBeam(h.ray, hand.ray.from, hand.ray.to);
    });
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

  /** A switch's cap on its recess: the body, its label on top, and a cover if it is guarded. */
  private addCap(slot: ControlSlot): void {
    const { f, w, h } = slot;
    const group = new THREE.Group();
    group.matrixAutoUpdate = false;
    group.matrix.makeBasis(new THREE.Vector3(...f.r), new THREE.Vector3(...f.u), new THREE.Vector3(...f.n)).setPosition(...f.c);
    const cap = new THREE.Group();
    group.add(cap);
    const body = new THREE.ShaderMaterial({ glslVersion: THREE.GLSL3, uniforms: { uPalette: this.hud.uPalette, uTop: { value: 0 }, uSide: { value: 0 } }, vertexShader: capVertex, fragmentShader: capFragment, side: THREE.DoubleSide });
    const b = new THREE.Mesh(capGeometry(w, h, CAP_HEIGHT), body);
    b.frustumCulled = false;
    cap.add(b);
    const atlas = this.labelAtlas();
    const label = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      uniforms: { uPalette: this.hud.uPalette, uAtlas: { value: atlas.texture }, uCell: { value: atlas.cells.get(slot.def.label) ?? new THREE.Vector4() }, uIdx: { value: 0 } },
      vertexShader: screenVertex,
      fragmentShader: labelFragment,
      side: THREE.DoubleSide,
    });
    // the label at its cell's shape, across most of the cap
    const lw = Math.min(w * 0.9, ((h * 0.8) / CELL_H) * CELL_W);
    const quad = new THREE.Mesh(new THREE.PlaneGeometry(lw, (lw / CELL_W) * CELL_H), label);
    quad.position.z = CAP_HEIGHT + 0.0005;
    quad.frustumCulled = false;
    cap.add(quad);
    let cover: THREE.Group | null = null;
    if (slot.def.guarded) {
      // hinged along the top edge, over the cap: a lid and its front lip, red as a bail-out's cover is
      cover = new THREE.Group();
      cover.position.set(0, h / 2 + 0.005, COVER_HEIGHT);
      const k = new Kit([0, 0, 0.5]);
      k.box([0, -(h / 2 + 0.005), 0], [w + 0.01, h + 0.01, 0.003], Mat.lampRed);
      k.box([0, -(h + 0.01), -COVER_HEIGHT / 2], [w + 0.01, 0.003, COVER_HEIGHT], Mat.lampRed);
      cover.add(this.meshOf(k));
      group.add(cover);
    }
    this.anchor.add(group);
    this.caps.push({ slot, cap, body, label, cover, shade: shadeOf(f.n) });
    this.slots.push(slot);
  }

  /** The labels' font texture (labelFont.ts), made once. */
  private labelAtlas(): { texture: THREE.Texture; cells: Map<string, THREE.Vector4> } {
    if (this.atlas) return this.atlas;
    const a = labelAtlas(Object.values(PANELS).flatMap((p) => p.map((d) => d.label)));
    const texture = new THREE.DataTexture(a.data, a.width, a.height, THREE.RedFormat, THREE.UnsignedByteType);
    texture.magFilter = THREE.NearestFilter;
    texture.minFilter = THREE.NearestFilter;
    texture.generateMipmaps = false;
    texture.needsUpdate = true;
    // a cell's corners as the quad's uv (0, 0) -> (u0, v0), (1, 1) -> (u1, v1): row 0 is v 0, and the rows run down the glyphs
    const cells = new Map<string, THREE.Vector4>();
    for (const [text, [x, y, w, h]] of a.cells) cells.set(text, new THREE.Vector4(x / a.width, (y + h) / a.height, (x + w) / a.width, y / a.height));
    this.atlas = { texture, cells };
    return this.atlas;
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
    // the hands stay: they are the headset's, not the design's
    const hands = new Set(this.hands.flatMap((h) => [h.glove, h.finger, h.ray]));
    for (const o of [...this.anchor.children]) {
      if (hands.has(o)) continue;
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
    this.caps = [];
    this.slots = [];
    this.grips.clear();
    this.design = null;
  }
}

/** A box `w` by `h` standing `d` off its foot (z = 0), its top face marked (aTop) for its own colour. */
function capGeometry(w: number, h: number, d: number): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(w, h, d).toNonIndexed();
  g.translate(0, 0, d / 2);
  const pos = g.getAttribute('position');
  const top = new Float32Array(pos.count);
  // BoxGeometry's faces come in pairs of triangles: a triangle with all three corners on top is the top's
  for (let t = 0; t < pos.count; t += 3) {
    const up = [0, 1, 2].every((j) => pos.getZ(t + j) > d * 0.99);
    if (up) top[t] = top[t + 1] = top[t + 2] = 1;
  }
  g.setAttribute('aTop', new THREE.Float32BufferAttribute(top, 1));
  return g;
}

/** A gauntlet in the controller's grip space (-z ahead, y up): the cuff, the back of the hand, its knuckle guard and thumb. */
function gloveKit(): Kit {
  const k = new Kit([0, 0.3, 0.3]);
  k.box([0, 0, 0.075], [0.07, 0.055, 0.07], Mat.hull);
  k.box([0, 0.004, 0.005], [0.08, 0.04, 0.085], Mat.frame);
  k.box([0, 0.016, -0.045], [0.084, 0.022, 0.026], Mat.trim);
  k.box([0.038, -0.01, -0.01], [0.018, 0.022, 0.05], Mat.frame);
  return k;
}

/** A unit beam from the origin along -z, `w` square in section. */
function beamKit(w: number, m: Mat): Kit {
  const k = new Kit([0, 1, 0]);
  k.box([0, 0, -0.5], [w, w, 1], m);
  return k;
}

/** Poses a unit beam (beamKit) from `a` to `b`. */
function poseBeam(o: THREE.Object3D, a: V3, b: V3): void {
  const from = new THREE.Vector3(...a);
  const d = new THREE.Vector3(...b).sub(from);
  const len = Math.max(1e-4, d.length());
  const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, -1), d.divideScalar(len));
  o.matrix.compose(from, q, new THREE.Vector3(1, 1, len));
  o.matrixWorldNeedsUpdate = true;
}
