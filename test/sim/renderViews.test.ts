// The 3D views the game draws mid-frame, seen from the render port: main's
// render hook as vfx_video_sub_010320 installs it, the render-state block's
// save and restore landing every dword back in its home, the HUD's inset
// views (the damage display's rear view, the target display's wireframe of
// the target's own tree) drawn from the pose with the viewport selected and
// everything put back, and the overhead map drawn through its own hooks in an
// orthographic view.
import { beforeAll, describe, expect, it } from 'vitest';
import { ExeImage } from '../../src/data/exe/ExeImage.ts';
import { ProjectFile } from '../../src/data/prj/ProjectFile.ts';
import type { SceneNode, WorldObject } from '../../src/generated/classes.gen.ts';
import { ailTimerService } from '../../src/engine/miles/ail.ts';
import { worldRootNode } from '../../src/engine/scene/objectLists.ts';
import { bootMission } from '../../src/mission/load.ts';
import { mainLoop, mainLoopFrame } from '../../src/mission/mainLoop.ts';
import { cam } from '../../src/sim/camera/cameraUpdate.ts';
import { viewer } from '../../src/sim/camera/viewer.ts';
import { playerTargetNode } from '../../src/sim/ai/targeting.ts';
import { hud } from '../../src/sim/cockpit/hud.ts';
import { radar, vfxVideoSub0123d0 } from '../../src/sim/cockpit/radar.ts';
import { vfxVideoSub010490 } from '../../src/sim/display/mainView.ts';
import { HOOK, newRenderBlock, renderBlockRestore, renderBlockSave, renderOptions } from '../../src/sim/display/renderState.ts';
import { renderPort, type RenderPort } from '../../src/sim/display/renderPort.ts';
import { display } from '../../src/sim/display/video.ts';
import { mechs } from '../../src/sim/mech/mechGlobals.ts';
import { lighting } from '../../src/sim/world/environment.ts';
import { gameSource, hasGameData, installFiles } from '../support/env.ts';

let exe: ExeImage;
let prj: ProjectFile;
let files: Map<string, Uint8Array>;

interface Call {
  kind: 'sky' | 'list' | 'tree' | 'main';
  viewport: number;
  pane: [number, number, number, number];
  pose: number[];
  zoom: number;
  list: WorldObject | null;
  root: SceneNode | null;
  wireframe: number;
  textureOffTypeMask: number;
  cull: number;
  colour: number;
  fill: number;
  project: number;
  sky: number;
  ground: number;
}

function recorder(): { calls: Call[]; port: RenderPort } {
  const calls: Call[] = [];
  const snap = (kind: Call['kind'], list: WorldObject | null = null, root: SceneNode | null = null) => {
    const v = viewer();
    const c = display.currentViewport;
    const r = renderOptions;
    calls.push({
      kind,
      viewport: display.currentViewportMode,
      pane: [c.left, c.top, c.right, c.bottom],
      pose: [v.posX, v.posY, v.posZ, v.yaw, v.pitch, v.roll],
      zoom: v.zoom,
      list,
      root,
      wireframe: r.wireframeMode,
      textureOffTypeMask: r.textureOffTypeMask,
      cull: r.objectCullHook,
      colour: r.polygonDrawHook,
      fill: r.polygonFillHook,
      project: r.clipProjectHook,
      sky: lighting.skyEnabled,
      ground: lighting.groundEnabled,
    });
  };
  return {
    calls,
    port: {
      skyAndGround: () => snap('sky'),
      objectList: (list) => snap('list', list),
      sceneTreeSorted: (root) => snap('tree', null, root),
      mainView: () => snap('main'),
    },
  };
}

function frame(ticks = 7) {
  for (let i = 0; i < ticks; i++) ailTimerService();
  mainLoopFrame();
}

function running(): void {
  const p = mechs.mechTable[mechs.playerMechIndex]!;
  for (let f = 0; f < 400 && p.loadout!.status !== 2; f++) frame();
  expect(p.loadout!.status).toBe(2);
}

