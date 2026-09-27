/**
 * Which chassis's cockpit the player sits in.
 *
 * The cockpit view is drawn from viewScene.cockpitHeadNode, the first
 * family-0xa0 world object: a mech's level-4 head, an inside-facing shell
 * (BM5_HEAD, TW5_HEAD, ...). Its detail record holds the POLY resource of
 * each level. The key the hand-built cockpits (cockpit/designs) are filed
 * under is the two-letter prefix of the level-0 head - the exterior's, whose
 * glass the cockpit is cut to (glass.ts) - when the level-4 one is a mech's
 * shell. The two differ for the Tarantula, which wears the Kit Fox's shell
 * (KF5_HEAD) under its own head (TR1_HEAD); VEHICLEG's shell is VG5_MAIN,
 * not a mech's.
 *
 * (Correction: the key was first the shell's prefix, which filed the
 * Tarantula under the Kit Fox; that was harmless while cockpits were cut to
 * the shells, and wrong once they followed the exterior.)
 *
 * @portOnly
 */
import type { ProjectFile } from '../../data/prj/ProjectFile.ts';
import { detail } from '../../sim/world/detailRecords.ts';
import { viewScene } from '../../sim/world/viewScene.ts';

/** The POLY resource name of the cockpit head at `level` (4: the shell; 0: the exterior), or '' when there is none. */
export function cockpitShellName(prj: ProjectFile, level = 4): string {
  const node = viewScene.cockpitHeadNode;
  if (!node) return '';
  for (let i = 0; i < detail.detailRecordCount; i++) {
    const r = detail.detailRecords[i]!;
    if (r.node !== node) continue;
    const id = r.polyIds[level]!;
    return id >= 0 ? prj.resourceName('POLY', id).toUpperCase() : '';
  }
  return '';
}

/** The chassis key (the exterior head's two letters, e.g. 'TW'), or '' when the shell is not a mech head. */
export function cockpitChassis(prj: ProjectFile): string {
  if (!/^[A-Z]{2}5_/.test(cockpitShellName(prj, 4))) return '';
  const m = /^([A-Z]{2})\d_/.exec(cockpitShellName(prj, 0));
  return m ? m[1]! : '';
}
