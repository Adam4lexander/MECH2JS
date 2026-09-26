/**
 * How the inspector shows a C value: raw, hex, and the unit interpretations
 * the decompilation established (16.16 angles in degrees, 2.29 matrix
 * entries, cm as metres, 16.16 fixed point).
 *
 * @portOnly
 */

export type View = 'dec' | 'hex' | 'deg' | 'fix16' | 'fix29' | 'metres';

export const VIEWS: View[] = ['dec', 'hex', 'deg', 'fix16', 'fix29', 'metres'];

export function formatValue(v: number, view: View, cKind: string): string {
  switch (view) {
    case 'hex': {
      const bits = cKind === 'short' || cKind === 'ushort' ? 16 : cKind === 'byte' || cKind === 'sbyte' || cKind === 'char' ? 8 : 32;
      const u = bits === 32 ? v >>> 0 : v & ((1 << bits) - 1);
      return '0x' + u.toString(16).padStart(bits / 4, '0');
    }
    case 'deg':
      return (v / 65536).toFixed(3) + '°';
    case 'fix16':
      return (v / 65536).toFixed(5);
    case 'fix29':
      return (v / 0x20000000).toFixed(6);
    case 'metres':
      return (v / 100).toFixed(2) + ' m';
    default:
      return String(v);
  }
}

/** Parses an edited value back (accepts 0x.., degrees with °, plain numbers). */
export function parseValue(text: string, view: View): number | null {
  const t = text.trim().replace(/[°m\s]+$/, '');
  if (t === '') return null;
  if (/^-?0x[0-9a-f]+$/i.test(t)) return parseInt(t, 16) | 0;
  const n = Number(t);
  if (!Number.isFinite(n)) return null;
  switch (view) {
    case 'deg':
    case 'fix16':
      return Math.round(n * 65536) | 0;
    case 'fix29':
      return Math.round(n * 0x20000000) | 0;
    case 'metres':
      return Math.round(n * 100) | 0;
    default:
      return Math.trunc(n);
  }
}

/** Stores a number with the field's C width, as the original's store would. */
export function coerce(v: number, cKind: string): number {
  switch (cKind) {
    case 'byte':
      return v & 0xff;
    case 'sbyte':
    case 'char':
      return (v << 24) >> 24;
    case 'short':
      return (v << 16) >> 16;
    case 'ushort':
      return v & 0xffff;
    case 'uint':
      return v >>> 0;
    default:
      return v | 0;
  }
}

/** Writes an (already coerced) value into a struct field, or one element of an array field. */
export function storeValue(obj: Record<string, unknown>, name: string, index: number | null, v: number): void {
  if (index === null) obj[name] = v;
  else (obj[name] as { [i: number]: number })[index] = v;
}
