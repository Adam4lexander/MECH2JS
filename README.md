# MechWarrior 2 - TypeScript port

A faithful port of MechWarrior 2 (1995, DOS) to TypeScript, three.js and
React, built from the decompilation in `../decompiled`. The data structures,
arithmetic and frame loop are the original's; the code is organised by
subject rather than by the address ranges the decompilation inherits.

**Nothing from the game is in this directory.** The port reads the game's
content from the install at runtime - `MW2.PRJ`, `MW2.EXE`, `MW2SHELL.EXE`,
`DATABASE.MW2`, `ARCHWO.MW2` / `ARCHJF.MW2`, `MW2.INI`, the `GIDDI\` input
drivers and the CD image (`*.CUE` / `*.BIN`) - and nothing else. The files the
two programs write (the pilot registry, `MW2PRM.CFG`, `MW2*.CFG`, the star
BWDs, the mech lab's `MEK\` variants, the controls files `INPUT.MAP`,
`GAMEKEY.MAP` and `giddi\*.cpc`) are the port's own: it seeds them itself on a
first run and keeps them in the browser (IndexedDB, `src/app/diskStore.ts`).
The dev server refuses to serve the install's copies.

## Running

```sh
npm install
npm run fetch-soundfont   # optional: a local copy of the General MIDI SoundFont (see below)
npm run dev               # http://localhost:5173 - serves the install from MW2_ROOT (default ..)
npm test                  # unit + golden tests (golden needs the install and ../decompiled)
npm run gen               # regenerate struct schemas and PORTING.md after the decompilation changes
npm run typecheck
```

Copy `.env.example` to `.env` to point `MW2_ROOT` / `MW2_DECOMPILED` elsewhere.

The game CD's image (e.g. `MECH2_16B.BIN` / `.CUE`) belongs in the install
directory beside `MW2.PRJ`. It is the CD drive: the intro and in-screen
movies, the launch pictures, the training instructor's voice (`KEATING\`) and
the CD music tracks all come from it. Without it there is no CD drive.

The front end's music is XMIDI played through a General MIDI SoundFont
(GeneralUser GS, free to redistribute; `tools/fetch-soundfont.ts`), which is
not game data and not kept in git. `npm run fetch-soundfont` puts a pinned,
checksummed copy in `public/soundfont/`; without it the synth fetches the same
file from jsDelivr, and offline the music is silent.

## The game

`http://localhost:5173` runs the game as MECH2.EXE does: the intro, then the
front end (MW2SHELL.EXE, ported under `src/shell/`) - register a pilot, the
Clan hall, training, the Trials, briefings, the mech lab, star configuration,
COMBAT VARIABLES and COCKPIT CONTROLS, debriefings and the career - handing
each launch to the combat sim (MW2.EXE) and back (`src/app/mech2Loop.ts`).
Your pilots, 'Mechs and settings persist across reloads.

## The developer route (`?dev`)

`http://localhost:5173/?dev` opens the mission picker and the editor instead.
The missions are sorted by which of the shell's hand-off files (loose BWDs)
each includes; the port builds them in the shell's own layout:

- **Ready** (20) - the mission sets the player's 'Mech itself (training, the
  Trials of Position): it just launches.
- **Choose pilot and 'Mech** (24) - the mission takes the player's star
  (`USERSTAR.BWD`). You name the pilot and pick a 'Mech - every 'Mech the
  shipped missions field - and up to four starmates. The last setup is
  remembered.
- **Opponents** (15) - these also take opponent stars (`EN01STAR`..
  `EN05STAR`, and for ten of them `INSTMAP1`), written by the shell's own
  code from the mission's briefing.

**NetMech…** in the picker starts a network game: MW2.EXE's own netplay
(`src/sim/net`) over a WebRTC data channel between two browser tabs, joined
by copying an offer and an answer between them (no server).

## Modes

- **Play** - a mission starts in Play. main's frame loop runs with the
  182 Hz timer fed from real time, at the toolbar's loop rate: 20 passes a
  second by default (15, 20, 30 or one per display frame). The original ran
  as fast as its PC allowed, about 15-25 a second, and several of its
  movement terms act once per pass - the velocity snap that holds a slow
  start to the axes, the jump-fuel refill, the push-back off walls, the
  keyboard's ramps - so at 60 passes a second the mech moves differently. The view is the
  game's own camera (`camera_update`), with its cockpit and HUD; nothing in
  it is the editor's (no picking, no gizmo). The keyboard and mouse go to the game through its own
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
  `w` enhanced vision, Alt+P or Pause to pause. The game's own menus: Esc the
  main menu (it pauses the game - Abort Mission, Device Calibration with the
  monitor brightness, Audio Ctrl, Combat Variables, Flee to DOS), `u` the
  systems status toggles, `b` / Ctrl+F1..F3 the lance's command computer;
  digits pick an item, Esc backs out. Click the view to give the game
  the mouse (MOUSE.DLL: it steers the torso like a centring joystick); while
  it has the mouse, the browser takes Esc to release it.
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
  mission ends after 20; MW2.EXE's results (mw2msn.cfg, MW2CAR.CFG) go to
  the port's own disk, and on this route the debriefing shows that record.
  The objects mission scripts animate - spinning, blinking,
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
  The rule toggles the original reads from mw2dif.cfg are the port's own
  file, which the front end's COMBAT VARIABLES screen writes; a first run
  starts it at the shell's defaults (`DEFAULT_RULES`,
  src/sim/mech/simOptions.ts). With heat tracking off the player's mech
  never heats, as in the original.
- **Edit** - no frame runs and time stands still; the editor shows the scene
  hierarchy, the game's tables, an inspector over every struct field with its
  offset and C type, the asset browser and the console. The viewport's
  Scene / Game buttons pick the camera: Scene is the editor's free camera
  (its own place, kept across Play), Game the paused game's own view with its
  cockpit and HUD. Step runs one pass of the loop in the clock's own
  fixed-step mode (12 ticks).

Scene camera controls: right-drag to look, WASD/QE to fly, wheel for speed,
click to select a gamepiece (Alt+click selects the part hit), F to frame the
selection, and drag the gizmo to move it. Moving a gamepiece, or editing its
posX/posY/posZ/heading in the inspector, keeps its entity fields and scene
node in step, which the tick hooks do in play. Mech detail levels come from
the game's own `mech_lod_update`, evaluated from the editor camera.

## Layout

See `docs/porting-notes.md` for the layers, conventions and decisions, and
`PORTING.md` (generated) for which original functions are ported.
