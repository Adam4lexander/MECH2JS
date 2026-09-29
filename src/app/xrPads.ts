/**
 * The VR controllers' mapping onto the game's keys (app/xrInput.ts reads the
 * controllers and sends what this returns). Pure, and free of the DOM, so
 * the unit tests reach it.
 *
 * @portOnly
 */
/** One frame of both controllers, in the xr-standard gamepad mapping's terms. */
export interface PadState {
  lx: number;
  ly: number;
  rx: number;
  ry: number;
  lTrigger: number;
  lGrip: number;
  lClick: boolean;
  rTrigger: number;
  rGrip: number;
  rClick: boolean;
  a: boolean;
  b: boolean;
  x: boolean;
  y: boolean;
}

export const IDLE_PAD: PadState = { lx: 0, ly: 0, rx: 0, ry: 0, lTrigger: 0, lGrip: 0, lClick: false, rTrigger: 0, rGrip: 0, rClick: false, a: false, b: false, x: false, y: false };

/** an analogue input presses at PRESS and lets go below RELEASE */
const PRESS = 0.6;
const RELEASE = 0.4;
/** the right stick's dead zone */
const DEAD = 0.12;

export interface KeyChange {
  code: string;
  down: boolean;
}

/**
 * Turns controller states into key presses and releases and a torso stick.
 * Pure: the caller sends what it returns.
 */
export class PadMapper {
  private readonly held = new Set<string>();
  private torsoActive = false;

  update(p: PadState): { keys: KeyChange[]; torso: [number, number] | null } {
    const keys: KeyChange[] = [];
    const set = (code: string, down: boolean) => {
      if (down === this.held.has(code)) return;
      if (down) this.held.add(code);
      else this.held.delete(code);
      keys.push({ code, down });
    };
    const analog = (code: string, v: number) => set(code, this.held.has(code) ? v > RELEASE : v > PRESS);
    // stick y is negative pushed forward
    analog('Equal', -p.ly);
    analog('Minus', p.ly);
    analog('ArrowLeft', -p.lx);
    analog('ArrowRight', p.lx);
    set('Backquote', p.lClick);
    analog('Enter', p.lTrigger);
    analog('Digit1', p.lGrip);
    set('KeyC', p.x);
    set('Escape', p.y);
    set('KeyM', p.rClick);
    analog('Space', p.rTrigger);
    analog('Semicolon', p.rGrip);
    set('KeyE', p.a);
    set('KeyT', p.b);
    // the torso: while deflected, and once more at rest to centre it
    const dz = (v: number) => (Math.abs(v) < DEAD ? 0 : (v - Math.sign(v) * DEAD) / (1 - DEAD));
    const tx = dz(p.rx);
    const ty = dz(p.ry);
    let torso: [number, number] | null = null;
    if (tx !== 0 || ty !== 0) {
      torso = [tx, ty];
      this.torsoActive = true;
    } else if (this.torsoActive) {
      torso = [0, 0];
      this.torsoActive = false;
    }
    return { keys, torso };
  }

  /** Releases everything held. */
  reset(): KeyChange[] {
    const keys = [...this.held].map((code) => ({ code, down: false }));
    this.held.clear();
    this.torsoActive = false;
    return keys;
  }
}
