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

## Missions

The shell (MW2SHELL.EXE - career, trials, mech lab) is not ported. It hands the
game its players through loose BWD files; the port does not read those from the
install, and sorts the missions by which of them each includes:

- **Ready** (20) - the mission sets the player's 'Mech itself (training, the
  Trials of Position): it just launches.
- **Choose pilot and 'Mech** (24) - the mission takes the player's star
  (`USERSTAR.BWD`). You name the pilot and pick a 'Mech - every 'Mech the
  shipped missions field - and up to four starmates; the port builds the file
  in the shell's own layout. The last setup is remembered.
- **Needs opponents** (15) - these also take opponent stars (`EN01STAR`..
  `EN05STAR`, and for ten of them `INSTMAP1`) that only the shell's opponent
  setup writes; they are listed but not offered yet.

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
  The rule toggles the original reads from mw2dif.cfg (the shell's options
  screen writes it) are the port's own: splash damage, collision damage
  and heat tracking on, difficulty 1 (`DEFAULT_RULES`,
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

The viewport bar's **Faithful** / **Modern** buttons pick how the view is
drawn, and the choice is remembered. Faithful renders at 640x480, scaled up
with nearest filtering, at the original's draw and detail distances. Modern
renders at native resolution and draws further out, as a headset always
does (`src/render/viewSettings.ts`). The original's distances were tuned for
a small screen; at higher resolutions buildings and hills pop in plainly.
Two sliders beside Modern set how far, and are remembered:

- **view**: how far out things are drawn, as a multiple of the mission's far
  distance (3x by default). It scales the object cull's far sphere and the
  clipper's far limit, on a copy of the game's viewer that the renderer culls
  for. The game's own viewer, which the sim reads, keeps the mission's
  distance.
- **detail**: how far out every LOD step is pushed (3x by default,
  `lodDistanceScale`, `src/sim/camera/projection.ts`). That covers the
  meshes' detail steps and the mechs' detail levels.

## VR

With a WebXR headset the viewport bar shows **VR** (Play only): you sit in
the cockpit. Nothing of the game changes. The game's viewer poses a rig and
your head moves inside it (`src/render/xr/xrRig.ts`). At a fixed loop
rate the rig is drawn one loop pass behind, interpolated between passes, so
the cockpit doesn't judder at 20 Hz. At "display rate" every frame is a
pass, so the rig stands at the last one.

While you're in VR, the page's viewport shows a spectator camera, for
recording (`src/render/xr/spectator.ts`). The **page** menu by the VR
sliders picks it, and it is remembered:

- **eye**: the headset's left eye, cropped to the viewport's shape. It is
  copied from the headset's framebuffer, not drawn again, so it costs
  nothing, but every glance and shake of your head is in it.
- **smooth** (the default): your view from the cockpit, HUD and all. It
  turns after your head, eased over **ease** seconds (0.35 by default),
  with the head's roll left out, at its own **fov** (90 degrees across).
  It stands at your head every frame; only the turn is eased.
- **chase**: a camera 16 m behind and 4 m above you, looking over the mech
  the way its torso faces and swinging round after it. It shows the whole
  mech (the "whole mech" enhancement), without the cockpit or HUD. The
  renderer's cull and facing are the head's, so it syncs a second time
  from the chase camera, or it would miss most of the mech.

Each spectator frame is drawn a second time, on top of the headset's two
eyes, at the viewport's size (up to about 3 megapixels). **Fill** on the
viewport bar makes the view fill the browser window, without the bar or
text. Esc leaves it while the game is paused; while it plays, Esc is the
game's, so use the button in the top-right corner, which shows only while
the mouse is over it. To record, size the browser window, Fill, and
capture it in OBS, with desktop audio for the game's sound.

Three things are specific to stereo:

- **The cockpit shell** is modelled at the mech's own scale, 2.7 m to
  11.5 m from the eye. It is shrunk to 0.35x about the eye, which puts its
  nearest parts under a metre away. The flat picture is unchanged.
- **The HUD** is the game's own window on a plane 1.2 m ahead, 60% of the
  game's field of view wide, centred on the torso's aim.
- **The reticle and the target brackets** are not on that plane. The game's
  pixels for them are tagged as they are drawn (`HUD_LAYER`,
  `src/engine/vfx/vfx.ts`), and each is drawn on its own plane across the
  game's whole field of view, so they sit on what they mark. They are drawn
  after the world with no depth test, and the cockpit covers them.
  - The brackets stand at the target's range.
  - The reticle stands at the targeted mech's range while it is in view.
    Otherwise it takes the nearest of what the ray under it meets, out to
    300 m (`src/render/xr/aim.ts`): the drawn world, the terrain the mechs
    walk on, or the flat ground. Its depth eases between them.
- **Detail and view distance** are the Modern view's (see Modes): a headset
  always draws that far out, whichever of Faithful and Modern is chosen.
- **The sky and ground** are drawn on a sphere about the eye
  (`src/render/xr/xrSky.ts`). The cull runs from your head, so a turned head
  sees what is behind the game's viewer.

When a headset is present, sliders next to **VR** tune these sizes live:
cockpit size, HUD width, seat height and HUD distance. They are remembered.

Controllers (`src/app/xrInput.ts`) press the game's own keys:

| Control | Action |
|---|---|
| Left stick | throttle `=` / `-` and turn |
| Left stick click | reverse |
| Left trigger | cycle weapon |
| Left grip | throttle stop |
| X / Y | cockpit view / main menu |
| Right stick | the mouse, which steers the torso |
| Right stick click | feet to torso |
| Right trigger | fire |
| Right grip | fire the selected group |
| A / B | nearest enemy / next target |

The keyboard still works. Recentre with the headset's own recentre.

WebXR needs a secure origin:

- **PC VR** (Link, SteamVR): Chrome or Edge on `localhost` works as is.
  The browser can take a minute to grant the session while the VR runtime
  starts; keeping the runtime running beforehand makes it quick. Meanwhile
  the button reads **VR...**, a notice says so, and the mission is paused.
  It carries on once the headset is showing it. The console logs a
  `[vr] entered VR` line with the timings.
- **Standalone Quest:** run `adb reverse tcp:5173 tcp:5173` and open
  `localhost:5173` in the Quest browser.
- **Without a headset:** the Immersive Web Emulator extension works on
  `localhost`.

## Enhancements

The viewport bar's **Enhance** menu adds detail in the game's own terms: every
new pixel is a palette index chosen by colour ramp, shade step or the
checkerboard dither. So the day cycle, dusk, night and infrared recolour it
all. Each item switches off on its own, and the inset displays the game reads
back (target display, damage views, map) stay the original's.

- **Armour panels.** Mech faces are divided into plates about a metre across,
  a shade step apart, with seams two steps darker, all on the face's own ramp.
  Plates too small to see are left plain (the shader in
  `src/render/materials/indexedMaterial.ts`).
- **All near mechs at top detail.** `mech_lod_update` gives its top level to
  every mech in its nearest range, not only the nearest one. This is the
  port-only `lodAllNear` in `src/sim/camera/projection.ts`, marked as a
  divergence.
- **Ground detail.** The flat ground becomes a dithered surface of broad
  patches, 1.3 km across, fading back into the original fill from about
  200 m. Its five shades are the ground colour at 80, 90, 110 and 120 per
  cent brightness, each the nearest palette colour of the same hue, found
  anywhere in the palette for the palette on screen, so dawn, dusk, night
  and infrared get their own (`groundShades`,
  `src/render/enhance/paletteRuns.ts`). The ground's own palette row is no
  use for this. Every mission's ground is index 0xef, the last of its row,
  and in most palettes the row holds other hues or copies of the same
  colour. The game's scrounge patch (rocks and scrub) is repeated on the
  grid cells round its own (`src/render/enhance/groundField.ts`).
- **Sky gradient and stars.** Above the haze band the sky keeps dithering up
  its ramp towards the zenith. At night there are stars in the palette's
  brightest grey (`src/render/enhance/skyDetail.ts`).
- **Shadows.** A shadow map along the mission's own light covers 320 m round
  the eye (`src/render/enhance/shadows.ts`). A shadowed colour becomes the
  palette's nearest colour to it at about 55% brightness, built the way a
  LUMA table is, from the palette on screen. The game's own LUMA tables leave
  whole ramps unchanged, AMY_SCN1's ground among them. Edges are dithered.
- **Cockpits.** Every chassis gets a hand-built cockpit in MW2's own style:
  low-poly, flat-shaded, palette-coloured (`src/render/cockpit`).
  - **The glass.** Each cockpit is cut to its mech's canopy as the outside
    of the mech shows it: the glass polygons of its exterior model, placed
    around the pilot's eye (`glass.ts`, `canopy.ts`;
    `test/sim/cockpits.test.ts` measures them again from the game). The
    original's cockpit shells often disagree with their own exteriors, and
    are not used. The windows are wherever the eye sees that glass, and the
    frame follows its outline and the seams between its facets. So the
    Timber Wolf sits under a faceted bubble on its nose, the Gargoyle looks
    out through its face's eye slits, and the Marauder through a slit in
    its wedge head. The Hellbringer and the Warhammer get a windshield
    between the shoulders, the Warhawk a band under its brim.
  - **Seating.** The game's eye is only roughly placed against its exterior,
    so a few canopies are seated around it. Each fit is recorded with its
    reason in `glass.ts`.
    - Canopies the eye sits on or pokes out of are lifted or moved:
      Hellbringer, Mad Dog, Stormcrow, Warhammer, Kit Fox, Summoner,
      Tarantula.
    - The Marauder's slit is brought nearer, and the Elemental's visor
      enlarged.
    - The Gargoyle's eye slits are joined across the nose, where the
      reticle is.
  - **Size.** Each cabin is at least as big as its canopy: its walls stand
    just outside the glass, so the glass lies in them at its true distance.
    Before, they were a car-sized box 1.4-2 m across, and in half the chassis
    the glass reached well beyond it; in a headset the cockpit looked
    shrunken. The Timber Wolf's cabin now runs 2.25 m out to the tip of its
    nose, the Tarantula's is 3.6 m across. The consoles and screens stay at
    arm's reach; only the dash's top runs out to the front wall. The mechs
    themselves are 8-15 m tall (the game works in centimetres). A box can't
    follow a curved exterior, and the seated canopies above are moved from
    where the exterior has them, so a cabin's rim can show a little outside
    the hull. The editor's scene camera is the only place that sees it.
    `window.mw2.view.cockpit.xray = true` draws the cabin through the mech
    there, to compare the two.
  - **The Tarantula** wears the Kit Fox's cockpit shell in the original.
    Here it has its own cockpit, cut to its own exterior. Cockpits are
    filed under the exterior head (`TR1_HEAD`), not the shell.
  - **Layout.** Inside, a console runs across under the glass. Its centre
    face carries the target display and the radar, where the flat view
    keeps them whole. The left wing carries the heat and jump-jet gauges;
    the right wing carries the weapon list over the damage display and
    speed. Where the glass runs on down (the Battlemaster's dome, the
    Warhawk's band), the console splits into two pods and the floor stays
    open: target and radar on the left pod, weapons, speed, damage and
    gauges on the right.
  - **Screens.** The console carries six screens: radar, speed and
    throttle, heat and jump-jet status, target display, weapon list and
    damage display. Each shows the game's own pixels, and the HUD keeps only
    the compass, altitude, reticle, target box and messages. The original's
    widget panes overlap, so each screen shows only the pieces of panes
    its widgets draw in (`kit.ts` SCREENS). The target screen is the
    target display over its name-and-range readout. The status screen is
    the heat, heat-rate and jump-jet gauges stacked. The speed screen is
    the kph readout over the throttle bar. Screens are laid out on their
    faces with a margin, each sized to its content's shape. Lamps and
    switches keep to a strip along each face's foot and trim to its top
    edge, so nothing sits on a screen.
  - **Controls and details.** Armrests carry a throttle lever and a stick
    that follow the controls. Inner Sphere mechs get pipes and switch banks;
    Clan mechs get cleaner panels and lamp strips.
  - **Modes.** The satellite map (F3) takes over the whole view as in the
    original. The large radar (F2) draws across the glass. The missile
    camera (F10) leaves the cockpit.
  - **Headset.** The **seat** slider in VR raises or lowers the whole
    cockpit.
- **Your whole mech from the cockpit.** In the cockpit view the game builds
  the player's mech at its cockpit detail level: coarse legs and arms, and
  nothing for the hips, feet and guns. The original never showed them, but
  the shadows cast from what is built, so the player's shadow was a couple of
  blobs. A render-only copy of every part at full detail now rides the
  game's own part nodes, so it walks, twists and aims with the mech
  (`src/render/enhance/ownChassis.ts`). The legs and hips show, so in a
  headset you can look down at them. The torso and arms cast their shadow
  but aren't drawn, since the eye is inside them. The hand-built cockpit and
  the game's own arms stand in for them. The editor's scene camera sees the
  whole mech. The game's objects, lists and records are untouched
  (`test/sim/ownChassis.test.ts`).

## Layout

See `docs/porting-notes.md` for the layers, conventions and decisions, and
`PORTING.md` (generated) for which original functions are ported.
