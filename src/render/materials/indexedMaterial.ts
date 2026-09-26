/**
 * The faithful material: every fragment ends as a palette index.
 *
 * Per face the CPU supplies the draw word polygon_resolve_colour produced:
 *   flat modes      index = word & 0xff  (ramp * 16 + shade, or a raw index)
 *   textured modes  slot = word & 0xff, shade = (word >> 8) & 0xf, mode 0x5000/0x6000/0x7000
 * Textured faces sample the CEL bound to bitmap3d slot (slot + 0x100) - the
 * mesh half of bitmap3dTable - and, when shade < 15, map the texel through the
 * LUMA row for that shade (bitmap3d_draw's shade path). Then the palette.
 *
 * Mode 0x4000 is the per-vertex-shade fill (render_asm_sub_03bb80's 0x4000
 * case, then the filler clib_core_sub_059e77). Each vertex carries its own
 * 16.16 palette index: the screen vertex's +0xc, which poly_emit_screen_vertices
 * copies from ClipVertex.texU = MeshVertex.texU << 16. Below 0x300000 it is
 * used as it is; otherwise its ramp (& 0xfff00000) is kept and its step within
 * the ramp (bits 16-19) is scaled by (polygon shade + 1) / 16 - so the
 * polygon's light and distance shade only scales what the vertex carries
 * (terrain: a height ramp, 0 in the valleys). The filler interpolates it
 * linearly in screen space (value * w and w interpolated, then divided, as for affine textures) from each edge value + 0x8000,
 * with 2x2 ordered dither: alternate pixels, swapped each scanline, add
 * 0x7fff or -0x8000 before taking the integer part - so a pixel is
 * (V + 0xffff) >> 16 or V >> 16 in a checkerboard (disassembly 0x59f1a,
 * 0x5a01f, 0x5a218..0x5a24c, 0x5a310). DIVERGENCES: the checkerboard's phase
 * follows the screen, where the filler starts it at each polygon's top
 * scanline; float interpolation stands in for its 16.16 stepping, taken back
 * to 16.16 per fragment with values within 1/512 of an index snapped onto
 * it. Float error would otherwise tip exact indices either way, and the
 * dither turns any fraction at all into a checkerboard with the next index:
 * at kilometre ranges (the ground enhancement's far cells) the error passed
 * the first cut's 4/65536 and speckled a flat colour with its neighbour. A
 * true fraction under 1/512 now fills flat where the filler would
 * checkerboard it - a sliver along each iso-line; with
 * shadedFillEnabled clear the filler would fill flat from one vertex - here
 * the dither is dropped instead.
 *
 * Mode 0x3000 is a SPRITE (render_asm_sub_03b950 -> render_asm_sub_03b990),
 * drawn only when code & 0xf is 0 or 3 and bit 0 of DAT_00097030 is set. Of
 * the polygon's first three screen vertices, the one with u = 0 and v = 0 is
 * P, the one with u = 0 and v != 0 is Q, and a negative v on Q or a negative
 * u on the third mirrors the texture (spriteVertices). The sprite is the
 * screen-space square with P and Q as the midpoints of two opposite sides -
 * half = (Q - P) >> 1, corners P -+ (half.y, -half.x) and Q +- (half.y,
 * -half.x) in screen pixels, y down - drawn with bitmap3d_draw(slot = (code &
 * 0xff0) >> 4 in the table's lower half, shade -1, so no LUMA), its corners
 * taking u, v from the table at 0x96f1c: (0,0) (1,0) (1,1) (0,1), times
 * (size - 1), so v runs from 0 at P to 1 at Q. In the data P is the upper
 * point and Q the one on the ground. SceneRenderer gives the vertices P as
 * position and Q plus a corner number in aSprite; the corners are made here,
 * at P's depth.
 *
 * TRANSPARENCY: the texture span loops (clib_core_sub_05b549 at 0x5baa6..,
 * clib_sub_06a13b, vfx_character_draw) look each texel up through the shade
 * row and skip the store when the result is 0xff. All three LUMA tables keep
 * 0xff as 0xff at every shade and map nothing else to it, so a texel of 0xff
 * is transparent, lit or not.
 *
 * THE MAP (uMapFill, the overhead map's SceneRenderer): map_fill_polygon
 * gives a mode 0x4000 polygon's vertices their palette index outright -
 * (word & 0xf0) | map_height_shade - which SceneRenderer puts in aUv.x, and
 * fills it with the same per-vertex-shade filler; its mode 0x3000 sprites
 * are render_asm_sub_03b990's other variant (last argument 1), drawn
 * without the DAT_00097030 / code & 0xf gate: from the vertex with u != 0
 * (R, aSpriteR) and Q, half = |(Q.x - R.x) >> 1| in screen pixels, the
 * square Q +- half on both axes, upright on the screen, at R's depth, with
 * the same corner u, v.
 *
 * OUTPUT: with uIndexOut the fragment is the palette index itself (red =
 * index / 255, alpha 1), for a render whose pixels are read back into the
 * game's 8-bit window (render/passes/indexedView.ts); otherwise its colour.
 *
 * ARMOUR PANELS (uPanels, the port's enhancement; the mech material only,
 * uPanel): a flat-lit or textured face of a mech part is divided into plates
 * on a grid in the part's own space, on the plane of the face's dominant
 * axis (its normal from the derivatives of the model-space position - exact,
 * the faces being flat). Each plate's shade is moved a step up or down or
 * left, by a hash of the plate, and the plates' borders go two steps down as
 * seams: ramp * 16 + shade for flat-lit faces, the LUMA row for textured ones
 * - so a plate is always a colour the face's own ramp has. Plates under about
 * ten pixels are left plain, so a distant mech is the original's, and seams
 * are drawn only on plates over about sixteen (thinner, they crawl).
 * @portOnly the enhancement, not the original's
 *
 * SHADOWS (uShadowOn, the port's enhancement, render/enhance/shadows.ts): a
 * fragment of a face turned towards the light that lies behind a caster in
 * the shadow map takes its index's shadow index (uShadowTable: the darker
 * colour of the same 16-colour ramp, from the palette on screen - the LUMA
 * tables leave whole ramps, the ground's among them, unchanged), with a
 * dithered edge (four map samples against a 2x2 ordered threshold). Sprites
 * take none.
 * @portOnly the enhancement, not the original's
 *
 * Mode 0x5000 is perspective-correct unless textureAffine is set; 0x6000 is
 * always affine (render_asm_sub_03bb80's dispatch, per polygon_resolve_colour's
 * note). WebGL interpolates perspective-correctly; affine is reproduced by
 * interpolating uv * w and w and dividing per fragment.
 *
 * @portOnly
 */
