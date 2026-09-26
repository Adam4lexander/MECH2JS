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

- **Play** - the game loop runs.
- **Edit** - the loop is paused (the original's own pause), and the editor
  shows the scene hierarchy, the game's tables, an inspector over every struct
  field with its offset and C type, a free camera, the asset browser and the
  console. Step advances one frame of the original loop. (Play and Step are
  disabled until Phase 2 ports the loop.)

Editor viewport controls: right-drag to look, WASD/QE to fly, wheel for speed,
click to select a gamepiece (Alt+click selects the part hit), F to frame the
selection, and drag the gizmo to move it. Moving a gamepiece, or editing its
posX/posY/posZ/heading in the inspector, keeps its entity fields and scene
node in step, which the tick hooks do in play. Mech detail levels come from
the game's own `mech_lod_update`, evaluated from the editor camera.

## Layout

See `docs/porting-notes.md` for the layers, conventions and decisions, and
`PORTING.md` (generated) for which original functions are ported.
