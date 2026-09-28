/**
 * The one TEXT-resource message box MW2.EXE draws: netplay_join's 'Link
 * established' / 'Connection NOT made' over the launch screen.
 */
import { divergence } from '../../core/provenance.ts';
import { registerGlobals } from '../../engine/globals.ts';
import { cacheLoadResource } from '../../engine/resources/cache.ts';

/** @portOnly what the host shows in place of vfx_video_font_handler's drawing */
export interface VideoTextShown {
  text: string;
  shapeId: number;
  fontId: number;
  x: number;
  y: number;
}

export const videoText = registerGlobals(
  'videoText',
  {
    /** @portOnly the last text vfx_video_text_handler put up, for the host to show; null for none */
    shown: null as VideoTextShown | null,
  },
  () => {
    videoText.shown = null;
  },
);

/**
 * Loads TEXT resource `textId`, whose bytes are stored negated, decodes it
 * (negating each byte in place up to the terminating 0) and hands it to
 * vfx_video_font_handler: drawn in font `fontId` over shape `shapeId`,
 * centred where x or y is negative.
 *
 * @mw2 vfx_video_text_handler 0x00011340
 * @fidelity partial
 * @divergence the text is decoded into a copy (the port's MW2.PRJ outlives the process, and the original negates the cached copy in place, so a second call in one run would re-encode it); vfx_video_font_handler's drawing is the host's: the text is left in videoText.shown
 */
export function vfxVideoTextHandler(shapeId: number, fontId: number, textId: number, x: number, y: number): void {
  const b = cacheLoadResource(textId, 'TEXT');
  if (!b) return;
  let text = '';
  for (let i = 0; i < b.length && b[i] !== 0; i++) text += String.fromCharCode(-b[i]! & 0xff);
  divergence('vfx_video_font_handler is not ported: the host shows the text', 'vfx_video_text_handler');
  videoText.shown = { text, shapeId, fontId, x, y };
}
