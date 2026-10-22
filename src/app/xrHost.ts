/**
 * The headset for the whole game: one renderer and one WebXR session from
 * the start screen to the quit, through the front end, the launch screen
 * and every mission.
 *
 * A browser grants a session only from a click, and MECH2's loop goes from
 * the shell to a mission and back with none, so the session cannot belong
 * to any one view: GameShell makes the host when the player picks VR, and
 * the views borrow it.
 *
 *  - The mission's view (app/gameScreen.ts, with `host`) draws through the
 *    host's renderer and takes its frames (present).
 *  - The front end's views (app/shell/ShellView.tsx, LaunchView.tsx) paint
 *    their 640x480 canvas as always, the page showing it, and hand the host
 *    that canvas (showScreen): in the headset it is a panel in a dark room
 *    (render/xr/screenRoom.ts). The mouse and keyboard play it as they play
 *    the page - the mouse locked to the page and moved by its motion, since
 *    the pilot cannot see the page's pointer (ShellView.tsx).
 *  - Their frames come from the host's loop (onTick), which is the
 *    window's animation frames outside the headset and the headset's inside
 *    it: a browser may stop the window's frames while a session is on.
 *
 * When the session ends (the headset taken off, the system menu) the game
 * carries on on the page; enter() from a click puts it back.
 *
 * @portOnly the host of the game's headset
 */
import * as THREE from 'three';
import { ScreenRoom, type ScreenSource } from '../render/xr/screenRoom.ts';

export interface XrHostState {
  /** a session is on */
  on: boolean;
  /** asked for, and the headset has not given it yet (the browser and the XR runtime can take a minute) */
  pending: boolean;
}

type Frame = (now: number) => void;

export class XrHost {
  readonly renderer = new THREE.WebGLRenderer({ antialias: false });
  private presenter: Frame | null = null;
  private readonly tickers = new Set<Frame>();
  private readonly room = new ScreenRoom();
  private screen: ScreenSource | null = null;
  private state: XrHostState = { on: false, pending: false };
  private readonly listeners = new Set<(s: XrHostState) => void>();

  constructor() {
    const r = this.renderer;
    r.setPixelRatio(1);
    r.autoClear = false;
    r.xr.enabled = true;
    r.xr.setReferenceSpaceType('local');
    r.setAnimationLoop(this.loop);
  }

  /** Whether this browser can give an immersive VR session. */
  static async supported(): Promise<boolean> {
    try {
      return (await navigator.xr?.isSessionSupported('immersive-vr')) ?? false;
    } catch {
      return false;
    }
  }

  get presenting(): boolean {
    return this.renderer.xr.isPresenting;
  }

  /** Calls `fn` with the state now and on every change; returns the unsubscribe. */
  subscribe(fn: (s: XrHostState) => void): () => void {
    this.listeners.add(fn);
    fn(this.state);
    return () => this.listeners.delete(fn);
  }

  private set(s: Partial<XrHostState>): void {
    this.state = { ...this.state, ...s };
    for (const f of this.listeners) f(this.state);
  }

  /** Asks for the headset - from a click, or the browser refuses. True once it shows the game. */
  enter(): Promise<boolean> {
    if (this.renderer.xr.getSession()) return Promise.resolve(true);
    if (this.state.pending || !navigator.xr) return Promise.resolve(false);
    this.set({ pending: true });
    return navigator.xr
      .requestSession('immersive-vr', { optionalFeatures: ['local'] })
      .then(async (session) => {
        session.addEventListener('end', this.onEnd, { once: true });
        await this.renderer.xr.setSession(session);
        this.set({ on: true, pending: false });
        return true;
      })
      .catch((err: unknown) => {
        console.warn('VR session refused', err);
        this.set({ pending: false });
        return false;
      });
  }

  /** Ends the session; the game carries on on the page. */
  leave(): void {
    void this.renderer.xr.getSession()?.end();
  }

  private readonly onEnd = (): void => {
    this.set({ on: false });
  };

  /** The mission's view takes every frame (null: it has closed). */
  present(frame: Frame | null): void {
    this.presenter = frame;
  }

  /** `fn` every frame, before anything is drawn; returns the unsubscribe. */
  onTick(fn: Frame): () => void {
    this.tickers.add(fn);
    return () => this.tickers.delete(fn);
  }

  /** The canvas the headset's panel shows. */
  showScreen(canvas: ScreenSource): void {
    this.screen = canvas;
  }

  /** Takes the panel down, if it still shows `canvas`. */
  hideScreen(canvas: ScreenSource): void {
    if (this.screen === canvas) this.screen = null;
  }

  private readonly loop = (now: number): void => {
    for (const t of [...this.tickers]) t(now);
    if (this.presenter) {
      this.presenter(now);
      return;
    }
    if (!this.presenting) return;
    const { room, renderer } = this;
    room.show(this.screen);
    renderer.clear();
    renderer.render(room.scene, room.camera);
  };

  dispose(): void {
    this.leave();
    this.renderer.setAnimationLoop(null);
    this.room.dispose();
    this.renderer.dispose();
  }
}

/**
 * `fn` every display frame until the returned stop: from the host's loop when
 * there is one (the headset's frames while it is on), from the window's
 * animation frames otherwise.
 */
export function everyFrame(host: XrHost | null | undefined, fn: Frame): () => void {
  if (host) return host.onTick(fn);
  let raf = requestAnimationFrame(function tick(now) {
    fn(now);
    raf = requestAnimationFrame(tick);
  });
  return () => cancelAnimationFrame(raf);
}
