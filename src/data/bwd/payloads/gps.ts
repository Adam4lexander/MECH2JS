/**
 * GPS (keyword gpspec, tag 52): places one gamepiece - a mech, but also the
 * turrets, tanks, aircraft, dropships and doors that are built the same way.
 *
 * Every field below is read by project_chunk_exec's GPS branch (0x4f91d..)
 * or by a function it hands the field to:
 *
 *   +0x08  short     MEK resource id: mech_load_config's third argument, the
 *                    FALLBACK config - it first tries a loose file
 *                    'mek\<config>' and only if that fails cache_loads this id
 *   +0x0a  short     \ the stream project_gpspec_apply opens (id at +0x0a,
 *   +0x24  char[12]  / strncpy 0xc from +0x24) and runs through
 *                    project_chunk_exec: the gamepiece's own stream (GP, OBJ,
 *                    THNG...). The branch also copies the first 8 bytes of
 *                    +0x24 as the chassis name mech_load_config logs
 *   +0x0c  byte      group (star) index; the branch replaces anything above
 *                    0xf with 0
 *   +0x0d  byte      1: group_set_leader makes this mech its group's leader
 *   +0x0e  byte      side: 0 the player's mech (playerMechIndex,
 *                    playerGroupIndex, allegiance 0), 1 allegiance 1 for its
 *                    group, anything else leaves allegiance alone; a network
 *                    game overrides it
 *   +0x10  short[8]  copied verbatim to MechEntity.gpsParams; mech_ai_setup
 *                    reads [0]..[4] for a local-AI mech (see gpsParams)
 *   +0x20  ushort    objective mask, widened (objectiveMask.ts) and passed to
 *                    mission_record_add_value with (mech index | 0x200)
 *   +0x22  ushort    MechEntity.flags, stored whole
 *   +0x2d  char[8]   config name: mech_load_config's fourth argument
 *   +0x36  char[22]  MechEntity.name  (strncpy 0x16, last byte forced NUL)
 *   +0x4c  char[22]  MechEntity.nameAlt (the same)
 *
 * The chunk in MW2.PRJ is 0x64 bytes; +0x2c, +0x35 and +0x62.. are not read.
 */
import type { Chunk, StreamRef } from '../stream.ts';

export interface GpsChunk {
  /** +0x08 MEK resource id - mech_load_config's fallback when no loose 'mek\<config>' file opens */
  mekId: number;
  /** +0x0a id and +0x24 name (12 chars): the stream project_gpspec_apply opens and runs */
  pieceStream: StreamRef;
  /** +0x0c group (star) index as stored; project_chunk_exec reads anything above 0xf as 0 */
  group: number;
  /** +0x0d 1 = group_set_leader(group, this mech) */
  leader: number;
  /** +0x0e 0 = the player's mech, 1 = allegiance 1 for the group, other = allegiance untouched */
  side: number;
  /**
   * +0x10 eight shorts, copied to MechEntity.gpsParams as ushorts. mech_ai_setup
   * (local-AI mechs only): [0] low byte thinkDelay; [1] aiRangeOp4, [2]
   * aiRangeOp1, [3] aiRangeOp2 in metres (unsigned, 0 = 250); [4] low byte
   * aiSkillLevel. [5]..[7] have no reader.
   */
  gpsParams: number[];
  /** +0x20 objective mask as stored (see widenObjectiveMask) */
  objectiveMask: number;
  /** +0x22 MechEntity.flags */
  flags: number;
  /** +0x24 the first 8 characters of the piece stream's name: the chassis name mech_load_config logs */
  chassisName: string;
  /** +0x2d config (loadout) name, 8 characters: mech_load_config loads 'mek\<config>' */
  configName: string;
  /** +0x36 MechEntity.name, at most 21 characters */
  name: string;
  /** +0x4c MechEntity.nameAlt, at most 21 characters */
  nameAlt: string;
}

/**
 * Reads a GPS chunk at the offsets project_chunk_exec and project_gpspec_apply
 * read it. Values are as stored (the group clamp is the handler's business).
 *
 * @portOnly the read half of project_chunk_exec's GPS branch
 */
export function decodeGps(c: Chunk): GpsChunk {
  return {
    mekId: c.i16(0x08),
    pieceStream: { id: c.i16(0x0a), name: c.str(0x24, 12) },
    group: c.u8(0x0c),
    leader: c.u8(0x0d),
    side: c.u8(0x0e),
    gpsParams: Array.from({ length: 8 }, (_, i) => c.u16(0x10 + i * 2)),
    objectiveMask: c.u16(0x20),
    flags: c.u16(0x22),
    chassisName: c.str(0x24, 8),
    configName: c.str(0x2d, 8),
    name: c.str(0x36, 0x15),
    nameAlt: c.str(0x4c, 0x15),
  };
}
