# MechWarrior 2 - TypeScript port

A faithful port of MechWarrior 2 (1995, DOS) to TypeScript, three.js and
React, built from the decompilation in `../decompiled`. The data structures,
arithmetic and frame loop are the original's; the code is organised by
subject rather than by the address ranges the decompilation inherits.

**Nothing from the game is in this directory.** The port reads the original
`MW2.PRJ`, `MW2.EXE` and loose files from the install at runtime.

## Running

```sh
npm install
npm run dev          # http://localhost:5173 - serves the install from MW2_ROOT (default ..)
npm test             # unit + golden tests (golden needs the install and ../decompiled)
npm run gen          # regenerate struct schemas and PORTING.md after the decompilation changes
npm run typecheck
```

Copy `.env.example` to `.env` to point `MW2_ROOT` / `MW2_DECOMPILED` elsewhere.

## Modes

- **Play** - main's frame loop runs, one pass per display frame, with the
  182 Hz timer fed from real time. The view is the game's own camera
  (`camera_update`). The keyboard and mouse go to the game through its own
  input layer: the browser's keys become PC scancodes for `GIDDI\KEYBOARD.DLL`,
  and INPUT.MAP / GAMEKEY.MAP bind them exactly as in the original - e.g. `=`
  / `-` throttle, `0`..`9` throttle presets, the arrow keys / keypad turn,
  `,` `.` twist the torso, `c` cockpit / external view, `m` feet to torso,
  `` ` `` reverse, Space fires the selected weapon, Enter cycles weapons,
  `\` toggles chain / group fire, `;` fires the selected group, Num Lock,
  keypad `/` and `*` fire groups 1-3, Shift+1..3 add the selected weapon to
  a group, `k` jettisons its ammo, `t` / `e` cycle targets / pick the
  nearest enemy, `x` / Shift+`x` zoom the radar, F1..F12 the cockpit displays
  (F2 radar mode, F3 map, F4 target display, F5 damage display, F11 HUD, F12
  objectives - the browser keeps some F-keys for itself), `l` infrared,
  `w` enhanced vision, Alt+P or Pause to pause. Click the view to give the game
  the mouse (MOUSE.DLL: it steers the torso like a centring joystick).
  The cockpit HUD is the game's own: its widgets, radar, tapes and reticle
  draw into the game's 640x480 indexed window, which is laid over the 3D view
  through the palette. The 3D views the game draws mid-frame - the target
  display (F4), the damage display's rear / down / missile views (F1 cycles),
  the overhead map (F3) - are rendered in palette indices and read back into
  that window when the game asks, so its 2D lands over them as it does in
  the original.
  The other gamepieces think for themselves: the AIT rule tables, the state
  machine and behaviours, group orders and the per-frame objective
  evaluation are the game's own (src/sim/ai, src/sim/groups/orders.ts,
  src/mission/results.ts). Enemy stars start shut down on their start
  objective and wake as the mission's objectives open - in AMY_SCN1 the
  first star powers up and comes for the player straight away. When the
  mission is decided, 'Press any key to exit...' follows after 3 s and the
  mission ends after 20; the debriefing shows the result record MW2.EXE
  would have left in mw2msn.cfg (the port never writes the game's cfg
  files). The objects mission scripts animate - spinning, blinking,
  driving and path-following - run their scheduled tasks.
  Sound is the game's own sound code (src/sim/sound): the eight streaming
  SFLX channels with their priorities and stealing, positional one-shots
  delayed at the speed of sound, the voice queue (cockpit cues, lancemate
  radio, damage callouts, the result announcements), the looping ambient
  emitters, and the mission's CD music track, which plays from the install's
  CD image (MECH2_16B.BIN/.CUE) when it is there. The Miles library under it
  is the port's own (src/engine/miles), following the semantics read from
  Miles' code in MW2.EXE; the browser plays its 11025 Hz mix. Sound comes on
  with the first Play; the toolbar's Sound button toggles it. The engine hum
  is a MIDI note on the player's sound card in the original - its pitch and
  level follow the game here, its timbre is a stand-in.
- **Edit** - no frame runs and time stands still; the editor shows the scene
  hierarchy, the game's tables, an inspector over every struct field with its
  offset and C type, a free camera, the asset browser and the console. Step
  runs one pass of the loop in the clock's own fixed-step mode (12 ticks).

Editor viewport controls: right-drag to look, WASD/QE to fly, wheel for speed,
click to select a gamepiece (Alt+click selects the part hit), F to frame the
selection, and drag the gizmo to move it. Moving a gamepiece, or editing its
posX/posY/posZ/heading in the inspector, keeps its entity fields and scene
node in step, which the tick hooks do in play. Mech detail levels come from
the game's own `mech_lod_update`, evaluated from the editor camera.

## Layout

See `docs/porting-notes.md` for the layers, conventions and decisions, and
`PORTING.md` (generated) for which original functions are ported.
