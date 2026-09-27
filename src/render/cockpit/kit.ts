/**
 * The kit the hand-built cockpits (cockpit/designs) are made with: faceted,
 * flat-shaded geometry in MW2's own terms.
 *
 * PILOT SPACE: metres, the eye at the origin, x right, y up, -z ahead - the
 * space of the game's viewer (flat view) and of the VR rig. dir(yaw, pitch,
 * distance) places a point by its angles from the eye (degrees, yaw to the
 * right, pitch up), the terms the original cockpits' window openings are
 * measured in.
 *
 * COLOUR is the game's rule for a flat-lit face, index = ramp * 16 + shade:
 * each face carries a MATERIAL (Mat) and a shade 0..15 from a fixed interior
 * light, quantised once when the face is made. The material resolves at draw
 * time (cockpit.ts): hull and trim to the ramps of the mech's own cockpit
 * shell, lamps to the palette index nearest a named colour, so a mission's
 * palette - dusk, night, infrared - recolours the cockpit as it does
 * everything else.
 *
 * SCREENS are made of slots: pieces of glass in pilot space, each showing
 * (part of) one HUD pane (SCREENS, PANE_WIDGETS). The kit makes the bezel and
 * the recess; the renderer puts the game's pixels in.
 *
 * MOVING PARTS (the throttle lever, the stick) are sub-kits with a pivot,
 * posed each frame.
 *
 * @portOnly
 */

export type V3 = [number, number, number];

/** A face's material: lit ones take a ramp and a shade offset, lamps a fixed index. */
export const Mat = {
  hull: 0,
  panel: 1,
  trim: 2,
  dark: 3,
  frame: 4,
  lampRed: 5,
  lampAmber: 6,
  lampGreen: 7,
} as const;
export type Mat = (typeof Mat)[keyof typeof Mat];
export const MAT_COUNT = 8;

