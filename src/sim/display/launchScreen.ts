/**
 * The launch screen MW2.EXE shows while a mission loads: the pilot's launch
 * picture (launch\<-B= name>.shp off the CD, 'supanm' by default) faded in,
 * with the 'launch' animation playing over it on an AIL timer until main
 * stops it at the end of its start-up (decompiled/mw2/src/boot/game_boot.c).
 */
import { LABEL } from '../../generated/labels.gen.ts';
import { ViewWindow } from '../../generated/classes.gen.ts';
import { registerGlobals } from '../../engine/globals.ts';
import { cdDriveLetter, dosFileLoad } from '../../engine/dosFiles.ts';
import { bootImage } from '../../engine/image.ts';
import { vfxPaneWipe, vfxShapeCount, vfxShapeDraw } from '../../engine/vfx/vfx.ts';
import { launchArgs } from '../../mission/commandLine.ts';
import { dacWrite, paletteFadeUsedColours } from '../world/palettes.ts';
import { layoutPaneFitShape } from './layout.ts';
import { defaultCanvas, display } from './video.ts';

export const launchScreen = registerGlobals(
  'launchScreen',
  {
    /** 0x957dc: the launch picture's shapes */
    picture: null as Uint8Array | null,
    /** 0x957e0 / 0x957e4: the animation's shapes and count */
    animation: null as Uint8Array | null,
    animationCount: 0,
    /** 0x95818: the frame launch_anim_tick draws next */
    frame: 0,
    /** 0xa560c / 0xa5610: where it draws it */
    x: 0,
    y: 0,
    /** 0xa55f0: currentViewport fitted to the picture */
    pane: new ViewWindow(),
    /** 0x957d8: the AIL timer, -1 for none (the host runs launch_anim_tick) */
    timer: -1,
  },
  () => {
    const s = launchScreen;
    s.picture = null;
    s.animation = null;
    s.animationCount = 0;
    s.frame = 0;
    s.x = 0;
    s.y = 0;
    s.pane = new ViewWindow();
    s.timer = -1;
  },
);

/** The launch timer's period: 0x50910 microseconds. */
export const LAUNCH_TICK_MS = 0x50910 / 1000;

/**
 * The art variant's file-name suffix: '' for variant 0, '6' for 1 and 2 (the
 * two-byte strings at 0x95760).
 *
 * @mw2 vfx_font_sub_015210 0x00015210
 * @fidelity exact
 */
export function vfxFontSub015210(): string {
  let v = display.assetVariant;
  if (v === 2) v = 1;
  return bootImage()?.cstrAt(0x95760 + v * 2) ?? (v === 0 ? '' : '6');
}

/**
 * Copies a shape's palette entries - {index, r, g, b} after a count, at the
 * shape's +0xc offset - into a 256 x RGB palette.
 *
 * @mw2 vfx_lib_sub_058966 0x00058966
 * @fidelity exact
 */
export function vfxLibSub058966(table: Uint8Array, n: number, out: Uint8Array): void {
  const dv = new DataView(table.buffer, table.byteOffset, table.byteLength);
  let at = dv.getInt32(n * 8 + 0xc, true);
  if (at === 0) return;
  let count = dv.getInt32(at, true);
  do {
    const i = table[at + 4]! * 3;
    out[i] = table[at + 5]!;
    out[i + 1] = table[at + 6]!;
    out[i + 2] = table[at + 7]!;
    at += 4;
  } while (--count !== 0);
}

/** The launch file 'X:launch/<name><variant>.shp' (the CD drive's letter; none when there is no CD). */
export function launchAnimPath(name: string, variant: string = vfxFontSub015210()): string {
  const d = cdDriveLetter();
  // bootImage's 'shp' at 0x90074 and 'launch' at 0x90080
  return `${d ? `${d}:` : ''}launch/${name}${variant}.shp`;
}

/** @portOnly the two files boot_load_launch_anims will open, for the host to fetch off the CD first */
export function launchAnimPaths(): [string, string] {
  const b = launchArgs.launchAnimNameB || 'supanm';
  const g = launchArgs.launchAnimNameG || 'launch';
  return [launchAnimPath(b), launchAnimPath(g)];
}

/**
 * Loads the launch picture and animation. With a picture: the DAC blacked
 * out, shape 0 drawn into currentViewport fitted to it and presented, its
 * own palette faded in over 0x3c ticks, then DAC 0..15 set from
 * launchGreyRamp >> 2 (shifted in place). With the animation too: its frame
 * count, and a position 0.55 of the way across the pane.
 *
 * @mw2 boot_load_launch_anims 0x00015230
 * @fidelity partial
 * @divergence the timer that runs launch_anim_tick is the host's (MW2.EXE's start-up is synchronous in the port)
 */
export function bootLoadLaunchAnims(): void {
  const s = launchScreen;
  const [pathB, pathG] = launchAnimPaths();
  s.picture = dosFileLoad(pathB);
  if (!s.picture) return;
  const target = new Uint8Array(0x300);
  for (let i = 0; i < 0x100; i++) dacWrite(i, target[i * 3]!, target[i * 3 + 1]!, target[i * 3 + 2]!);
  const v = display.currentViewport;
  s.pane.canvas = v.canvas;
  s.pane.left = v.left;
  s.pane.top = v.top;
  s.pane.right = v.right;
  s.pane.bottom = v.bottom;
  layoutPaneFitShape(s.pane, s.pane, s.picture, 0);
  vfxShapeDraw(s.pane, s.picture, 0, 0, 0);
  // the present hook (0x9fd74) blits the pane: the host shows defaultCanvas
  vfxLibSub058966(s.picture, 0, target);
  paletteFadeUsedColours(defaultCanvas, target, 0x3c);
  const img = bootImage();
  for (let i = 0; i < 0x10; i++) {
    const at = LABEL.launchGreyRamp + i * 3;
    const r = (img?.u8(at) ?? 0) >> 2;
    const g = (img?.u8(at + 1) ?? 0) >> 2;
    const b = (img?.u8(at + 2) ?? 0) >> 2;
    dacWrite(i, r, g, b);
  }
  s.animation = dosFileLoad(pathG);
  if (!s.animation) return;
  s.animationCount = vfxShapeCount(s.animation);
  s.x = Math.trunc((s.pane.right - s.pane.left) * 0.55);
  s.y = 0;
  s.timer = 1;
}

/**
 * The timer's tick: with both files and 2+ frames, the pane wiped, the
 * picture and the animation's current frame drawn, presented, and the frame
 * advanced.
 *
 * @mw2 launch_anim_tick 0x000154d0
 * @fidelity exact
 */
export function launchAnimTick(): void {
  const s = launchScreen;
  if (!s.picture || !s.animation || s.animationCount < 2) return;
  vfxPaneWipe(s.pane, 0);
  vfxShapeDraw(s.pane, s.picture, 0, 0, 0);
  vfxShapeDraw(s.pane, s.animation, s.frame, s.x, s.y);
  s.frame = (s.frame + 1) % s.animationCount;
}

/**
 * Stops the launch animation: the timer released, both files freed.
 *
 * @mw2 game_boot_sub_0155a0 0x000155a0
 * @fidelity exact
 */
export function gameBootSub0155a0(): void {
  const s = launchScreen;
  s.timer = -1;
  s.picture = null;
  s.animation = null;
  s.animationCount = 0;
}
