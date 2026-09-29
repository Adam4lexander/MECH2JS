/**
 * Assemblies the cockpit designs share: the cabin round the mech's own glass
 * (glassCabin), the dashboard and side pods and the screens laid out on
 * their faces (layoutScreens), the seat with its armrests, the throttle and
 * the stick, the pedals and the floor, and the ribs and fittings on the walls
 * (kept off the glass). Each takes the measurements a design gives it; the
 * designs add their own character.
 *
 * @portOnly
 */
import { add, dir, facingEye, frameAt, Kit, Mat, norm, on, scale, sub, type Frame, type Glass, type SlotName, type V3 } from './kit.ts';

const RAD = Math.PI / 180;

/** A face's usable rectangle: its frame (centred) and its width and height, metres. */
export interface FaceArea {
  f: Frame;
  w: number;
  h: number;
}

export interface DashSpec {
  /** the face's top edge: height and distance ahead (metres from the eye) */
  top: [number, number];
  /** the face's bottom edge */
  bottom: [number, number];
  /** half the centre face's width */
  halfWidth: number;
  /** the wings either side: their width and how far they turn towards the pilot (degrees) */
  wing?: { width: number; turn: number };
  /** where the shelf meets the window wall (the sill): height; z is the cabin's depth */
  sill: number;
  depth: number;
  floor: number;
}

export interface Dash {
  /** the centre face and the wings */
  centre: FaceArea;
  left: FaceArea | null;
  right: FaceArea | null;
}

/** The dashboard: a shelf from the sill to the face, the face tipped towards the pilot, wings turned in. */
export function dash(k: Kit, s: DashSpec): Dash {
  const [ty, tz] = s.top;
  const [by, bz] = s.bottom;
  const hw = s.halfWidth;
  // the centre section's side profile: sill, face top, face bottom, down to the floor, back to the wall
  const profile: Array<[number, number]> = [
    [s.sill, -s.depth],
    [ty, tz],
    [by, bz],
    [s.floor, bz],
    [s.floor, -s.depth],
  ];
  k.prismX(profile, -hw, hw, Mat.hull);
  const faceMid: V3 = [0, (ty + by) / 2, (tz + bz) / 2];
  const faceN = norm([0, bz - tz, -(by - ty)]);
  const faceHeight = Math.hypot(ty - by, tz - bz);
  const centre: FaceArea = { f: frameAt(faceMid, faceN[2] > 0 ? faceN : [-faceN[0], -faceN[1], -faceN[2]]), w: 2 * hw, h: faceHeight };
  let left: FaceArea | null = null;
  let right: FaceArea | null = null;
  if (s.wing) {
    const w = s.wing.width;
    const a = s.wing.turn * RAD;
    for (const side of [-1, 1] as const) {
      // the wing hinges on the centre face's edge and turns towards the pilot
      const hx = side * hw;
      const ex = hx + side * w * Math.cos(a);
      const dz = w * Math.sin(a);
      const topIn: V3 = [hx, ty, tz];
      const botIn: V3 = [hx, by, bz];
      const topOut: V3 = [ex, ty, tz + dz];
      const botOut: V3 = [ex, by, bz + dz];
      // face and a shelf back to the wall, and a side cheek down to the floor
      k.quad(topIn, topOut, botOut, botIn, Mat.hull);
      k.quad([hx, s.sill, -s.depth], [ex, s.sill, -s.depth], topOut, topIn, Mat.hull);
      k.quad(botIn, botOut, [ex, s.floor, bz + dz], [hx, s.floor, bz], Mat.hull);
      k.poly([[ex, s.sill, -s.depth], topOut, botOut, [ex, s.floor, bz + dz], [ex, s.floor, -s.depth]], Mat.panel);
      const mid: V3 = [(hx + ex) / 2, (ty + by) / 2, (tz + bz) / 2 + dz / 2];
      const n = norm(crossN(sub(topOut, topIn), sub(botIn, topIn)));
      const area: FaceArea = { f: frameAt(mid, n[2] > 0 ? n : [-n[0], -n[1], -n[2]]), w, h: faceHeight };
      if (side < 0) left = area;
      else right = area;
    }
  }
  return { centre, left, right };
}

function crossN(a: V3, b: V3): V3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

