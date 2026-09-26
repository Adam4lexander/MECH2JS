/**
 * The ui context list (project_tables): 18-byte nodes main registers with
 * ids 4, 5, 6, 7, 8 and 3, walked every frame by menu_poll_key and
 * project_tables_sub_017ea0. Id 4 is the pause context: game_update_pause
 * stops the sim clock while it is active.
 *
 * Node layout, as its consumers read it (ui_context_register's notes):
 *   +0 id, +4 active (menu_poll_key tests it for 1), +5 a request the owner
 *   sets and the dispatcher clears, +6 the context's record, +0xa four bytes
 *   nothing read so far touches, +0xe next.
 */
import { divergence, unestablished } from '../../core/provenance.ts';
import { LABEL } from '../../generated/labels.gen.ts';
import { registerGlobals } from '../../engine/globals.ts';
import { imageI32 } from '../../engine/image.ts';
import { stopwatchElapsed, stopwatchReset, timerSetPaused } from '../../engine/timer.ts';
import { mechs } from '../mech/mechGlobals.ts';
import { inputGlobals } from '../controls/inputGlobals.ts';
import { inputSub048ca0 } from '../controls/input.ts';
import { commandExecute } from './commands.ts';

/** A context's record (+6). Only its byte at +4 is read here: bit 0 lets menu_poll_key produce keys. */
export interface UiContextRecord {
  flags: number;
}

export class UiContext {
  /** +0x0 */
  id = 0;
  /** +0x4: 1 while the context is active */
  active = 0;
  /** +0x5: the request the owner sets; project_tables_sub_017ea0 moves it into active */
  request = 0;
  /** +0x6 */
  record: UiContextRecord | null = null;
  /** +0xa: not established */
  field_0xa = 0;
  /** +0xe */
  next: UiContext | null = null;
}

export const ui = registerGlobals(
  'ui',
  {
    /** 0xd4044 */
    uiContextHead: null as UiContext | null,
    /** 0xd4040 */
    uiContextTail: null as UiContext | null,
    /** 0xd404c: the key code menu_poll_key leaves for the menus */
    menuKeyPending: 0,
    /** 0x958a4: the stopwatch menu_poll_key times its axis repeats with; which call creates it is not established here */
    dat000958a4: 0,
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
    u.dat000958a4 = imageI32(0x958a4, 0);
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

/** @portOnly the node with this id, or null (the walk ui_context_active makes) */
export function uiContextFind(id: number): UiContext | null {
  let c = ui.uiContextHead;
  while (c && c.id !== id) c = c.next;
  return c;
}

/**
 * The active byte of the context with this id, or 0 if there is none.
 *
 * @mw2 ui_context_active 0x00018690
 * @fidelity exact
 */
export function uiContextActive(id: number): number {
  const c = uiContextFind(id);
  return c ? c.active & 0xff : 0;
}

/**
 * The pause gate: freezes the sim clock (and sound) on the frame context 4
 * becomes active, resumes them on the frame it clears.
 *
 * @mw2 game_update_pause 0x00015e90
 * @fidelity partial
 * @divergence the sound pause and resume (sound_config_sub_043f70 / _043fd0) are Phase 7
 */
export function gameUpdatePause(): void {
  if (uiContextActive(4) === 0) {
    if (ui.gamePaused !== 0) {
      timerSetPaused(0x80, 0);
      ui.gamePaused = 0;
    }
  } else if (ui.gamePaused === 0) {
    timerSetPaused(0x80, 1);
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
  let record: UiContextRecord | null = null;
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
 * The ui dispatcher: for each context whose request differs from its active
 * byte, runs the context's open or close handler, and gives the first
 * active one its frame.
 *
 * @mw2 project_tables_sub_017ea0 0x00017ea0
 * @fidelity partial
 * @divergence Phase 4 (menus): no context is ever requested, so the handlers (project_tables_sub_017b40, project_tables_font_handler_2, project_tables_sub_017f30) are not ported; a request is reported and dropped
 */
export function projectTablesSub017ea0(): void {
  for (let c = ui.uiContextHead; c; c = c.next) {
    if ((c.active & 0xff) !== (c.request & 0xff)) {
      unestablished(`ui context ${c.id} requested ${c.request}: the menu handlers are not ported`, 'project_tables_sub_017ea0');
      c.request = c.active;
    }
    if ((c.active & 0xff) === 1) {
      divergence('an active ui context gets no frame: the menu frame (project_tables_sub_017f30) is not ported', 'project_tables_sub_017ea0');
      break;
    }
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
