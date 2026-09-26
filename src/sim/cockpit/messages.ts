/**
 * The message bars: two slots (messageSlots, 0x95558) that message_post
 * fills and message_bar_draw shows each frame, after the HUD and before the
 * page flip - slot 0 along the top of the screen, slot 1 along the bottom,
 * each the SHP bar 0x4c with its text in a FONT. A message shows for its own
 * number of SIM stopwatch ticks, timed on the raw stopwatch, so it does not
 * run out while the timer is paused.
 */
import { cdiv } from '../../core/int/cint.ts';
import { unestablished } from '../../core/provenance.ts';
import { simStopwatchElapsed } from '../../engine/clock.ts';
import { registerGlobals } from '../../engine/globals.ts';
import { imageI32 } from '../../engine/image.ts';
import { cacheLoadResource } from '../../engine/resources/cache.ts';
import { vfxFontHeight, vfxShapeDraw, vfxStringDraw } from '../../engine/vfx/vfx.ts';
import { MessageSlot, ViewWindow } from '../../generated/classes.gen.ts';
import { LABEL } from '../../generated/labels.gen.ts';
import { layoutPaneFitShape, layoutPaneToWindow, layoutPointInPane } from '../display/layout.ts';
import { defaultCanvas, display, imageCanvas } from '../display/video.ts';

function bootMessages() {
  const slots = [0, 1].map((i) => {
    const at = LABEL.messageSlots + i * 0x24;
    const s = new MessageSlot();
    // +0 points at the slot's 0x100-byte buffer (messageText + i * 0x100), empty in the image
    s.text = '';
    s.textX = imageI32(at + 4, 0x28f);
    s.textY = imageI32(at + 8, 0);
    s.inUse = imageI32(at + 0xc, 0);
    s.priority = imageI32(at + 0x10, 0);
    s.fontId = imageI32(at + 0x14, 1);
    s.shpId = imageI32(at + 0x18, 0x4c);
    s.endTick = imageI32(at + 0x1c, 0);
    // +0x20 points at messagePanes[i]
    const p = LABEL.messagePanes + i * 0x14;
    const pane = new ViewWindow();
    pane.canvas = imageCanvas(p);
    pane.left = imageI32(p + 4, 0);
    pane.top = imageI32(p + 8, 0);
    pane.right = imageI32(p + 0xc, 0x10000);
    pane.bottom = imageI32(p + 0x10, 0x10000);
    s.pane = pane;
    return s;
  });
  return {
    /** 0x95558: the two slots - 0 the top bar, 1 the bottom */
    messageSlots: slots,
  };
}

export const messages = registerGlobals('messages', bootMessages(), () => Object.assign(messages, bootMessages()));

/**
 * Posts a message: the first empty slot, else - of the busy slots whose
 * priority is not above this one's - the one of lowest priority, and among
 * equal lowest the one that ends later; else nothing (0). The text is cut
 * at 0xff bytes; a font below 1 becomes 1. Returns 1 when posted.
 *
 * @mw2 message_post 0x00011020
 * @fidelity exact
 */
export function messagePost(text: string, fontId: number, ticks: number, priority: number): number {
  const slots = messages.messageSlots;
  let done = false;
  let chosen = -1;
  let best = 0x29a;
  let bestEnd = 0;
  let i = 0;
  while (!done) {
    const s = slots[i]!;
    if (s.inUse === 0) {
      done = true;
      chosen = i;
    } else {
      const p = s.priority;
      if (p <= priority) {
        if (p < best) {
          bestEnd = s.endTick;
          chosen = i;
          best = p;
        } else if (best === p) {
          if (chosen === -1) unestablished('message_post: a slot of priority 0x29a compares against an uninitialised local', 'message_post');
          if (bestEnd < s.endTick) {
            bestEnd = s.endTick;
            chosen = i;
          }
        }
      }
      i++;
      if (i === 2) done = true;
    }
  }
  if (chosen === -1) return 0;
  const s = slots[chosen]!;
  const nul = text.indexOf('\0');
  s.text = (nul < 0 ? text : text.slice(0, nul)).slice(0, 0xff);
  s.inUse = 1;
  s.priority = priority;
  s.endTick = (simStopwatchElapsed() + ticks) | 0;
  s.fontId = fontId < 1 ? 1 : fontId;
  return 1;
}

/**
 * The start-up layout, from layout_rescale_all: each slot's pane (the whole
 * screen as fractions) into window pixels, fitted about its centre to its
 * bar shape, then moved to x = 0 and by its own top - up for slot 0 (to the
 * top of the screen), down for slot 1 (to the bottom); the text point into
 * the pane, and the text centred vertically in the slot's font.
 *
 * @mw2 message_bar_layout 0x00010f00
 * @fidelity exact
 */
export function messageBarLayout(): void {
  for (let i = 0; i < 2; i++) {
    const s = messages.messageSlots[i]!;
    const pane = s.pane!;
    layoutPaneToWindow(defaultCanvas, pane, pane);
    const shp = cacheLoadResource((display.assetVariant + s.shpId) | 0, 'SHP');
    if (shp) layoutPaneFitShape(pane, pane, shp, 0);
    const dy = Math.imul(i === 0 ? -1 : 1, pane.top);
    const left = pane.left;
    pane.left = (pane.left - left) | 0;
    pane.right = (pane.right - left) | 0;
    pane.bottom = (pane.bottom + dy) | 0;
    pane.top = (pane.top + dy) | 0;
    const pt = Int32Array.of(s.textX, s.textY);
    layoutPointInPane(pane, pt, pt);
    s.textX = pt[0]!;
    s.textY = pt[1]!;
    const font = cacheLoadResource((display.assetVariant + s.fontId) | 0, 'FONT');
    if (font) s.textY = cdiv((pane.bottom - pane.top + 1 - vfxFontHeight(font)) | 0, 2);
  }
}

/**
 * Each frame, after the HUD: every slot in use draws its bar and text while
 * the stopwatch is below its endTick, and is freed once it is not. A slot
 * whose FONT or SHP does not load shows nothing and stays in use.
 *
 * @mw2 message_bar_draw 0x00011130
 * @fidelity exact
 */
export function messageBarDraw(): void {
  for (let i = 0; i < 2; i++) {
    const s = messages.messageSlots[i]!;
    if (s.inUse === 0) continue;
    if (simStopwatchElapsed() < s.endTick) {
      const font = cacheLoadResource((display.assetVariant + s.fontId) | 0, 'FONT');
      if (!font) continue;
      const shp = cacheLoadResource((display.assetVariant + s.shpId) | 0, 'SHP');
      if (!shp) continue;
      vfxShapeDraw(s.pane!, shp, 0, 0, 0);
      vfxStringDraw(s.pane!, s.textX, s.textY, font, s.text ?? '', display.textColourTable);
    } else s.inUse = 0;
  }
}
