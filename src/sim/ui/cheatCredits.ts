/**
 * MW2.EXE's fifth cheat code ("You asked for it!"): cheat_handle_command
 * calls cheat_credits_hook_install, which puts cheat_credits_render_hook in
 * main's render hook (DAT_00097074). Over the following frames the hook runs
 * the view as usual for 0x38e ticks (5 s), shrinks it to a small box at the
 * centre of the screen and back (0x27d ticks each way), closes it to a point
 * (a line, then a dot, on black, framed in colour 10, 0x2d8 ticks), then
 * shows two pictures - VFX\VFXJK.BIN and VFX\VFXHD.BIN, GIF87a files of the
 * install, each faded in and held for 0x111 ticks - opens MENU 3 (the
 * credits pages) over the second picture and, once that is closed and
 * 0x111 ticks more have gone, puts the palette and the old hook back and
 * turns the HUD on.
 *
 * The pictures are two versions of one digitised group photograph of about
 * twenty people standing and kneeling in rows in front of a building: in
 * vfxjk (320x211) every face has been replaced by the same face, in vfxhd
 * (320x200) the faces are enlarged heads pasted onto the bodies. A third
 * version, VFX\VFXTM.BIN (320x200, the photograph unaltered), is on the disk
 * but nothing in MW2.EXE or MW2SHELL.EXE names it.
 *
 * decompiled/mw2/src/ui/ui_callbacks.c (0x19e80..0x1a843).
 */
import { ViewWindow } from '../../generated/classes.gen.ts';
import { LABEL } from '../../generated/labels.gen.ts';
import { divergence, quirk, unestablished } from '../../core/provenance.ts';
import { clock } from '../../engine/clock.ts';
import { registerCode } from '../../engine/codePtr.ts';
import { dosFileLoad } from '../../engine/dosFiles.ts';
import { registerGlobals } from '../../engine/globals.ts';
import { bootImage, imageI32, imageU8 } from '../../engine/image.ts';
import { GIF_WORK_SIZE, gifDecode, gifPaletteRead } from '../../engine/vfx/gif.ts';
import { vfxPaneWipe } from '../../engine/vfx/vfx.ts';
import { mainLoop, type RenderHook } from '../../mission/mainLoop.ts';
import { hud, paneTransitionRestart, paneTransitionStep, paneTransitionStepSplit } from '../cockpit/hud.ts';
import { radar } from '../cockpit/radar.ts';
import type { PaneTransition } from '../cockpit/resources.ts';
import { layoutPaneFitGif, layoutPaneToWindow, vfxPaneFrame } from '../display/layout.ts';
import { defaultCanvas, display, imageCanvas, viewportSelect } from '../display/video.ts';
import { lighting } from '../world/environment.ts';
import { dacWrite, paletteApplySlot, paletteFadeUsedColours, palettes } from '../world/palettes.ts';
import { uiContextClearRequest } from './menuCallbacks.ts';
import { uiContextActiveRecord, uiContextRequestOpen } from './menus.ts';

/** A ViewWindow as the image holds it at addr. */
function paneAt(addr: number): ViewWindow {
  const w = new ViewWindow();
  w.canvas = imageCanvas(addr);
  w.left = imageI32(addr + 4, 0);
  w.top = imageI32(addr + 8, 0);
  w.right = imageI32(addr + 0xc, 0);
  w.bottom = imageI32(addr + 0x10, 0);
  return w;
}

