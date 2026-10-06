/**
 * The switches' labels: a 5 x 7 pixel font, and an atlas of every label
 * (controls.ts) drawn in it once - one byte a pixel, 255 where ink is - for
 * the caps' label shader (cockpit.ts) to sample as a texture.
 *
 * @portOnly the VR controls
 */

/** Each glyph's seven rows, five columns: '#' is ink. */
const GLYPHS: Record<string, readonly string[]> = {
  A: [' ### ', '#   #', '#   #', '#####', '#   #', '#   #', '#   #'],
  B: ['#### ', '#   #', '#   #', '#### ', '#   #', '#   #', '#### '],
  C: [' ### ', '#   #', '#    ', '#    ', '#    ', '#   #', ' ### '],
  D: ['#### ', '#   #', '#   #', '#   #', '#   #', '#   #', '#### '],
  E: ['#####', '#    ', '#    ', '#### ', '#    ', '#    ', '#####'],
  F: ['#####', '#    ', '#    ', '#### ', '#    ', '#    ', '#    '],
  G: [' ### ', '#   #', '#    ', '# ###', '#   #', '#   #', ' ####'],
  H: ['#   #', '#   #', '#   #', '#####', '#   #', '#   #', '#   #'],
  I: [' ### ', '  #  ', '  #  ', '  #  ', '  #  ', '  #  ', ' ### '],
  J: ['  ###', '   # ', '   # ', '   # ', '   # ', '#  # ', ' ##  '],
  K: ['#   #', '#  # ', '# #  ', '##   ', '# #  ', '#  # ', '#   #'],
  L: ['#    ', '#    ', '#    ', '#    ', '#    ', '#    ', '#####'],
  M: ['#   #', '## ##', '# # #', '# # #', '#   #', '#   #', '#   #'],
  N: ['#   #', '##  #', '# # #', '#  ##', '#   #', '#   #', '#   #'],
  O: [' ### ', '#   #', '#   #', '#   #', '#   #', '#   #', ' ### '],
  P: ['#### ', '#   #', '#   #', '#### ', '#    ', '#    ', '#    '],
  Q: [' ### ', '#   #', '#   #', '#   #', '# # #', '#  # ', ' ## #'],
  R: ['#### ', '#   #', '#   #', '#### ', '# #  ', '#  # ', '#   #'],
  S: [' ####', '#    ', '#    ', ' ### ', '    #', '    #', '#### '],
  T: ['#####', '  #  ', '  #  ', '  #  ', '  #  ', '  #  ', '  #  '],
  U: ['#   #', '#   #', '#   #', '#   #', '#   #', '#   #', ' ### '],
  V: ['#   #', '#   #', '#   #', '#   #', '#   #', ' # # ', '  #  '],
  W: ['#   #', '#   #', '#   #', '# # #', '# # #', '## ##', '#   #'],
  X: ['#   #', '#   #', ' # # ', '  #  ', ' # # ', '#   #', '#   #'],
  Y: ['#   #', '#   #', ' # # ', '  #  ', '  #  ', '  #  ', '  #  '],
  Z: ['#####', '    #', '   # ', '  #  ', ' #   ', '#    ', '#####'],
  '0': [' ### ', '#   #', '#  ##', '# # #', '##  #', '#   #', ' ### '],
  '1': ['  #  ', ' ##  ', '  #  ', '  #  ', '  #  ', '  #  ', ' ### '],
  '2': [' ### ', '#   #', '    #', '   # ', '  #  ', ' #   ', '#####'],
  '3': ['#### ', '    #', '    #', ' ### ', '    #', '    #', '#### '],
  '4': ['   # ', '  ## ', ' # # ', '#  # ', '#####', '   # ', '   # '],
  '5': ['#####', '#    ', '#### ', '    #', '    #', '#   #', ' ### '],
  '6': [' ### ', '#    ', '#    ', '#### ', '#   #', '#   #', ' ### '],
  '7': ['#####', '    #', '   # ', '  #  ', ' #   ', ' #   ', ' #   '],
  '8': [' ### ', '#   #', '#   #', ' ### ', '#   #', '#   #', ' ### '],
  '9': [' ### ', '#   #', '#   #', ' ####', '    #', '    #', ' ### '],
  '+': ['     ', '  #  ', '  #  ', '#####', '  #  ', '  #  ', '     '],
  '-': ['     ', '     ', '     ', '#####', '     ', '     ', '     '],
  '<': ['   # ', '  #  ', ' #   ', '#    ', ' #   ', '  #  ', '   # '],
  '>': [' #   ', '  #  ', '   # ', '    #', '   # ', '  #  ', ' #   '],
  ' ': ['     ', '     ', '     ', '     ', '     ', '     ', '     '],
};

const GLYPH_W = 5;
const GLYPH_H = 7;
/** a cell: four glyphs and a column between each, a pixel's margin all round */
export const LABEL_CHARS = 4;
export const CELL_W = LABEL_CHARS * (GLYPH_W + 1) + 1;
export const CELL_H = GLYPH_H + 2;

export interface LabelAtlas {
  width: number;
  height: number;
  /** one byte a pixel, rows top down */
  data: Uint8Array;
  /** each label's cell: x, y, width, height in pixels */
  cells: Map<string, [number, number, number, number]>;
}

/** Draws `labels` (four characters at most, upper case) into an atlas, one cell a row, each centred in its cell. */
export function labelAtlas(labels: readonly string[]): LabelAtlas {
  const unique = [...new Set(labels)];
  const width = CELL_W;
  const height = CELL_H * unique.length;
  const data = new Uint8Array(width * height);
  const cells = new Map<string, [number, number, number, number]>();
  unique.forEach((text, i) => {
    const y0 = i * CELL_H;
    const chars = [...text.slice(0, LABEL_CHARS)];
    const inked = chars.length * (GLYPH_W + 1) - 1;
    let x = Math.floor((CELL_W - inked) / 2);
    for (const ch of chars) {
      const g = GLYPHS[ch] ?? GLYPHS[' ']!;
      for (let r = 0; r < GLYPH_H; r++) for (let c = 0; c < GLYPH_W; c++) if (g[r]![c] === '#') data[(y0 + 1 + r) * width + x + c] = 255;
      x += GLYPH_W + 1;
    }
    cells.set(text, [0, y0, CELL_W, CELL_H]);
  });
  return { width, height, data, cells };
}
