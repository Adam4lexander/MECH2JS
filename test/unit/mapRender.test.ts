// The overhead map's render hooks and the per-polygon fill dispatch, against
// the disassembly's cases: map_polygon_colour's class and family table,
// map_fill_polygon's black-and-outline for mode 0 and height indices for
// 0x4000, poly_fill_dispatch's wireframe (hidden-line fills black first),
// and object_view_cull's reason codes for the orthographic volume.
import { afterEach, describe, expect, it } from 'vitest';
import { MeshPolygon, Viewer, WorldObject } from '../../src/generated/classes.gen.ts';
import { radar, type RadarMode } from '../../src/sim/cockpit/radar.ts';
import { HOOK, renderOptions } from '../../src/sim/display/renderState.ts';
import { lighting } from '../../src/sim/world/environment.ts';
import { mapPolygonColour, mapVertexIndex } from '../../src/render/shading/mapColour.ts';
import { FillKind, polyFillDispatch, type PolyDraw } from '../../src/render/pipeline/fillDispatch.ts';
import { objectViewCull } from '../../src/render/pipeline/drawPipeline.ts';
import { viewerLatchGlobals } from '../../src/render/pipeline/viewLatch.ts';

const ONE = 0x20000000;
// RADAR's map mode colour table (listing/radar.txt, +0x74)
const COLOURS = [14, 10, 6, 15, 11, 245, 2, 3, 249, 255, 240, 1, 2, 0];

function withMapMode(): void {
  radar.module = { modes: [null, null, null, null, { colours: Int32Array.from(COLOURS), range: 100000 } as unknown as RadarMode, null] } as unknown as typeof radar.module;
  radar.mode = 4;
}

function ownedPolygon(type: number): MeshPolygon {
  const p = new MeshPolygon();
  const o = new WorldObject();
  o.type = type;
  p.owner = o;
  return p;
}

const out = (): PolyDraw => ({ fill: -1, kind: FillKind.ByMode, outline: -1 });

afterEach(() => {
  radar.module = null;
  radar.mode = 0;
  renderOptions.wireframeMode = 0;
  renderOptions.polygonRampOverride = 0;
  renderOptions.polygonFillHook = 0;
});

describe('map_polygon_colour', () => {
  it('colours by class and family through the mode record, height-shaded (0x4000) otherwise', () => {
    withMapMode();
    // class 0x400: t[6], mode 0
    expect(mapPolygonColour(ownedPolygon(0x400), 0x1234)).toBe(2);
    // class 0x800: the code's ramp as the row, 0x4000; a sprite code takes t[10]
    expect(mapPolygonColour(ownedPolygon(0x800), 0x1a55)).toBe(0x40a0);
    expect(mapPolygonColour(ownedPolygon(0x800), 0x3a55)).toBe(0x4000 | 240);
    // families: 0x40 t[7], 0x50 t[8], 0x80 t[9]; 0x10 / 0x20 / 0x60 keep their code
    expect(mapPolygonColour(ownedPolygon(0x40), 0x1234)).toBe(3);
    expect(mapPolygonColour(ownedPolygon(0x50), 0x1234)).toBe(249);
    expect(mapPolygonColour(ownedPolygon(0x80), 0x1234)).toBe(255);
    for (const f of [0x10, 0x20, 0x60]) expect(mapPolygonColour(ownedPolygon(f), 0x5123)).toBe(0x5123);
    // anything else: like class 0x800
    expect(mapPolygonColour(ownedPolygon(0x30), 0x1700)).toBe(0x4070);
    // the ramp override ORs 0xf0 into the table colours only
    renderOptions.polygonRampOverride = 1;
    expect(mapPolygonColour(ownedPolygon(0x400), 0)).toBe(0xf2);
    expect(mapPolygonColour(ownedPolygon(0x800), 0x1a00)).toBe(0x40a0);
  });

  it('is 0 without a mode record', () => {
    expect(mapPolygonColour(ownedPolygon(0x400), 0x1234)).toBe(0);
  });

  it("gives a vertex its row plus map_height_shade of its height", () => {
    withMapMode();
    lighting.mapHeightLow = 0;
    radar.mapHeightRange = 16000;
    // height = altitude - depth / 4: depth 4 * 95000 cm puts the vertex at 5000 cm, shade 5
    expect(mapVertexIndex(0x40a0, 4 * 95000)).toBe(0xa5);
    // clamped at 15 and at 0
    expect(mapVertexIndex(0x40a0, 0)).toBe(0xaf);
    expect(mapVertexIndex(0x40a0, 4 * 200000)).toBe(0xa0);
  });
});