import * as THREE from 'three';
import { dac6to8 } from '../../data/formats/image.ts';

export const vertexShader = /* glsl */ `
in float aDraw;
in vec2 aUv;
in vec4 aSprite;        // mode 0x3000: xyz the sprite's point Q (model space), w its corner 0..3; w < 0 otherwise
in vec3 aSpriteR;       // mode 0x3000: the vertex with u != 0 (the map variant's P)
uniform vec2 uViewport; // the render target, pixels
uniform int uMapFill;   // the overhead map: map_fill_polygon's vertex indices and sprite squares
flat out int vDraw;
out vec3 vUvw;
out vec2 vUvPersp;
out float vIdxW;   // vIdx * w: divided by the interpolated w, it is linear in screen space
out vec3 vModel;   // the vertex in model space (world space for baked scenery), metres
out vec3 vWorld;   // the vertex in world space, metres (the shadow enhancement)
void main() {
  vModel = position;
  vWorld = (modelMatrix * vec4(position, 1.0)).xyz;
  vDraw = aDraw < 0.0 ? -1 : int(aDraw + 0.5);
  float vIdx = 0.0;
  if (vDraw >= 0 && (vDraw & 0x7000) == 0x4000 && uMapFill != 0) {
    vIdx = aUv.x;   // (word & 0xf0) | map_height_shade(depth), set per vertex by SceneRenderer
  } else if (vDraw >= 0 && (vDraw & 0x7000) == 0x4000) {
    int u = int(floor(aUv.x * 65536.0 + 0.5));   // ClipVertex.texU, 16.16 (fractional at near-plane crossings)
    int shade = vDraw & 15;
    // (u & 0xfff00000) + ((u & 0xf0000) * ((shade + 1) * 0x1000) >> 16), in index units
    vIdx = u < 0x300000 ? float(u) / 65536.0 : float(u >> 20) * 16.0 + float((u >> 16) & 15) * float(shade + 1) / 16.0;
  }
  vec4 clip = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  // A sprite is a square made on the screen from its points' projections, so both must lie in front of the
  // eye: one behind it (w <= 0) turns the square inside out and it fills the view. The game's clipper drops
  // such sprites before they reach here (spriteVertices); what it never saw does not pass it - the scrounge
  // field's copies (enhance/groundField.ts), and in a headset each eye, which stands a few centimetres off
  // the viewer the clipper culled for. Such a sprite is sent outside the clip volume, all four corners at once.
  const float SPRITE_NEAR = 0.05;
  if (aSprite.w >= 0.0 && uMapFill == 0) {
    vec4 cq = projectionMatrix * modelViewMatrix * vec4(aSprite.xyz, 1.0);
    if (clip.w < SPRITE_NEAR || cq.w < SPRITE_NEAR) {
      vUvw = vec3(0.0);
      vIdxW = 0.0;
      vUvPersp = aUv;
      gl_Position = vec4(0.0, 0.0, 2.0, 1.0);
      return;
    }
  }
  if (aSprite.w >= 0.0 && uMapFill != 0) {
    // render_asm_sub_03b990, last argument 1: a square upright on the screen about Q, half the x distance from R to Q, at R's depth
    vec4 cr = projectionMatrix * modelViewMatrix * vec4(aSpriteR, 1.0);
    vec4 cq = projectionMatrix * modelViewMatrix * vec4(aSprite.xyz, 1.0);
    vec2 h = uViewport * 0.5;
    vec2 r = floor(vec2(cr.x, -cr.y) / cr.w * h);
    vec2 q = floor(vec2(cq.x, -cq.y) / cq.w * h);
    float a = abs(floor((q.x - r.x) * 0.5));
    int c = int(aSprite.w + 0.5);
    vec2 s = c == 0 ? q + vec2(-a, -a) : c == 1 ? q + vec2(a, -a) : c == 2 ? q + vec2(a, a) : q + vec2(-a, a);
    clip = vec4(s.x / h.x * cr.w, -s.y / h.y * cr.w, cr.z, cr.w);
  } else if (aSprite.w >= 0.0) {
    // render_asm_sub_03b990: the square on P and Q in screen pixels (y down), at P's depth
    vec4 cq = projectionMatrix * modelViewMatrix * vec4(aSprite.xyz, 1.0);
    vec2 h = uViewport * 0.5;
    vec2 p = vec2(clip.x, -clip.y) / clip.w * h;
    vec2 q = vec2(cq.x, -cq.y) / cq.w * h;
    vec2 d = floor((q - p) * 0.5);
    int c = int(aSprite.w + 0.5);
    vec2 s = c == 0 ? p + vec2(-d.y, d.x) : c == 1 ? p + vec2(d.y, -d.x) : c == 2 ? q + vec2(d.y, -d.x) : q + vec2(-d.y, d.x);
    clip = vec4(s.x / h.x * clip.w, -s.y / h.y * clip.w, clip.z, clip.w);
  }
  vUvw = vec3(aUv * clip.w, clip.w);
  vIdxW = vIdx * clip.w;
  vUvPersp = aUv;
  gl_Position = clip;
}
`;

