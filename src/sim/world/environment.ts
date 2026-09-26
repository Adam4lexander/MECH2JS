/**
 * The mission's environment: the planet, climate, lighting, sky and viewport
 * globals that project_chunk_exec's PLNT, CLIM, HTXT, LTBL, MUSI, INIT, LITE,
 * GNDM, HRZM, SKYM, VWSP and LITO branches write. The branches themselves are
 * the interpreter's (mission/vm/chunkExec.ts); this module owns the globals
 * and their boot values, which come from MW2.EXE's initialised data.
 *
 * Every field is named as the decompilation names the global (labels.gen.ts),
 * with two exceptions that have no label: lightDimFlag (0x9705c) and
 * lightObjectFlag (0x954fc). Both are named for what writes them, not for a
 * meaning - see their notes.
 *
 * gravity and gravitySetting are PLNT globals too, but live in planet.ts.
 */
import { ViewWindow } from '../../generated/classes.gen.ts';
import { LABEL } from '../../generated/labels.gen.ts';
import { registerGlobals } from '../../engine/globals.ts';
import { bootImage, imageI32 } from '../../engine/image.ts';

/**
 * viewportModes' length. The contract's VWSP writes 0..8 (it refuses an index
 * of 9 or more with system_error 0x27), but the table is 11 ViewWindows:
 * viewport_select bounds its index at 0xb (label note on viewportModes).
 */
export const VIEWPORT_MODE_COUNT = 11;

/** 0x9705c - not labelled; see lighting.lightDimFlag. */
const LIGHT_DIM_FLAG = 0x9705c;
/** 0x954fc - not labelled; see lighting.lightObjectFlag. */
const LIGHT_OBJECT_FLAG = 0x954fc;

/** A NUL-terminated string in the image's initialised data (empty before an image is loaded). */
function imageCstr(addr: number, max: number): string {
  const img = bootImage();
  return img ? img.cstrAt(addr, max) : '';
}

function bootViewportModes(): ViewWindow[] {
  return Array.from({ length: VIEWPORT_MODE_COUNT }, (_, i) => {
    const w = new ViewWindow();
    const at = LABEL.viewportModes + i * 0x14;
    // canvas (+0) is a pointer into the original's memory; it stays null.
    w.left = imageI32(at + 4, 0);
    w.top = imageI32(at + 8, 0);
    w.right = imageI32(at + 0xc, 0);
    w.bottom = imageI32(at + 0x10, 0);
    return w;
  });
}

