// The HUD's layers (a headset draws the reticle and the target marker into
// the world, apart from the rest): every pixel carries the layer it was last
// written in, and a clear forgets it.
import { describe, expect, it } from 'vitest';
import { ViewWindow } from '../../src/generated/classes.gen.ts';
import { HUD_LAYER, VfxWindow, hudDrawInLayer, vfxLineDraw, vfxWindowAllocate, vfxWindowClear, vfxWindowClearPane } from '../../src/engine/vfx/vfx.ts';

function setup(): { win: VfxWindow; pane: ViewWindow } {
  const win = new VfxWindow();
  vfxWindowAllocate(win, 16, 8);
  const pane = new ViewWindow();
  pane.canvas = win;
  pane.left = 0;
  pane.top = 0;
  pane.right = 15;
  pane.bottom = 7;
  return { win, pane };
}

describe('HUD layers', () => {
  it('tags pixels drawn inside hudDrawInLayer, and only those', () => {
    const { win, pane } = setup();
    vfxLineDraw(pane, 0, 0, 15, 0, 0, 7);
    hudDrawInLayer(HUD_LAYER.reticle, () => vfxLineDraw(pane, 0, 2, 15, 2, 0, 9));
    vfxLineDraw(pane, 0, 4, 15, 4, 0, 7);
    expect(win.layer[0]).toBe(HUD_LAYER.rest);
    expect(win.layer[2 * 16 + 5]).toBe(HUD_LAYER.reticle);
    expect(win.layer[4 * 16 + 5]).toBe(HUD_LAYER.rest);
  });

  it('retags a pixel drawn over, and a clear forgets the tags', () => {
    const { win, pane } = setup();
    hudDrawInLayer(HUD_LAYER.targetMarker, () => vfxLineDraw(pane, 0, 3, 15, 3, 0, 9));
    vfxLineDraw(pane, 4, 0, 4, 7, 0, 7);
    expect(win.layer[3 * 16 + 4]).toBe(HUD_LAYER.rest);
    expect(win.layer[3 * 16 + 5]).toBe(HUD_LAYER.targetMarker);
    vfxWindowClearPane(pane);
    expect(win.layer.every((l) => l === 0)).toBe(true);
    hudDrawInLayer(HUD_LAYER.targetMarker, () => vfxLineDraw(pane, 0, 3, 15, 3, 0, 9));
    vfxWindowClear(win);
    expect(win.layer.every((l) => l === 0)).toBe(true);
  });

  it('restores the layer when the drawing throws', () => {
    const { win, pane } = setup();
    expect(() =>
      hudDrawInLayer(HUD_LAYER.reticle, () => {
        throw new Error('x');
      }),
    ).toThrow();
    vfxLineDraw(pane, 0, 1, 15, 1, 0, 7);
    expect(win.layer[16 + 3]).toBe(HUD_LAYER.rest);
  });
});
