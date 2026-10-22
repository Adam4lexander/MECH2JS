/**
 * The front end in a headset: MW2SHELL's 640x480 screen (or MW2.EXE's launch
 * screen) on a panel in a dark room.
 *
 * The panel shows the page's own canvas - the one the shell's view paints
 * every frame, pointer included - as a texture, so what the headset shows is
 * pixel for pixel what the page shows, and the mouse and keyboard work it as
 * they work the page (app/shell/ShellView.tsx). It is curved round the
 * seated head (the 'local' reference space's origin, where the head
 * started), every column the same distance from the eye, so its edges are as
 * easy to read as its middle.
 *
 * @portOnly
 */
import * as THREE from 'three';

/** the screen's pixels */
const SCREEN_W = 640;
const SCREEN_H = 480;

/** the panel: this far from the head (metres), this wide along its curve, its middle this far below the eye */
export const PANEL_DISTANCE = 2.2;
export const PANEL_WIDTH = 2.4;
export const PANEL_DROP = 0.1;
/** the floor, this far below the head's start */
const FLOOR_DROP = 1.2;

/** what the panel shows: the page's canvas (typed as three takes it, so the module needs no DOM types) */
export type ScreenSource = ConstructorParameters<typeof THREE.CanvasTexture>[0];

/**
 * The panel's geometry: a PANEL_WIDTH x (PANEL_WIDTH * 3/4) plane bent onto
 * a cylinder of radius PANEL_DISTANCE round the head's vertical axis, facing
 * it, its u and v those of the flat plane (u across, v up).
 */
export function curvedPanel(distance = PANEL_DISTANCE, width = PANEL_WIDTH, drop = PANEL_DROP): THREE.BufferGeometry {
  const height = (width * SCREEN_H) / SCREEN_W;
  const g = new THREE.PlaneGeometry(width, height, 48, 1);
  const pos = g.getAttribute('position') as THREE.BufferAttribute;
  for (let i = 0; i < pos.count; i++) {
    const a = pos.getX(i) / distance;
    pos.setXYZ(i, distance * Math.sin(a), pos.getY(i) - drop, -distance * Math.cos(a));
  }
  pos.needsUpdate = true;
  g.computeVertexNormals();
  g.computeBoundingSphere();
  return g;
}

export class ScreenRoom {
  readonly scene = new THREE.Scene();
  /** three swaps in the headset's cameras; this one only carries the scene's near and far */
  readonly camera = new THREE.PerspectiveCamera(70, 1, 0.05, 100);
  private readonly panel: THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>;
  private readonly grid: THREE.GridHelper;
  private texture: THREE.CanvasTexture<ScreenSource> | null = null;
  private source: ScreenSource | null = null;

  constructor() {
    this.scene.background = new THREE.Color(0x050608);
    this.panel = new THREE.Mesh(curvedPanel(), new THREE.MeshBasicMaterial({ color: 0xffffff }));
    this.panel.visible = false;
    this.scene.add(this.panel);
    // a floor to stand the room on: a dark void is hard to sit in
    this.grid = new THREE.GridHelper(40, 40, 0x2a2e36, 0x15181d);
    this.grid.position.y = -FLOOR_DROP;
    this.scene.add(this.grid);
  }

  /** The canvas the panel shows (null: no panel), uploaded again every frame it is shown. */
  show(canvas: ScreenSource | null): void {
    if (canvas !== this.source) {
      this.source = canvas;
      this.texture?.dispose();
      this.texture = null;
      if (canvas) {
        const t = new THREE.CanvasTexture(canvas);
        t.colorSpace = THREE.SRGBColorSpace;
        // the screen's pixels stay square close up; mipmaps keep its text from shimmering further off
        t.magFilter = THREE.NearestFilter;
        t.minFilter = THREE.LinearMipmapLinearFilter;
        t.anisotropy = 4;
        this.texture = t;
      }
      this.panel.material.map = this.texture;
      this.panel.material.needsUpdate = true;
    }
    this.panel.visible = canvas !== null;
    if (this.texture) this.texture.needsUpdate = true;
  }

  dispose(): void {
    this.texture?.dispose();
    this.panel.geometry.dispose();
    this.panel.material.dispose();
    this.grid.dispose();
  }
}