/** A side pod: a block standing on the floor at yaw `yaw`, its face tipped towards the pilot, `w` by `h`, for screens. */
export function pod(k: Kit, yaw: number, pitch: number, dist: number, w: number, h: number, depth: number, floor: number, tilt = 25): FaceArea {
  const c = dir(yaw, pitch, dist);
  const f = facingEye(c, tilt);
  // the face, a slab behind it, and a column to the floor
  k.slab(f, w, h, -depth, Mat.hull);
  const base = on(f, 0, -h / 2 + 0.02, -depth / 2);
  k.box([base[0], (base[1] + floor) / 2, base[2]], [w * 0.7, Math.max(0.02, base[1] - floor), depth * 0.8], Mat.panel);
  return { f, w, h };
}

/**
 * Each screen's shape, width over height: what its parts (kit.ts SCREENS)
 * fill - the target display (103 x 80) with the readout's 119 x 40 under it
 * at 0.87 of its scale; the three status gauges (120 x 35, 79 x 35) and the
 * MASC line stacked; the speed over the throttle bar. The content is fitted
 * to its slot either way.
 */
export const SLOT_ASPECT: Record<SlotName, number> = {
  radar: 1,
  throttle: 0.54,
  status: 0.99,
  target: 0.9,
  weapons: 1.85,
  damage: 1.29,
};

/** The tallest a screen of each kind is laid out, metres. */
const SLOT_CAP: Record<SlotName, number> = {
  radar: 0.16,
  throttle: 0.14,
  status: 0.13,
  target: 0.17,
  weapons: 0.12,
  damage: 0.11,
};

export interface ScreenLayout {
  /** the centre height (on the face's up axis) of the strip left for lamps and switches, and its width */
  decorY: number;
  decorW: number;
}

/**
 * Lays screens out on a face in rows, top to bottom: each row as tall as its
 * screens' shapes allow across the face's width (and no taller than each
 * kind's cap), all rows scaled together to fit its height, the block centred
 * - so every screen sits inside its face with a margin round it, and a strip
 * along the face's foot is kept for lamps and switches.
 */
export function layoutScreens(k: Kit, a: FaceArea, rows: SlotName[][], opts: { margin?: number; top?: number; gap?: number; decor?: number } = {}): ScreenLayout {
  const margin = opts.margin ?? 0.018;
  // above the screens, room for the face's top trim (topTrim) clear of their bezels
  const topMargin = opts.top ?? 0.03;
  const gap = opts.gap ?? 0.02;
  const decor = opts.decor ?? 0.03;
  const W = a.w - 2 * margin;
  const H = a.h - margin - topMargin - (decor > 0 ? decor + gap : 0);
  const heights = rows.map((row) => {
    const aspects = row.reduce((s, n) => s + SLOT_ASPECT[n], 0);
    const fit = (W - gap * (row.length - 1)) / aspects;
    return Math.min(fit, ...row.map((n) => SLOT_CAP[n]));
  });
  const total = heights.reduce((s, h) => s + h, 0) + gap * (rows.length - 1);
  const shrink = total > H ? (H - gap * (rows.length - 1)) / (total - gap * (rows.length - 1)) : 1;
  const hs = heights.map((h) => h * shrink);
  const block = hs.reduce((s, h) => s + h, 0) + gap * (rows.length - 1);
  // the block centred in the space above the decor strip
  const top = a.h / 2 - topMargin - (H - block) / 2;
  let y = top;
  rows.forEach((row, i) => {
    const h = hs[i]!;
    const widths = row.map((n) => h * SLOT_ASPECT[n]);
    const rowW = widths.reduce((s, w) => s + w, 0) + gap * (row.length - 1);
    let x = -rowW / 2;
    row.forEach((n, j) => {
      const w = widths[j]!;
      k.screen(n, a.f, w, h, x + w / 2, y - h / 2);
      x += w + gap;
    });
    y -= h + gap;
  });
  return { decorY: -a.h / 2 + margin + decor / 2, decorW: W };
}

/** Lamps and a switch bank along a face's decor strip, spread to its width. */
export function decorate(k: Kit, a: FaceArea, l: ScreenLayout, style: 'clan' | 'is'): void {
  const lamps = style === 'clan' ? [Mat.lampGreen, Mat.lampGreen, Mat.lampAmber] : [Mat.lampRed, Mat.lampAmber, Mat.lampGreen];
  const lampW = lamps.length * 0.022;
  k.lamps(a.f, lamps, 0.022, -l.decorW / 2 + lampW / 2, l.decorY, 0.011);
  const room = l.decorW - lampW - 0.03;
  const cols = Math.max(0, Math.min(style === 'is' ? 8 : 4, Math.floor(room / 0.022)));
  if (cols > 0) k.switches(a.f, 1, cols, 0.022, l.decorW / 2 - (cols * 0.022) / 2, l.decorY, style === 'is' ? Mat.trim : Mat.frame);
}

