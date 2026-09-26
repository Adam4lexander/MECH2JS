/**
 * MGEO resources - a mech's (or vehicle's) body geometry constants - as
 * res_load_mgeo (0x4bb80) reads them: seven dwords copied into seven
 * out-parameters, which the MGDF chunk (project_chunk_exec) points at
 * currentGamepiece's MechLoadout. Offsets are the loader's; the meanings are
 * the MechLoadout fields' (mw2_types.h), each established by its consumers
 * there, not by this loader:
 *
 *   +0x00  rideHeight      -> MechLoadout +0xcc, cm the origin sits above the
 *                             ground (terrain tick: posY - rideHeight - groundHeight)
 *   +0x04  eyeOffsetY      -> +0xd0, pilot eye above aimNode (camera, fire ray);
 *                             0 in every record
 *   +0x08  mgeoWord2       -> +0xd4, WRITE-ONLY in the game; -rideHeight in
 *                             every record. Meaning not established
 *   +0x0c  mgeoWord3       -> +0xd8, write-only; 0 in every record
 *   +0x10  mgeoWord4       -> +0xdc, write-only; 0 in every record
 *   +0x14  torsoPanLimit   -> +0xe0, symmetric torso yaw clamp, 16.16 degrees
 *   +0x18  radius          -> +0xe8, body radius in cm (collision, brackets)
 *
 * The loader reads exactly these 28 bytes and never checks the resource
 * size; all 55 MGEO resources in MW2.PRJ are exactly 28 bytes
 * (test/golden/mgeo.test.ts). MechLoadout.tons at +0xe4 sits between the
 * last two targets and is not written by it.
 *
 * Resolution (resource_load_ref, 0x34560, table 5): a reference whose id is
 * -1 is resolved by name through TABL 5; if the project load fails, the
 * first 8 characters of the name + '.mgi' are tried as a loose file. The
 * loose file is read into the same pointer, so it has this format too.
 */

export const MGEO_RECORD_SIZE = 0x1c;

export interface MgeoRecord {
  rideHeight: number;
  eyeOffsetY: number;
  mgeoWord2: number;
  mgeoWord3: number;
  mgeoWord4: number;
  torsoPanLimit: number;
  radius: number;
}

/**
 * The seven dwords, or null if the payload is shorter than 28 bytes (the
 * loader would read past it).
 *
 * @portOnly the parse half of res_load_mgeo (0x4bb80); storing into the loadout is sim work
 */
export function parseMgeo(c: Uint8Array): MgeoRecord | null {
  if (c.length < MGEO_RECORD_SIZE) return null;
  const dv = new DataView(c.buffer, c.byteOffset, c.byteLength);
  const d = (o: number) => dv.getInt32(o, true);
  return {
    rideHeight: d(0x00),
    eyeOffsetY: d(0x04),
    mgeoWord2: d(0x08),
    mgeoWord3: d(0x0c),
    mgeoWord4: d(0x10),
    torsoPanLimit: d(0x14),
    radius: d(0x18),
  };
}
