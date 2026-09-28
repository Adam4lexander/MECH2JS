# MechWarrior 2 - TypeScript port

A faithful port of MechWarrior 2 (MW2.EXE, the sim; MW2SHELL.EXE, the front
end; MECH2.EXE's loop between them) to the browser. `README.md` says how to
run it; `docs/porting-notes.md` holds the conventions - **read it before
adding code**. `PORTING.md` (generated) says what is ported.

## Setup

`.env.local` (copied from `.env.example`, git-ignored) sets `MW2_ROOT` (the
game install) and `MW2_DECOMPILED` (the decompilation). `.env.example` has
only `MW2_ROOT`: the decompilation is not public, so `MW2_DECOMPILED` is the
maintainer's, added to `.env.local` by hand. `tools/paths.ts`
loads it for the dev server, the tests and `npm run gen` alike. With it
unset the golden tests *skip* rather than fail - a test run showing skips
means the setup is missing, not that the port is fine.

## The decompilation is a separate repo

The port is ported from `mw2-decompiled` (locally `MW2_DECOMPILED`; its
`CLAUDE.md` has the method rules, which apply here too). Porting keeps
finding things it got wrong or left unnamed:

- Fix them **there**, through its pipeline inputs, and run its `deepen.ps1`
  (it must print `verify_export: OK`). Never edit its generated `src/`,
  `include/` or `listing/`, and never work around a decompilation error in
  the port instead.
- Commit there first; then `npm run gen` here and commit the port's side.
  `PORTING.md` records the decompilation commit it was checked against.

## Rules

- Every ported function carries `@mw2 <name> <address>` or
  `@mw2shell <name> <address>`. **Look the address up** in the
  decompilation's `listing/functions.csv`; never type it from memory.
  `npm run gen` fails on a mismatch.
- Behaviour the decompilation has not established is `unestablished(...)`,
  never a guess. Positional names (`*_sub_<address>`) stay positional.
- The port is self-contained: it reads the original files only as content
  (MW2.PRJ, the EXEs, the .MW2 archives, MW2.INI, GIDDI drivers, the CD
  image). Everything the programs write - cfgs, controls files, star BWDs,
  MEKs, the pilot registry - is the port's own, kept in the browser. Tests
  may read the install's copies as expected output; the app never does.
- The user usually has the dev server open (http://localhost:5173) while
  work happens. Editing `src/` hot-reloads into their running game and can
  leave it in a state no real run produces. Instrument in a scratch test
  instead, and tell the user to reload after `src/` edits.

## Checks

```sh
npm run gen && npm run typecheck && npm run lint && npm test
```

`npm run gen` must leave the tree clean, and `npm test` should show no skipped
suites on a machine with `.env.local` set.