/** A trim line along a face's top edge, in its margin: hazard stripes for the Inner Sphere, a lamp strip for the Clans. */
export function topTrim(k: Kit, a: FaceArea, style: 'clan' | 'is'): void {
  const y = a.h / 2 - 0.009;
  if (style === 'is') {
    const n = Math.floor((a.w - 0.03) / 0.024);
    for (let i = 0; i < n; i++) k.slab(a.f, 0.012, 0.008, 0.002, i % 2 ? Mat.dark : Mat.lampAmber, (i - (n - 1) / 2) * 0.024, y, 0.001);
  } else k.slab(a.f, a.w - 0.06, 0.004, 0.002, Mat.lampGreen, 0, y, 0.001);
}

/**
 * The seat the pilot sits in - the eye some 70 cm over its pan, the headrest
 * just behind the head - with its armrests (the throttle on the left, the
 * stick on the right), and straps down its back.
 */
export function seat(k: Kit, o: { armX: number; armY: number; floor: number; style: 'clan' | 'is' }): void {
  const pan = o.armY - 0.14;
  const half = o.armX - 0.08;
  // the pan and its cushion, on a pedestal
  k.box([0, pan - 0.05, 0.08], [2 * half, 0.1, 0.5], Mat.hull);
  k.box([0, pan + 0.012, 0.06], [2 * half - 0.04, 0.025, 0.44], Mat.panel);
  k.box([0, (pan - 0.1 + o.floor) / 2, 0.12], [0.3, pan - 0.1 - o.floor, 0.3], Mat.panel);
  // the back, leaning a little, with bolsters, and the headrest behind the head
  const lean = 0.12;
  const b0: V3 = [0, pan, 0.3];
  const b1: V3 = [0, 0.02, 0.3 + lean];
  k.beam(b0, b1, 2 * half - 0.02, 0.07, Mat.hull, [0, 0, -1]);
  for (const side of [-1, 1] as const) k.beam(add(b0, [side * (half - 0.02), 0, -0.04]), add(b1, [side * (half - 0.04), 0, -0.04]), 0.05, 0.08, Mat.trim, [0, 0, -1]);
  k.box([0, 0.1, 0.3 + lean + 0.02], [0.28, 0.2, 0.08], Mat.hull);
  // straps: two down from the shoulders, a buckle where they meet
  for (const side of [-1, 1] as const) k.beam([side * 0.12, -0.05, 0.26 + lean * 0.3], [side * 0.05, pan + 0.03, 0.2], 0.035, 0.008, Mat.dark, [0, 0, -1]);
  k.box([0, pan + 0.04, 0.18], [0.05, 0.04, 0.012], Mat.frame);
  // armrests on the seat's sides
  for (const side of [-1, 1] as const) {
    const x = side * o.armX;
    k.box([x, (o.armY + pan) / 2, -0.08], [0.16, o.armY - pan, 0.5], Mat.hull);
    k.box([x, o.armY + 0.005, -0.1], [0.13, 0.01, 0.42], Mat.panel);
  }
  controls(k, o.armX, o.armY, o.style);
}

/** The throttle quadrant on the left armrest and the stick on the right, each moving about its pivot. */
function controls(k: Kit, armX: number, armY: number, style: 'clan' | 'is'): void {
  // the throttle's gate: two rails either side of its slot
  const tz = -0.2;
  for (const dx of [-0.022, 0.022]) k.box([-armX + dx, armY + 0.02, tz], [0.012, 0.03, 0.2], Mat.frame);
  k.part('throttle', [-armX, armY + 0.02, tz], (p) => {
    p.box([0, 0.08, 0], [0.028, 0.16, 0.028], Mat.frame);
    p.box([0, 0.18, -0.01], [0.075, 0.06, 0.07], Mat.trim);
    p.box([0.025, 0.215, -0.03], [0.014, 0.012, 0.014], Mat.lampRed);
    p.box([-0.025, 0.215, -0.03], [0.014, 0.012, 0.014], style === 'is' ? Mat.lampAmber : Mat.lampGreen);
  });
  // the stick: a boot, the shaft, a grip leaning forward, the trigger and a hat
  k.box([armX, armY + 0.02, -0.18], [0.08, 0.04, 0.08], Mat.dark);
  k.part('stick', [armX, armY + 0.02, -0.18], (p) => {
    p.box([0, 0.1, 0], [0.03, 0.2, 0.03], Mat.frame);
    p.box([0, 0.25, -0.01], [0.05, 0.11, 0.055], Mat.trim);
    p.box([0, 0.23, -0.045], [0.018, 0.03, 0.015], Mat.lampRed);
    p.box([0, 0.31, -0.005], [0.022, 0.012, 0.022], Mat.lampAmber);
  });
}

