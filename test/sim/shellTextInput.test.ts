// text_input, the shell's line editor, driven from the BIOS keyboard buffer
// the way the register and star select use it.
import { beforeAll, describe, expect, it } from 'vitest';
import { ExeImage } from '../../src/data/exe/ExeImage.ts';
import { ProjectFile } from '../../src/data/prj/ProjectFile.ts';
import { mpackDbGetItem, mpackDbOpen } from '../../src/data/formats/mpack.ts';
import { startShellProcess } from '../../src/shell/boot.ts';
import { ShellPump } from '../../src/shell/host/pump.ts';
import { hardware, hwMouseButtons } from '../../src/shell/host/hardware.ts';
import { shell } from '../../src/shell/state.ts';
import { VideoDriver, videoDriverInit } from '../../src/shell/video/driver.ts';
import { FontHolder, fontHolderInit, type TextLabel } from '../../src/shell/ui/labels.ts';
import { Mouse, mouseInit } from '../../src/shell/ui/mouse.ts';
import { KeyInput, inputInit } from '../../src/shell/ui/keys.ts';
import { textInput, type TextInputResult } from '../../src/shell/ui/textInput.ts';
import { gameSource, hasGameData, hasShellData } from '../support/env.ts';

describe.runIf(hasGameData && hasShellData)('text_input', () => {
  let exe: ExeImage;
  let prj: ProjectFile;
  let fontBytes: Uint8Array;
  beforeAll(async () => {
    exe = ExeImage.fromExe(await gameSource().read('MW2SHELL.EXE'));
    prj = new ProjectFile(await gameSource().read('MW2.PRJ'));
    fontBytes = mpackDbGetItem(mpackDbOpen('DATABASE.MW2', await gameSource().read('DATABASE.MW2')), 0x1b)!;
  });

  /** Runs text_input in a fresh shell process, pushing `keys` (ASCII codes) one a frame from frame 5. */
  function edit(initial: string, keys: number[], maxChars: number, maxWidth: number): { result: TextInputResult; label: string } {
    startShellProcess(exe, prj);
    hwMouseButtons(0);
    hardware.keys.length = 0;
    const d = videoDriverInit(new VideoDriver());
    shell.videoDriver = d;
    const font = fontHolderInit(new FontHolder(), fontBytes, d);
    shell.shellMouse = mouseInit(new Mouse(), d, font, null);
    shell.keyInput = inputInit(new KeyInput());
    let result: TextInputResult | null = null;
    let label = '';
    const pump = new ShellPump(
      (function* () {
        result = yield* textInput(font, 0x2a, 0x5c, initial, null, maxChars, maxWidth);
        return 0;
      })(),
    );
    for (let f = 0; f < 200 && pump.frame(1000 / 60); f++) {
      if (f >= 5 && f - 5 < keys.length) hardware.keys.push(keys[f - 5]!);
      const over = d.labelsOver as TextLabel[];
      if (over.length) label = over[over.length - 1]!.text;
    }
    if (pump.error) throw pump.error;
    return { result: result!, label };
  }
  const k = (s: string) => [...s].map((c) => c.charCodeAt(0));

  it('types, backspaces and accepts with Enter; the label shows the cursor', () => {
    const { result, label } = edit('', [...k('ab'), 8, ...k('Cd'), 0x0d], 14, 300);
    expect(result).toEqual({ accepted: 1, text: 'aCd' });
    expect(label).toBe('aCd_');
  });

  it('Esc returns 0 with what was typed; "~" and control keys are ignored', () => {
    const { result } = edit('X', [...k('y~'), 1, ...k('z'), 0x1b], 14, 300);
    expect(result).toEqual({ accepted: 0, text: 'Xyz' });
  });

  it('stops at maxChars and at maxWidth', () => {
    expect(edit('', [...k('abcdef'), 0x0d], 3, 300).result.text).toBe('abc');
    // a width that fits only a few characters with the cursor
    const narrow = edit('', [...k('WWWWWWWWWW'), 0x0d], 14, 30).result.text;
    expect(narrow.length).toBeGreaterThan(0);
    expect(narrow.length).toBeLessThan(10);
  });
});