function bootLighting() {
  return {
    /** 0x96cf0: the LUMA shade table the mission uses (LTBL); bitmap3d_draw loads it on first use */
    lumaTableId: imageI32(LABEL.lumaTableId, 0),
    /** 0x97064: LITE +0x20 - light_shade_level subtracts one shade level per this much distance */
    lightDimDistance: imageI32(LABEL.lightDimDistance, 100000),
    /**
     * 0x9705c: the LITE branch sets it to 1 when lightDimDistance is positive;
     * effect_spawn saves and clears it while an explosion is the scene light
     * and sim_slots_update restores it. No reader of it has been found, so it
     * is named for its writers only. 0 in the image.
     */
    lightDimFlag: imageI32(LIGHT_DIM_FLAG, 0),
    /** 0x96eac: palette index of the below-horizon fill (GNDM); 239 in the image */
    groundColour: imageI32(LABEL.groundColour, 239),
    /** 0x96ea8: palette index of the above-horizon fill (SKYM); 224 in the image */
    skyColour: imageI32(LABEL.skyColour, 224),
    /** 0x97088: HRZM +0xc, the horizon gradient band's height - 320x200 design pixels as HRZM sets it, screen pixels after layout_rescale_all; 36 in the image */
    horizonBandHeight: imageI32(LABEL.horizonBandHeight, 36),
    /** 0x96eb0: HRZM +8. WRITE-ONLY - no reader in the image */
    hrzmChunkValue: imageI32(LABEL.hrzmChunkValue, 234),
    /** 0x957b8: CLIM +0xc as a signed short. WRITE-ONLY - no reader in the image */
    climChunkValue: imageI32(LABEL.climChunkValue, 0),
    /** 0xa5680: MUSI +8, or resource_id_by_name(0xc, +10) when that is -1; read by music_start_mission_track */
    missionMusicResource: imageI32(LABEL.missionMusicResource, 0),
    /** 0xa5684: MUSI's name string. WRITE-ONLY */
    missionMusicName: imageCstr(LABEL.missionMusicName, 64),
    /** 0xfe100: HTXT's string; the target readout shows it for a concealed, unidentified gamething */
    hiddenText: imageCstr(LABEL.hiddenText, 64),
    /** 0x957c8: seconds into the planet's day; INIT +0x10 sets it, day_cycle_tick advances it. 43200 (noon) in the image */
    timeOfDay: imageI32(LABEL.timeOfDay, 43200),
    /** 0x957c4: INIT +0x14 as a signed short; day_cycle_tick advances it mod daysPerYear */
    dayOfYear: imageI32(LABEL.dayOfYear, 0),
    /** 0x957c0: PLNT [4]; the modulus for dayOfYear */
    daysPerYear: imageI32(LABEL.daysPerYear, 365),
    /** 0x957bc: PLNT [5]; the day length the day cycle wraps timeOfDay at */
    dayLengthSeconds: imageI32(LABEL.dayLengthSeconds, 86400),
    /** 0x957d0: PLNT [9]; mech_load_config picks heat-sink dissipation from it (cold below -30, hot above 50) */
    ambientTemperature: imageI32(LABEL.ambientTemperature, 25),
    /** 0x957d4: PLNT [14] == 0; while set mech_eject refuses */
    ejectDisabled: imageI32(LABEL.ejectDisabled, 0),
    /** 0x96ebc: PLNT [15]; 0 darkens damaged parts' shade, non-zero raises it towards 15 */
    damageShadeRaises: imageI32(LABEL.damageShadeRaises, 0),
    /** 0x9ee50: PLNT [16] == 0; effect_spawn only lets an effect become the scene light while it is set */
    effectLightsAllowed: imageI32(LABEL.effectLightsAllowed, 1),
    /** 0x9703c: PLNT [17] == 0; render_sky_and_ground fills above the horizon while set */
    skyEnabled: imageI32(LABEL.skyEnabled, 1),
    /** 0x97040: PLNT [18] == 0; render_sky_and_ground fills below the horizon while set */
    groundEnabled: imageI32(LABEL.groundEnabled, 1),
    /** 0x97044: PLNT [19] == 0; gates the horizon gradient band */
    horizonBandEnabled: imageI32(LABEL.horizonBandEnabled, 1),
    /** 0x961e4: PLNT [10] when positive; caps the jump jets' climb rate */
    jetClimbLimit: imageI32(LABEL.jetClimbLimit, 100000),
    /** 0x955bc: PLNT [11] (with [12], when either is non-zero); top of the overhead map's height ramp */
    mapHeightHigh: imageI32(LABEL.mapHeightHigh, 6400),
    /** 0x955b8: PLNT [12]; bottom of the overhead map's height ramp */
    mapHeightLow: imageI32(LABEL.mapHeightLow, 0),
    /** 0x961e8: PLNT [13] when positive; the ground slope below which a mech's speed is unaffected (16.16) */
    slopeThreshold: imageI32(LABEL.slopeThreshold, 0x2000),
    /**
     * 0x954fc: the LITO branch sets it to 1 together with lightObjectFollow
     * (label note on lightObjectFollow: vfx_video moves the light only while
     * both are set). Named for that writer; no other meaning established.
     */
    lightObjectFlag: imageI32(LIGHT_OBJECT_FLAG, 0),
    /** 0x95500: while set (with lightObjectFlag) the light follows lightObjectRecord each frame */
    lightObjectFollow: imageI32(LABEL.lightObjectFollow, 1),
    /** 0x95504: the world record the light follows (LITO), -1 for none */
    lightObjectRecord: imageI32(LABEL.lightObjectRecord, -1),
    /** 0x14fd30: ViewWindow[11]; VWSP writes entries 0..8 as {left, top, right, bottom} (inclusive) */
    viewportModes: bootViewportModes(),
  };
}

export const lighting = registerGlobals('environment', bootLighting(), () => {
  Object.assign(lighting, bootLighting());
});
