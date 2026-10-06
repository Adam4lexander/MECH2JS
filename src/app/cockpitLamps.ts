/**
 * Which of the cockpit's switches are lit (render/cockpit/controls.ts
 * LampKey), read from the sim each frame. It only reads.
 *
 * @portOnly the VR controls
 */
import { CONTROLS, type LampKey } from '../render/cockpit/controls.ts';
import { hud } from '../sim/cockpit/hud.ts';
import { objectivesHud } from '../sim/cockpit/objectivesHud.ts';
import { radar } from '../sim/cockpit/radar.ts';
import { renderOptions } from '../sim/display/renderState.ts';
import { mechs } from '../sim/mech/mechGlobals.ts';
import { mechRuntime } from '../sim/mech/mechRuntime.ts';
import { weaponGlobals } from '../sim/weapons/weapons.ts';
import { dayCycle } from '../sim/world/dayCycle.ts';

/** The ids of the switches whose lamps are on. */
export function cockpitLit(): Set<string> {
  const l = mechs.mechTable[mechs.playerMechIndex]?.loadout ?? null;
  const on: Record<LampKey, boolean> = {
    // status 3: shut down (command_execute's STARTUP/SHUTDOWN_MECH)
    shutdown: l?.status === 3,
    // flags 8: the heat shutdown overridden (player_cockpit_frame)
    override: !!l && (l.flags & 8) !== 0,
    masc: mechRuntime.mascEngaged !== 0,
    autoEject: mechRuntime.autoEjectEnabled !== 0,
    // 1: chain fire, 0: group fire (mech_weapons_tick)
    chain: weaponGlobals.chainFireMode !== 0,
    autopilot: !!l && l.autopilotEngaged !== 0,
    ir: dayCycle.infraredOn !== 0,
    enhanced: renderOptions.wireframeMode === 1,
    hud: hud.hudEnabled !== 0,
    objectives: objectivesHud.objectivesDisplayOn !== 0,
    // radar modes 3-5: the satellite map
    map: radar.mode >= 3,
  };
  const lit = new Set<string>();
  for (const d of CONTROLS.values()) if (d.lamp && on[d.lamp]) lit.add(d.id);
  return lit;
}
