/**
 * The 'Mechs a player can take into a mission, read from MW2.PRJ: every
 * gamepiece a mission's GPS chunk places whose piece stream is a 'Mech (its
 * GP chunk's class, +0xa, is 1 - the class the AI's isMech test and
 * gamepieceClasses[1] are), keyed by its loadout config. Each carries what a
 * GPS chunk of the player's star needs: the MEK resource, the piece stream
 * and the config name - exactly as the missions' own GPS chunks give them.
 *
 * The shell (MW2SHELL.EXE, not decompiled) has its own rules for which 'Mechs
 * a pilot may take; this is every 'Mech the shipped missions field.
 *
 * @portOnly
 */
import type { ProjectFile } from '../prj/ProjectFile.ts';
import { readNameTable, TABL } from '../prj/ProjectFile.ts';
import { walkStream, type Chunk } from '../bwd/stream.ts';
import { decodeGps } from '../bwd/payloads/gps.ts';

export interface MechChoice {
  /** the loadout config, e.g. 'mdg00std' - also the key */
  config: string;
  /** GPS +0x08: the MEK resource */
  mekId: number;
  /** GPS +0x0a / +0x24: the piece stream (the chassis), e.g. {29, 'maddog'} */
  stream: { id: number; name: string };
  /** MechChassis.tons from the MEK record */
  tons: number;
}

/** The chunks of BWD stream `id`, or of the stream with this name when id < 0. */
function streamChunks(prj: ProjectFile, names: Map<string, number>, ref: { id: number; name: string }): Chunk[] {
  const id = ref.id >= 0 ? ref.id : (names.get(ref.name.toUpperCase()) ?? -1);
  if (id < 0) return [];
  const bytes = prj.readResource('BWD', id);
  return bytes ? [...walkStream(bytes, ref.name)] : [];
}

export function mechCatalog(prj: ProjectFile): MechChoice[] {
  const names = new Map(readNameTable(prj, TABL.BWD).map((e) => [e.name.toUpperCase(), e.id] as const));
  const bwd = prj.type('BWD');
  const out = new Map<string, MechChoice>();
  const isMech = new Map<string, boolean>();
  if (!bwd) return [];
  for (let rid = 0; rid < bwd.entries.length; rid++) {
    const bytes = prj.readResource('BWD', rid);
    if (!bytes) continue;
    for (const c of walkStream(bytes, prj.resourceName('BWD', rid))) {
      if (c.tag !== 'GPS') continue;
      const g = decodeGps(c);
      const key = g.configName.toLowerCase();
      if (!key || out.has(key)) continue;
      const sk = `${g.pieceStream.id}:${g.pieceStream.name.toUpperCase()}`;
      let mech = isMech.get(sk);
      if (mech === undefined) {
        mech = streamChunks(prj, names, g.pieceStream).some((k) => k.tag === 'GP' && k.i16(0xa) === 1);
        isMech.set(sk, mech);
      }
      if (!mech) continue;
      const mek = prj.readResource('MEK', g.mekId);
      if (!mek || mek.length < 4) continue;
      const tons = new DataView(mek.buffer, mek.byteOffset, mek.byteLength).getInt32(0, true);
      out.set(key, { config: key, mekId: g.mekId, stream: { id: g.pieceStream.id, name: g.pieceStream.name.toLowerCase() }, tons });
    }
  }
  return [...out.values()].sort((a, b) => a.tons - b.tons || a.config.localeCompare(b.config));
}
