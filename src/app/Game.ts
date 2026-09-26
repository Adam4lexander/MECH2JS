/**
 * The running game as the UI sees it: the loaded data, the current mission,
 * and the mode. Play runs the frame loop (Phase 2 ports its body); Edit holds
 * the original's own pause - time stands still and nothing ticks - while the
 * editor inspects and edits state.
 *
 * @portOnly
 */
import { SystemErrorFatal } from '../core/systemError.ts';
import { error as logError, log } from '../core/log.ts';
import { bootMission } from '../mission/load.ts';
import { engineStore } from '../editor/store/store.ts';
import type { GameData } from './gameData.ts';
import { parseLuma } from '../data/formats/image.ts';
import { cacheLoadResource } from '../engine/resources/cache.ts';
import { palettes, paletteSlotRgb } from '../sim/world/palettes.ts';
import { lighting } from '../sim/world/environment.ts';
import { dayCycle } from '../sim/world/dayCycle.ts';
import type { SceneRenderer } from '../render/SceneRenderer.ts';
import { BitmapAtlas } from '../render/textures/bitmapAtlas.ts';
import { clock } from '../engine/clock.ts';
import { ailTimerService } from '../engine/miles/ail.ts';
import { AudioHost } from '../audio/AudioHost.ts';
import { mainLoopRunning, mainLoopStep } from '../mission/mainLoop.ts';
import { missionEnd, type MissionResults } from '../mission/end.ts';

export type Mode = 'edit' | 'play';

export class Game {
  mode: Mode = 'edit';
  mission: string | null = null;
  loadError: string | null = null;
  /** main's results once its loop has ended (the debriefing's data), else null */
  results: MissionResults | null = null;

  /** the browser's sound: off until the first Play (a user gesture), then the toolbar's toggle */
  readonly audio: AudioHost;
  private audioChosen = false;

  constructor(readonly data: GameData) {
    this.audio = new AudioHost(data.cue);
  }

  loadMission(stream: string): boolean {
    this.audio.pause();
    this.mission = stream;
    this.loadError = null;
    this.results = null;
    const t0 = performance.now();
    let ok = false;
    try {
      ok = bootMission({ exe: this.data.exe, prj: this.data.prj, ini: this.data.ini, looseFiles: this.data.loose, mission: stream });
    } catch (e) {
      this.loadError = e instanceof SystemErrorFatal ? `fatal system error: ${e.message}` : String(e instanceof Error ? (e.stack ?? e.message) : e);
      logError('mission', this.loadError);
    }
    log('mission', `${stream} loaded in ${(performance.now() - t0).toFixed(0)} ms${ok ? '' : ' (with errors)'}`);
    this.mode = 'edit';
    engineStore.bump();
    return ok;
  }

  /**
   * The palette to show. In play, the PAL in paletteCurrentSlot. A mission
   * starts on slot 0x10 (the fade-from preset) with a fade running toward the
   * day cycle's palette; in edit mode time is frozen before that fade, so the
   * editor shows the fade's target instead of the black it starts from.
   */
  /** Editor override: a day phase (0 dawn, 1 day, 2 dusk, 3 night) whose palette to show, or null for the game's. */
  palettePhase: number | null = null;

  /** The editor's palette override: a day phase (0 dawn .. 3 night), or null for the game's own palette. */
  setPalettePhase(phase: number | null): void {
    this.palettePhase = phase;
  }

  paletteRgb(): Uint8Array | null {
    const p = palettes;
    let slot = p.paletteCurrentSlot;
    if (this.palettePhase !== null) return paletteSlotRgb(dayCycle.dayPhasePaletteSlot[this.palettePhase]!) ?? paletteSlotRgb(slot);
    if (this.mode === 'edit') {
      if (p.paletteFadeStepsLeft > 0) slot = p.paletteFadeTarget;
      else if (dayCycle.dayPhase === -1 && dayCycle.dayCycleEnabled) {
        // the phase day_cycle_tick will pick for the current time of day
        let phase = 3;
        for (let i = 0; i < 4; i++) if (dayCycle.dayPhaseStart[i]! <= lighting.timeOfDay) phase = i;
        slot = dayCycle.dayPhasePaletteSlot[phase]!;
      }
    }
    return paletteSlotRgb(slot) ?? paletteSlotRgb(p.paletteCurrentSlot);
  }

