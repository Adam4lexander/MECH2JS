/**
 * The shared button bar every screen puts up (decompiled/mw2shell/src/ui/
 * button_bar.c): hotspot rectangles from a table of 7-dword definitions
 * {x0, y0, x1, y1, labelX, labelY, label}. A label starting '<' is drawn
 * all the time; any other appears while the pointer is over the button.
 * button_bar_hit returns the button under the pointer; the screen tests
 * the click itself.
 */
import { fieldOffset, mem, structSize } from '../memory.ts';
import { shell } from '../state.ts';
import { videoDriverLine, type VideoDriver } from '../video/driver.ts';
import { labelCreate, labelDestroy, labelHide, labelsAdd, textLabelRedraw, type FontHolder, type TextLabel } from './labels.ts';

/** @portOnly a button, 0x2a bytes */
export class Button {
  /** +0x00 the hover label's text */
  label: string | null = null;
  /** +0x04 / +0x08 */
  labelX = 0;
  labelY = 0;
  /** +0x0c */
  field0c = -1;
  /** +0x10 */
  font: FontHolder | null = null;
  /** +0x14 the hover label's colour table */
  colour: Uint8Array | null = null;
  /** +0x18 {x0, y0, x1, y1} */
  rect: [number, number, number, number] = [0, 0, 0, 0];
  /** +0x1c the hover label while the pointer is over the button */
  hoverLabel: TextLabel | null = null;
  /** +0x20 the '<' label drawn all the time */
  staticLabel: TextLabel | null = null;
  /** +0x24 */
  index = 0;
  /** +0x28 1: its rectangle's edges are drawn */
  outline = 0;
  /** +0x29 */
  enabled = 1;
}

/** @portOnly a button bar */
export class ButtonBar {
  /** +0x00 */
  buttons: Button[] = [];
  /** +0x04 */
  driver: VideoDriver | null = null;
  /** +0x08 */
  font: FontHolder | null = null;
  /** +0x0c a 256-byte colour table: the identity with ink 1 drawn as 6 (entry 0 0xff) */
  ramp = new Uint8Array(256);
  /** +0x10c */
  outline = 0;
}

/** One 7-dword definition, read from the shell's image. */
export interface ButtonDef {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  labelX: number;
  labelY: number;
  label: string | null;
}

/** @portOnly `count` ButtonDefs at `addr` in the shell's image (label pointers followed) */
export function buttonDefsAt(addr: number, count: number): ButtonDef[] {
  const m = mem();
  const f = (a: number, n: string) => a + fieldOffset('ButtonDef', n);
  return Array.from({ length: count }, (_, i) => {
    const a = addr + i * structSize('ButtonDef');
    return {
      x0: m.i32(f(a, 'x0')),
      y0: m.i32(f(a, 'y0')),
      x1: m.i32(f(a, 'x1')),
      y1: m.i32(f(a, 'y1')),
      labelX: m.i32(f(a, 'labelX')),
      labelY: m.i32(f(a, 'labelY')),
      label: m.ptrStr(f(a, 'label')),
    };
  });
}

/**
 * Fills a button; with outline set, draws the rectangle's four edges.
 *
 * @mw2shell button_init 0x00028c30
 * @fidelity exact
 */
export function buttonInit(
  b: Button,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  index: number,
  outline: number,
  driver: VideoDriver,
  font: FontHolder,
  label: string | null,
  labelX: number,
  labelY: number,
  colour: Uint8Array | null,
  enabled: number,
): Button {
  b.index = index;
  b.outline = outline;
  b.label = label;
  b.labelX = labelX;
  b.labelY = labelY;
  b.hoverLabel = null;
  b.font = font;
  b.colour = colour;
  b.enabled = enabled;
  b.field0c = -1;
  b.rect = [x0, y0, x1, y1];
  if (b.outline === 1) {
    // colour 0: the driver's line draw takes no colour here; the original passes its stack slot through
    const [a, c, e, g] = b.rect;
    videoDriverLine(driver, a, g, e, g, 0);
    videoDriverLine(driver, a, c, e, c, 0);
    videoDriverLine(driver, e, c, e, g, 0);
    videoDriverLine(driver, a, g, a, c, 0);
  }
  return b;
}

/**
 * (bar, driver, font, outline, defs, count): one button per definition,
 * button i with index i; a '<' label is drawn now in the bar's colour
 * table. The bar always uses font28, whatever font it is given.
 *
 * @mw2shell button_bar_create 0x00028680
 * @fidelity exact
 */