function bootCheatCredits() {
  const smallPane = paneAt(LABEL.cheatCreditsSmallPane);
  // the params record 0x95a14: {duration, from 0x959d0, to 0x959e4, out 0x959f8}; the state record 0x95a0c: {now, before, elapsed}
  const transition: PaneTransition = {
    now: imageU8(0x95a0c, 0),
    before: imageU8(0x95a0d, 0),
    elapsed: imageI32(0x95a0e, 0),
    duration: imageI32(0x95a14, 0xb6),
    from: smallPane,
    to: paneAt(0x959e4),
    out: paneAt(0x959f8),
  };
  return {
    /** 0x959b8: main's render hook as the cheat found it (vfx_video_sub_010490 in the image) */
    cheatCreditsSavedHook: null as RenderHook | null,
    /** 0x959bc: the screen's centre point (all four edges 0x8000 as fractions); the close's end */
    cheatCreditsPointPane: paneAt(LABEL.cheatCreditsPointPane),
    /** 0x959d0: a small box round the centre (0x7d71..0x828f as fractions) */
    cheatCreditsSmallPane: smallPane,
    /** 0x95a24: the pane transition, from 0x959d0 (then 0x959bc) to the full screen 0x959e4 */
    cheatCreditsTransition: transition,
    /** 0x95a2c: the picture file, or null */
    cheatCreditsPicture: null as Uint8Array | null,
    /** 0x95a30: 256 x 3 bytes, the fade's target palette */
    cheatCreditsPalette: null as Uint8Array | null,
    /** 0x95a34: gif_decode's work block */
    cheatCreditsGifWork: null as Uint8Array | null,
    /** 0x95a38: a picture is up */
    cheatCreditsPictureShown: imageI32(LABEL.cheatCreditsPictureShown, 0),
    /** 0x95a3c: the simTick the current state ends at */
    cheatCreditsTimer: imageI32(LABEL.cheatCreditsTimer, 0),
    /** 0x95a40: pane_transition_step's direction, 1 then 0 */
    cheatCreditsTransitionDir: imageU8(LABEL.cheatCreditsTransitionDir, 0),
    /** 0xd4050: currentViewport fitted to the first picture; both are drawn in it */
    cheatCreditsPicturePane: paneAt(LABEL.cheatCreditsPicturePane),
    /** 0xd4064: currentViewport as state 0 found it */
    cheatCreditsSavedViewport: paneAt(LABEL.cheatCreditsSavedViewport),
    /** 0xd4080: the colour the fades go through - bss, written by nothing: black */
    cheatCreditsFadeColour: Uint8Array.from([0, 1, 2].map((i) => imageU8(LABEL.cheatCreditsFadeColour + i, 0))),
    /** 0xd4083: the state, 0..7 then 0xff */
    cheatCreditsState: imageU8(LABEL.cheatCreditsState, 0),
  };
}

export const cheatCredits = registerGlobals('cheatCredits', bootCheatCredits(), () => {
  Object.assign(cheatCredits, bootCheatCredits());
});

/** viewportModes[i]; the original indexes the table with whatever currentViewportMode holds. */
function modeSlot(i: number): ViewWindow {
  const w = lighting.viewportModes[i];
  if (w) return w;
  unestablished(`cheat_credits_render_hook: currentViewportMode ${i} is outside viewportModes - the original reads and writes the memory there`, 'cheat_credits_render_hook');
  return new ViewWindow();
}

function copyPane(dst: ViewWindow, src: ViewWindow): void {
  dst.canvas = src.canvas;
  dst.left = src.left;
  dst.top = src.top;
  dst.right = src.right;
  dst.bottom = src.bottom;
}

/** A string of the image's (its address is in the code). */
function text(addr: number, fallback: string): string {
  return bootImage()?.cstrAt(addr) ?? fallback;
}

/**
 * Loads vfx/<name>.bin whole - sprintf("%s/%s.%s", "vfx", name, "bin") and
 * file_load - or returns null.
 *
 * @mw2 vfx_bin_file_load 0x00019e80
 * @fidelity exact
 */
export function vfxBinFileLoad(name: string): Uint8Array | null {
  return dosFileLoad(`${text(0x90268, 'vfx')}/${name}.${text(0x90264, 'bin')}`);
}

/** hudEnabled = 0 and the requests of ui contexts 6, 2, 4, 7, 8 and 5 cleared - the hook's every-frame opening from state 2 on. */
function hideHud(): void {
  hud.hudEnabled = 0;
  for (const id of [6, 2, 4, 7, 8, 5]) uiContextClearRequest(id);
}

/** The driver's window refresh (vfxWindowRefresh, 0x9fd60) of the whole window, which the port's host does every frame. */
function windowRefresh(): void {
  divergence('vfxWindowRefresh (0x9fd60, the VFX driver copying the window to the screen at once) is the host\'s, which shows defaultCanvas every frame', 'cheat_credits_render_hook');
}

/**
 * The render hook while the fifth cheat code runs, a state machine on
 * cheatCreditsState:
 *   0  saves currentViewport, lays the transition's panes out the first time
 *      and draws the view through the saved hook; 1 goes on doing so for
 *      0x38e ticks.
 *   2  the view drawn through the transition's rectangle (viewportModes'
 *      entry swapped for it) - full screen to the small box, then back -
 *      with hudEnabled saved in 0x955ac and the flip told to restore it;
 *   3  then closed to the centre point with pane_transition_step_split on a
 *      black screen, the shrinking pane framed in colour 10.
 *   4  the DAC set to the fade colour, the first picture ("vfxjk") fitted,
 *      decoded, shown and faded in; 5 after 0x111 ticks faded out, the
 *      second ("vfxhd") shown and faded in; 6 after 0x111 more, MENU 3
 *      opened over it (the palette left as the picture's); 7 the picture
 *      redrawn under the menu until no context is active; 0xff after 0x111
 *      more, the palette slot, the hook and the HUD put back.
 * From state 2 on hudEnabled is 0 and the lance and user menus' requests
 * are cleared each frame (except in 7).
 *
 * @mw2 cheat_credits_render_hook 0x00019f40
 * @fidelity exact
 * @divergence vfxWindowRefresh, the driver's immediate copy of the window to the screen, is the host's frame; the blocking fades are played by the host after the frame (palettes.dacPlayback), each with a copy of the window as it stood when the fade ran
 */
