/**
 * main's start-up rescale of the screen layout, once the mission has loaded:
 * every table the mission (VWSP, HRZM), CPIT and HUD filled in 320x200
 * design pixels becomes pixels of the real window.
 */
import { divergence } from '../../core/provenance.ts';
import { cam } from '../camera/cameraUpdate.ts';
import { cameraGlobals } from '../camera/viewer.ts';
import { viewerBuildTransform, viewerUpdateProjection } from '../camera/projection.ts';
import { cockpit } from '../cockpit/resources.ts';
import { lighting } from '../world/environment.ts';
import {
  layoutPaneInPane,
  layoutPaneToFraction,
  layoutPaneToWindow,
  layoutPointInPane,
  layoutPointToFraction,
  layoutPointToWindow,
} from './layout.ts';
import { defaultCanvas, viewportSelect } from './video.ts';

/**
 * The 24 HudWidget panes (0x968e0) from design pixels to the screen, their
 * text positions (0x96ac0) from fractions of the pane to pixels relative to
 * it, and each pane transition's two panes placed inside its widget's pane.
 *
 * @mw2 hud_widget_panes_rescale 0x000329c0
 * @fidelity exact
 */
export function hudWidgetPanesRescale(): void {
  const c = cockpit;
  for (let i = 0; i < 0x18; i++) {
    const pane = c.dat000968e0[i]!;
    layoutPaneToFraction(pane, pane);
    layoutPaneToWindow(defaultCanvas, pane, pane);
    layoutPointInPane(pane, c.dat00096ac0, c.dat00096ac0, i * 2);
    const t = c.paneTransitions[i];
    if (t) {
      t.from.canvas = defaultCanvas;
      layoutPaneInPane(pane, t.from, t.from);
      t.to.canvas = defaultCanvas;
      layoutPaneInPane(pane, t.to, t.to);
      t.out.canvas = defaultCanvas;
    }
  }
}

/**
 * The start-up rescale: viewportModes 0..7, the five panes at 0x955e8, the
 * point at 0x9572c, the six points at 0x9623c and horizonBandHeight (as the
 * x of a point) go from design pixels to fractions to the window; then
 * viewport_select(0) and the viewer's projection and transform, and the HUD
 * widgets' panes.
 *
 * @mw2 layout_rescale_all 0x00014950
 * @fidelity partial
 * @divergence vfx_video_font_handler (the message bar's layout) and hud_debug_sub_049a90 (the debug text's) are not ported yet
 */
export function layoutRescaleAll(): void {
  const c = cockpit;
  for (let i = 0; i < 8; i++) {
    const w = lighting.viewportModes[i]!;
    layoutPaneToFraction(w, w);
    layoutPaneToWindow(defaultCanvas, w, w);
  }
  for (let i = 0; i < 5; i++) {
    const w = c.dat000955e8[i]!;
    layoutPaneToFraction(w, w);
    layoutPaneToWindow(defaultCanvas, w, w);
  }
  layoutPointToFraction(c.dat0009572c, c.dat0009572c);
  layoutPointToWindow(defaultCanvas, c.dat0009572c, c.dat0009572c);
  for (let i = 0; i < 6; i++) {
    layoutPointToFraction(c.dat0009623c, c.dat0009623c, i * 2);
    layoutPointToWindow(defaultCanvas, c.dat0009623c, c.dat0009623c, i * 2);
  }
  viewportSelect(0);
  const v = cameraGlobals.viewerPosition ?? cameraGlobals.mainViewer;
  viewerUpdateProjection(v);
  viewerBuildTransform(v);
  cam.dat000954ec = 0;
  const band = Int32Array.of(lighting.horizonBandHeight, 0);
  layoutPointToFraction(band, band);
  layoutPointToWindow(defaultCanvas, band, band);
  lighting.horizonBandHeight = band[0]!;
  hudWidgetPanesRescale();
  divergence('vfx_video_font_handler (the message bar layout) is not ported yet', 'layout_rescale_all');
  divergence('hud_debug_sub_049a90 (the debug text layout) is not ported', 'layout_rescale_all');
}
