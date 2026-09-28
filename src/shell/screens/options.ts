/**
 * COMBAT VARIABLES, item 1 of shell_menu: the options panel
 * (decompiled/mw2shell/src/screens/options.c). The panel is data -
 * optionsWidgets (0x7d09c), 15 widget rows each pointing at the byte or
 * dword it shows and edits in simOptions (MW2DIF.CFG) or soundConfig
 * (MW2SND.CFG) - and these are the rows' draw and click functions. The
 * panel reads both files as it opens and writes both as it closes; nothing
 * in the shell acts on soundConfig, which is for MW2.EXE.
 *
 *   y 128 / 152 / 176  sliders: musicVolume, sfxVolume, voiceVolume (x 335)
 *   y 219  difficulty          EASY / MEDIUM / HARD
 *   y 239  heat tracking       ON / OFF
 *   y 277 .. 357  object textures, terrain textures, display detail,
 *                 object density, explosion chunks
 *   y 377  resolution          soundConfig.videoDriver
 *   y 416 / 436 / 456  invulnerability, unlimited ammo, collision damage:
 *                 'ON (Dishonorable)' when set the way that stops a career
 */
import { SHELL_LABEL } from '../../generated/shell/labels.gen.ts';
import { mpackDbGetItem } from '../../data/formats/mpack.ts';
import { cdiv } from '../../core/int/cint.ts';
import { quirk } from '../../core/provenance.ts';
import { registerGlobals } from '../../engine/globals.ts';
import { fieldOffset, mem } from '../memory.ts';
import { database, driver, mouse, shell } from '../state.ts';
import type { Blocking } from '../host/blocking.ts';
import { screenPaintPicture } from '../video/background.ts';
import { videoDriverErase, videoDriverShape } from '../video/driver.ts';
import { BackgroundMovie, movieBackgroundClose, movieBackgroundStep, movieOpenBackground } from '../anim/movies.ts';
import { labelCreateUnder, type TextLabel } from '../ui/labels.ts';
import { inputFlush, inputPollKey } from '../ui/keys.ts';
import { mouseLeftClicked, mouseRightClicked, mouseUpdate } from '../ui/mouse.ts';
import { menuScreens } from '../ui/menuScreens.ts';
import {
  registerWidgetClick,
  registerWidgetDraw,
  WIDGET,
  type WidgetClickFn,
  widgetField,
  widgetPanelFreeLabels,
  widgetPanelHit,
  widgetPanelLayout,
  widgetPanelRedraw,
  widgetRowClick,
} from '../ui/widgets.ts';
import { soundSamplePlay } from '../sound/samples.ts';
import { musicApplyVolume } from '../sound/music.ts';
import { simOptionsRead, simOptionsWrite } from '../options/simOptions.ts';
import { soundConfigRead, soundConfigWrite } from '../options/soundConfig.ts';

/** optionsWidgets (0x7d09c): the panel's rows */
const TABLE = SHELL_LABEL.optionsWidgets;
/** soundConfig.sfxVolume (0x7d3d4): options_click_slider's preview swaps it */
const SFX_VOLUME = SHELL_LABEL.soundConfig + fieldOffset('SoundConfig', 'sfxVolume');

export const optionsPanel = registerGlobals(
  'optionsPanel',
  {
    /** optionsMovie (0x91150): the amwlogo1 loop behind the panel; left as it was after its close */
    movie: null as BackgroundMovie | null,
    /** sliderShapes (0x91154): DATABASE.MW2 item 8 - shape 1 the bar, shape 0 the knob */
    sliderShapes: null as Uint8Array | null,
  },
  () => {
    optionsPanel.movie = null;
    optionsPanel.sliderShapes = null;
  },
  'mw2shell',
);

/** @portOnly a click function that never blocks, in the WidgetClickFn shape */
function immediate(fn: (row: number) => void): WidgetClickFn {
  // eslint-disable-next-line require-yield
  return function* (row) {
    fn(row);
  };
}

/** The address a row's value points at. */
const valueOf = (row: number): number => mem().u32(row + WIDGET.value);

