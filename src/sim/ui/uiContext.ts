/**
 * The ui context list (project_tables): the UiContext nodes main registers
 * with ids 4, 5, 6, 7, 8 and 3 - each id the MENU it opens - walked every
 * frame by menu_poll_key and ui_context_dispatch (sim/ui/menus.ts). Id 4 is
 * also the pause context: game_update_pause stops the sim clock while it is
 * active.
 */
import { soundPause, soundResume } from '../sound/music.ts';
import { unestablished } from '../../core/provenance.ts';
import { UiContext, type MenuContext } from '../../generated/classes.gen.ts';
import { LABEL } from '../../generated/labels.gen.ts';
import { registerGlobals } from '../../engine/globals.ts';
import { imageI32 } from '../../engine/image.ts';
import { stopwatchElapsed, stopwatchReset, timerSetPaused } from '../../engine/timer.ts';
import { mechs } from '../mech/mechGlobals.ts';
import { inputGlobals } from '../controls/inputGlobals.ts';
import { inputSub048ca0 } from '../controls/input.ts';
import { commandExecute } from './commands.ts';

export const ui = registerGlobals(
  'ui',
  {
    /** 0xd4044 */
    uiContextHead: null as UiContext | null,
    /** 0xd4040 */
    uiContextTail: null as UiContext | null,
    /** 0xd404c: the key code menu_poll_key leaves for the menus */
    menuKeyPending: 0,
    /** 0x958a4 menuRepeatStopwatch: -1 until menu_open creates it; menu_poll_key times the axis repeats with it */
    dat000958a4: -1,
    /** 0xd4048: menus open (menu_open / menu_close) */
    menuOpenCount: 0,
    /** 0xd407c: set by 'Flee to DOS'; main exits with 0xff */
    fleeToDos: 0,
    /** 0x982f4: set once 'Press any key to exit...' is posted */
    exitPromptShown: 0,
    /** 0x95860 */
    quitRequested: 0,
    /** 0x95864: the frame loop runs while this is below 3 */
    quitCountdown: 0,
    /** 0x95898: 1 while paused (game_update_pause) */
    gamePaused: 0,
  },
  () => {
    const u = ui;
    u.uiContextHead = null;
    u.uiContextTail = null;
    u.menuKeyPending = imageI32(LABEL.menuKeyPending, 0);
    u.dat000958a4 = imageI32(LABEL.menuRepeatStopwatch, -1);
    u.menuOpenCount = imageI32(LABEL.menuOpenCount, 0);
    u.fleeToDos = imageI32(LABEL.fleeToDos, 0);
    u.exitPromptShown = imageI32(LABEL.exitPromptShown, 0);
    u.quitRequested = imageI32(LABEL.quitRequested, 0);
    u.quitCountdown = imageI32(LABEL.quitCountdown, 0);
    u.gamePaused = imageI32(LABEL.gamePaused, 0);
  },
);

/**
 * Appends a context with this id to the list.
 *
 * @mw2 ui_context_register 0x00017570
 * @fidelity exact
 * @divergence the node is a JS object rather than malloc(0x12)
 */
export function uiContextRegister(id: number): UiContext {
  const c = new UiContext();
  c.id = id | 0;
  if (ui.uiContextHead) ui.uiContextTail!.next = c;
  else ui.uiContextHead = c;
  ui.uiContextTail = c;
  return c;
}

/**
 * The active byte of the context with this id, or 0 if there is none.
 *
 * @mw2 ui_context_active 0x00018690
 * @fidelity exact
 */
export function uiContextActive(id: number): number {
  let c = ui.uiContextHead;
  while (c && c.id !== id) c = c.next;
  return c ? c.active & 0xff : 0;
}

/**
 * The pause gate: freezes the sim clock (and sound) on the frame context 4
 * becomes active, resumes them on the frame it clears.
 *
 * @mw2 game_update_pause 0x00015e90
 * @fidelity exact
 */
export function gameUpdatePause(): void {
  if (uiContextActive(4) === 0) {
    if (ui.gamePaused !== 0) {
      timerSetPaused(0x80, 0);
      soundResume();
      ui.gamePaused = 0;
    }
  } else if (ui.gamePaused === 0) {
    timerSetPaused(0x80, 1);
    soundPause();
    ui.gamePaused = 1;
  }
}

/**
 * Turns the menu control channels into one pending key code for the active
 * context's menu.
 *
 * @mw2 menu_poll_key 0x00017cd0
 * @fidelity exact
 */
export function menuPollKey(): void {
  const u = ui;
  const pc = mechs.playerControls;
  const inp = inputGlobals;
  u.menuKeyPending = 0;
  let record: MenuContext | null = null;
  for (let c = u.uiContextHead; c; c = c.next) {
    if ((c.active & 0xff) === 1) {
      record = c.record;
      break;
    }
  }
  if (!record) {
    u.menuKeyPending = 0;
    return;
  }
  const b = record.flags & 0xff;
  const key = inp.controlKey & 0xffff;
  if (key === 0) {
    if (b & 1) {
      if (pc.menu_enter === 0) {
        if (pc.menu_abort !== 0) u.menuKeyPending = 0x1b;
      } else u.menuKeyPending = 0xd;
      if (u.menuKeyPending === 0 && 0x5b < stopwatchElapsed(u.dat000958a4)) {
        if (pc.menu_item < -0x2000) u.menuKeyPending = 0x96;
        else if (0x2000 < pc.menu_item) u.menuKeyPending = 0x97;
      }
      if (u.menuKeyPending === 0 && 0x2d < stopwatchElapsed(u.dat000958a4)) {
        if (pc.menu_value < -0x2000) u.menuKeyPending = 0x99;
        else if (0x2000 < pc.menu_value) u.menuKeyPending = 0x20;
      }
    }
  } else {
    const sk = (key << 16) >> 16;
    let v = sk;
    if (sk !== 0x1b && (sk < 0x30 || 0x39 < sk)) {
      v = u.menuKeyPending;
      if (b & 1) {
        if (key < 0x20) {
          if (8 < key && (key < 10 || key === 0xd)) v = sk;
        } else if (key < 0x21 || (0x95 < key && (key < 0x9a || key === 0x209))) v = sk;
      }
    }
    u.menuKeyPending = v;
    if (u.menuKeyPending === sk) inp.controlKey = 0;
  }
  if (u.menuKeyPending !== 0 && (b & 1) !== 0) {
    stopwatchReset(u.dat000958a4);
    pc.menu_item_reset = 1;
    pc.menu_value_reset = 1;
  }
}

/**
 * The per-frame key command step: a waiting key quits at the exit prompt,
 * otherwise goes to the cheat decoder (single player) and then, mapped
 * through GAMEKEY.MAP, to command_execute.
 *
 * @mw2 key_command_update 0x00045d80
 * @fidelity partial
 * @divergence cheat_handle_command (the cheat-code decoder) is not ported
 */
export function keyCommandUpdate(): void {
  const key = inputGlobals.controlKey & 0xffff;
  if (key === 0) return;
  if (ui.exitPromptShown !== 0) {
    ui.quitRequested = 1;
    ui.quitCountdown = (ui.quitCountdown + 2) | 0;
    return;
  }
  if (mechs.netGameEnabled === 0) unestablished('cheat codes (cheat_handle_command) are not ported', 'key_command_update');
  commandExecute(inputSub048ca0(key) & 0xffff);
}
