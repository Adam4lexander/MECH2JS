/**
 * MW2SHELL.EXE's main (decompiled/mw2shell/src/boot/shell_main.c): the
 * start-up, then the screen state machine - each screen returns the next
 * state; -2 goes back, -3 quits (exit 0xff, which ends MECH2's loop), and
 * state 10 parks the shell's state in mw2prm.cfg and exits with 3 so MECH2
 * runs the mission.
 */
import { SHELL_LABEL } from '../generated/shell/labels.gen.ts';
import { mpackDbGetItem, mpackDbGetItemUnpacked, mpackDbOpen } from '../data/formats/mpack.ts';
import { cdDriveLetter, dosFileLoad } from '../engine/dosFiles.ts';
import { unestablished } from '../core/provenance.ts';
import { mem } from './memory.ts';
import { shell } from './state.ts';
import { hardware } from './host/hardware.ts';
import { ShellExit, type Blocking } from './host/blocking.ts';
import { timerStart } from './host/timer.ts';
import { VideoDriver, videoDriverInit } from './video/driver.ts';
import { FontHolder, fontHolderInit, textRemapInit } from './ui/labels.ts';
import { Mouse, mouseInit } from './ui/mouse.ts';
import { KeyInput, inputInit } from './ui/keys.ts';
import { messageBox } from './ui/messageBox.ts';
import { moviePlay } from './anim/movies.ts';
import { SMACK_TRACKS } from './video/smack.ts';
import { Sample, soundSampleCreate, soundSampleSetLooping, soundSampleSetVolume } from './sound/samples.ts';
import { Song, musicCreate, musicDestroy, musicIsPlaying, musicStart, soundSystemInit } from './sound/music.ts';
import { careerRegistryLoad } from './career/registry.ts';
import { simOptionsRead } from './options/simOptions.ts';
import { prmLoad, prmSave } from './handoff/prm.ts';
import { starConfigure, starSetMember } from './handoff/stars.ts';
import { missionBrf2Load } from './career/brf2.ts';
import { projectClose, projectOpen } from './career/orders.ts';
import { screenTitle } from './screens/title.ts';
import { shellScreens, type MainLocals } from './screens/registry.ts';
import './screens/index.ts';
import { screenLoadBackground } from './video/background.ts';
import { fieldOffset } from './memory.ts';

/** A font holder over a raw DATABASE.MW2 font item. */
function fontFromItem(item: number, d: VideoDriver): FontHolder {
  return fontHolderInit(new FontHolder(), mpackDbGetItem(shell.database!, item) ?? new Uint8Array(12), d);
}

/** A DATABASE.MW2 sample. */
function sampleFromItem(item: number): Sample {
  const wav = mpackDbGetItem(shell.database!, item);
  return soundSampleCreate(new Sample(), shell.soundSystem!, wav, wav?.length ?? 0);
}

/** The state's song: musicByState{Wolf,JadeFalcon,Grievance}[state] (0 leave it, 0x20000000 stop, 0x10000000 stop first, low 24 bits the base item). */
function stateMusic(state: number, career: number): void {
  const m = mem();
  if (m.i32(SHELL_LABEL.midiEnabled) === 0) return;
  const table = career === 0 ? SHELL_LABEL.musicByStateWolf : career === 1 ? SHELL_LABEL.musicByStateJadeFalcon : SHELL_LABEL.musicByStateGrievance;
  const entry = m.i32(table + state * 4);
  if (entry === 0) return;
  const stop = () => {
    if (shell.currentMusic) musicDestroy(shell.currentMusic);
    shell.currentMusic = null;
  };
  if ((entry & 0x20000000) !== 0) {
    stop();
    m.setI32(SHELL_LABEL.currentMusicItem, 0);
    return;
  }
  if ((entry & 0x10000000) !== 0) {
    stop();
    m.setI32(SHELL_LABEL.currentMusicItem, 0);
  }
  if (m.u8(SHELL_LABEL.musicSetChosen) === 0) {
    m.setI32(SHELL_LABEL.musicSetOffset, 8);
    m.setU8(SHELL_LABEL.musicSetChosen, 1);
    // sound_mdi_ini_read: MDI.INI's driver file name, looked up in midiDriverSets
    for (let i = 0; i < 14; i++) {
      const name = m.ptrStr(SHELL_LABEL.midiDriverSets + i * 8);
      if (name !== null && name === hardware.midiDriverName) {
        m.setI32(SHELL_LABEL.musicSetOffset, m.i32(SHELL_LABEL.midiDriverSets + i * 8 + 4));
        break;
      }
    }
  }
  const item = (entry & 0xffffff) + m.i32(SHELL_LABEL.musicSetOffset);
  const song = shell.currentMusic;
  if (song === null || !musicIsPlaying(song) || item !== m.i32(SHELL_LABEL.currentMusicItem)) {
    if (song) musicDestroy(song);
    m.setI32(SHELL_LABEL.currentMusicItem, item);
    const xmidi = mpackDbGetItemUnpacked(shell.database!, item);
    shell.currentMusic = musicCreate(new Song(), shell.soundSystem!, xmidi, xmidi?.length ?? 0);
    musicStart(shell.currentMusic);
  }
}