/** label_create_under(font27, x + w / 2 - shift, y, text, 0): every text row's label ('~' texts centre on that x). */
function rowLabel(row: number, text: number, shift = 0): TextLabel {
  const x = widgetField(row, 'x') + cdiv(widgetField(row, 'w'), 2) - shift;
  return labelCreateUnder(shell.font27!, x, widgetField(row, 'y'), mem().cstr(text), null);
}

/**
 * The difficulty row: difficultyNames[byte] - '~EASY', '~MEDIUM', '~HARD' -
 * centred on the row. The byte is not bounded: past 2 the original reads
 * the next table's first dword as the text's pointer (an MW2DIF.CFG only
 * the panel writes never holds one).
 *
 * @mw2shell options_draw_difficulty 0x000251a0
 * @fidelity exact
 */
export const optionsDrawDifficulty = registerWidgetDraw('options_draw_difficulty', 0x000251a0, (row) =>
  rowLabel(row, mem().u32(SHELL_LABEL.difficultyNames + mem().u8(valueOf(row)) * 4)),
);

/**
 * A dword row: '~ON' when non-zero, else '~OFF' (object and terrain
 * textures, explosion chunks).
 *
 * @mw2shell options_draw_on_off 0x000251e0
 * @fidelity exact
 */
export const optionsDrawOnOff = registerWidgetDraw('options_draw_on_off', 0x000251e0, (row) =>
  rowLabel(row, mem().i32(valueOf(row)) === 0 ? SHELL_LABEL.optionsTextOff : SHELL_LABEL.optionsTextOn),
);

/**
 * The same for a byte (heat tracking).
 *
 * @mw2shell options_draw_on_off_byte 0x00025230
 * @fidelity exact
 */
export const optionsDrawOnOffByte = registerWidgetDraw('options_draw_on_off_byte', 0x00025230, (row) =>
  rowLabel(row, mem().u8(valueOf(row)) === 0 ? SHELL_LABEL.optionsTextOffByte : SHELL_LABEL.optionsTextOnByte),
);

/**
 * A rule that stops a career when set (invulnerability, unlimited ammo):
 * 'ON (Dishonorable)' when the byte is non-zero, else '~OFF'. The long
 * text has no '~', so it is not centred: it starts 14 px left of the
 * row's centre and runs right.
 *
 * @mw2shell options_draw_dishonorable_when_set 0x00025280
 * @fidelity exact
 */
export const optionsDrawDishonorableWhenSet = registerWidgetDraw('options_draw_dishonorable_when_set', 0x00025280, (row) =>
  mem().u8(valueOf(row)) === 0 ? rowLabel(row, SHELL_LABEL.optionsTextOffSet) : rowLabel(row, SHELL_LABEL.optionsTextDishonorableSet, 0xe),
);

/**
 * The inverse, for collision damage (a career needs it on): '~OFF' when
 * the byte is non-zero, 'ON (Dishonorable)' (uncentred, from 14 px left of
 * the centre) when it is 0 - so the row reads as "no collision damage".
 *
 * @mw2shell options_draw_dishonorable_when_clear 0x000252d0
 * @fidelity exact
 */
export const optionsDrawDishonorableWhenClear = registerWidgetDraw('options_draw_dishonorable_when_clear', 0x000252d0, (row) =>
  mem().u8(valueOf(row)) === 0 ? rowLabel(row, SHELL_LABEL.optionsTextDishonorableClear, 0xe) : rowLabel(row, SHELL_LABEL.optionsTextOffClear),
);

/**
 * A dword row: '~HIGH' when non-zero, else '~LOW' (display detail, object
 * density).
 *
 * @mw2shell options_draw_high_low 0x00025320
 * @fidelity exact
 */
export const optionsDrawHighLow = registerWidgetDraw('options_draw_high_low', 0x00025320, (row) =>
  rowLabel(row, mem().i32(valueOf(row)) === 0 ? SHELL_LABEL.optionsTextLow : SHELL_LABEL.optionsTextHigh),
);

/**
 * The resolution row, from soundConfig.videoDriver: '~320x200' for an
 * empty name, '~640x480' when its fifth character is '4' (vesa480.dll),
 * anything else '~1024x768' - so a name MW2.EXE left there ('mcga.dll', its
 * image's) reads as 1024x768.
 *
 * @mw2shell options_draw_resolution 0x00025370
 * @fidelity exact
 */
