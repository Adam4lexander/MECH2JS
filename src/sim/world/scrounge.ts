/**
 * The scrounge patch: one mission object (named by the SCRG chunk) that is
 * kept under the camera by snapping it to a grid - the ground detail that
 * seems to go on forever. scrounge_install measures it and takes it out of
 * the world; scrounge_follow_viewer (from camera_update, every frame) moves
 * it to the grid cell under viewerPosition.
 *
 * The seven dwords at 0xf43a0..0xf43b8 are unlabelled and keep positional
 * names; what each does is in its note.
 */
import type { SceneNode } from '../../generated/classes.gen.ts';
import { LABEL } from '../../generated/labels.gen.ts';
import { cdiv, iabs } from '../../core/int/cint.ts';
import { divergence } from '../../core/provenance.ts';
import { registerGlobals } from '../../engine/globals.ts';
import { imageI32 } from '../../engine/image.ts';
import {
  sceneNodeRemoveSubtreeFromWorld,
  sceneNodeSetOrigin,
  sceneNodeWalk,
  sceneSubtreeMoveToAltList,
  sceneSubtreeMoveToWorldList,
} from '../../engine/scene/sceneGraph.ts';
import { viewer } from '../camera/viewer.ts';

function bootScrounge() {
  return {
    /** 0x95aec: the grid pitch in cm, a multiple of 0x4000 */
    scroungeTileSize: imageI32(LABEL.scroungeTileSize, 0),
    /** 0x95af8: scrounge_follow_viewer does nothing while 0 */
    scroungeActive: imageI32(LABEL.scroungeActive, 0),
    /** 0x95afc: set when the node has children: re-snap only past a margin, to the nearest cell */
    scroungeHysteresis: imageI32(LABEL.scroungeHysteresis, 0),
    /** 0x95b00: the patch's node */
    scroungeNode: null as SceneNode | null,
    /** 0x95af0: set by scrounge_install; scrounge_follow_viewer also returns while it is 0. No other writer read */
    dat00095af0: imageI32(0x95af0, 0),
    /** 0x95af4: cleared by scrounge_install; scrounge_follow_viewer puts the node back in the world list once while it is 0, then sets it */
    dat00095af4: imageI32(0x95af4, 0),
    /** 0xf43a0: x of the node's origin, cellX * scroungeTileSize */
    dat000f43a0: imageI32(0xf43a0, 0),
    /** 0xf43a4: y of the node's origin, always 0 */
    dat000f43a4: imageI32(0xf43a4, 0),
    /** 0xf43a8: z of the node's origin, cellZ * scroungeTileSize */
    dat000f43a8: imageI32(0xf43a8, 0),
    /** 0xf43ac: the hysteresis margin, ((size >> 3) + size) >> 1 */
    dat000f43ac: imageI32(0xf43ac, 0),
    /** 0xf43b0: the cell x the node was last placed at */
    dat000f43b0: imageI32(0xf43b0, 0),
    /** 0xf43b4: zeroed with the others; no reader found */
    dat000f43b4: imageI32(0xf43b4, 0),
    /** 0xf43b8: the cell z the node was last placed at */
    dat000f43b8: imageI32(0xf43b8, 0),
  };
}

export const scrounge = registerGlobals('scrounge', bootScrounge(), () => {
  Object.assign(scrounge, bootScrounge());
});

/**
 * The SCRG handler: measures the x and z extent of the first mesh of the
 * node's object, takes the larger - a third of it when the node has no
 * children - rounds it up past the next multiple of 0x4000 as the tile size,
 * resets the follow state and takes the node out of the world. Does nothing
 * for a node without an object or mesh, or with no positive extent.
 *
 * @mw2 scrounge_install 0x0001f120
 * @fidelity exact
 */
