/**
 * The player's own mech, whole, round the cockpit view.
 *
 * In the cockpit view mech_lod_update builds the player's mech at level 4
 * (detailRecords.ts): the torso is the cockpit shell (XX5_HEAD), the arms
 * and legs are coarse stand-ins, and the hips, feet, toes and guns are
 * DUMMY - nothing. The original never looked at them: the shell hid the
 * world below, and nothing cast a shadow. The shadow enhancement casts from
 * what is built, so the player's shadow was a pair of sticks and a box.
 *
 * This keeps a render-only copy of every part at level 0, each riding its
 * record's own scene node - the node the game animates, whatever level it
 * built - so it walks, twists and aims with the mech. The game's objects,
 * lists and records are not touched: the copies are loaded here, as
 * detail_record_build loads a level (poly_load_wtbo_block, the owner's
 * colours), and never linked into a list.
 *
 *   the torso (the head record) and everything under it - the eye is inside
 *   it - cast only: the hand-built cockpit stands in for it in view, and the
 *   game's own cockpit pass still draws the arms;
 *   the rest - hips, legs, feet - cast and show, in place of the level-4
 *   stand-ins, which are hidden while this is on.
 *
 * A part blown off (released as debris) goes from the copy with it.
 *
 * @portOnly
 */
import type { WorldObject } from '../../generated/classes.gen.ts';
import { polyLoadWtboBlock, polySetLoadFlags, polySetVertexScale, wtboGlobals } from '../../engine/scene/wtboLoader.ts';
import { detail } from '../../sim/world/detailRecords.ts';
import { mechs } from '../../sim/mech/mechGlobals.ts';
import { viewScene } from '../../sim/world/viewScene.ts';

/** One part of the copy: the level-0 object on its record's node, and whether it shows or only casts. */
export interface OwnPart {
  record: number;
  obj: WorldObject;
  view: boolean;
}

/** What SceneRenderer draws for it: the owner whose level-4 parts it stands in for, and the parts. */
export interface OwnChassisDraw {
  owner: number;
  parts: OwnPart[];
}

/**
 * A level's POLY as detail_record_build loads it (unit vertex scale, no load
 * flags, the owner's affiliation colours - mech_apply_detail_level's
 * polyOwner* settings), with the loader's globals put back after, so the
 * game's next load sees them as it left them.
 */
export function loadPartLevel(data: Uint8Array, owner: number): WorldObject | null {
  const g = wtboGlobals;
  const saved = { ...g };
  try {
    polySetVertexScale(1, 1, 1);
    polySetLoadFlags(0);
    g.polyOwnerActive = 1;
    g.polyOwnerKind = 0x100;
    g.polyOwnerIndex = owner;
    const obj = polyLoadWtboBlock(data, 0, data.length, null);
    // a part-mode block would have made scene nodes of its own: not a mech part, not used
    if (!obj || g.wtboPartMode !== 0) return null;
    return obj;
  } finally {
    Object.assign(g, saved);
  }
}

export class OwnChassis {
  private builtFor = '';
  private parts: OwnPart[] = [];

  /**
   * The copy for this frame, or null when there is none to draw: `on` off,
   * not in the cockpit view, or no cockpit head. `readPoly` reads a POLY
   * resource's bytes (the project file). `outside`: the view stands outside
   * the mech (the editor's scene camera), so the torso shows too.
   */
  update(on: boolean, cockpitView: boolean, readPoly: (id: number) => Uint8Array | null, outside = false): OwnChassisDraw | null {
    const owner = mechs.playerMechIndex;
    const head = viewScene.cockpitHeadNode?.userData ?? null;
    if (!on || !cockpitView || !head || owner < 0) return null;
    const records: number[] = [];
    let headRecord = -1;
    for (let i = 0; i < detail.detailRecordCount; i++) {
      const r = detail.detailRecords[i]!;
      if (r.owner !== owner) continue;
      records.push(i);
      if (r.object === head) headRecord = i;
    }
    if (headRecord < 0) return null;
    const key = `${owner}:${records.map((i) => detail.detailRecords[i]!.polyIds[0]).join(',')}`;
    if (key !== this.builtFor) {
      this.builtFor = key;
      this.parts = this.build(owner, records, headRecord, readPoly);
    }
    // each part on its record's node, as the game last posed it; gone with its part
    const live: OwnPart[] = [];
    for (const p of this.parts) {
      const r = detail.detailRecords[p.record]!;
      if (r.released !== 0 || !r.node || !r.object) continue;
      p.obj.node = r.node;
      // its world vertices are refreshed when this differs from its mesh's (objectSelectLodMesh)
      p.obj.transformVersion = (p.obj.transformVersion + 1) | 0;
      live.push(p);
    }
    return { owner, parts: outside ? live.map((p) => ({ ...p, view: true })) : live };
  }

  private build(owner: number, records: number[], headRecord: number, readPoly: (id: number) => Uint8Array | null): OwnPart[] {
    const under = (i: number): boolean => {
      for (let r = i, n = 0; r >= 0 && n < 64; r = detail.detailRecords[r]!.parent, n++) if (r === headRecord) return true;
      return false;
    };
    const out: OwnPart[] = [];
    for (const i of records) {
      const r = detail.detailRecords[i]!;
      // family 0x70: built off the world list (a dummy) at level 0 too
      if ((r.typeCodes[0]! & 0xf0) === 0x70) continue;
      const data = readPoly(r.polyIds[0]!);
      if (!data) continue;
      const obj = loadPartLevel(data, owner);
      if (!obj) continue;
      // as detail_record_build types it: the family, a mech part (0x100), its owner - so the renderer and
      // the VR rig's carry (SceneRenderer.carryOwned) treat it as the mech's own
      obj.type = (r.typeCodes[0]! & 0xf0) | 0x100;
      obj.index = owner;
      obj.hitLocation = r.location;
      out.push({ record: i, obj, view: !under(i) });
    }
    return out;
  }
}
