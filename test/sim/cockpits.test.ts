// The hand-built cockpits against the game: every chassis the mission picker
// offers resolves to a design, and the glass table (render/cockpit/glass.ts)
// is what its original shell shows from its eye.
import { beforeAll, describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { ExeImage } from '../../src/data/exe/ExeImage.ts';
import { ProjectFile } from '../../src/data/prj/ProjectFile.ts';
import { mechCatalog, type MechChoice } from '../../src/data/catalog/mechs.ts';
import { ailTimerService } from '../../src/engine/miles/ail.ts';
import { bootMission } from '../../src/mission/load.ts';
import { mainLoopFrame } from '../../src/mission/mainLoop.ts';
import { viewer } from '../../src/sim/camera/viewer.ts';
import { viewScene } from '../../src/sim/world/viewScene.ts';
import { SceneRenderer } from '../../src/render/SceneRenderer.ts';
import { cameraFromViewer } from '../../src/render/bridge/cameraViewer.ts';
import { cockpitChassis } from '../../src/render/cockpit/chassis.ts';
import { DESIGNS } from '../../src/render/cockpit/designs/index.ts';
import { GLASS } from '../../src/render/cockpit/glass.ts';
import { ShellProbe } from '../../src/render/cockpit/shell.ts';
import { gameSource, hasGameData, installFiles } from '../support/env.ts';

describe.runIf(hasGameData)('hand-built cockpits', () => {
  let exe: ExeImage;
  let prj: ProjectFile;
  const chassis: MechChoice[] = [];

  beforeAll(async () => {
    const src = gameSource();
    exe = ExeImage.fromExe(await src.read('MW2.EXE'));
    prj = new ProjectFile(await src.read('MW2.PRJ'));
    const seen = new Set<string>();
    for (const m of mechCatalog(prj)) if (!seen.has(m.stream.name)) {
      seen.add(m.stream.name);
      chassis.push(m);
    }
  });

  it('gives every chassis a design, and its glass is its shell as seen from its eye', () => {
    const keys = new Set<string>();
    for (const m of chassis) {
      bootMission({ exe, prj, looseFiles: installFiles({ pilot: { name: 'T', mech: m }, starmates: [] }), mission: 'BLONSCN1' });
      for (let f = 0; f < 3; f++) {
        for (let i = 0; i < 9; i++) ailTimerService();
        mainLoopFrame();
      }
      const key = cockpitChassis(prj);
      // the turret gamepiece has no cockpit shell: it keeps the original view
      if (m.stream.name === 'dumbfuck') {
        expect(key).toBe('');
        continue;
      }
      expect(DESIGNS[key], `${m.stream.name} -> ${key}`).toBeDefined();
      keys.add(key);
      // the Tarantula sits in the Kit Fox's shell placed elsewhere: its eye sees it wrongly, and it takes the Kit Fox's glass
      if (m.stream.name === 'tarantul') continue;
      const sr = new SceneRenderer();
      sr.sync(viewer());
      const cam = new THREE.PerspectiveCamera();
      cameraFromViewer(viewer(), cam, 4 / 3);
      const probe = new ShellProbe(sr.cockpitEntryOf(viewScene.cockpitHeadNode!.userData!)!, cam.matrixWorld);
      const measured = probe.outline(48);
      const table = GLASS[key]!;
      const worst = Math.max(...measured.map((p, i) => Math.hypot(p[0] - table[i]![0], p[1] - table[i]![1])));
      expect(worst, `${key} glass`).toBeLessThan(1);
      probe.dispose();
    }
    expect([...keys].sort()).toEqual(Object.keys(DESIGNS).sort());
  }, 600000);
});