export function buttonBarCreate(bar: ButtonBar, driver: VideoDriver, _font: FontHolder | null, outline: number, defs: readonly ButtonDef[], count: number): ButtonBar {
  bar.ramp[0] = 0xff;
  bar.outline = outline;
  bar.driver = driver;
  bar.font = shell.font28;
  for (let i = 1; i < 0x100; i++) bar.ramp[i] = i;
  bar.ramp[1] = 6;
  bar.buttons = [];
  for (let i = 0; i < count; i++) {
    const d = defs[i]!;
    let label = d.label;
    let staticLabel: TextLabel | null = null;
    if (label !== null && label[0] === '<') {
      label = label.slice(1);
      staticLabel = labelCreate(bar.font!, d.labelX, d.labelY, label, bar.ramp);
    }
    const b = buttonInit(new Button(), d.x0, d.y0, d.x1, d.y1, i, bar.outline, bar.driver, bar.font!, label, d.labelX, d.labelY, null, 1);
    b.staticLabel = staticLabel;
    bar.buttons.push(b);
  }
  return bar;
}

function buttonFree(b: Button): void {
  if (b.hoverLabel) labelDestroy(b.hoverLabel);
  if (b.staticLabel) labelDestroy(b.staticLabel);
}

/**
 * Frees every button with its labels.
 *
 * @mw2shell button_bar_destroy 0x000287a0
 * @fidelity exact
 */
export function buttonBarDestroy(bar: ButtonBar): ButtonBar {
  for (const b of bar.buttons) buttonFree(b);
  bar.buttons = [];
  return bar;
}

/**
 * Keeps the buttons with index below n and frees the rest.
 *
 * @mw2shell button_bar_truncate 0x00028820
 * @fidelity exact
 */
export function buttonBarTruncate(bar: ButtonBar, n: number): void {
  const keep: Button[] = [];
  for (const b of bar.buttons) {
    if (b.index < n) keep.push(b);
    else buttonFree(b);
  }
  bar.buttons = keep;
}

/**
 * The index of the enabled button whose rectangle holds (x, y), or -1 (the
 * last such, as the loop keeps going). A button under the pointer gets its
 * hover label; one the pointer left loses it and redraws its static label.
 *
 * @mw2shell button_bar_hit 0x000288d0
 * @fidelity exact
 */
export function buttonBarHit(bar: ButtonBar, x: number, y: number): number {
  let hit = -1;
  for (const b of bar.buttons) {
    const [x0, y0, x1, y1] = b.rect;
    const over = b.enabled !== 0 && !(y1 < y || y < y0 || x1 < x || x < x0);
    if (!over) {
      if (b.hoverLabel) {
        labelDestroy(b.hoverLabel);
        b.hoverLabel = null;
        if (b.staticLabel) textLabelRedraw(b.staticLabel);
      }
    } else if (b.hoverLabel === null && b.label !== null && b.label.length !== 0) {
      b.hoverLabel = labelCreate(b.font!, b.labelX, b.labelY, b.label, b.colour);
    }
    if (over && b.enabled === 1) hit = b.index;
  }
  return hit;
}

/**
 * Deletes the button with that index.
 *
 * @mw2shell button_bar_remove 0x00028a60
 * @fidelity exact
 */
export function buttonBarRemove(bar: ButtonBar, index: number): void {
  bar.buttons = bar.buttons.filter((b) => {
    if (b.index !== index) return true;
    buttonFree(b);
    return false;
  });
}

/**
 * Appends one button, with the same '<' rule.
 *
 * @mw2shell button_bar_add 0x00028ad0
 * @fidelity exact
 */
export function buttonBarAdd(bar: ButtonBar, def: ButtonDef, index: number, outline: number): void {
  let label = def.label ?? '';
  let staticLabel: TextLabel | null = null;
  if (label[0] === '<') {
    label = label.slice(1);
    staticLabel = labelCreate(bar.font!, def.labelX, def.labelY, label, bar.ramp);
  }
  const b = buttonInit(new Button(), def.x0, def.y0, def.x1, def.y1, index, outline, bar.driver!, bar.font!, label, def.labelX, def.labelY, null, 1);
  b.staticLabel = staticLabel;
  bar.buttons.push(b);
}

/**
 * Enables the button and draws its static label.
 *
 * @mw2shell button_enable 0x00028b60
 * @fidelity exact
 */
export function buttonEnable(bar: ButtonBar, index: number): void {
  for (const b of bar.buttons) {
    if (b.index === index && b.enabled === 0) {
      b.enabled = 1;
      if (b.staticLabel) {
        labelsAdd(bar.driver!, b.staticLabel, 1);
        textLabelRedraw(b.staticLabel);
      }
    }
  }
}

/**
 * Disables the button and takes its labels down.
 *
 * @mw2shell button_disable 0x00028bc0
 * @fidelity exact
 */
export function buttonDisable(bar: ButtonBar, index: number): void {
  for (const b of bar.buttons) {
    if (b.index === index && b.enabled !== 0) {
      b.enabled = 0;
      if (b.hoverLabel) {
        labelDestroy(b.hoverLabel);
        b.hoverLabel = null;
      }
      if (b.staticLabel) labelHide(b.staticLabel);
    }
  }
}