export const optionsDrawResolution = registerWidgetDraw('options_draw_resolution', 0x00025370, (row) => {
  const p = valueOf(row);
  const text = mem().u8(p) === 0 ? SHELL_LABEL.optionsText320x200 : mem().u8(p + 4) === 0x34 ? SHELL_LABEL.optionsText640x480 : SHELL_LABEL.optionsText1024x768;
  return rowLabel(row, text);
});

/**
 * The difficulty byte steps 0 -> 1 -> 2 -> 0.
 *
 * @mw2shell options_click_cycle3 0x000253c0
 * @fidelity exact
 */
export const optionsClickCycle3 = registerWidgetClick('options_click_cycle3', 0x000253c0, immediate((row) => {
  const p = valueOf(row);
  let v = (mem().u8(p) + 1) & 0xff;
  if (2 < v) v = 0;
  mem().setU8(p, v);
}));

/**
 * dword *value = (*value == 0).
 *
 * @mw2shell options_click_toggle 0x000253e0
 * @fidelity exact
 */
export const optionsClickToggle = registerWidgetClick('options_click_toggle', 0x000253e0, immediate((row) => {
  const p = valueOf(row);
  mem().setI32(p, mem().i32(p) === 0 ? 1 : 0);
}));

/**
 * byte *value = (*value == 0).
 *
 * @mw2shell options_click_toggle_byte 0x00025400
 * @fidelity exact
 */
export const optionsClickToggleByte = registerWidgetClick('options_click_toggle_byte', 0x00025400, immediate((row) => {
  const p = valueOf(row);
  mem().setU8(p, mem().u8(p) === 0 ? 1 : 0);
}));

/**
 * soundConfig.videoDriver cycles '' -> 'vesa480.dll' -> 'vesa768.dll' ->
 * '' (strncpy of 15, NUL-padded; the 16th byte is left). MW2.EXE's
 * game_boot takes the name for its video driver.
 *
 * @mw2shell options_click_resolution 0x00025410
 * @fidelity exact
 * @divergence the name is stored and shown faithfully, but nothing in the port acts on it: MW2.EXE's driver DLLs (mcga, vesa480, vesa768) are not loaded and the renderer draws at the browser's resolution whatever the row says
 */
export const optionsClickResolution = registerWidgetClick('options_click_resolution', 0x00025410, immediate((row) => {
  const m = mem();
  const p = valueOf(row);
  let next: number;
  if (m.u8(p) === 0) next = SHELL_LABEL.videoDriverVesa480;
  else if (m.u8(p + 4) === 0x34) next = SHELL_LABEL.videoDriverVesa768;
  else next = SHELL_LABEL.videoDriverNone;
  m.strncpy(p, m.cstr(next), 0xf);
}));

/**
 * A row with no value: its own rectangle (335, 128, 285 x 78, the box
 * behind the three sliders) erased back to the background. No label.
 *
 * @mw2shell options_draw_rect 0x00025460
 * @fidelity exact
 */
export const optionsDrawRect = registerWidgetDraw('options_draw_rect', 0x00025460, (row) => {
  videoDriverErase(driver(), widgetField(row, 'x'), widgetField(row, 'y'), widgetField(row, 'w'), widgetField(row, 'h'));
  return null;
});

/**
 * A slider: the bar (sliderShapes shape 1) over the row, and the knob
 * (shape 0, 15 x 29) at x + 15 + value / 256 - 7, one pixel higher. No
 * label.
 *
 * @mw2shell options_draw_slider 0x00025480
 * @fidelity exact
 */
export const optionsDrawSlider = registerWidgetDraw('options_draw_slider', 0x00025480, (row) => {
  const d = driver();
  const shapes = optionsPanel.sliderShapes!;
  const v = mem().i32(valueOf(row));
  const x = widgetField(row, 'x');
  const y = widgetField(row, 'y');
  videoDriverShape(d, shapes, 1, x, y, widgetField(row, 'w'), widgetField(row, 'h'));
  videoDriverShape(d, shapes, 0, x + 0xf + cdiv(v, 0x100) - 7, y - 1, 0xf, 0x1d);
  return null;
});