  /** The mission's LUMA shade table (lumaTableId, set by LTBL). */
  lumaRows(): Uint8Array | null {
    const b = lighting.lumaTableId > 0 ? cacheLoadResource(lighting.lumaTableId, 'LUMA') : null;
    return b ? parseLuma(b).rows : null;
  }

  /** skyColour as an RGB triple through the current palette. */
  skyRgb(): [number, number, number] {
    const p = this.paletteRgb();
    const i = lighting.skyColour & 0xff;
    return p ? [p[i * 3]!, p[i * 3 + 1]!, p[i * 3 + 2]!] : [0, 0, 0];
  }

  private atlas = new BitmapAtlas();

  /** Builds the CEL atlas for the mission and keeps the slot table live. */
  bindTextures(sr: SceneRenderer): void {
    this.atlas.build(sr.uniforms);
    this.atlas.updateSlots(sr.uniforms);
  }

  /** Per rendered frame: slot animation. */
  updateTextures(sr: SceneRenderer): void {
    this.atlas.updateSlots(sr.uniforms);
  }

  setMode(m: Mode): void {
    if (m === 'play' && !this.audioChosen) {
      this.audioChosen = true;
      this.audio.enable();
    }
    if (m !== 'play') this.audio.pause();
    if (m === 'play') {
      // leave the fixed-step mode Step uses; the next frame steps its last 12 ticks and hands back to real time
      clock.dat00095828 = 0;
      this.pending = 0;
    }
    this.mode = m;
    engineStore.bump();
  }

  /** timer interrupts owed to the game for real time elapsed, fractional */
  private pending = 0;
  /** the most real time one display frame may feed the game (a hidden tab resumes without a burst) */
  private static readonly MAX_TICKS_PER_FRAME = 45;

  /**
   * Play: feeds the 182 Hz timer for `ms` of real time, then runs one pass of
   * main's loop (the original runs as fast as it can; the port runs one pass
   * per display frame). Returns false once the loop has ended (quit).
   */
  playFrame(ms: number): boolean {
    this.pending = Math.min(this.pending + (ms * 182) / 1000, Game.MAX_TICKS_PER_FRAME);
    while (this.pending >= 1) {
      ailTimerService();
      this.pending -= 1;
    }
    const ok = this.runFrame();
    this.audio.pump();
    return ok;
  }

  /**
   * Step: one pass of the loop in the clock's fixed-step mode (simClockMode
   * 3, +12 ticks a frame, the timer frozen) - the original's own mechanism,
   * requested through the flag at 0x95828. The first Step from real time
   * enters the mode with the ticks already due, so it runs two passes.
   */
  step(): boolean {
    this.mode = 'edit';
    const entering = clock.simClockMode !== 3;
    clock.dat00095828 = 1;
    if (entering && !this.runFrame()) return false;
    const ok = this.runFrame();
    engineStore.bump();
    return ok;
  }

  private runFrame(): boolean {
    if (!mainLoopRunning()) return false;
    try {
      mainLoopStep();
      if (!mainLoopRunning()) {
        // main's shutdown after its loop: the results the debriefing shows
        this.results = missionEnd();
        this.mode = 'edit';
        engineStore.bump();
      }
    } catch (e) {
      this.loadError = e instanceof SystemErrorFatal ? `fatal system error: ${e.message}` : String(e instanceof Error ? (e.stack ?? e.message) : e);
      logError('frame', this.loadError);
      this.mode = 'edit';
      engineStore.bump();
      return false;
    }
    return mainLoopRunning();
  }
}
