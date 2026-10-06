/**
 * The cockpit's switches: what each one does, what its lamp shows and which
 * panel it sits on. The kit lays them out (kit.ts Kit.panel, archetypes.ts),
 * the renderer draws them (cockpit.ts), and the VR hands press them
 * (touch.ts) - each press a command for command_execute, or a ControlState
 * channel held for one pass (sim/controls/pilotIntent.ts).
 *
 * Every command id is MW2's own (the decompilation's listing/commands.txt):
 * a switch does what its key does.
 *
 * @portOnly the VR controls
 */

/** What a lamp shows: read from the sim each frame for display (app/cockpitLamps.ts). */
export type LampKey = 'shutdown' | 'override' | 'masc' | 'autoEject' | 'chain' | 'autopilot' | 'ir' | 'enhanced' | 'hud' | 'objectives' | 'map';

export type LampColour = 'red' | 'amber' | 'green';

export interface ControlDef {
  id: string;
  /** what the cap reads, four characters at most */
  label: string;
  /** a command_execute id, or a ControlState channel held for a pass */
  action: { command: number } | { channel: 'weapon_cycle' };
  /** under a cover that must be flipped up first */
  guarded?: boolean;
  lamp?: LampKey;
  colour?: LampColour;
}

const cmd = (id: string, label: string, command: number, more: Partial<ControlDef> = {}): ControlDef => ({ id, label, action: { command }, ...more });

/** MW2's command ids (listing/commands.txt) */
export const CMD = {
  RESET_INPUTS: 0x01,
  MFD_CYCLE: 0x02,
  TOGGLE_HTAL: 0x03,
  TOGGLE_REAR_VIEW: 0x04,
  TOGGLE_DOWN_VIEW: 0x05,
  TOGGLE_WEAPON_DISPLAY: 0x06,
  TOGGLE_DAMAGE_DISPLAY: 0x07,
  TOGGLE_TARGET_DISPLAY: 0x08,
  COCKPIT_VIEW: 0x09,
  ORDINANCE_VIEW: 0x0e,
  FEET_TO_TORSO: 0x11,
  INSPECT_TARGET: 0x12,
  TOGGLE_HUD: 0x13,
  JETTISON_AMMO: 0x14,
  THROTTLE_STOP: 0x1a,
  RESET_TARGETTING: 0x27,
  NEXT_NAVPOINT: 0x28,
  PREV_NAVPOINT: 0x29,
  NEXT_RADAR_MODE: 0x2e,
  RADAR_ZOOM_IN: 0x2f,
  RADAR_ZOOM_OUT: 0x30,
  RADAR_MAP_TOGGLE: 0x32,
  MAIN_MENU: 0x33,
  USER_MENU: 0x34,
  ALL_PT_MENU: 0x35,
  EJECT: 0x3b,
  TOGGLE_AUTOEJECT: 0x3c,
  SHUTDOWN_MECH: 0x3e,
  OVERRIDE_SHUTDOWN: 0x40,
  DISPLAY_OBJECTIVES: 0x41,
  TOGGLE_AUTOPILOT: 0x42,
  TOGGLE_GROUP_FIRE: 0x43,
  NEXT_TARGET: 0x44,
  PREV_TARGET: 0x45,
  TARGET_NEAREST_ENEMY: 0x47,
  TARGET_FRIENDLY: 0x48,
  TARGET_AT_RETICLE: 0x49,
  TARGET_LAST_SHOT: 0x4a,
  NEXT_OBJECTIVE: 0x4b,
  PUNCH_IN_AUTO_HDG: 0x4c,
  TOGGLE_MASC: 0x4d,
  SELF_DESTRUCT: 0x4e,
  PAUSE_GAME: 0x4f,
  ADD_WEAPON_TO_GROUP_1: 0x8e,
  ADD_WEAPON_TO_GROUP_2: 0x8f,
  ADD_WEAPON_TO_GROUP_3: 0x90,
  NEXT_WEAPON_GROUP: 0x91,
  INFRARED: 0x9d,
  ENHANCED_VISION: 0x9e,
} as const;

/**
 * The panels:
 *   sensors  along the foot of the face with the radar and target screens
 *   mfd      along the foot of the face with the weapon list and damage display: its F-key modes
 *   left     the console outboard of the left armrest: the reactor, navigation, vision, the bail-out
 *   right    the console outboard of the right armrest: weapons, the torso, the view, orders
 * The side consoles are grids of four columns, row by row.
 */