/**
 * Drags a slider while the left button is held: each pass the value is
 * the pointer's x less x + 15, clamped to 0..256, times 256 (0..0x10000);
 * whenever it has moved 0xa00 or more since the last preview, sound102
 * plays with soundConfig.sfxVolume set to the new value for the call. The
 * panel is redrawn, the movie stepped, the mouse read, and the song's
 * volume re-applied.
 *
 * @mw2shell options_click_slider 0x000254f0
 * @fidelity exact
 */
export const optionsClickSlider = registerWidgetClick('options_click_slider', 0x000254f0, function* (row) {
  const m = mem();
  const ms = mouse();
  const p = valueOf(row);
  let previewed = m.i32(p);
  do {
    let v = (ms.x - (widgetField(row, 'x') + 0xf)) | 0;
    if (v < 0) v = 0;
    else if (0x100 < v) v = 0x100;
    v <<= 8;
    m.setI32(p, v);
    if (Math.abs((previewed - v) | 0) >= 0xa00) {
      previewed = v;
      const saved = m.i32(SFX_VOLUME);
      m.setI32(SFX_VOLUME, v);
      quirk('the slider preview sets soundConfig.sfxVolume around sound_sample_play, which never reads it: sound102 plays at its own volume whichever slider moves');
      soundSamplePlay(shell.sound102!);
      m.setI32(SFX_VOLUME, saved);
    }
    widgetPanelRedraw(TABLE);
    if (optionsPanel.movie) movieBackgroundStep(optionsPanel.movie);
    yield* mouseUpdate(ms);
    // music_apply_volume re-applies the song's own volume; the music slider does not reach it
    if (shell.soundSystem) musicApplyVolume(shell.soundSystem);
  } while (ms.leftDown === 1);
});

/**
 * COMBAT VARIABLES: DATABASE picture 3 over the screen, the erase fill
 * turned off, 375, 124 (258 x 352) erased, the amwlogo1 loop at (120, 4).
 * MW2SND.CFG is read into soundConfig and MW2DIF.CFG into simOptions (each
 * left as it was when missing), and optionsWidgets laid out. Then each
 * pass: the movie stepped, the mouse read; a right click ends it; a left
 * click on a row with a clickFn runs it and redraws the panel; any key
 * ends it. The labels freed, both files written back whole, the movie
 * closed and the fill restored. shell_menu erases the screen and restores
 * its palette after.
 *
 * @portOnly shell_menu's item 1 (0x258e0), split out so it registers with menuScreens like the menu's other items; the body is shell_menu's case 1, reads and writes included
 */
export function* combatVariables(): Blocking<void> {
  const d = driver();
  const m = mem();
  optionsPanel.movie = null;
  optionsPanel.sliderShapes = mpackDbGetItem(database(), 8);
  screenPaintPicture(d, 3);
  d.fillColour = 0;
  videoDriverErase(d, 0x177, 0x7c, 0x102, 0x160);
  optionsPanel.movie = null;
  optionsPanel.movie = yield* movieOpenBackground(new BackgroundMovie(), m.cstr(SHELL_LABEL.optionsMovieName), 0x78, 4);
  inputFlush(shell.keyInput!);
  soundConfigRead();
  simOptionsRead();
  widgetPanelLayout(TABLE);
  const ms = mouse();
  do {
    if (optionsPanel.movie) movieBackgroundStep(optionsPanel.movie);
    yield* mouseUpdate(ms);
    if (mouseRightClicked(ms) === 1) break;
    if (mouseLeftClicked(ms) === 1) {
      const row = widgetPanelHit(TABLE, ms.x, ms.y);
      if (row !== 0 && m.u32(row + WIDGET.clickFn) !== 0) {
        yield* widgetRowClick(row);
        widgetPanelRedraw(TABLE);
      }
    }
  } while (inputPollKey(shell.keyInput!) === 0);
  widgetPanelFreeLabels(TABLE);
  soundConfigWrite();
  simOptionsWrite();
  if (optionsPanel.movie) movieBackgroundClose(optionsPanel.movie);
  d.fillColour = -1;
}

menuScreens.register(1, combatVariables);