/** The panes the screens show, and the HUD widgets each is the union of (hud.ts's widget indices). */
export const PANE_WIDGETS = {
  radar: [0],
  target: [13],
  readout: [14],
  damage: [2],
  weapons: [3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
  heat: [19],
  heatRate: [20],
  jets: [21],
  masc: [18],
  speed: [17],
} as const;
export type PaneName = keyof typeof PANE_WIDGETS;

/** A rectangle as fractions [x0, y0, x1, y1], y down. */
export type Frac = [number, number, number, number];

/**
 * A piece of a screen: where on the screen it sits (`place`), the pane it
 * shows and which part of that pane (`crop`; all of it by default), fitted
 * whole into its place - centred, or against the place's left edge.
 */
export interface ScreenPart {
  pane: PaneName;
  place: Frac;
  crop?: Frac;
  align?: 'left';
}

/**
 * The screens and what each shows. The widgets' panes overlap in the
 * original's layout - the speed widget's pane (551,313 to 635,469 in a 640 x
 * 480 window) takes in the right half of the damage display's (517,349 to
 * 619,428), the status gauges' union the damage display's foot, the target
 * readout's the autopilot's - which the HUD, drawing both over one view, never
 * shows. So a screen shows the pieces of panes its widgets draw in, measured
 * from their drawn pixels (at 640 x 480):
 *   target    the target display over the readout's text, which draws at the
 *             pane's left and is kept to its left 60% (24 characters)
 *   status    the heat, heat-rate and jump-jet gauges stacked, each 120 or 79
 *             by 35, the MASC lamp's text (its pane's top 15 rows) under them
 *   throttle  '%d kph' (from the pane's foot, 552,453 to 582,466) over the
 *             throttle bar and its frame (625,338 to 635,469)
 */
export const SCREENS = {
  radar: [{ pane: 'radar', place: [0, 0, 1, 1] }],
  target: [
    { pane: 'target', place: [0, 0, 1, 0.7] },
    { pane: 'readout', place: [0.03, 0.72, 1, 1], crop: [0, 0, 0.6, 1], align: 'left' },
  ],
  damage: [{ pane: 'damage', place: [0, 0, 1, 1] }],
  weapons: [{ pane: 'weapons', place: [0, 0, 1, 1] }],
  status: [
    { pane: 'heat', place: [0.03, 0.02, 1, 0.3], align: 'left' },
    { pane: 'heatRate', place: [0.03, 0.3, 1, 0.58], align: 'left' },
    { pane: 'jets', place: [0.03, 0.58, 1, 0.86], align: 'left' },
    { pane: 'masc', place: [0.03, 0.86, 1, 0.98], crop: [0, 0, 1, 0.6], align: 'left' },
  ],
  throttle: [
    { pane: 'speed', place: [0.05, 0.03, 0.95, 0.2], crop: [0, 0.875, 0.6, 1] },
    { pane: 'speed', place: [0.25, 0.24, 0.75, 0.97], crop: [0.85, 0.15, 1, 1] },
  ],
} as const satisfies Record<string, readonly ScreenPart[]>;
export type SlotName = keyof typeof SCREENS;

/** A piece of glass showing one screen part. */
export interface Slot {
  /** the screen it is part of */
  name: SlotName;
  /** which screen of the kit (the parts of one screen share it) */
  screen: number;
  part: ScreenPart;
  /** top-left, top-right, bottom-right, bottom-left, in pilot space (or the part's space) */
  corners: [V3, V3, V3, V3];
}

/** the interior light, from above, a little ahead and to the left */
const LIGHT: V3 = norm([-0.25, 1, -0.45]);

export function add(a: V3, b: V3): V3 {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}
export function sub(a: V3, b: V3): V3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}
export function scale(a: V3, k: number): V3 {
  return [a[0] * k, a[1] * k, a[2] * k];
}
export function dot(a: V3, b: V3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}
export function cross(a: V3, b: V3): V3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}
export function norm(a: V3): V3 {
  const l = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
}
export function lerp(a: V3, b: V3, t: number): V3 {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

const RAD = Math.PI / 180;

/** The point `dist` metres from the eye at `yaw` degrees right and `pitch` degrees up. */
export function dir(yaw: number, pitch: number, dist: number): V3 {
  const c = Math.cos(pitch * RAD);
  return [dist * c * Math.sin(yaw * RAD), dist * Math.sin(pitch * RAD), -dist * c * Math.cos(yaw * RAD)];
}

/** The angles of a point from the eye: [yaw, pitch] in degrees, and its distance. */
export function anglesOf(p: V3): { yaw: number; pitch: number; dist: number } {
  const d = Math.hypot(p[0], p[1], p[2]);
  return { yaw: Math.atan2(p[0], -p[2]) / RAD, pitch: Math.asin(p[1] / (d || 1)) / RAD, dist: d };
}

/** A frame on a plane: its centre, right and up axes, and its normal (towards the viewer). */
export interface Frame {
  c: V3;
  r: V3;
  u: V3;
  n: V3;
}

/**
 * The frame of a plane at `c` whose normal is `n` (pointing out of the
 * surface, towards the pilot), with its up axis as near world up as can be.
 */
export function frameAt(c: V3, n: V3): Frame {
  const nn = norm(n);
  const worldUp: V3 = Math.abs(nn[1]) > 0.97 ? [0, 0, -1] : [0, 1, 0];
  const r = norm(cross(worldUp, nn));
  const u = cross(nn, r);
  return { c, r, u, n: nn };
}

/** A frame at `c` facing the eye, tipped back `tilt` degrees about its horizontal axis (positive: top away). */
export function facingEye(c: V3, tilt = 0): Frame {
  const f = frameAt(c, scale(c, -1));
  if (tilt === 0) return f;
  const t = tilt * RAD;
  // rotate n and u about r
  const n = norm(add(scale(f.n, Math.cos(t)), scale(f.u, Math.sin(t))));
  return frameAt(c, n);
}

/** A point on a frame: `x` along its right, `y` along its up, `z` out along its normal. */
export function on(f: Frame, x: number, y: number, z = 0): V3 {
  return add(add(add(f.c, scale(f.r, x)), scale(f.u, y)), scale(f.n, z));
}

export class Kit {
  readonly pos: number[] = [];
  readonly mat: number[] = [];
  readonly shade: number[] = [];
  readonly slots: Slot[] = [];
  readonly parts = new Map<string, { pivot: V3; kit: Kit }>();
  private screens = 0;

  /** `eye`: where the pilot is in this kit's space (the origin, or minus a part's pivot) */
  constructor(private readonly eye: V3 = [0, 0, 0]) {}

  /** One triangle; its shade from the interior light on the side the pilot sees. */
  tri(a: V3, b: V3, c: V3, m: Mat): void {
    const eye = this.eye;
    let n = norm(cross(sub(b, a), sub(c, a)));
    const centre = scale(add(add(a, b), c), 1 / 3);
    // the side the pilot sees is the lit one: faces are drawn both ways
    if (dot(n, sub(eye, centre)) < 0) n = scale(n, -1);
    const s = shadeOf(n);
    for (const p of [a, b, c]) {
      this.pos.push(p[0], p[1], p[2]);
      this.mat.push(m);
      this.shade.push(s);
    }
  }

  /** A convex polygon (fanned). */
  poly(pts: V3[], m: Mat): void {
    for (let i = 1; i + 1 < pts.length; i++) this.tri(pts[0]!, pts[i]!, pts[i + 1]!, m);
  }

  quad(a: V3, b: V3, c: V3, d: V3, m: Mat): void {
    this.tri(a, b, c, m);
    this.tri(a, c, d, m);
  }

  /**
   * A box on a frame: `w` wide, `h` high, `d` deep out of the frame's plane
   * (from z0 to z0 + d along the normal; things mounted on a face stand a
   * millimetre off it, so they never share its depth).
   */
  slab(f: Frame, w: number, h: number, d: number, m: Mat, x = 0, y = 0, z0 = 0): void {
    const p = (sx: number, sy: number, sz: number) => on(f, x + (sx * w) / 2, y + (sy * h) / 2, z0 + sz * d);
    const c = [p(-1, -1, 0), p(1, -1, 0), p(1, 1, 0), p(-1, 1, 0), p(-1, -1, 1), p(1, -1, 1), p(1, 1, 1), p(-1, 1, 1)];
    this.box8(c as V3[], m);
  }

  /** A hexahedron from its eight corners: 0..3 the back face (bl, br, tr, tl), 4..7 the front. */
  box8(c: V3[], m: Mat): void {
    const [a, b, cc, d, e, f, g, h] = c as [V3, V3, V3, V3, V3, V3, V3, V3];
    this.quad(a, b, cc, d, m);
    this.quad(e, f, g, h, m);
    this.quad(a, b, f, e, m);
    this.quad(d, cc, g, h, m);
    this.quad(a, d, h, e, m);
    this.quad(b, cc, g, f, m);
  }

  /** An axis-aligned box by its centre and size. */
  box(c: V3, size: V3, m: Mat): void {
    const [w, h, d] = [size[0] / 2, size[1] / 2, size[2] / 2];
    const p = (x: number, y: number, z: number): V3 => [c[0] + x * w, c[1] + y * h, c[2] + z * d];
    this.box8([p(-1, -1, 1), p(1, -1, 1), p(1, 1, 1), p(-1, 1, 1), p(-1, -1, -1), p(1, -1, -1), p(1, 1, -1), p(-1, 1, -1)], m);
  }

  /** A beam from `a` to `b`, `w` by `h` in section; `up` orients the section (default world up, or z for a vertical beam). */
  beam(a: V3, b: V3, w: number, h: number, m: Mat, up?: V3): void {
    const axis = norm(sub(b, a));
    const u0: V3 = up ?? (Math.abs(axis[1]) > 0.9 ? [0, 0, 1] : [0, 1, 0]);
    const r = norm(cross(axis, u0));
    const u = cross(r, axis);
    const corner = (p: V3, sx: number, sy: number) => add(add(p, scale(r, (sx * w) / 2)), scale(u, (sy * h) / 2));
    this.box8([corner(a, -1, -1), corner(a, 1, -1), corner(a, 1, 1), corner(a, -1, 1), corner(b, -1, -1), corner(b, 1, -1), corner(b, 1, 1), corner(b, -1, 1)], m);
  }

  /** A six-sided pipe from `a` to `b`. */
  pipe(a: V3, b: V3, radius: number, m: Mat): void {
    const axis = norm(sub(b, a));
    const u0: V3 = Math.abs(axis[1]) > 0.9 ? [0, 0, 1] : [0, 1, 0];
    const r = norm(cross(axis, u0));
    const u = cross(r, axis);
    const ring = (p: V3) => Array.from({ length: 6 }, (_, i) => add(add(p, scale(r, radius * Math.cos((i * Math.PI) / 3))), scale(u, radius * Math.sin((i * Math.PI) / 3))));
    const ra = ring(a);
    const rb = ring(b);
    for (let i = 0; i < 6; i++) this.quad(ra[i]!, ra[(i + 1) % 6]!, rb[(i + 1) % 6]!, rb[i]!, m);
  }

  /**
   * A prism: the profile (points in the y-z plane, as [y, z]) extruded along
   * x from x0 to x1, with both ends capped.
   */
  prismX(profile: Array<[number, number]>, x0: number, x1: number, m: Mat): void {
    const at = (x: number, [y, z]: [number, number]): V3 => [x, y, z];
    for (let i = 0; i < profile.length; i++) {
      const p = profile[i]!;
      const q = profile[(i + 1) % profile.length]!;
      this.quad(at(x0, p), at(x0, q), at(x1, q), at(x1, p), m);
    }
    this.poly(
      profile.map((p) => at(x0, p)),
      m,
    );
    this.poly(
      profile.map((p) => at(x1, p)),
      m,
    );
  }

  /** The same for a profile in the x-y plane ([x, y]) extruded along z. */
  prismZ(profile: Array<[number, number]>, z0: number, z1: number, m: Mat): void {
    const at = (z: number, [x, y]: [number, number]): V3 => [x, y, z];
    for (let i = 0; i < profile.length; i++) {
      const p = profile[i]!;
      const q = profile[(i + 1) % profile.length]!;
      this.quad(at(z0, p), at(z0, q), at(z1, q), at(z1, p), m);
    }
    this.poly(
      profile.map((p) => at(z0, p)),
      m,
    );
    this.poly(
      profile.map((p) => at(z1, p)),
      m,
    );
  }

  /**
   * A screen in a frame's plane, centred at (x, y) on it: the slot `w` by `h`
   * (metres), a bezel `rim` wide standing `lip` proud of the plane, and a
   * dark recess behind the glass.
   */
  screen(name: SlotName, f: Frame, w: number, h: number, x = 0, y = 0, rim = 0.012, lip = 0.008): void {
    const g = 0.002;
    // the recess, just off the plane
    this.slab(f, w, h, 0.004, Mat.dark, x, y, 0.001);
    // the rim: four bars round the glass
    const bars: Array<[number, number, number, number]> = [
      [x, y + h / 2 + rim / 2, w + 2 * rim, rim],
      [x, y - h / 2 - rim / 2, w + 2 * rim, rim],
      [x - w / 2 - rim / 2, y, rim, h],
      [x + w / 2 + rim / 2, y, rim, h],
    ];
    for (const [bx, by, bw, bh] of bars) this.slab(f, bw, bh, lip, Mat.frame, bx, by, 0.001);
    // the glass, a piece for each of the screen's parts
    const screen = this.screens++;
    for (const part of SCREENS[name] as readonly ScreenPart[]) {
      const [u0, v0, u1, v1] = part.place;
      const px = (u: number) => x - w / 2 + u * w;
      const py = (v: number) => y + h / 2 - v * h;
      this.slots.push({ name, screen, part, corners: [on(f, px(u0), py(v0), g + 0.004), on(f, px(u1), py(v0), g + 0.004), on(f, px(u1), py(v1), g + 0.004), on(f, px(u0), py(v1), g + 0.004)] });
    }
  }

  /** A bank of switches: `rows` x `cols` little blocks on a frame, `pitch` apart. */
  switches(f: Frame, rows: number, cols: number, pitch: number, x = 0, y = 0, m: Mat = Mat.trim): void {
    for (let i = 0; i < rows; i++)
      for (let j = 0; j < cols; j++) this.slab(f, pitch * 0.45, pitch * 0.45, pitch * 0.35, m, x + (j - (cols - 1) / 2) * pitch, y + (i - (rows - 1) / 2) * pitch, 0.001);
  }

  /** A row of lamps on a frame. */
  lamps(f: Frame, mats: Mat[], pitch: number, x = 0, y = 0, size = 0.012): void {
    mats.forEach((m, i) => this.slab(f, size, size, 0.004, m, x + (i - (mats.length - 1) / 2) * pitch, y, 0.001));
  }

  /** A moving part: its geometry in its own space about `pivot` (given in this kit's space). */
  part(name: string, pivot: V3, build: (k: Kit) => void): void {
    const k = new Kit(scale(pivot, -1));
    build(k);
    this.parts.set(name, { pivot, kit: k });
  }
}

/** A face's shade 0..15 from its normal: the interior light on it, never quite black. */
export function shadeOf(n: V3): number {
  const l = Math.max(0, dot(n, LIGHT));
  return Math.min(15, Math.max(0, Math.round(4 + 10 * l)));
}

/**
 * A slot's content rectangle within it, as fractions [u0, v0, u1, v1] (v
 * down), for a pane of `paneAspect` (width / height) in a slot of
 * `slotAspect`: the pane fitted whole, centred (or against the left edge),
 * the rest glass.
 */
export function fitRect(paneAspect: number, slotAspect: number, align?: 'left'): Frac {
  if (!(paneAspect > 0) || !(slotAspect > 0)) return [0, 0, 1, 1];
  if (paneAspect > slotAspect) {
    const h = slotAspect / paneAspect;
    return [0, (1 - h) / 2, 1, (1 + h) / 2];
  }
  const w = paneAspect / slotAspect;
  return align === 'left' ? [0, 0, w, 1] : [(1 - w) / 2, 0, (1 + w) / 2, 1];
}

/** The piece `crop` (fractions) of a rectangle of pixels, rounded to whole pixels. */
export function cropRect(r: { x: number; y: number; w: number; h: number }, crop: Frac = [0, 0, 1, 1]): { x: number; y: number; w: number; h: number } {
  const x0 = Math.round(r.x + crop[0] * r.w);
  const y0 = Math.round(r.y + crop[1] * r.h);
  return { x: x0, y: y0, w: Math.round(r.x + crop[2] * r.w) - x0, h: Math.round(r.y + crop[3] * r.h) - y0 };
}

/** What a design builds round: its mech's canopy (glass.ts, canopy.ts). */
export interface Glass {
  /** the canopy's triangles as seated about the eye, pilot space: nine numbers each */
  tris: Float32Array;
  /** whether the eye sees glass along `d` (pilot space, any length) */
  sees(d: V3): boolean;
  /** the edges its frame follows: the glass's outline (boundary) and the creases between its facets */
  edges: Array<{ a: V3; b: V3; boundary: boolean }>;
  /** how far the glass reaches from straight ahead straight down, up, left and right (degrees, magnitudes; 120: all the way round) */
  down: number;
  up: number;
  left: number;
  right: number;
}

/** A design: one chassis's cockpit interior, built into its own shell. */
export interface CockpitDesign {
  /** the chassis key (chassis.ts) */
  key: string;
  name: string;
  build(k: Kit, glass: Glass): void;
}
