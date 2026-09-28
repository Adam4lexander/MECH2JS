# Porting notes

Conventions for the TypeScript port and the decisions behind them. Read this
before adding code. `decompiled/CLAUDE.md` and `decompiled/README.md` explain
the decompilation this is ported from; the method rules there apply here too.

## Where things go

| layer | holds | may import |
|---|---|---|
| `src/core` | C integer semantics, fixed-point math, trig, matrices, RNG, ramps, provenance, system_error hook | nothing |
| `src/data` | parsers for MW2.EXE, MW2.PRJ and the loose files; no engine state | core |
| `src/generated` | output of `npm run gen` (struct schemas, live classes) - never edit | core, engine/schema |
| `src/engine` | game state, resource cache, scene graph, world objects, the frame loop | core, data, generated |
| `src/sim`, `src/ai`, `src/mission` | the game proper, organised by subject | the above and each other |
| `src/render`, `src/audio`, `src/input`, `src/hud` | presentation (three.js, WebAudio, DOM input) | everything above |
| `src/editor`, `src/app` | React | everything |

The simulation layers compile without the DOM lib (`tsconfig.engine.json`).

**Subject, not position.** The decompilation's module names are address
ranges (`damage` holds AI code, `terrain` holds the scene graph). A ported
function goes where its *subject* belongs; its `@mw2` tag records where it came
from.

## Provenance - every ported function

```ts
/**
 * One line on what it does, in the port's own words.
 *
 * @mw2 world_record_define 0x00035e40
 * @fidelity exact            // exact | partial | stub
 * @divergence why, if the port differs on purpose
 */
export function worldRecordDefine(...) { ... }
```

- `@mw2 <name> <address>` must match `decompiled/mw2/listing/functions.csv`.
  **Look the address up; never type it from memory** (`grep ",name," decompiled/mw2/build/names.csv`).
  `npm run gen` (tools/porting-map.ts) fails on any mismatch.
- Static tables read from MW2.EXE use `@mw2data <name> <address>`.
- Helpers with no original use `@portOnly <reason>` instead.
- TS names are the original names in camelCase. A positional name
  (`render_asm_sub_03d380`) stays positional (`renderAsmSub03d380`) - do not
  invent meaning for it.
- In bodies: `unestablished('...')` for behaviour the decompilation has not
  established (return the most neutral value, never a guess), `quirk('...')`
  for an original oddity reproduced on purpose, `divergence('...')` for a
  runtime difference. All three appear in PORTING.md.

## Two executables: MW2.EXE and MW2SHELL.EXE

The port reproduces the sim (MW2.EXE) and the front end (MW2SHELL.EXE,
`decompiled/mw2shell/`). In the original they are separate processes that
MECH2.EXE runs in turn, so they are separate address spaces. Everything keyed
by an address or reset at start-up is therefore keyed by executable
(`engine/exeTarget.ts`, `'mw2' | 'mw2shell'`, MW2 by default):

| | MW2.EXE | MW2SHELL.EXE |
|---|---|---|
| function tag | `@mw2 <name> <addr>` | `@mw2shell <name> <addr>` |
| static data tag | `@mw2data` | `@mw2shelldata` |
| checked against | `decompiled/mw2/listing/functions.csv` | `decompiled/mw2shell/listing/functions.csv` |
| structs | `src/generated/classes.gen.ts` | `src/generated/shell/classes.gen.ts` |
| labels | `LABEL` (`generated/labels.gen.ts`) | `SHELL_LABEL` (`generated/shell/labels.gen.ts`) |
| boot image | `imageI32`, ... | `imageReader('mw2shell')` |
| globals | `registerGlobals(name, state, reset)` | `registerGlobals(name, state, reset, 'mw2shell')` |
| code pointers | `registerCode(name, addr, fn)` | `registerCode(name, addr, fn, 'mw2shell')` |

- Look shell addresses up in the shell's `functions.csv`; the two images
  overlap, so an MW2 address means nothing in the shell and the reverse.
- A shell struct with MW2's name *and* layout (SimOptions, the Project* file
  structs) is MW2's class, re-exported from the shell module, so one value
  passes between them. The shell's `MenuItem`, `MechSection` and
  `MissionObjectiveRecord` share only a name and are their own classes.
- Code the two share byte for byte (the VFX drawing and runtime routines,
  `decompiled/mw2shell/build/matched.csv`) is ported once and carries a tag
  for each executable.
- `resetAllGlobals(target)` resets one executable's globals, as starting that
  process would. Library groups (clib, Miles, Smacker) and the shell's dead
  WASM compiler are left out of PORTING.md's totals.

### The disk: what the two programs share

In the original the shell and the sim are separate processes and the files
are the whole contract between them (decompiled/mech2/README.md). The port
keeps that contract: `engine/dosFiles.ts` is a virtual DOS disk both read
and write through the ported fopen/fread/fwrite sites, in three layers -
read-only content from the install (the GIDDI drivers), the
port's own files (everything a program writes: MW2REG.CFG, mw2prm.cfg,
MW2DIF/MW2SND/MW2CAR/mw2msn.cfg, the star BWDs, user MEKs, INPUT.MAP and
giddi\config00.cpc; persisted in IndexedDB by `app/diskStore.ts`), and a
scratch overlay (the dev mission picker's launches, never persisted).
**The port never reads the install's config or player files at run
time**; tests read them as the expected output of the ported writers
(`installShellFixtures`). Files the original ships and a program only
reads - GAMEKEY.MAP, the per-device giddi\<device>.cpc profiles - are the
port's own data, written onto the disk on a first run together with the
controls screen's INPUT.MAP (`shell/controls/seed.ts`).

`src/launcher/mech2.ts` is MECH2.EXE's loop (shell intro -> mw2prm.cfg ->
mw2.exe -> shell sim, until an exit status of 0xff); MW2.EXE takes its argv
through `check_launched_by_shell` (`mission/commandLine.ts`).