export function scroungeInstall(node: SceneNode): void {
  const mesh = node ? node.userData?.meshList : null;
  if (!node || !mesh) return;
  let minX = 0x7fffffff;
  let maxX = -0x7fffffff;
  let minZ = 0x7fffffff;
  let maxZ = -0x7fffffff;
  const n = mesh.vertexCount; // movsx
  if (n > mesh.vertices.length) divergence('scrounge_install: vertexCount beyond the vertices the port holds');
  for (let i = 0; i < n && i < mesh.vertices.length; i++) {
    const v = mesh.vertices[i]!;
    if (maxX < v.modelX) maxX = v.modelX;
    if (maxZ < v.modelZ) maxZ = v.modelZ;
    if (v.modelX < minX) minX = v.modelX;
    if (v.modelZ < minZ) minZ = v.modelZ;
  }
  let extent = (maxX - minX) | 0;
  const ez = (maxZ - minZ) | 0;
  if (extent < ez) extent = ez;
  if (extent <= 0) return;
  const s = scrounge;
  if (node.firstChild) {
    s.scroungeHysteresis = 1;
  } else {
    extent = cdiv(extent, 3);
    s.scroungeHysteresis = 0;
  }
  // (extent >> 14) + 1 in 0x4000 units; extent is never negative here, so the
  // sign-correction the disassembly carries (sbb) adds nothing
  s.scroungeTileSize = (((extent >> 14) + 1) << 14) | 0;
  s.scroungeNode = node;
  s.dat00095af0 = 1;
  s.scroungeActive = 1;
  s.dat00095af4 = 0;
  s.dat000f43a8 = 0;
  s.dat000f43a4 = 0;
  s.dat000f43a0 = 0;
  s.dat000f43b8 = 0;
  s.dat000f43ac = ((s.scroungeTileSize >> 3) + s.scroungeTileSize) >> 1;
  s.dat000f43b4 = 0;
  s.dat000f43b0 = 0;
  sceneSubtreeMoveToAltList(node);
  sceneNodeRemoveSubtreeFromWorld(node);
}

/**
 * Each frame: moves the patch to the grid cell under the camera. Without
 * hysteresis the cell is position / tileSize (truncating); with it, the patch
 * stays put until the camera is more than the margin from its origin on
 * either axis, and the new cell is rounded to the nearest. The first call
 * also puts the node back in the world list.
 *
 * @mw2 scrounge_follow_viewer 0x0001f270
 * @fidelity exact
 */
export function scroungeFollowViewer(): void {
  const s = scrounge;
  if (s.scroungeActive === 0 || s.dat00095af0 === 0) return;
  const v = viewer();
  let x = v.posX;
  let z = v.posZ;
  let cellX: number;
  let cellZ: number;
  const tile = s.scroungeTileSize;
  if (s.scroungeHysteresis !== 0 && iabs((x - s.dat000f43a0) | 0) <= s.dat000f43ac && iabs((z - s.dat000f43a8) | 0) <= s.dat000f43ac) {
    cellX = s.dat000f43b0;
    cellZ = s.dat000f43b8;
  } else {
    if (s.scroungeHysteresis !== 0) {
      x = (x + ((x < 0 ? -tile : tile) >> 1)) | 0;
      z = (z + ((z < 0 ? -tile : tile) >> 1)) | 0;
    }
    cellX = cdiv(x, tile);
    cellZ = cdiv(z, tile);
  }
  if (s.dat00095af4 === 0) {
    if (s.scroungeNode) sceneSubtreeMoveToWorldList(s.scroungeNode);
    s.dat00095af4 = 1; // EDX, loaded with 1 before the call and preserved by it (0x1f35f)
  }
  if (cellX !== s.dat000f43b0 || cellZ !== s.dat000f43b8) {
    s.dat000f43a0 = Math.imul(cellX, tile);
    s.dat000f43a4 = 0;
    s.dat000f43a8 = Math.imul(cellZ, tile);
    if (s.scroungeNode) {
      sceneSubtreeMoveToWorldList(s.scroungeNode);
      sceneNodeSetOrigin(s.scroungeNode, s.dat000f43a0, s.dat000f43a4, s.dat000f43a8);
      sceneNodeWalk(s.scroungeNode);
    }
  }
  s.dat000f43b8 = cellZ;
  s.dat000f43b4 = 0;
  s.dat000f43b0 = cellX;
}