describe.runIf(hasGameData)('render views', () => {
  beforeAll(async () => {
    const src = gameSource();
    exe = ExeImage.fromExe(await src.read('MW2.EXE'));
    prj = new ProjectFile(await src.read('MW2.PRJ'));
    files = installFiles();
  });

  it('main installs the frame render and the main draw hooks, and the frame asks for the main view', () => {
    bootMission({ exe, prj, looseFiles: files, mission: 'AMY_SCN1' });
    expect(mainLoop.renderHook).toBe(vfxVideoSub010490);
    expect(renderOptions.objectCullHook).toBe(HOOK.objectCullMainView);
    expect(renderOptions.clipProjectHook).toBe(HOOK.clipProjectPerspective);
    expect(renderOptions.polygonDrawHook).toBe(HOOK.polygonResolveColour);
    expect(renderOptions.polygonFillHook).toBe(HOOK.polyFillByMode);
    const { calls, port } = recorder();
    renderPort.current = port;
    try {
      frame();
    } finally {
      renderPort.current = null;
    }
    expect(calls.filter((c) => c.kind === 'main').length).toBe(1);
  });

  it('the render-state block goes back dword for dword into its homes', () => {
    bootMission({ exe, prj, looseFiles: files, mission: 'AMY_SCN1' });
    const before = renderBlockSave(newRenderBlock());
    // distinct values in every dword: a restore that put one into another's home would show
    const marked = newRenderBlock();
    for (let i = 0; i < 26; i++) marked.words[i] = 0x1000 + i;
    marked.renderHook = null;
    renderBlockRestore(marked);
    expect(cam.dat00097020).toBe(0x1000);
    expect(lighting.skyEnabled).toBe(0x1007);
    expect(renderOptions.wireframeMode).toBe(0x100d);
    expect(renderOptions.textureOffTypeMask).toBe(0x1014);
    expect(renderOptions.polygonFillHook).toBe(0x1019);
    expect(mainLoop.renderHook).toBeNull();
    const again = renderBlockSave(newRenderBlock());
    const want = Array.from(marked.words);
    want[21] = 0; // 0x97074, the render hook, travels as the port's function
    expect(Array.from(again.words)).toEqual(want);
    renderBlockRestore(before);
    expect(mainLoop.renderHook).toBe(vfxVideoSub010490);
    expect(Array.from(renderBlockSave(newRenderBlock()).words)).toEqual(Array.from(before.words));
  });

  it('the rear view draws sky, ground and the world list from behind the eye, then puts everything back', () => {
    bootMission({ exe, prj, looseFiles: files, mission: 'AMY_SCN1' });
    running();
    hud.damageDisplayMode = 3;
    const { calls, port } = recorder();
    const block = renderBlockSave(newRenderBlock());
    renderPort.current = port;
    try {
      frame();
    } finally {
      renderPort.current = null;
    }
    const e = mechs.mechTable[mechs.playerMechIndex]!;
    const inset = calls.filter((c) => c.viewport === 5);
    expect(inset.map((c) => c.kind)).toEqual(lighting.skyEnabled !== 0 || lighting.groundEnabled !== 0 ? ['sky', 'list'] : ['list']);
    const list = inset.at(-1)!;
    expect(list.list).toBe(worldRootNode);
    expect(list.zoom).toBe(0x20000);
    // yaw half a turn from the mech's heading, level
    expect(list.pose[3]).toBe((e.heading + 0xb40000) | 0);
    expect(list.pose[4]).toBe(0);
    // the pane is viewportModes[5]'s, and the inset render state is set
    const vm = lighting.viewportModes[5]!;
    expect(list.pane).toEqual([vm.left, vm.top, vm.right, vm.bottom]);
    expect(list.textureOffTypeMask).toBe(0xb00);
    expect(list.cull).toBe(HOOK.objectCullMainView);
    // afterwards: main's viewport, the block as it was
    expect(display.currentViewportMode).toBe(0);
    expect(Array.from(renderBlockSave(newRenderBlock()).words)).toEqual(Array.from(block.words));
    expect(viewer().zoom).not.toBe(0x20000);
  });

  it("the target display draws only the target's own tree, in wireframe while its mode is 1", () => {
    bootMission({ exe, prj, looseFiles: files, mission: 'AMY_SCN1' });
    running();
    const p = mechs.mechTable[mechs.playerMechIndex]!;
    const enemy = mechs.mechTable.findIndex((m, i) => m && i !== mechs.playerMechIndex && m.node);
    expect(enemy).toBeGreaterThanOrEqual(0);
    p.targetHandle = 0x200 | enemy;
    for (const mode of [1, 2]) {
      hud.targetDisplayMode = mode;
      const { calls, port } = recorder();
      renderPort.current = port;
      try {
        frame();
      } finally {
        renderPort.current = null;
      }
      const t = calls.filter((c) => c.viewport === 7);
      expect(t.map((c) => c.kind)).toEqual(['tree']);
      expect(t[0]!.root).toBe(playerTargetNode());
      expect(t[0]!.wireframe).toBe(mode === 1 ? 1 : 0);
      expect(t[0]!.sky).toBe(0);
      expect(t[0]!.ground).toBe(0);
      expect(renderOptions.wireframeMode).toBe(0);
    }
  });

  it('the map draws the world list through its own hooks in an orthographic view, and hands them back', () => {
    bootMission({ exe, prj, looseFiles: files, mission: 'AMY_SCN1' });
    running();
    frame();
    vfxVideoSub0123d0();
    frame();
    const { calls, port } = recorder();
    renderPort.current = port;
    try {
      frame();
      frame();
    } finally {
      renderPort.current = null;
    }
    expect(radar.mode).toBe(4);
    const map = calls.filter((c) => c.kind === 'list' && c.viewport === 10);
    expect(map.length).toBeGreaterThan(0);
    for (const c of map) {
      expect(c.cull).toBe(HOOK.mapObjectCull);
      expect(c.colour).toBe(HOOK.mapPolygonColour);
      expect(c.fill).toBe(HOOK.mapFillPolygon);
      expect(c.project).toBe(HOOK.orthoClipProject);
      // straight down from the mode's altitude
      expect(c.pose[1]).toBe(radar.module!.modes[4]!.range);
      expect(c.pose[4]).toBe(0x5a0000);
    }
    // the main view is not asked for while the map has the render hook
    expect(calls.some((c) => c.kind === 'main')).toBe(false);
    expect(renderOptions.objectCullHook).toBe(HOOK.objectCullMainView);
    expect(renderOptions.polygonFillHook).toBe(HOOK.polyFillByMode);
    expect(renderOptions.clipProjectHook).toBe(HOOK.clipProjectPerspective);
  });
});