export const fragmentShader = /* glsl */ `
precision highp float;
precision highp int;
uniform sampler2D uPalette;   // 256 x 1 RGBA
uniform sampler2D uLuma;      // 256 x 16 R8: row = shade, column = index
uniform sampler2D uAtlas;     // R8 palette indices of every CEL in use
uniform sampler2D uSlots;     // 512 x 1 RGBA32F: atlas x, y, w, h of each slot's current frame (w = 0: none)
uniform vec2 uAtlasSize;
uniform int uTextureAffine;
uniform int uTexturesOn;      // DAT_0009702c: textured modes are drawn (1 in the image and in every inset setup)
uniform int uShadedFill;
uniform int uSprites;         // DAT_00097030 bit 0: mode 0x3000 sprites are drawn
uniform int uMapFill;
uniform int uIndexOut;        // write the palette index, not its colour
uniform int uPanels;          // the armour-panel enhancement is on (the main view only)
uniform int uPanel;           // this material draws mech parts
flat in int vDraw;
in vec3 vUvw;
in vec2 vUvPersp;
in float vIdxW;
in vec3 vModel;
in vec3 vWorld;
uniform int uShadowOn;          // the shadow enhancement is on (the main view only)
uniform sampler2D uShadowMap;   // depth along the light, 0..1
uniform mat4 uShadowMatrix;     // world to the map's 0..1 cube
uniform vec3 uShadowDir;        // towards the light
uniform float uShadowTexel;
uniform sampler2D uShadowTable; // 256 x 1 R8: each index's shadow index
out vec4 outColor;

vec3 pal(int i) { return texelFetch(uPalette, ivec2(i & 255, 0), 0).rgb; }
vec4 outFor(int i) { return uIndexOut != 0 ? vec4(float(i & 255) / 255.0, 0.0, 0.0, 1.0) : vec4(pal(i), 1.0); }

// SHADOWS: whether this fragment (face normal n, world space) lies in a caster's shadow, dithered at the edge
bool inShadow(vec3 n, ivec2 px) {
  if (dot(n, uShadowDir) <= 0.0) return false;   // turned away from the light: its own shade already says so
  vec4 s = uShadowMatrix * vec4(vWorld, 1.0);
  vec3 p = s.xyz / s.w;
  if (p.x <= 0.0 || p.y <= 0.0 || p.x >= 1.0 || p.y >= 1.0 || p.z >= 1.0) return false;
  int n4 = 0;
  for (int i = 0; i < 4; i++) {
    vec2 o = (vec2(float(i & 1), float(i >> 1)) - 0.5) * uShadowTexel;
    if (texture(uShadowMap, p.xy + o).r < p.z - 0.0004) n4++;
  }
  // 2x2 ordered threshold [0 2; 3 1]: none in shadow never, all always, between on a checker
  int b = ((px.y & 1) << 1) | (px.x & 1);
  int t = b == 0 ? 0 : b == 1 ? 2 : b == 2 ? 3 : 1;
  return n4 > t;
}

// ARMOUR PANELS: the shade steps this fragment's plate moves by (0 when plain)
const vec2 PANEL = vec2(1.1, 0.75);   // plate size, metres
float hash21(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
int panelShift() {
  vec3 n = abs(cross(dFdx(vModel), dFdy(vModel)));
  int axis = n.x >= n.y && n.x >= n.z ? 0 : n.y >= n.z ? 1 : 2;
  vec2 p = (axis == 0 ? vModel.zy : axis == 1 ? vModel.xz : vModel.xy) / PANEL;
  vec2 w = fwidth(p);
  // plates under about ten pixels: plain; seams only on plates over about sixteen - thin lines on small
  // plates alias, and crawl as the mech moves
  float m = max(w.x, w.y);
  if (m > 0.1) return 0;
  vec2 cell = floor(p);
  vec2 f = p - cell;
  if (m < 0.06 && (f.x < w.x * 1.5 || f.y < w.y * 1.5)) return -2;
  float h = hash21(cell + float(axis) * 17.31);
  return h < 0.3 ? -1 : h > 0.75 ? 1 : 0;
}

void main() {
  if (vDraw < 0) discard; // not queued by the clipper
  int mode = vDraw & 0x7000;
  int idx = vDraw & 255;
  // the face's world normal for the shadow test (derivatives: uniform control flow, every fragment)
  vec3 faceN = normalize(cross(dFdx(vWorld), dFdy(vWorld)));
  // the derivatives panelShift takes need uniform control flow: taken for every fragment, used by mode
  int panel = 0;
  if (uPanels != 0 && uPanel != 0) {
    int shift = panelShift();
    if (mode == 0x1000 || mode >= 0x5000) panel = shift;
  }
  if (mode == 0x1000 && panel != 0) idx = (idx & 0xf0) | clamp((idx & 15) + panel, 0, 15);
  if (mode == 0x4000) {
    ivec2 px = ivec2(gl_FragCoord.xy);
    bool up = uShadedFill != 0 && ((px.x + px.y) & 1) == 1;
    float vIdx = vIdxW / vUvw.z;
    // back to 16.16, snapping float error off exact indices, then the filler's own integer step
    float r = floor(vIdx + 0.5);
    if (abs(vIdx - r) < 1.0 / 512.0) vIdx = r;
    int V = int(floor(vIdx * 65536.0 + 0.5));
    idx = (V + (up ? 0xffff : 0)) >> 16;
  }
  if (mode == 0x3000) {
    int k = vDraw & 15;
    if (uMapFill == 0 && (uSprites == 0 || !(k == 0 || k == 3))) discard;
    vec4 r = texelFetch(uSlots, ivec2((vDraw & 0xff0) >> 4, 0), 0);
    if (r.z <= 0.0) discard;         // bitmap3d_draw draws nothing without a frame
    vec2 t = clamp(floor(vUvPersp * (r.zw - 1.0)), vec2(0.0), r.zw - 1.0);
    idx = int(texelFetch(uAtlas, ivec2(r.xy + t), 0).r * 255.0 + 0.5);
    if (idx == 0xff) discard;
  }
  if ((mode == 0x5000 || mode == 0x6000 || mode == 0x7000)) {
    int slot = (vDraw & 255) + 256;
    int shade = clamp(((vDraw >> 8) & 15) + panel, 0, 15);
    vec4 r = texelFetch(uSlots, ivec2(slot, 0), 0);
    // render_asm_sub_03bb80 hands modes 0x5000..0x7000 to bitmap3d_draw only while DAT_0009702c is set,
    // and bitmap3d_draw draws nothing for a slot without a frame (stopped, not running, celId < 1): in
    // both cases the polygon is not drawn. (An effect's animation can end before the effect retires -
    // the DEATH0 quad's 32 frames stop 0.4 s early; this used to fill it flat, an opaque billboard.)
    if (uTexturesOn == 0 || r.z <= 0.0) discard;
    else {
      bool affine = mode == 0x6000 || (mode == 0x5000 && uTextureAffine != 0) || mode == 0x7000;
      vec2 uv = affine ? vUvw.xy / vUvw.z : vUvPersp;
      vec2 t = mod(floor(uv), r.zw);   // wrapping: not established for out-of-range texels
      int texel = int(texelFetch(uAtlas, ivec2(r.xy + t), 0).r * 255.0 + 0.5);
      idx = shade < 15 ? int(texelFetch(uLuma, ivec2(texel, shade), 0).r * 255.0 + 0.5) : texel;
      if (idx == 0xff) discard;      // the span loops skip 0xff after the shade lookup
    }
  }
  if (uShadowOn != 0 && mode != 0x3000) {
    // a face's derivative normal points either way: face it towards the eye, as the side seen is the one lit
    vec3 n = dot(faceN, cameraPosition - vWorld) < 0.0 ? -faceN : faceN;
    if (inShadow(n, ivec2(gl_FragCoord.xy))) idx = int(texelFetch(uShadowTable, ivec2(idx & 255, 0), 0).r * 255.0 + 0.5);
  }
  outColor = outFor(idx);
}
`;

