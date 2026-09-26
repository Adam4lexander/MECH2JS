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

export type Mode = 'edit' | 'play';

export class Game {
  mode: Mode = 'edit';
  mission: string | null = null;
  loadError: string | null = null;

  constructor(readonly data: GameData) {}

  loadMission(stream: string): boolean {
    this.mission = stream;
    this.loadError = null;
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
    this.mode = m;
    engineStore.bump();
  }
}