export const cheatCreditsRenderHook = registerCode('cheat_credits_render_hook', 0x19f40, (): void => {
  const s = cheatCredits;
  const t = s.cheatCreditsTransition;
  const pic = () => gifDecode(s.cheatCreditsPicturePane, s.cheatCreditsPicture!, s.cheatCreditsGifWork!);

  // The view drawn through the rectangle a transition step returns, in
  // place of viewportModes' current entry; states 2 and 3.
  const throughRect = (rect: ViewWindow, draw: () => void): void => {
    const mode = display.currentViewportMode;
    const keep = new ViewWindow();
    copyPane(keep, modeSlot(mode));
    copyPane(modeSlot(mode), rect);
    display.currentViewportMode = -1;
    viewportSelect(mode);
    draw();
    copyPane(modeSlot(display.currentViewportMode), keep);
  };

  // State 2 (0x1a06e): the view shrinks to the small box and grows back.
  // Returns true when it has passed on to state 3 (the original falls through).
  const shrink = (): boolean => {
    radar.savedHudEnabled = hud.hudEnabled;
    hideHud();
    const rect = paneTransitionStep(s.cheatCreditsTransitionDir, t);
    if (rect) {
      throughRect(rect, () => {
        s.cheatCreditsSavedHook?.();
        radar.viewportRestorePending = 1;
      });
      return false;
    }
    if (s.cheatCreditsTransitionDir === 1) {
      s.cheatCreditsTransitionDir = 0;
      paneTransitionRestart(t);
      return false;
    }
    t.duration = 0x2d8;
    t.from = s.cheatCreditsPointPane;
    paneTransitionRestart(t);
    s.cheatCreditsState = 3;
    return true;
  };

  // State 3 (0x1a1a7): the view closes to the centre point on black.
  const close = (): boolean => {
    hideHud();
    const rect = paneTransitionStepSplit(1, t);
    if (rect) {
      throughRect(rect, () => {
        vfxPaneWipe(s.cheatCreditsSavedViewport, 0);
        s.cheatCreditsSavedHook?.();
        vfxPaneFrame(display.currentViewport, 10);
      });
      copyPane(display.currentViewport, s.cheatCreditsSavedViewport);
      return false;
    }
    const mode = display.currentViewportMode;
    display.currentViewportMode = -1;
    viewportSelect(mode);
    s.cheatCreditsState = 4;
    return true;
  };

  // State 4 (0x1a2ce): the first picture.
  const firstPicture = (): void => {
    hideHud();
    copyPane(s.cheatCreditsPicturePane, display.currentViewport);
    // malloc(0x502e) and calloc(0x100, 3), which cannot fail here
    s.cheatCreditsGifWork = new Uint8Array(GIF_WORK_SIZE);
    s.cheatCreditsPalette = new Uint8Array(0x300);
    const f = s.cheatCreditsFadeColour;
    for (let i = 0; i < 0x100; i++) dacWrite(i, f[0]!, f[1]!, f[2]!);
    s.cheatCreditsPicture = vfxBinFileLoad(text(0x90278, 'vfxjk'));
    if (s.cheatCreditsPicture) {
      layoutPaneFitGif(s.cheatCreditsPicturePane, s.cheatCreditsPicturePane, s.cheatCreditsPicture);
      pic();
      windowRefresh();
      gifPaletteRead(s.cheatCreditsPicture, s.cheatCreditsPalette);
      paletteFadeUsedColours(defaultCanvas, s.cheatCreditsPalette, 0xb6);
      s.cheatCreditsPictureShown = 1;
    }
    s.cheatCreditsTimer = (clock.simTick + 0x111) | 0;
    s.cheatCreditsState = 5;
  };

  switch (s.cheatCreditsState) {
    case 0: {
      copyPane(s.cheatCreditsSavedViewport, display.currentViewport);
      t.from = s.cheatCreditsSmallPane;
      s.cheatCreditsPictureShown = 0;
      if (t.from.canvas === null) {
        layoutPaneToWindow(defaultCanvas, t.from, t.from);
        t.from.canvas = defaultCanvas;
        layoutPaneToWindow(defaultCanvas, t.to, t.to);
        t.to.canvas = defaultCanvas;
        t.out.canvas = defaultCanvas;
        s.cheatCreditsPointPane.canvas = defaultCanvas;
        layoutPaneToWindow(defaultCanvas, s.cheatCreditsPointPane, s.cheatCreditsPointPane);
      }
      s.cheatCreditsTimer = (clock.simTick + 0x38e) | 0;
      s.cheatCreditsState = 1;
      s.cheatCreditsSavedHook?.();
      return;
    }
    case 1:
      if (clock.simTick < s.cheatCreditsTimer) {
        s.cheatCreditsSavedHook?.();
        return;
      }
      s.cheatCreditsTransitionDir = 1;
      t.duration = 0x27d;
      paneTransitionRestart(t);
      s.cheatCreditsState = 2;
      if (shrink() && close()) firstPicture();
      return;
    case 2:
      if (shrink() && close()) firstPicture();
      return;
    case 3:
      if (close()) firstPicture();
      return;
    case 4:
      firstPicture();
      return;
    case 5:
      hideHud();
      if (s.cheatCreditsTimer <= clock.simTick) {
        s.cheatCreditsPicture = vfxBinFileLoad(text(0x90280, 'vfxhd'));
        if (!s.cheatCreditsPicture || s.cheatCreditsPictureShown === 0) s.cheatCreditsPictureShown = 0;
        else {
          const p = s.cheatCreditsPalette!;
          const f = s.cheatCreditsFadeColour;
          for (let i = 0; i < 0x100; i++) p.set(f, i * 3);
          paletteFadeUsedColours(defaultCanvas, p, 0x5b);
          vfxPaneWipe(display.currentViewport, 0);
          quirk('the second picture (320x200) is drawn in the pane fitted to the first (320x211), from its top row: it sits about 5 rows above centre, with black below', 'cheat_credits_render_hook');
          pic();
          windowRefresh();
          gifPaletteRead(s.cheatCreditsPicture, p);
          paletteFadeUsedColours(defaultCanvas, p, 0xb6);
        }
        s.cheatCreditsTimer = (clock.simTick + 0x111) | 0;
        s.cheatCreditsState = 6;
        return;
      }
      if (s.cheatCreditsPictureShown !== 0) {
        pic();
        windowRefresh();
      }
      return;
    case 6:
      hideHud();
      if (s.cheatCreditsTimer <= clock.simTick) {
        if (s.cheatCreditsPictureShown === 0) paletteApplySlot(palettes.paletteCurrentSlot);
        uiContextRequestOpen(3);
        s.cheatCreditsState = 7;
        return;
      }
      if (s.cheatCreditsPictureShown !== 0) pic();
      return;
    case 7:
      vfxPaneWipe(display.currentViewport, 0);
      if (s.cheatCreditsPictureShown !== 0) pic();
      if (uiContextActiveRecord() === null) {
        s.cheatCreditsState = 0xff;
        s.cheatCreditsTimer = (clock.simTick + 0x111) | 0;
      }
      return;
    case 0xff:
      hideHud();
      if (clock.simTick < s.cheatCreditsTimer) {
        vfxPaneWipe(display.currentViewport, 0);
        if (s.cheatCreditsPictureShown !== 0) pic();
        return;
      }
      vfxPaneWipe(display.currentViewport, 0);
      windowRefresh();
      paletteApplySlot(palettes.paletteCurrentSlot);
      s.cheatCreditsPicture = null;
      s.cheatCreditsPalette = null;
      s.cheatCreditsGifWork = null;
      mainLoop.renderHook = s.cheatCreditsSavedHook;
      quirk('the HUD comes back on (savedHudEnabled = 1) whatever it was before the cheat', 'cheat_credits_render_hook');
      radar.savedHudEnabled = 1;
      radar.viewportRestorePending = 1;
      s.cheatCreditsState = 0;
      return;
  }
});

/**
 * The fifth cheat code: main's render hook saved and cheat_credits_render_hook
 * put in its place, at state 0.
 *
 * @mw2 cheat_credits_hook_install 0x0001a820
 * @fidelity exact
 */
export function cheatCreditsHookInstall(): void {
  cheatCredits.cheatCreditsSavedHook = mainLoop.renderHook;
  mainLoop.renderHook = cheatCreditsRenderHook;
  cheatCredits.cheatCreditsState = 0;
}