/** Outlines (mode 0x2000, wireframe): a line loop in one palette index, aDraw per vertex (< 0: not drawn). */
export const lineVertexShader = /* glsl */ `
in float aDraw;
flat out int vDraw;
void main() {
  vDraw = aDraw < 0.0 ? -1 : int(aDraw + 0.5);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

export const lineFragmentShader = /* glsl */ `
precision highp float;
precision highp int;
uniform sampler2D uPalette;
uniform int uIndexOut;
flat in int vDraw;
out vec4 outColor;
void main() {
  if (vDraw < 0) discard;
  int i = vDraw & 255;
  outColor = uIndexOut != 0 ? vec4(float(i) / 255.0, 0.0, 0.0, 1.0) : vec4(texelFetch(uPalette, ivec2(i, 0), 0).rgb, 1.0);
}
`;

/** The draw word for a polygon the clipper did not queue; the shader discards it. */
export const NOT_DRAWN = -1;

export interface IndexedUniforms {
  uPalette: { value: THREE.DataTexture };
  uLuma: { value: THREE.DataTexture };
  uAtlas: { value: THREE.DataTexture };
  uSlots: { value: THREE.DataTexture };
  uAtlasSize: { value: THREE.Vector2 };
  uTextureAffine: { value: number };
  uTexturesOn: { value: number };
  uShadedFill: { value: number };
  uSprites: { value: number };
  uViewport: { value: THREE.Vector2 };
  uMapFill: { value: number };
  uIndexOut: { value: number };
  /** the enhancements (render/enhance), on in the main view only */
  uPanels: { value: number };
  uShadowOn: { value: number };
  uShadowMap: { value: THREE.Texture | null };
  uShadowMatrix: { value: THREE.Matrix4 };
  uShadowDir: { value: THREE.Vector3 };
  uShadowTexel: { value: number };
  uShadowTable: { value: THREE.DataTexture };
  [k: string]: { value: unknown };
}

function dataTex(data: ArrayBufferView, w: number, h: number, format: THREE.PixelFormat, type: THREE.TextureDataType): THREE.DataTexture {
  const t = new THREE.DataTexture(data as never, w, h, format, type);
  t.magFilter = THREE.NearestFilter;
  t.minFilter = THREE.NearestFilter;
  t.generateMipmaps = false;
  t.needsUpdate = true;
  return t;
}

export function makeUniforms(): IndexedUniforms {
  return {
    uPalette: { value: dataTex(new Uint8Array(256 * 4), 256, 1, THREE.RGBAFormat, THREE.UnsignedByteType) },
    uLuma: { value: dataTex(new Uint8Array(256 * 16), 256, 16, THREE.RedFormat, THREE.UnsignedByteType) },
    uAtlas: { value: dataTex(new Uint8Array(4), 1, 1, THREE.RedFormat, THREE.UnsignedByteType) },
    uSlots: { value: dataTex(new Float32Array(512 * 4), 512, 1, THREE.RGBAFormat, THREE.FloatType) },
    uAtlasSize: { value: new THREE.Vector2(1, 1) },
    uTextureAffine: { value: 0 },
    uTexturesOn: { value: 1 },
    uShadedFill: { value: 1 },
    uSprites: { value: 1 },
    uViewport: { value: new THREE.Vector2(640, 480) },
    uMapFill: { value: 0 },
    uIndexOut: { value: 0 },
    uPanels: { value: 0 },
    uPanel: { value: 0 },
    uShadowOn: { value: 0 },
    uShadowMap: { value: null },
    uShadowMatrix: { value: new THREE.Matrix4() },
    uShadowDir: { value: new THREE.Vector3(0, 1, 0) },
    uShadowTexel: { value: 1 / 2048 },
    uShadowTable: { value: dataTex(new Uint8Array(256), 256, 1, THREE.RedFormat, THREE.UnsignedByteType) },
  };
}

/**
 * A uniform set sharing `shared`'s palette, LUMA, atlas and slot textures
 * (the same { value } holders, so uploads and rebinds reach both) with its
 * own per-view values.
 */
export function makeViewUniforms(shared: IndexedUniforms, indexOut: boolean, mapFill: boolean): IndexedUniforms {
  return {
    ...shared,
    uTextureAffine: { value: 0 },
    uShadedFill: { value: 1 },
    uSprites: { value: 1 },
    uViewport: { value: new THREE.Vector2(1, 1) },
    uMapFill: { value: mapFill ? 1 : 0 },
    uIndexOut: { value: indexOut ? 1 : 0 },
    // the views the game reads back are the original's: no enhancements
    uPanels: { value: 0 },
    uShadowOn: { value: 0 },
  };
}

/** Uploads a PAL resource (6-bit DAC values) as display colours. */
export function setPalette(u: IndexedUniforms, rgb: Uint8Array): void {
  const d = u.uPalette.value.image.data as Uint8Array;
  for (let i = 0; i < 256; i++) {
    d[i * 4] = dac6to8(rgb[i * 3]!);
    d[i * 4 + 1] = dac6to8(rgb[i * 3 + 1]!);
    d[i * 4 + 2] = dac6to8(rgb[i * 3 + 2]!);
    d[i * 4 + 3] = 255;
  }
  u.uPalette.value.needsUpdate = true;
}

export function setLuma(u: IndexedUniforms, rows: Uint8Array): void {
  (u.uLuma.value.image.data as Uint8Array).set(rows.subarray(0, 4096));
  u.uLuma.value.needsUpdate = true;
}

/** `panel`: the material draws mech parts (the armour-panel enhancement's uPanel); it shares every other uniform holder with `u`. */
export function makeIndexedMaterial(u: IndexedUniforms, opts: { behind?: boolean; panel?: boolean } = {}): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    glslVersion: THREE.GLSL3,
    uniforms: opts.panel ? { ...u, uPanel: { value: 1 } } : u,
    vertexShader,
    fragmentShader,
    side: THREE.DoubleSide, // the clipper's back-face test (polyDepthKey) is the original's; the GPU does not add its own
    depthWrite: !opts.behind,
    // a polygon's outline is drawn after its fill (poly_fill_dispatch); fills sit slightly behind so it shows
    polygonOffset: true,
    polygonOffsetFactor: 1,
    polygonOffsetUnits: 1,
  });
}

export function makeLineMaterial(u: IndexedUniforms): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    glslVersion: THREE.GLSL3,
    uniforms: u,
    vertexShader: lineVertexShader,
    fragmentShader: lineFragmentShader,
  });
}
