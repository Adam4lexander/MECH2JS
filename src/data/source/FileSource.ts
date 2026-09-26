/**
 * Where the game's files come from. The browser fetches them from the dev
 * server's /mw2/ mount (app/fetchSource.ts); tests read them from disk
 * (tools/nodeSource.ts).
 * Names are the game's own (MW2.PRJ, USERSTAR.BWD, MEK/MDG00USR.MEK) and are
 * matched case-insensitively.
 */
export interface FileSource {
  read(name: string): Promise<Uint8Array>;
  exists(name: string): Promise<boolean>;
}

/** Serves a few in-memory files ahead of another source - the loose-file overlay. */
export class OverlaySource implements FileSource {
  private files = new Map<string, Uint8Array>();
  constructor(readonly under: FileSource) {}

  put(name: string, bytes: Uint8Array): void {
    this.files.set(name.toUpperCase(), bytes);
  }
  remove(name: string): void {
    this.files.delete(name.toUpperCase());
  }
  async read(name: string): Promise<Uint8Array> {
    return this.files.get(name.toUpperCase()) ?? this.under.read(name);
  }
  async exists(name: string): Promise<boolean> {
    return this.files.has(name.toUpperCase()) || this.under.exists(name);
  }
}