describe('poly_fill_dispatch', () => {
  it('fills by mode, and draws 0x2000 as an outline', () => {
    renderOptions.polygonFillHook = HOOK.polyFillByMode;
    expect(polyFillDispatch(4, 0x1037, out())).toEqual({ fill: 0x1037, kind: FillKind.ByMode, outline: -1 });
    expect(polyFillDispatch(4, 0x20ab, out())).toEqual({ fill: -1, kind: FillKind.ByMode, outline: 0xab });
    // points and lines are not drawn
    expect(polyFillDispatch(2, 0x1037, out())).toEqual({ fill: -1, kind: FillKind.ByMode, outline: -1 });
  });

  it('wireframe 1 fills black then outlines; wireframe 2 only outlines', () => {
    renderOptions.polygonFillHook = HOOK.polyFillByMode;
    renderOptions.wireframeMode = 1;
    expect(polyFillDispatch(3, 7, out())).toEqual({ fill: 0, kind: FillKind.ByMode, outline: 7 });
    renderOptions.wireframeMode = 2;
    expect(polyFillDispatch(3, 7, out())).toEqual({ fill: -1, kind: FillKind.ByMode, outline: 7 });
  });

  it("map_fill_polygon: mode 0 black with an outline, 0x4000 by height, 0x3000 the map's sprite", () => {
    renderOptions.polygonFillHook = HOOK.mapFillPolygon;
    expect(polyFillDispatch(4, 14, out())).toEqual({ fill: 0, kind: FillKind.ByMode, outline: 14 });
    expect(polyFillDispatch(4, 0x40a0, out())).toEqual({ fill: 0x40a0, kind: FillKind.MapHeight, outline: -1 });
    expect(polyFillDispatch(3, 0x3120, out())).toEqual({ fill: 0x3120, kind: FillKind.MapSprite, outline: -1 });
    // other modes go to render_asm_sub_03bb80
    expect(polyFillDispatch(4, 0x5012, out())).toEqual({ fill: 0x5012, kind: FillKind.ByMode, outline: -1 });
  });
});

describe('object_view_cull', () => {
  /** Straight down from (0, 100000, 0): view x = world x, view y = world z, depth = 100000 - world y. */
  function downViewer(): Viewer {
    const v = new Viewer();
    v.rotation.set([ONE, 0, 0, 0, 0, ONE, 0, -ONE, 0]);
    [v.translationX, v.translationY, v.translationZ] = [0, 100000, 0];
    v.nearClip = 50;
    v.farClip = 150000;
    return v;
  }

  function object(x: number, y: number, z: number, r: number, flags = 0): WorldObject {
    const o = new WorldObject();
    [o.posX, o.posY, o.posZ, o.radius, o.flags] = [x, y, z, r, flags];
    return o;
  }

  it('returns 1 / 4 / 5 / 6 / 7 by the first test that fails, 0 inside', () => {
    viewerLatchGlobals(downViewer());
    radar.orthoLeft = -50000;
    radar.orthoRight = 50000;
    radar.orthoBottom = -37500;
    radar.orthoTop = 37500;
    expect(objectViewCull(object(0, 0, 0, 100))).toBe(0);
    expect(objectViewCull(object(0, 0, 0, 100, 0x1000))).toBe(1);
    expect(objectViewCull(object(0, 100500, 0, 100))).toBe(4);
    expect(objectViewCull(object(0, -60000, 0, 100))).toBe(5);
    expect(objectViewCull(object(60000, 0, 0, 100))).toBe(6);
    expect(objectViewCull(object(-60000, 0, 0, 100))).toBe(6);
    // within its radius of the edge: drawn
    expect(objectViewCull(object(50050, 0, 0, 100))).toBe(0);
    expect(objectViewCull(object(0, 0, 40000, 100))).toBe(7);
  });
});