/** A state whose screen is not ported yet. */
function* placeholder(l: MainLocals, state: number): Blocking<number> {
  const d = shell.videoDriver!;
  screenLoadBackground(d, l.db, 1);
  yield* messageBox(`State ${state} is not in the port yet.#Ok`, 0);
  return 8;
}

/**
 * main(argc, argv): argv[1] 'sim' is MECH2's relaunch after a mission
 * (resume the saved state, skip the intro); any argument count but 2 turns
 * off MIDI, digital and movie sound and the sim launch. Returns the exit
 * status (3: run the mission; 0xff: quit).
 *
 * @mw2shell main 0x00036700
 * @fidelity partial
 * @divergence the mouse, CD (MSCDEX), interrupt hooks and Miles are the port's host; unported screens show a placeholder
 */
export function* shellMain(argv: readonly string[]): Blocking<number> {
  const m = mem();
  const argc = argv.length;
  const sim = argc === 2 && argv[1] === 'sim';
  if (argc !== 2) {
    m.setI32(SHELL_LABEL.digitalSoundEnabled, 0);
    m.setI32(SHELL_LABEL.midiEnabled, 0);
    m.setI32(SHELL_LABEL.movieSoundEnabled, 0);
    m.setI32(SHELL_LABEL.simLaunchEnabled, 0);
  }
  // MSCDEX: the CD drive's letter becomes cdPath 'X:\'
  const letter = cdDriveLetter();
  m.strcpy(SHELL_LABEL.cdPath, letter ? `${letter}:\\` : '');
  if (argc !== 2) m.setU8(SHELL_LABEL.cdPath, 0);
  // the critical-error and keyboard handlers are the host's (keyboard_isr's filter is in its key mapping)
  textRemapInit();
  const dbBytes = dosFileLoad('DATABASE.MW2');
  if (!dbBytes) throw new ShellExit(1);
  shell.database = mpackDbOpen('DATABASE.MW2', dbBytes);
  shell.soundSystem = soundSystemInit();
  // every movie and animation is opened with these: all seven sound tracks when movie sound is on
  m.setI32(SHELL_LABEL.smackerOpenFlags, m.i32(SHELL_LABEL.movieSoundEnabled) === 0 ? 0 : SMACK_TRACKS);
  timerStart();
  if (!sim) yield* moviePlay('mintro');
  const d = videoDriverInit(new VideoDriver());
  shell.videoDriver = d;
  shell.font32 = fontFromItem(0x1a, d);
  shell.font27 = fontFromItem(0x1b, d);
  shell.font28 = fontFromItem(0x1c, d);
  shell.font30 = fontFromItem(0x1e, d);
  shell.uiFont = shell.font32;
  shell.font31 = fontFromItem(0x1f, d);
  const f = fontFromItem(0x20, d);
  shell.uiFont = f;
  shell.font32 = f;
  shell.archiveFont = f;
  shell.pageFont = f;
  shell.sound77 = sampleFromItem(0x4d);
  soundSampleSetLooping(shell.sound77);
  shell.sound101 = sampleFromItem(0x65);
  soundSampleSetVolume(shell.sound101, 0x32);
  shell.sound102 = sampleFromItem(0x66);
  soundSampleSetVolume(shell.sound102, 0x32);
  shell.sound103 = sampleFromItem(0x67);
  soundSampleSetVolume(shell.sound103, 0x32);
  shell.cursorShapes = mpackDbGetItem(shell.database, 0x19);
  shell.shellMouse = mouseInit(new Mouse(), d, shell.uiFont, shell.cursorShapes);
  shell.keyInput = inputInit(new KeyInput());
  // 0x77b60 'MW2.PRJ'
  projectOpen('MW2.PRJ');
  careerRegistryLoad();
  simOptionsRead();
  const saved = prmLoad();
  const locals: MainLocals = {
    db: shell.database,
    career: { value: 2 },
    accepted: { value: 0 },
    commandLine: { value: '' },
    previous: 8,
  };
  let state: number;
  if (sim) {
    locals.previous = 10;
    state = saved?.state ?? 8;
    locals.career.value = saved?.career ?? 2;
    locals.accepted.value = saved?.pilotAccepted ?? 0;
    locals.commandLine.value = saved?.commandLine ?? '';
  } else {
    state = 8;
    locals.previous = 8;
    locals.career.value = 2;
    locals.commandLine.value = '';
    locals.accepted.value = 0;
  }
  // uVar13: where -2 goes back to - the state before the current one
  let back = sim ? 10 : 8;
  for (;;) {
    const previous = locals.previous;
    if (state === 0xb && locals.career.value === 2) state = 7;
    if (state === -2) state = back;
    locals.previous = state;
    stateMusic(state, locals.career.value);
    const current = state;
    back = previous;
    switch (current) {
      case 8:
        starConfigure(1, 0, 0, 0, 100);
        locals.accepted.value = 0;
        state = yield* screenTitle(locals.db, locals.career);
        break;
      case 1:
        if (previous === 0xc) {
          starConfigure(0, 0, 3, 1, 100);
          const pilot = m.u32(SHELL_LABEL.currentPilot);
          starSetMember(0, null, pilot === 0 ? '' : m.cstr(pilot + fieldOffset('PilotRecord', 'pilotName')));
        }
        state = yield* runScreen(current, { ...locals, previous });
        break;
      case 7:
        locals.career.value = 2;
        state = yield* runScreen(current, { ...locals, previous });
        break;
      case 10:
        state = previous === 0 ? 3 : previous;
        if (m.i32(SHELL_LABEL.simLaunchEnabled) !== 0) {
          prmSave(state, locals.career.value, locals.accepted.value, locals.commandLine.value);
          projectClose();
          return 3;
        }
        break;
      case 0xb:
        if (previous === 1 || previous === 3) {
          starConfigure(0, 0, 3, 1, 100);
          const pilot = m.u32(SHELL_LABEL.currentPilot);
          const mission = pilot === 0 ? 0 : m.i32(pilot + fieldOffset('PilotRecord', 'missionIndex'));
          const table = m.u32(SHELL_LABEL.careerMissionTables + locals.career.value * 4);
          locals.commandLine.value = m.ptrStr(table + mission * 9) ?? '';
          missionBrf2Load(locals.commandLine.value, true, false);
        }
        starConfigure(1, 0, 0, 0, 100);
        starConfigure(0, -1, -1, -1, -1);
        starSetMember(0, null, null);
        state = yield* runScreen(current, { ...locals, previous });
        break;
      case 0xf:
        if (locals.career.value === 0) {
          if ((yield* moviePlay('mwoland')) === 0) yield* moviePlay('mjfland');
        } else if (locals.career.value === 1 && (yield* moviePlay('mjfland')) === 0) yield* moviePlay('mwoland');
        state = 1;
        break;
      case 0x10:
        if (locals.career.value === 0) {
          if ((yield* moviePlay('mend')) === 0) yield* moviePlay('mend2');
        } else if (locals.career.value === 1 && (yield* moviePlay('mend2')) === 0) yield* moviePlay('mend');
        state = 1;
        break;
      case 0:
      case 3:
      case 5:
      case 9:
      case 0xc:
      case 0xd:
      case 0xe:
        state = yield* runScreen(current, { ...locals, previous });
        break;
      default:
        // fatal: the message at 0x86158 and exit(1)
        unestablished(`main: state ${current} has no screen`, 'main');
        throw new ShellExit(1);
    }
    if (state === -3) {
      prmSave(-3, locals.career.value, locals.accepted.value, 'exittos');
      projectClose();
      return 0xff;
    }
  }
}

/** A registered screen, or the placeholder. The locals it writes go back to main's. */
function* runScreen(state: number, l: MainLocals): Blocking<number> {
  const screen = shellScreens.get(state);
  return screen ? yield* screen(l) : yield* placeholder(l, state);
}
