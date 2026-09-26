/**
 * Edit-mode camera: fly with WASD (Q/E down/up, Shift faster) while the right
 * mouse button is held to look around; the wheel changes speed.
 *
 * @portOnly
 */
import * as THREE from 'three';

export class FreeFly {
  yaw = 0;
  pitch = -0.2;
  speed = 60; // metres per second
  private keys = new Set<string>();
  private looking = false;
  private disposers: Array<() => void> = [];

  constructor(
    readonly camera: THREE.PerspectiveCamera,
    readonly el: HTMLElement,
  ) {
    const on = <K extends keyof HTMLElementEventMap>(t: EventTarget, type: K | string, fn: (e: never) => void) => {
      t.addEventListener(type, fn as EventListener);
      this.disposers.push(() => t.removeEventListener(type, fn as EventListener));
    };
    on(el, 'contextmenu', (e: MouseEvent) => e.preventDefault());
    on(el, 'mousedown', (e: MouseEvent) => {
      if (e.button === 2) this.looking = true;
    });
    on(window, 'mouseup', (e: MouseEvent) => {
      if (e.button === 2) this.looking = false;
    });
    on(window, 'mousemove', (e: MouseEvent) => {
      if (!this.looking) return;
      this.yaw -= e.movementX * 0.003;
      this.pitch = Math.max(-1.55, Math.min(1.55, this.pitch - e.movementY * 0.003));
    });
    on(window, 'keydown', (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).tagName === 'INPUT') return;
      this.keys.add(e.code);
    });
    on(window, 'keyup', (e: KeyboardEvent) => this.keys.delete(e.code));
    on(el, 'wheel', (e: WheelEvent) => {
      this.speed = Math.max(2, Math.min(2000, this.speed * (e.deltaY > 0 ? 0.8 : 1.25)));
    });
  }

  lookAt(target: THREE.Vector3): void {
    const d = target.clone().sub(this.camera.position).normalize();
    this.yaw = Math.atan2(-d.x, -d.z);
    this.pitch = Math.asin(Math.max(-1, Math.min(1, d.y)));
  }

  update(dt: number): void {
    const c = this.camera;
    c.rotation.set(this.pitch, this.yaw, 0, 'YXZ');
    const f = new THREE.Vector3(0, 0, -1).applyEuler(c.rotation);
    const r = new THREE.Vector3(1, 0, 0).applyEuler(c.rotation);
    const s = this.speed * dt * (this.keys.has('ShiftLeft') || this.keys.has('ShiftRight') ? 4 : 1);
    if (this.keys.has('KeyW')) c.position.addScaledVector(f, s);
    if (this.keys.has('KeyS')) c.position.addScaledVector(f, -s);
    if (this.keys.has('KeyD')) c.position.addScaledVector(r, s);
    if (this.keys.has('KeyA')) c.position.addScaledVector(r, -s);
    if (this.keys.has('KeyE')) c.position.y += s;
    if (this.keys.has('KeyQ')) c.position.y -= s;
    c.updateMatrixWorld();
  }

  dispose(): void {
    for (const d of this.disposers) d();
  }
}
