/**
 * MW2.INI, read the way the game reads it: ini_find_section finds a
 * "[section]" line and remembers the file position after it (the global at
 * 0x9e8e8); ini_get_value re-reads from that position for "key=value" until
 * the next "[" line. system_error_report is their one caller, as
 * ini_find_section("SystemError") then ini_get_value("%02X" of the code).
 *
 * Both open mw2.ini in text mode ("rt") and read it with the Watcom fgets at
 * 0x75cc9 into a 0x85-byte buffer, so the reading below reproduces that
 * runtime exactly:
 *   - fgetc (0x8080c) drops a '\r' by returning the byte after it, and turns
 *     0x1a (^Z) into end-of-file (the ^Z is still consumed);
 *   - fgets stops after '\n' or after 0x84 bytes, whichever comes first, so a
 *     longer line is read as several;
 *   - ftell / fseek work on the raw file offset.
 */

import { quirk } from '../../core/provenance.ts';

/** ini_find_section's results. */
export const INI_OK = 0;
/** mw2.ini would not open. */
export const INI_NO_FILE = 0x34;
/** no "[section]" line. */
export const INI_NO_SECTION = 0x39;

/** strtok's delimiters in ini_find_section (0x93448) and strspn's in ini_get_value (0x93450). */
const TOKEN_DELIMS = ' \t\n';
const LEAD_SPACE = ' \t';
const FGETS_SIZE = 0x85;

/** The Watcom text-mode stream over an in-memory file. @portOnly C runtime stand-in */
class TextStream {
  pos: number;
  constructor(
    private readonly bytes: Uint8Array,
    pos = 0,
  ) {
    this.pos = pos;
  }
  private raw(): number {
    return this.pos < this.bytes.length ? this.bytes[this.pos++]! : -1;
  }
  /** clib_dos4g_sub_08080c in text mode. */
  getc(): number {
    let c = this.raw();
    if (c === 0x0d) c = this.raw();
    if (c === 0x1a) c = -1;
    return c;
  }
  /** miles_driver_sub_075cc9: fgets(buf, n). null when nothing was read. */
  gets(n: number): string | null {
    let s = '';
    let c = 0;
    while (--n >= 1) {
      c = this.getc();
      if (c === -1) break;
      s += String.fromCharCode(c);
      if (c === 0x0a) break;
    }
    if (c === -1 && s === '') return null;
    return s;
  }
}

/** miles_driver_sub_075dfc: strnicmp folding only 'A'..'Z'. 0 when equal. */
function strnicmp(a: string, b: string, n: number): number {
  for (let i = 0; i < n; i++) {
    let x = i < a.length ? a.charCodeAt(i) : 0;
    let y = i < b.length ? b.charCodeAt(i) : 0;
    if (x > 0x40 && x < 0x5b) x += 0x20;
    if (y > 0x40 && y < 0x5b) y += 0x20;
    if (x !== y) return x - y;
    if (y === 0) return 0;
  }
  return 0;
}

/**
 * An INI file as the game reads mw2.ini. `null` bytes stand for a file that
 * would not open.
 */
export class IniFile {
  /** 0x9e8e8: the offset just past the found "[section]" line, or -1. */
  sectionPos = -1;

  constructor(readonly bytes: Uint8Array | null) {}

  /**
   * Finds "[name]" (case-insensitive, after leading blanks; anything after the
   * ']' is ignored) and remembers the position after its line.
   *
   * @mw2 ini_find_section 0x00049d10
   * @fidelity exact
   * @divergence reads the INI from memory instead of opening mw2.ini
   */
  iniFindSection(name: string): number {
    const n = name.length;
    this.sectionPos = -1;
    if (!this.bytes) return INI_NO_FILE;
    const f = new TextStream(this.bytes);
    for (;;) {
      const line = f.gets(FGETS_SIZE);
      if (line === null) return INI_NO_SECTION;
      // strtok(line, " \t\n"): the first token, cut at the next delimiter.
      let a = 0;
      while (a < line.length && TOKEN_DELIMS.includes(line[a]!)) a++;
      if (a === line.length) {
        // strtok returns NULL and the original reads the byte at address 0.
        quirk('ini_find_section dereferences strtok NULL on a blank line; read as "not a section"');
        continue;
      }
      let b = a;
      while (b < line.length && !TOKEN_DELIMS.includes(line[b]!)) b++;
      const tok = line.slice(a, b);
      if (tok[0] !== '[') continue;
      if (strnicmp(tok.slice(1), name, n) !== 0) continue;
      if (tok[n + 1] !== ']') continue;
      this.sectionPos = f.pos;
      return INI_OK;
    }
  }

  /**
   * The value of "key=value" in the section ini_find_section found: the rest
   * of the line after '=', with its LAST character dropped (meant to be the
   * '\n'; a last line with no newline loses a real character instead). The
   * key must sit right against the '=' - "key =" does not match. '' when the
   * key, the section or the file is missing.
   *
   * @mw2 ini_get_value 0x00049df0
   * @fidelity exact
   * @divergence returns a string instead of a pointer into the static buffer at 0x152d78
   */
  iniGetValue(key: string): string {
    const n = key.length;
    if (this.sectionPos === -1 || !this.bytes) return '';
    const f = new TextStream(this.bytes, this.sectionPos);
    let value: string;
    for (;;) {
      value = '';
      const line = f.gets(FGETS_SIZE);
      if (line === null) break;
      let s = 0;
      while (s < line.length && LEAD_SPACE.includes(line[s]!)) s++;
      if (line[s] === '[') break;
      const eq = line.indexOf('=', s);
      if (eq < 0) continue;
      value = line.slice(eq + 1);
      if (eq - s !== n) continue;
      if (strnicmp(line.slice(s), key, n) !== 0) continue;
      break;
    }
    if (value.length > 0) {
      if (!value.endsWith('\n')) quirk('ini_get_value drops the last character of a value with no line end');
      value = value.slice(0, -1);
    }
    return value;
  }
}

/**
 * system_error_report's lookup of a code's text: "[SystemError]", key "%02X".
 *
 * @portOnly the INI half of system_error_report (0x4ae00), whose formatting and output are not ported here
 */
export function systemErrorText(ini: IniFile, code: number): string {
  ini.iniFindSection('SystemError');
  return ini.iniGetValue((code >>> 0).toString(16).toUpperCase().padStart(2, '0'));
}
