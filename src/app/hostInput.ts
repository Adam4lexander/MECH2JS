/**
 * The PC hardware below the GIDDI drivers: the browser's keyboard becomes
 * the keyboard controller's set-1 scancodes (fed to KEYBOARD.DLL's
 * interrupt handler, sim/controls/giddi.ts), and the pointer becomes the
 * DOS mouse driver's position and buttons (read by MOUSE.DLL).
 *
 * Mapping is by KeyboardEvent.code, the physical key, so the layout is the
 * PC keyboard's regardless of the user's language. A held key repeats as
 * the browser repeats it (the BIOS typematic rate the driver sets is not
 * reproduced).
 *
 * @portOnly hardware emulation
 */
import { input } from '../sim/controls/input.ts';
import { KeyboardDriver, MouseDriver } from '../sim/controls/giddi.ts';

/** code -> set-1 make sequence (break = the same with 0x80 on the last byte) */
const SCANCODES: Record<string, number[]> = {
  Escape: [0x01],
  Digit1: [0x02], Digit2: [0x03], Digit3: [0x04], Digit4: [0x05], Digit5: [0x06],
  Digit6: [0x07], Digit7: [0x08], Digit8: [0x09], Digit9: [0x0a], Digit0: [0x0b],
  Minus: [0x0c], Equal: [0x0d], Backspace: [0x0e], Tab: [0x0f],
  KeyQ: [0x10], KeyW: [0x11], KeyE: [0x12], KeyR: [0x13], KeyT: [0x14],
  KeyY: [0x15], KeyU: [0x16], KeyI: [0x17], KeyO: [0x18], KeyP: [0x19],
  BracketLeft: [0x1a], BracketRight: [0x1b], Enter: [0x1c], ControlLeft: [0x1d],
  KeyA: [0x1e], KeyS: [0x1f], KeyD: [0x20], KeyF: [0x21], KeyG: [0x22],
  KeyH: [0x23], KeyJ: [0x24], KeyK: [0x25], KeyL: [0x26],
  Semicolon: [0x27], Quote: [0x28], Backquote: [0x29], ShiftLeft: [0x2a], Backslash: [0x2b],
  KeyZ: [0x2c], KeyX: [0x2d], KeyC: [0x2e], KeyV: [0x2f], KeyB: [0x30], KeyN: [0x31], KeyM: [0x32],
  Comma: [0x33], Period: [0x34], Slash: [0x35], ShiftRight: [0x36], NumpadMultiply: [0x37],
  AltLeft: [0x38], Space: [0x39], CapsLock: [0x3a],
  F1: [0x3b], F2: [0x3c], F3: [0x3d], F4: [0x3e], F5: [0x3f],
  F6: [0x40], F7: [0x41], F8: [0x42], F9: [0x43], F10: [0x44],
  NumLock: [0x45], ScrollLock: [0x46],
  Numpad7: [0x47], Numpad8: [0x48], Numpad9: [0x49], NumpadSubtract: [0x4a],
  Numpad4: [0x4b], Numpad5: [0x4c], Numpad6: [0x4d], NumpadAdd: [0x4e],
  Numpad1: [0x4f], Numpad2: [0x50], Numpad3: [0x51], Numpad0: [0x52], NumpadDecimal: [0x53],
  IntlBackslash: [0x56], F11: [0x57], F12: [0x58],
  NumpadEnter: [0xe0, 0x1c], ControlRight: [0xe0, 0x1d], NumpadDivide: [0xe0, 0x35], AltRight: [0xe0, 0x38],
  Home: [0xe0, 0x47], ArrowUp: [0xe0, 0x48], PageUp: [0xe0, 0x49], ArrowLeft: [0xe0, 0x4b],
  ArrowRight: [0xe0, 0x4d], End: [0xe0, 0x4f], ArrowDown: [0xe0, 0x50], PageDown: [0xe0, 0x51],
  Insert: [0xe0, 0x52], Delete: [0xe0, 0x53],
};

/** Pause sends its whole make-and-break sequence on press and nothing on release. */
const PAUSE = [0xe1, 0x1d, 0x45, 0xe1, 0x9d, 0xc5];

/** DOS mouse units per CSS pixel of pointer movement (the driver reads position >> 3). */
const MOUSE_UNITS_PER_PIXEL = 8;

function keyboard(): KeyboardDriver | null {
  const d = input.devices.find((x) => x.driver instanceof KeyboardDriver);
  return (d?.driver as KeyboardDriver | undefined) ?? null;
}

function mouse(): MouseDriver | null {
  const d = input.devices.find((x) => x.driver instanceof MouseDriver);
  return (d?.driver as MouseDriver | undefined) ?? null;
}

/** The scancode bytes for a key event, or null for a key the PC keyboard did not have. */
export function scancodesFor(code: string, down: boolean): number[] | null {
  if (code === 'Pause') return down ? PAUSE : [];
  const s = SCANCODES[code];
  if (!s) return null;
  if (down) return s;
  return [...s.slice(0, -1), s[s.length - 1]! | 0x80];
}

/** int 33h button bits: 1 left, 2 right, 4 middle */
const BUTTON_BITS = [1, 4, 2];

/**
 * Feeds the game's devices from `target` while `active()` holds. Returns a
 * function that detaches everything and releases any key still down.
 */
export function attachHostInput(target: HTMLElement, active: () => boolean): () => void {
  const held = new Set<string>();
  const onKey = (e: KeyboardEvent) => {
    if (!active()) return;
    const down = e.type === 'keydown';
    const seq = scancodesFor(e.code, down);
    if (!seq) return;
    e.preventDefault();
    if (down) held.add(e.code);
    else held.delete(e.code);
    const kb = keyboard();
    if (kb) for (const b of seq) kb.isr(b);
  };
  const onMove = (e: MouseEvent) => {
    if (!active() || document.pointerLockElement !== target) return;
    mouse()?.hostMove(e.movementX * MOUSE_UNITS_PER_PIXEL, e.movementY * MOUSE_UNITS_PER_PIXEL);
  };
  const onButton = (e: MouseEvent) => {
    if (!active()) return;
    const m = mouse();
    const bit = BUTTON_BITS[e.button] ?? 0;
    if (!m || !bit) return;
    if (e.type === 'mousedown') {
      if (document.pointerLockElement !== target) {
        void target.requestPointerLock();
        return;
      }
      m.buttons |= bit;
    } else m.buttons &= ~bit;
    e.preventDefault();
  };
  const release = () => {
    const kb = keyboard();
    for (const code of held) for (const b of scancodesFor(code, false) ?? []) kb?.isr(b);
    held.clear();
    const m = mouse();
    if (m) m.buttons = 0;
  };
  const onContext = (e: Event) => {
    if (active()) e.preventDefault();
  };
  window.addEventListener('keydown', onKey);
  window.addEventListener('keyup', onKey);
  window.addEventListener('blur', release);
  target.addEventListener('mousemove', onMove);
  target.addEventListener('mousedown', onButton);
  window.addEventListener('mouseup', onButton);
  target.addEventListener('contextmenu', onContext);
  return () => {
    release();
    window.removeEventListener('keydown', onKey);
    window.removeEventListener('keyup', onKey);
    window.removeEventListener('blur', release);
    target.removeEventListener('mousemove', onMove);
    target.removeEventListener('mousedown', onButton);
    window.removeEventListener('mouseup', onButton);
    target.removeEventListener('contextmenu', onContext);
  };
}
