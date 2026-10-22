// The HUD's layers (a headset draws the reticle and the target marker into
// the world, apart from the rest): every pixel carries the layer it was last
// written in, and a clear forgets it. And the inset views' marks: a view
// stands over the pixels of its pane until the 2D draws over them.
import { describe, expect, it } from 'vitest';
import { ViewWindow } from '../../src/generated/classes.gen.ts';
import { HUD_LAYER, VfxWindow, hudDrawInLayer, vfxLineDraw, vfxPaneWipe, vfxWindowAllocate, vfxWindowClear, vfxWindowClearPane, vfxWindowMarkInset } from '../../src/engine/vfx/vfx.ts';

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

describe('inset view marks', () => {
  const at = (x: number, y: number) => y * 16 + x;

  it('marks the rectangle a view stands over, clipped to the window, keeping the pixels under it', () => {
    const { win, pane } = setup();
    vfxPaneWipe(pane, 5);
    vfxWindowMarkInset(win, 12, 6, 8, 8, 2);
    expect(win.inset[at(12, 6)]).toBe(3);
    expect(win.inset[at(15, 7)]).toBe(3);
    expect(win.inset[at(11, 6)]).toBe(0);
    expect(win.inset[at(12, 5)]).toBe(0);
    // the wipe under it stays, for where the view draws nothing
    expect(win.buffer[at(12, 6)]).toBe(5);
    expect(win.drawn[at(12, 6)]).toBe(1);
    // wholly off the window: nothing
    vfxWindowMarkInset(win, 20, 0, 4, 4, 0);
    vfxWindowMarkInset(win, -8, -8, 4, 4, 0);
    expect(win.inset.filter((m) => m === 1).length).toBe(0);
  });

  it('lets the 2D drawn afterwards cover the view pixel by pixel (the frame round the target display)', () => {
    const { win, pane } = setup();
    vfxWindowMarkInset(win, 0, 0, 16, 8, 0);
    vfxLineDraw(pane, 0, 0, 15, 0, 0, 8);
    expect(win.inset[at(3, 0)]).toBe(0);
    expect(win.inset[at(3, 1)]).toBe(1);
    // a view drawn again marks its pane again
    vfxWindowMarkInset(win, 0, 0, 16, 8, 0);
    expect(win.inset[at(3, 0)]).toBe(1);
  });

  it('is forgotten with the rest of the 2D', () => {
    const { win, pane } = setup();
    vfxWindowMarkInset(win, 0, 0, 16, 8, 1);
    vfxWindowClearPane(pane);
    expect(win.inset.every((m) => m === 0)).toBe(true);
    vfxWindowMarkInset(win, 0, 0, 16, 8, 1);
    vfxWindowClear(win);
    expect(win.inset.every((m) => m === 0)).toBe(true);
  });
});