/** Two pedals on the floor ahead of the seat, on rails, and grating strips across the floor. */
export function pedalsAndFloor(k: Kit, floor: number, z0: number, z1: number, halfWidth: number): void {
  for (const side of [-1, 1] as const) {
    const x = side * 0.17;
    k.box([x, floor + 0.025, -0.58], [0.05, 0.05, 0.2], Mat.frame);
    const f = frameAt([x, floor + 0.12, -0.6], [0, 0.7, 0.7]);
    k.slab(f, 0.1, 0.2, 0.02, Mat.trim);
  }
  for (let z = z0; z < z1; z += 0.07) k.box([0, floor + 0.004, z], [2 * halfWidth - 0.1, 0.008, 0.025], Mat.dark);
}

/**
 * Ribs up the side walls and across the roof, every `spacing` metres, where
 * the wall is solid - broken where the glass is, so a rib never crosses the
 * view - and fittings on the back wall: a hatch, an extinguisher.
 */
export function wallDetail(k: Kit, b: CabinBox, glass: Glass, spacing = 0.4): void {
  const solid = (p: V3) => !glass.sees(p);
  /** a rib from a to b, in pieces where the wall behind is solid */
  const rib = (a: V3, c: V3, n: V3) => {
    const steps = Math.max(1, Math.round(Math.hypot(...sub(c, a)) / 0.05));
    let start = -1;
    for (let i = 0; i <= steps; i++) {
      const ok = i < steps && solid(add(a, scale(sub(c, a), (i + 0.5) / steps)));
      if (ok && start < 0) start = i;
      if (!ok && start >= 0) {
        const p0 = add(add(a, scale(sub(c, a), start / steps)), scale(n, 0.02));
        const p1 = add(add(a, scale(sub(c, a), i / steps)), scale(n, 0.02));
        k.beam(p0, p1, 0.04, 0.04, Mat.frame, n);
        start = -1;
      }
    }
  };
  for (let z = -b.front + spacing; z < b.back - 0.1; z += spacing) {
    for (const side of [-1, 1] as const) rib([side * b.halfWidth, b.floor, z], [side * b.halfWidth, b.roof, z], [-side, 0, 0]);
    rib([-b.halfWidth, b.roof, z], [b.halfWidth, b.roof, z], [0, -1, 0]);
  }
  // the back wall: a hatch's frame and handle, an extinguisher in its clip
  const zb = b.back - 0.01;
  const hatch: Array<[V3, V3]> = [
    [[-0.3, -0.45, zb], [0.3, -0.45, zb]],
    [[0.3, -0.45, zb], [0.3, 0.35, zb]],
    [[0.3, 0.35, zb], [-0.3, 0.35, zb]],
    [[-0.3, 0.35, zb], [-0.3, -0.45, zb]],
  ];
  for (const [p0, p1] of hatch) if (solid(p0) && solid(p1)) k.beam(p0, p1, 0.035, 0.02, Mat.frame, [0, 0, -1]);
  if (solid([0.2, -0.05, zb])) k.box([0.2, -0.05, zb - 0.02], [0.12, 0.03, 0.03], Mat.trim);
  const ex: V3 = [-b.halfWidth + 0.1, b.floor + 0.25, b.back - 0.06];
  if (solid(ex)) {
    k.pipe(add(ex, [0, -0.1, 0]), add(ex, [0, 0.1, 0]), 0.03, Mat.lampRed);
    k.box(add(ex, [0, 0.12, 0]), [0.03, 0.04, 0.03], Mat.frame);
    k.box(add(ex, [0, 0, 0.035]), [0.08, 0.025, 0.015], Mat.dark);
  }
}

/** A cabin's box, metres from the eye: half its width, its floor and roof heights, how far its front and back walls stand. */
export interface CabinBox {
  halfWidth: number;
  floor: number;
  roof: number;
  front: number;
  back: number;
}

/** Where the ray from the eye along unit `d` leaves the box. */
export function boxHit(b: CabinBox, d: V3): V3 {
  let t = Infinity;
  const test = (num: number, den: number) => {
    if (Math.abs(den) > 1e-9) {
      const s = num / den;
      if (s > 0 && s < t) t = s;
    }
  };
  test(b.halfWidth, d[0]);
  test(-b.halfWidth, d[0]);
  test(b.roof, d[1]);
  test(b.floor, d[1]);
  test(-b.front, d[2]);
  test(b.back, d[2]);
  return [d[0] * t, d[1] * t, d[2] * t];
}

