/**
 * Which chassis's cockpit the player sits in.
 *
 * The cockpit view is drawn from viewScene.cockpitHeadNode, the first
 * family-0xa0 world object: a mech's level-4 head, an inside-facing shell
 * (BM5_HEAD, TW5_HEAD, ...). Its detail record holds the POLY resource of
 * each level; the level-4 one's name in the project file begins with the
 * chassis's two-letter prefix, the key the hand-built cockpits
 * (cockpit/designs) are filed under. KF5_HEAD serves the Kit Fox and the
 * Tarantula; VEHICLEG's is VG5_MAIN.
 *
 * @portOnly
 */
import type { ProjectFile } from '../../data/prj/ProjectFile.ts';
import { detail } from '../../sim/world/detailRecords.ts';
import { viewScene } from '../../sim/world/viewScene.ts';

/** The POLY resource name of the cockpit shell ('' when there is none). */
export function cockpitShellName(prj: ProjectFile): string {
  const node = viewScene.cockpitHeadNode;
  if (!node) return '';
  for (let i = 0; i < detail.detailRecordCount; i++) {
    const r = detail.detailRecords[i]!;
    if (r.node !== node) continue;
    const id = r.polyIds[4]!;
    return id >= 0 ? prj.resourceName('POLY', id).toUpperCase() : '';
  }
  return '';
}

/** The chassis key (the shell name's two letters, e.g. 'TW'), or '' when the shell is not a mech head. */
export function cockpitChassis(prj: ProjectFile): string {
  const m = /^([A-Z]{2})5_/.exec(cockpitShellName(prj));
  return m ? m[1]! : '';
}