export const PANELS = {
  sensors: [
    cmd('radarMode', 'RDR', CMD.NEXT_RADAR_MODE),
    cmd('rangeIn', 'RNG+', CMD.RADAR_ZOOM_IN),
    cmd('rangeOut', 'RNG-', CMD.RADAR_ZOOM_OUT),
    cmd('map', 'MAP', CMD.RADAR_MAP_TOGGLE, { lamp: 'map', colour: 'green' }),
    cmd('targetDisplay', 'TDSP', CMD.TOGGLE_TARGET_DISPLAY),
    cmd('nextTarget', 'TGT>', CMD.NEXT_TARGET),
    cmd('prevTarget', '<TGT', CMD.PREV_TARGET),
    cmd('nearest', 'NRST', CMD.TARGET_NEAREST_ENEMY),
    cmd('friendly', 'FRND', CMD.TARGET_FRIENDLY),
    cmd('atReticle', 'RTCL', CMD.TARGET_AT_RETICLE),
    cmd('inspect', 'INSP', CMD.INSPECT_TARGET),
  ],
  mfd: [
    cmd('mfdCycle', 'MFD', CMD.MFD_CYCLE),
    cmd('damage', 'DMG', CMD.TOGGLE_DAMAGE_DISPLAY),
    cmd('htal', 'HTAL', CMD.TOGGLE_HTAL),
    cmd('rear', 'REAR', CMD.TOGGLE_REAR_VIEW),
    cmd('down', 'DOWN', CMD.TOGGLE_DOWN_VIEW),
    cmd('weaponDisplay', 'WPNS', CMD.TOGGLE_WEAPON_DISPLAY),
    cmd('missileCam', 'MSL', CMD.ORDINANCE_VIEW),
  ],
  left: [
    cmd('power', 'PWR', CMD.SHUTDOWN_MECH, { lamp: 'shutdown', colour: 'red' }),
    cmd('override', 'OVRD', CMD.OVERRIDE_SHUTDOWN, { lamp: 'override', colour: 'amber' }),
    cmd('masc', 'MASC', CMD.TOGGLE_MASC, { lamp: 'masc', colour: 'green' }),
    cmd('jettison', 'JETT', CMD.JETTISON_AMMO, { guarded: true }),
    cmd('nextNav', 'NAV>', CMD.NEXT_NAVPOINT),
    cmd('prevNav', '<NAV', CMD.PREV_NAVPOINT),
    cmd('autopilot', 'AUTO', CMD.TOGGLE_AUTOPILOT, { lamp: 'autopilot', colour: 'green' }),
    cmd('heading', 'HDG', CMD.PUNCH_IN_AUTO_HDG),
    cmd('infrared', 'IR', CMD.INFRARED, { lamp: 'ir', colour: 'green' }),
    cmd('enhanced', 'EV', CMD.ENHANCED_VISION, { lamp: 'enhanced', colour: 'green' }),
    cmd('hud', 'HUD', CMD.TOGGLE_HUD, { lamp: 'hud', colour: 'green' }),
    cmd('objectives', 'OBJ', CMD.DISPLAY_OBJECTIVES, { lamp: 'objectives', colour: 'green' }),
    cmd('autoEject', 'AEJ', CMD.TOGGLE_AUTOEJECT, { lamp: 'autoEject', colour: 'amber' }),
    cmd('eject', 'EJCT', CMD.EJECT, { guarded: true }),
    cmd('selfDestruct', 'SD', CMD.SELF_DESTRUCT, { guarded: true }),
    cmd('menu', 'MENU', CMD.MAIN_MENU),
  ],
  right: [
    { id: 'cycleWeapon', label: 'WPN', action: { channel: 'weapon_cycle' } },
    cmd('nextGroup', 'GRP', CMD.NEXT_WEAPON_GROUP),
    cmd('chain', 'CHN', CMD.TOGGLE_GROUP_FIRE, { lamp: 'chain', colour: 'amber' }),
    cmd('lastShot', 'LAST', CMD.TARGET_LAST_SHOT),
    cmd('group1', 'G1+', CMD.ADD_WEAPON_TO_GROUP_1),
    cmd('group2', 'G2+', CMD.ADD_WEAPON_TO_GROUP_2),
    cmd('group3', 'G3+', CMD.ADD_WEAPON_TO_GROUP_3),
    cmd('clearTarget', 'CLR', CMD.RESET_TARGETTING),
    cmd('centreTorso', 'CTR', CMD.RESET_INPUTS),
    cmd('feetToTorso', 'FEET', CMD.FEET_TO_TORSO),
    cmd('view', 'VIEW', CMD.COCKPIT_VIEW),
    cmd('nextObjective', 'OBJ>', CMD.NEXT_OBJECTIVE),
    cmd('orders', 'ORDR', CMD.USER_MENU),
    cmd('lance', 'ALL', CMD.ALL_PT_MENU),
    cmd('pause', 'PAUS', CMD.PAUSE_GAME),
  ],
} as const satisfies Record<string, readonly ControlDef[]>;
export type PanelName = keyof typeof PANELS;

/** Every control, by id. */
export const CONTROLS: ReadonlyMap<string, ControlDef> = new Map(Object.values(PANELS).flatMap((p) => p.map((d): [string, ControlDef] => [d.id, d])));