/**
 * A cabin whose glass is the mech's own: the box's walls, tiled in `cell`
 * squares, with every square through which the eye sees the canopy
 * (canopy.ts) left open - so the windows have the exterior's shape, a
 * bubble canopy opens the roof and a wrap-round one the side walls. The
 * frame follows the canopy's edges - its outline and the creases between its
 * facets - carried out along the eye's rays onto the walls, so it lies
 * where the openings' edges are and crosses them where the facets meet, and
 * hides the squares' steps. Runs of wall squares merge into single quads.
 */
export function glassCabin(k: Kit, glass: Glass, b: CabinBox, opts: { cell?: number; rim?: number; crease?: number; rimDepth?: number } = {}): void {
  const cell = opts.cell ?? 0.05;
  const open = (p: V3) => glass.sees(p);
  // each face: its origin corner and two edge vectors (u across, v up), tiled
  const W = b.halfWidth;
  const faces: Array<{ o: V3; u: V3; v: V3; m: Mat }> = [
    { o: [-W, b.floor, -b.front], u: [2 * W, 0, 0], v: [0, b.roof - b.floor, 0], m: Mat.hull }, // front
    { o: [-W, b.floor, b.back], u: [2 * W, 0, 0], v: [0, b.roof - b.floor, 0], m: Mat.panel }, // back
    { o: [-W, b.floor, b.back], u: [0, 0, -(b.front + b.back)], v: [0, b.roof - b.floor, 0], m: Mat.hull }, // left
    { o: [W, b.floor, b.back], u: [0, 0, -(b.front + b.back)], v: [0, b.roof - b.floor, 0], m: Mat.hull }, // right
    { o: [-W, b.roof, b.back], u: [2 * W, 0, 0], v: [0, 0, -(b.front + b.back)], m: Mat.hull }, // roof
    { o: [-W, b.floor, b.back], u: [2 * W, 0, 0], v: [0, 0, -(b.front + b.back)], m: Mat.panel }, // floor
  ];
  const at = (f: (typeof faces)[number], s: number, t: number): V3 => [f.o[0] + f.u[0] * s + f.v[0] * t, f.o[1] + f.u[1] * s + f.v[1] * t, f.o[2] + f.u[2] * s + f.v[2] * t];
  for (const f of faces) {
    const lu = Math.hypot(...f.u);
    const lv = Math.hypot(...f.v);
    const nu = Math.max(1, Math.round(lu / cell));
    const nv = Math.max(1, Math.round(lv / cell));
    for (let j = 0; j < nv; j++) {
      let run = -1;
      for (let i = 0; i <= nu; i++) {
        const solid = i < nu && !open(at(f, (i + 0.5) / nu, (j + 0.5) / nv));
        if (solid && run < 0) run = i;
        if (!solid && run >= 0) {
          k.quad(at(f, run / nu, j / nv), at(f, i / nu, j / nv), at(f, i / nu, (j + 1) / nv), at(f, run / nu, (j + 1) / nv), f.m);
          run = -1;
        }
      }
    }
  }
  // the frame along the canopy's edges, on the walls and a little in from them: each edge in pieces a few
  // centimetres long, so one that crosses from wall to roof bends with them. A crease is left out within
  // CLEAR degrees of straight ahead, where the reticle is (the Timber Wolf's nose facets meet down the middle)
  const CLEAR = 14;
  const onWall = (p: V3): V3 => scale(boxHit(b, norm(p)), 0.985);
  const offAxis = (p: V3) => (Math.acos(Math.max(-1, Math.min(1, -norm(p)[2]))) * 180) / Math.PI;
  for (const e of glass.edges) {
    const w = e.boundary ? (opts.rim ?? 0.045) : (opts.crease ?? 0.03);
    const n = Math.max(1, Math.ceil(Math.hypot(...sub(e.b, e.a)) / 0.06));
    let prev = e.a;
    for (let i = 1; i <= n; i++) {
      const next = add(e.a, scale(sub(e.b, e.a), i / n));
      if (e.boundary || offAxis(add(prev, next)) > CLEAR) k.beam(onWall(prev), onWall(next), w, opts.rimDepth ?? 0.04, Mat.frame, norm(prev));
      prev = next;
    }
  }
}
