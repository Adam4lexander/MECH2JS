/**
 * The standard cockpit the designs are built from: the cabin round the
 * mech's own glass, a console carrying the six screens, the seat with its
 * armrests, throttle and stick, pedals, and ribs and fittings on the walls -
 * laid out one of two ways and dressed in one of two styles. A design gives
 * its measurements, layout and style, then adds what is its own.
 *
 * LAYOUTS
 *   wrap   a console across the front under the glass: a centre face (the
 *          target display and the radar), wings turned in either side (the
 *          status gauges left; weapons over damage and the speed right). For
 *          glass that stops above about 30 degrees down.
 *   split  two pods either side, the middle left open down to the floor:
 *          for glass that runs on down (the Mad Dog's and the Nova's nose
 *          glass), so looking down the pilot sees the ground. Left pod: the
 *          target display and the radar (inboard); right pod: weapons
 *          (inboard) and the speed over damage and the status gauges.
 *
 * Screens are laid out on their faces (archetypes.ts layoutScreens): in rows,
 * sized by their shapes, always inside the face with a margin; lamps and
 * switches keep to a strip along each face's foot, trim to its top edge, so
 * nothing sits on a screen.
 *
 * STYLES
 *   clan   smooth faces, a lamp strip along each console's top, few switches
 *   is     the Inner Sphere's: hazard striping, switch banks, pipes along
 *          the walls
 *
 * @portOnly
 */
import { boxHit, dash, decorate, glassCabin, insideOutline, layoutScreens, pedalsAndFloor, pod, seat, topTrim, wallDetail, type CabinBox, type Dash, type FaceArea } from './archetypes.ts';
import { dir, facingEye, Kit, Mat, norm, type Glass, type SlotName, type V3 } from './kit.ts';

export interface StandardSpec {
  box: CabinBox;
  layout: 'wrap' | 'split';
  style: 'clan' | 'is';
  /** wrap: the console's top edge, degrees down and metres out; its face's height (m); the centre face's half-width; wings */
  console?: { pitch?: number; dist?: number; height?: number; halfWidth?: number; wing?: number; turn?: number };
  /** split: the pods' yaw either side (degrees), their pitch and distance */
  pods?: { yaw?: number; pitch?: number; dist?: number };
  /** the armrests: half the distance between them, and their height */
  arms?: { x?: number; y?: number };
  /** an overhead panel (off with false) */
  overhead?: boolean;
  /** ribs on the walls and roof, metres apart (0: none) */
  ribs?: number;
}

export interface Standard {
  glass: Glass;
  box: CabinBox;
  /** wrap: the console */
  dash: Dash | null;
  /** split: the pods' faces */
  left: FaceArea | null;
  right: FaceArea | null;
}

export function standard(k: Kit, glass: Glass, s: StandardSpec): Standard {
  const b = s.box;
  glassCabin(k, glass.outline, b);
  const faces: Array<[FaceArea, SlotName[][]]> = [];
  let d: Dash | null = null;
  let left: FaceArea | null = null;
  let right: FaceArea | null = null;
  if (s.layout === 'wrap') {
    const c = s.console ?? {};
    const pitch = c.pitch ?? -18;
    const dist = c.dist ?? 0.66;
    const height = c.height ?? 0.25;
    const top = dir(0, pitch, dist);
    // the face leans back 25 degrees from upright: its bottom edge nearer the pilot
    const lean = (25 * Math.PI) / 180;
    const bottom: V3 = [0, top[1] - height * Math.cos(lean), top[2] + height * Math.sin(lean)];
    const sill = boxHit(b, norm(dir(0, -Math.min(glass.down, 60) - 2, 1)));
    d = dash(k, { top: [top[1], top[2]], bottom: [bottom[1], bottom[2]], halfWidth: c.halfWidth ?? 0.22, wing: { width: c.wing ?? 0.28, turn: c.turn ?? 42 }, sill: Math.min(sill[1], top[1] - 0.02), depth: -sill[2], floor: b.floor });
    // the target display and the radar on the centre face to themselves, where the flat view keeps them whole
    faces.push([d.centre, [['target', 'radar']]], [d.left!, [['status']]], [d.right!, [['weapons'], ['damage', 'throttle']]]);
  } else {
    const p = s.pods ?? {};
    const yaw = p.yaw ?? 30;
    const pitch = p.pitch ?? -23;
    const dist = p.dist ?? 0.62;
    left = pod(k, -yaw, pitch, dist, 0.42, 0.26, 0.12, b.floor, 22);
    right = pod(k, yaw, pitch, dist, 0.42, 0.26, 0.12, b.floor, 22);
    // the target display and the radar on the left pod to themselves, the radar inboard
    faces.push([left, [['target', 'radar']]], [right, [['weapons', 'throttle'], ['damage', 'status']]]);
  }
  for (const [a, rows] of faces) {
    const l = layoutScreens(k, a, rows);
    decorate(k, a, l, s.style);
    topTrim(k, a, s.style);
  }
  const arms = s.arms ?? {};
  seat(k, { armX: arms.x ?? 0.42, armY: arms.y ?? -0.52, floor: b.floor, style: s.style });
  pedalsAndFloor(k, b.floor, -0.45, -0.1, 0.35);
  if ((s.ribs ?? 0.4) > 0) wallDetail(k, b, glass.outline, s.ribs ?? 0.4);
  if (s.overhead !== false && !insideOutline(glass.outline, 0, 70)) {
    const over = facingEye([0, b.roof - 0.08, -0.3], -60);
    k.slab(over, 0.36, 0.14, -0.04, Mat.panel);
    k.switches(over, 2, 6, 0.028, 0, 0.012, s.style === 'is' ? Mat.frame : Mat.trim);
    k.lamps(over, [Mat.lampGreen, Mat.lampAmber, Mat.lampGreen], 0.03, 0, -0.05, 0.012);
  }
  if (s.style === 'is') {
    // pipes along the walls at knee height and under the roof
    for (const side of [-1, 1] as const) {
      const x = side * (b.halfWidth - 0.05);
      k.pipe([x, b.floor + 0.3, -b.front + 0.05], [x, b.floor + 0.3, b.back - 0.05], 0.018, Mat.trim);
      k.pipe([x, b.roof - 0.06, -0.2], [x, b.roof - 0.06, b.back - 0.05], 0.014, Mat.frame);
    }
  }
  return { glass, box: b, dash: d, left, right };
}
