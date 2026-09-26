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