### The shell's memory

MW2SHELL.EXE is mostly a file editor, and writes its globals to disk with a
single fwrite of the struct, residue bytes and all. So its static data is a
byte-for-byte copy of its image (`shell/memory.ts`, reset on each start):
`prmBlock`, `playerStar`, `pilotRegistry`, `bwdBuffer` live at their own
addresses, pointers into the image are followed where they point, and field
offsets come from the generated schemas (`fieldOffset`). Heap objects stay
JS objects. String constants the code copies get a label in
Mw2shellTypes.java like any other global - never a literal typed in.

### The shell's blocking loops

Every screen and modal helper of MW2SHELL.EXE is a loop that owns the
machine until it returns. The port writes each as a generator with the
original's control flow (`shell/host/blocking.ts`) and composes them with
`yield*`; a function that can block - anything that reaches
`mouse_update`, a Smacker wait, or a file read off the CD - is
`function*` and returns `Blocking<T>`. `mouse_update` yields between its
present and its read of the mouse, which is the shell's frame boundary.
`shell/host/pump.ts` resumes the generator from the host's frames at a
fixed number of passes a second (a `@divergence`: the original ran as fast
as the PC could, and some timings count passes). The hardware the shell's
drivers talk to - the screen and DAC, int 33h, the BIOS keyboard buffer, the
250 Hz timer, the sound card - is `shell/host/hardware.ts`; the browser
side (`app/shell/`) feeds it input and presents it. `?dev` in the address
opens the mission picker and editor instead of the game.

## Numbers

- The sim is exact fixed-point. Positions are cm, angles 16.16 degrees
  (0x1680000 = full turn), matrices 2.29 (0x20000000 = 1.0), velocities 16.16.
- Every value stored in a C-typed field goes through its width: `| 0` for int,
  `>>> 0` for uint, `i16()`, `u8()` etc. from `core/int/cint.ts`.
- Multiply with `Math.imul` when the C multiplies two ints into an int. When
  the C widens to 64 bits (`longlong`), use `core/int/i64.ts` - a double loses
  the low bits exactly where the rounding looks.
- Divide with `cdiv` (truncating, faults on zero); `%` on ints already matches C.
- x87 code (`clib_fp_trunc`, `ROUND`) is ported with doubles and `Math.trunc`;
  say so with `@divergence` if the precision could matter.

## Structs

`npm run gen` turns `mw2_types.h` into `src/generated/structs.gen.ts`
(schemas + `Raw*` interfaces for reading bytes) and
`src/generated/classes.gen.ts` (live classes with the C field names, in C
order, with zeroed defaults). Engine code uses the live classes. Pointers are
object references; a `void *` whose target is established is typed through
`tools/struct-overrides.ts`; code pointers are `CodePtr` (an original address,
resolved through `engine/codeRegistry.ts`).

## Globals

A C global lives as a field of a state object exported by the module of its
subject (e.g. `engine/scene/sceneGlobals.ts`), named exactly as in the
decompilation. Each state object registers itself with
`engine/globals.ts` so the editor can show it and a mission load can reset it.

## Tests

- `test/unit` - no game data needed.
- `test/golden` - checks against the real MW2.PRJ / MW2.EXE and against the
  decompilation's listings. **Correspondence, not counts**: print the port's
  reading in the listing's exact format and compare line by line with
  `expectSameLines` (test/support/listing.ts). A test that only compares
  totals would pass a parser that shuffled records.
- Suites that need data use `describe.runIf(hasGameData && hasDecompiled)`.

## Decisions log

- **Random seed.** random_tables_init seeds the Miles LCG with EAX, which main
  loads from its argv parameter - the original's seed is the address of the argv
  array under DOS/4GW. The port takes a seed parameter (core/random.ts).
- **Mesh storage.** MeshBlock's trailing vertex and polygon arrays and
  MeshPolygon's index bytes (reached through byte offsets in C) are JS arrays
  (tools/struct-overrides.ts). Indices are still truncated to a byte on load,
  as poly_add_index does.
- **Resource cache.** MW2.PRJ is held in memory; cache_lock / unlock / release
  have no memory to manage. They are ported as no-ops where they are called.
- **FetchSource** lives in `src/app` because `fetch` is a DOM API.
- **NetMech.** The INT 0x65 driver is a `NetTransport` the host installs
  (`sim/net/transport.ts`; `QueueTransport`/`MemoryNetHub` in memory,
  `app/net/webrtcLink.ts` over a WebRTC data channel signalled by pasted
  offer/answer text). The join blocks on the other stations, so
  netplay_start/netplay_join are generators and main's start-up is
  `bootMissionStartSteps` (the sync `bootMission` throws if the join would
  wait). Loops the original spun in real time on a silent driver (a failed
  send, the sign-off's second) spend timer ticks through `setNetSpin`
  (default: one `timerInterrupt`). Two stations cannot share one process's
  globals: `test/sim/netplay.test.ts` runs each in a child process.
