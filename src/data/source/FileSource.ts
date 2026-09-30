/**
 * Where the game's files come from. The browser fetches them from the dev
 * server's /mw2/ mount (app/fetchSource.ts) or reads them from a folder the
 * player dropped on the page (app/droppedInstall.ts); tests read them from
 * disk (tools/nodeSource.ts).
 * Names are the game's own (MW2.PRJ, USERSTAR.BWD, MEK/MDG00USR.MEK) and are
 * matched case-insensitively.
 */
export interface FileSource {
  read(name: string): Promise<Uint8Array>;
  exists(name: string): Promise<boolean>;
}

/**
 * The install as the browser reaches it: the dev server's /mw2/ mount
 * (app/fetchSource.ts) or a folder the player dropped on the page
 * (app/droppedInstall.ts). Only the install's content is there
 * (data/source/installFiles.ts).
 */
export interface InstallSource extends FileSource {
  /** bytes [start, end) of a file, end null for the rest of it (the CD image is read this way) */
  readRange(name: string, start: number, end: number | null): Promise<Uint8Array>;
  /** the files in one install directory ('' for the root), as 'DIR/NAME' paths */
  list(dir: string): Promise<string[]>;
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
