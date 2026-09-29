/**
 * The body of main's frame loop (game_boot.c, main @ 0x15a30), one ported
 * call per line in the original order. Steps whose bodies belong to later
 * phases are the stubs in laterPhases.ts, each reporting once that it did
 * nothing.
 *
 *   while (quitCountdown < 3) {
 *     netplay_frame_exchange();   sim_clock_step();      input_poll_controls();
 *     menu_poll_key();            key_command_update(0,0);
 *     task_list_run(&missionTaskList);
 *     mech_dispatch_hook1();      camera_update();
 *     projectiles_update_all();   sim_slots_update();
 *     mech_dispatch_hook3();      mech_dispatch_hook2();
 *     destructibles_update();     world_records_tick();  bitmap3d_animate();
 *     (*DAT_00097074)(0);         mech_dispatch_hook4();
 *     ui_context_dispatch(); vfx_video_sub_0106d0();
 *     sound_frame_update();       voice_queue_advance();
 *     day_cycle_tick();           mission_results_update();
 *     music_update();             game_update_pause();
 *     if (quitRequested && !local_2c[2]) { quitCountdown++; local_2c[2] = 1; }
 *   }
 *
 * The loop itself is the host's (a browser cannot block in a while loop):
 * it calls mainLoopFrame() once per displayed frame while mainLoopRunning().
 */
import { simClockStep } from '../engine/clock.ts';
import { taskGlobals, taskListRun } from '../engine/tasks/taskList.ts';
import { cameraUpdate } from '../sim/camera/cameraUpdate.ts';
import { inputPollControls } from '../sim/controls/input.ts';
import { inputGlobals } from '../sim/controls/inputGlobals.ts';
import { commandGlobals, keyPauseEnd } from '../sim/ui/commands.ts';
import { mechDispatchHook1, mechDispatchHook2, mechDispatchHook3, mechDispatchHook4 } from '../sim/mech/hooks.ts';
import { netplayFrameExchange } from '../sim/net/netSession.ts';
import { gameUpdatePause, keyCommandUpdate, menuPollKey, ui } from '../sim/ui/uiContext.ts';
import { uiContextDispatch } from '../sim/ui/menus.ts';
import { bitmap3dAnimate } from '../sim/world/bitmap3d.ts';
import { dayCycleTick } from '../sim/world/dayCycle.ts';
import { paletteApplyPending, paletteFadeStep } from '../sim/world/palettes.ts';
import { worldRecordsTick } from '../sim/world/worldRecords.ts';
import { registerGlobals } from '../engine/globals.ts';
import { divergence } from '../core/provenance.ts';
import { simSlotsUpdate } from '../sim/effects/effects.ts';
import { destructiblesUpdate } from '../sim/things/destructibles.ts';
import { projectilesUpdateAll } from '../sim/weapons/projectiles.ts';
import { messageBarDraw } from '../sim/cockpit/messages.ts';
import { radarFlipRestore } from '../sim/cockpit/radar.ts';
import { soundFrameUpdate } from '../sim/sound/mixer.ts';
import { musicUpdate } from '../sim/sound/music.ts';
import { voiceQueueAdvance } from '../sim/sound/voice.ts';
import { missionResultsUpdate } from './results.ts';
import { presentPassBegin } from '../engine/scene/present.ts';
import { DRAWN } from '../engine/vfx/vfx.ts';
import { defaultCanvas } from '../sim/display/video.ts';

/**
 * DAT_00097074: the frame's render call. main's loop calls it between
 * bitmap3d_animate and mech_dispatch_hook4; what it points at is the
 * presentation layer's (the host sets it, see app/Host.ts).
 */
export type RenderHook = () => void;

export const mainLoop = registerGlobals(
  'mainLoop',
  {
    /** 0x97074 */
    renderHook: null as RenderHook | null,
    /** main's local_2c[2]: quitCountdown has had its one extra step */
    quitCounted: 0,
    /** @portOnly frames run since the loop started */
    frameCount: 0,
  },
  () => {
    mainLoop.renderHook = null;
    mainLoop.quitCounted = 0;
    mainLoop.frameCount = 0;
  },
);

/** @portOnly main's loop condition */
export function mainLoopRunning(): boolean {
  return ui.quitCountdown < 3;
}

/**
 * The display step after the HUD: the message bars, input housekeeping,
 * the palette fade, then the page flip.
 *
 * @mw2 vfx_video_sub_0106d0 0x000106d0
 * @fidelity partial
 * @divergence input_sub_048ed0 and the driver's flip (DAT_0009fd74) are the presentation layer's; the message bars, the palette steps and the map transition's restore (0xa46d0) run here
 */
export function vfxVideoSub0106d0(): void {
  messageBarDraw();
  divergence('the page flip and input housekeeping of vfx_video_sub_0106d0 are the host renderer\'s', 'vfx_video_sub_0106d0');
  paletteFadeStep();
  paletteApplyPending();
  // after the flip (DAT_0009fd74): a map transition's currentViewport and hudEnabled go back
  radarFlipRestore();
}

/**
 * One pass of main's frame loop.
 *
 * @portOnly the body of main's while loop, in order; main (0x15a30) itself is claimed by nothing
 */
export function mainLoopFrame(): void {
  // port-only: what the window is drawn with is drawn before any world-anchored 2D (engine/vfx/vfx.ts DRAWN)
  defaultCanvas.drawnMark = DRAWN;
  netplayFrameExchange();
  simClockStep();
  inputPollControls();
  menuPollKey();
  keyCommandUpdate();
  taskListRun(taskGlobals.missionTaskList);
  mechDispatchHook1();
  cameraUpdate();
  projectilesUpdateAll();
  simSlotsUpdate();
  mechDispatchHook3();
  mechDispatchHook2();
  destructiblesUpdate();
  worldRecordsTick();
  bitmap3dAnimate();
  mainLoop.renderHook?.();
  mechDispatchHook4();
  uiContextDispatch();
  vfxVideoSub0106d0();
  soundFrameUpdate();
  voiceQueueAdvance();
  dayCycleTick();
  missionResultsUpdate();
  musicUpdate();
  gameUpdatePause();
  if (ui.quitRequested !== 0 && mainLoop.quitCounted === 0) {
    ui.quitCountdown = (ui.quitCountdown + 1) | 0;
    mainLoop.quitCounted = 1;
  }
  mainLoop.frameCount++;
}

/**
 * What the host calls for each pass: one pass of the loop, or, while
 * PAUSE_GAME is waiting for a key (cheats_sub_046ac0), one turn of that
 * wait - input_poll_controls and the sound refill - until a key comes.
 * Either way it is a pass boundary for the presentation model
 * (engine/scene/present.ts): what the pass writes is drawn moving from where
 * it was before.
 *
 * @portOnly the host's entry into main's loop
 */
export function mainLoopStep(): void {
  presentPassBegin();
  if (commandGlobals.keyPauseActive !== 0) {
    inputPollControls();
    soundFrameUpdate();
    if ((inputGlobals.controlKey & 0xffff) !== 0) {
      inputGlobals.controlKey = 0;
      keyPauseEnd();
    }
    return;
  }
  mainLoopFrame();
}
