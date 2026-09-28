/**
 * GAMEKEY.MAP, the keystroke -> command table MW2.EXE's input_load_gamekeys
 * reads (sim/controls/input.ts): the port's own copy, written onto the
 * disk on a first run in the file's text format. The bindings are the
 * install's GAMEKEY.MAP's, in its order (test/golden/shellControls.test.ts
 * checks both load to the same table); the layout - comments and
 * whitespace - is the port's.
 *
 * A line is '<COMMAND> <key>': the command by the name in MW2.EXE's
 * commandNames, the key a '+'-joined sum of the named keys (Esc, F1..F12,
 * CTRL, ALT, SHIFT, BSP, PAUSE ...) and single characters. The first
 * binding of a keystroke wins.
 *
 * @portOnly the port's own copy of a file the original ships
 */

/** [command, key] */
export type GamekeyBinding = readonly [string, string];

export interface GamekeySection {
  title: string;
  /** runs of bindings, written with a blank line between them */
  groups: readonly (readonly GamekeyBinding[])[];
}

export const GAMEKEY_SECTIONS: readonly GamekeySection[] = [
  {
    title: 'AI Commands',
    groups: [
      [
        ['MAIN_MENU', 'Esc'],
        ['USER_MENU', 'u'],
        ['ALL_PT_MENU', 'b'],
        ['ALL_PT_MENU', 'CTRL+F1'],
        ['PT_2_MENU', 'CTRL+F2'],
        ['PT_3_MENU', 'CTRL+F3'],
      ],
    ],
  },
  {
    title: 'F-Key Displays',
    groups: [
      [
        ['MFD_CYCLE', 'F1'],
        ['NEXT_RADAR_MODE', 'F2'],
        ['RADAR_MAP_TOGGLE', 'F3'],
        ['TOGGLE_TARGET_DISPLAY', 'F4'],
        ['TOGGLE_DAMAGE_DISPLAY', 'F5'],
        ['TOGGLE_HTAL', 'F6'],
        ['TOGGLE_REAR_VIEW', 'F7'],
        ['TOGGLE_DOWN_VIEW', 'F8'],
        ['TOGGLE_WEAPON_DISPLAY', 'F9'],
        ['ORDINANCE_VIEW', 'F10'],
        ['TOGGLE_HUD', 'F11'],
        ['DISPLAY_OBJECTIVES', 'F12'],
      ],
      [['COCKPIT_VIEW', 'c']],
      [['COCKPIT_RESET_ZOOM', 'CTRL+z']],
    ],
  },
  {
    title: 'Driving Your Mech',
    groups: [
      [
        ['RESET_INPUTS', '/'],
        ['FEET_TO_TORSO', 'm'],
      ],
      [
        ['THROTTLE_STOP', '1'],
        ['THROTTLE_2', '2'],
        ['THROTTLE_3', '3'],
        ['THROTTLE_4', '4'],
        ['THROTTLE_5', '5'],
        ['THROTTLE_6', '6'],
        ['THROTTLE_7', '7'],
        ['THROTTLE_8', '8'],
        ['THROTTLE_9', '9'],
        ['THROTTLE_FULL', '0'],
        ['REVERSE_DIRECTION', '`'],
        ['REVERSE_DIRECTION', 'BSP'],
      ],
    ],
  },
  {
    title: 'Targeting',
    groups: [
      [
        ['NEXT_TARGET', 't'],
        ['PREV_TARGET', 'r'],
        ['RESET_TARGETTING', 'CTRL+t'],
      ],
      [
        ['TARGET_NEAREST_ENEMY', 'e'],
        ['TARGET_FRIENDLY', 'f'],
        ['TARGET_AT_RETICLE', 'q'],
        ['INSPECT_TARGET', 'i'],
      ],
      [
        ['NEXT_NAVPOINT', 'n'],
        ['PREV_NAVPOINT', 'SHIFT+n'],
      ],
      [
        ['RADAR_ZOOM_IN', 'x'],
        ['RADAR_ZOOM_OUT', 'SHIFT+x'],
      ],
      [
        ['EJECT', 'CTRL+ALT+e'],
        ['TOGGLE_AUTOEJECT', 'CTRL+e'],
      ],
      [
        ['STARTUP_MECH', 'CTRL+s'],
        ['SHUTDOWN_MECH', 's'],
      ],
      [['OVERRIDE_SHUTDOWN', 'o']],
      [['TOGGLE_AUTOPILOT', 'a']],
      [['TOGGLE_MASC', 'v']],
      [
        ['INFRARED', 'l'],
        ['ENHANCED_VISION', 'w'],
      ],
      [['SELF_DESTRUCT', 'Ctrl+Alt+x']],
    ],
  },
  {
    title: 'Weapons',
    groups: [
      [
        ['ADD_WEAPON_TO_GROUP_1', 'SHIFT+1'],
        ['ADD_WEAPON_TO_GROUP_2', 'SHIFT+2'],
        ['ADD_WEAPON_TO_GROUP_3', 'SHIFT+3'],
      ],
      [['TOGGLE_GROUP_FIRE', '\\']],
      [
        ['NEXT_WEAPON_GROUP', "'"],
        ['FIRE_WEAPON_GROUP', ';'],
      ],
      [['JETTISON_AMMO', 'k']],
    ],
  },
  {
    title: 'Miscellaneous',
    groups: [
      [
        ['CRACK_MODE', 'CTRL+ALT+f'],
        ['DUMP_GIF', 'Ctrl+p'],
      ],
      [
        ['PAUSE_GAME', 'Alt+p'],
        ['PAUSE_GAME', 'PAUSE'],
      ],
      [['EXIT_SIM', 'Ctrl+Q']],
    ],
  },
];

/** Every binding, in file order. */
export function gamekeyBindings(sections: readonly GamekeySection[] = GAMEKEY_SECTIONS): GamekeyBinding[] {
  return sections.flatMap((s) => s.groups.flat());
}

/** The file's text: '#' comments, then per section a heading and its runs of '<COMMAND><spaces><key>' lines; CRLF line ends. */
export function gamekeyMapText(sections: readonly GamekeySection[] = GAMEKEY_SECTIONS): string {
  const lines = ['#***********************************************', '#*', '#*  MechWarrior II Keyboard Mapping File', '#*', '#***********************************************'];
  for (const s of sections) {
    lines.push('', `###### ${s.title} ######`);
    s.groups.forEach((g, i) => {
      if (i > 0) lines.push('');
      for (const [cmd, key] of g) lines.push(cmd.padEnd(32) + key);
    });
  }
  return lines.join('\r\n') + '\r\n';
}

/** The file's bytes. */
export function gamekeyMapBytes(sections: readonly GamekeySection[] = GAMEKEY_SECTIONS): Uint8Array {
  const t = gamekeyMapText(sections);
  return Uint8Array.from(t, (c) => c.charCodeAt(0) & 0xff);
}
