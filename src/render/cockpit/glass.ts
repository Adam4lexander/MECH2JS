/**
 * Each chassis's canopy: the glass of its exterior model - what other pilots
 * see - as it stands about the cockpit eye. Generated (the port's scratch
 * extraction; test/sim/cockpits.test.ts measures it again from the game):
 * the triangles drawn in mode 0x4000 on ramp 0xe - on every chassis only
 * the glass is drawn so, in that ramp's blue - of the player mech's
 * parts rebuilt at detail level 0, through each part's node into pilot space
 * (metres, the eye at the origin, -z ahead).
 *
 * (Correction: the first cut measured the glass of the original's cockpit
 * shells, the XX5_HEAD meshes the cockpit view draws. Those were made apart
 * from the exterior and often disagree with it: the Timber Wolf's shell
 * opens past 90 degrees either side, where its exterior has a bubble canopy
 * over the nose.)
 *
 * The game's eye is only roughly placed against the exterior: under some
 * canopies, on or beside others. `fit` seats those (canopy.ts): `grow`
 * enlarges the glass about its centre, `normal` lifts it that far along its
 * area-weighted normal, `move` translates it, `bridge` adds the port's own
 * glass, `outlineOnly` frames the outline alone. `note` says why.
 *
 * @portOnly
 */
export interface CanopySource {
  /** the exterior's glass triangles, pilot space, metres: nine numbers each */
  tris: number[];
  fit?: { grow?: number; normal?: number; move?: [number, number, number]; bridge?: number[]; outlineOnly?: boolean };
  note?: string;
}

export const CANOPY: Record<string, CanopySource> = {
  BM: {
    // bttlmstr
    tris: [0.67, 1.14, 0.87, -0.09, 0.85, -0.49, -0.09, 1.81, 1.18, -0.09, 0.85, -0.49, 0.56, -0.37, -0.6, -0.09, -0.77, -1.02, -0.09, 1.81, 1.18, -0.09, 0.85, -0.49, -0.85, 1.14, 0.87, -0.09, 0.85, -0.49, -0.09, -0.77, -1.02, -0.75, -0.37, -0.6, 0.56, -0.37, -0.6, -0.09, 0.85, -0.49, 0.67, 1.14, 0.87, 0.92, 0.15, 0.89, 0.56, -0.37, -0.6, 0.67, 1.14, 0.87, -0.09, 0.85, -0.49, -0.75, -0.37, -0.6, -0.85, 1.14, 0.87, -0.75, -0.37, -0.6, -1.1, 0.15, 0.89, -0.85, 1.14, 0.87],
  },
  DW: {
    // direwolf
    tris: [1.05, 0.67, 1.36, 0.4, 0.2, -0.25, -0.35, 0.2, -0.25, 1.05, 0.67, 1.36, -0.35, 0.2, -0.25, -1.0, 0.67, 1.36, 1.46, 0.09, 1.7, 0.4, 0.2, -0.25, 1.05, 0.67, 1.36, 1.46, 0.09, 1.7, 0.7, -0.24, -0.84, 0.4, 0.2, -0.25, -1.0, 0.67, 1.36, -0.65, -0.24, -0.84, -1.41, 0.09, 1.7, -1.0, 0.67, 1.36, -0.35, 0.2, -0.25, -0.65, -0.24, -0.84, -0.65, -0.24, -0.84, -0.35, 0.2, -0.25, 0.4, 0.2, -0.25, -0.65, -0.24, -0.84, 0.4, 0.2, -0.25, 0.7, -0.24, -0.84, -0.35, -0.53, -0.92, -0.65, -0.24, -0.84, 0.7, -0.24, -0.84, -0.35, -0.53, -0.92, 0.7, -0.24, -0.84, 0.4, -0.53, -0.92],
  },
  EL: {
    // elementl
    tris: [0.0, -0.04, -0.34, -0.25, 0.1, -0.16, -0.21, 0.17, -0.13, 0.0, -0.04, -0.34, -0.21, 0.17, -0.13, 0.0, 0.13, -0.27, 0.25, 0.1, -0.16, 0.0, -0.04, -0.34, 0.0, 0.13, -0.27, 0.25, 0.1, -0.16, 0.0, 0.13, -0.27, 0.21, 0.17, -0.13],
    fit: { grow: 2.2, outlineOnly: true },
    note: "the helmet's visor is a chevron 50 cm across, a +/-13 degree view from the eye: grown 2.2 times about its centre, and framed round its outline only (its facets' creases would cross the view)",
  },
  FM: {
    // firemoth
    tris: [-0.43, -1.0, -1.59, -0.56, -0.06, -1.36, 0.52, -0.06, -1.36, -0.43, -1.0, -1.59, 0.52, -0.06, -1.36, 0.38, -1.0, -1.59, -0.56, -0.06, -1.36, -0.92, 0.6, -0.22, 0.88, 0.6, -0.22, -0.56, -0.06, -1.36, 0.88, 0.6, -0.22, 0.52, -0.06, -1.36],
  },
  GG: {
    // gargoyle
    tris: [-0.74, 0.17, -0.46, -0.22, 0.17, -0.46, -0.25, -0.12, -0.43, -0.74, 0.17, -0.46, -0.25, -0.12, -0.43, -0.54, -0.12, -0.43, 0.21, -0.12, -0.43, 0.19, 0.17, -0.46, 0.71, 0.17, -0.46, 0.21, -0.12, -0.43, 0.71, 0.17, -0.46, 0.52, -0.12, -0.43],
    fit: { bridge: [-0.25, -0.12, -0.43, 0.21, -0.12, -0.43, 0.19, 0.17, -0.46, -0.25, -0.12, -0.43, 0.19, 0.17, -0.46, -0.22, 0.17, -0.46] },
    note: "two eye slits either side of a nose ridge that stands where the reticle is: the port bridges them (bridge) into one visor slit",
  },
  HB: {
    // hellbrgr
    tris: [0.24, 0.28, 0.57, 0.58, -0.43, -0.82, -0.57, -0.43, -0.82, 0.24, 0.28, 0.57, -0.57, -0.43, -0.82, -0.25, 0.28, 0.57],
    fit: { move: [0, 0.15, -0.35] },
    note: "the windshield's plane passes through the game's eye (1 cm off): moved up 15 cm and forward 35 cm, so the pilot sits 28 cm under it and sees down to 13 degrees",
  },
  JN: {
    // jenner
    tris: [0.56, -0.18, -0.81, -0.56, -0.18, -0.81, -0.38, 0.25, -0.23, 0.56, -0.18, -0.81, -0.38, 0.25, -0.23, 0.37, 0.25, -0.23, -0.56, -0.18, -0.81, -1.48, -0.18, -0.15, -0.98, 0.25, 0.21, -0.56, -0.18, -0.81, -0.98, 0.25, 0.21, -0.38, 0.25, -0.23, 1.47, -0.18, -0.15, 0.56, -0.18, -0.81, 0.37, 0.25, -0.23, 1.47, -0.18, -0.15, 0.37, 0.25, -0.23, 0.98, 0.25, 0.21],
  },
  KF: {
    // kitfox
    tris: [-1.07, -0.36, -0.37, -0.85, 0.39, -0.09, 0.82, 0.39, -0.09, -1.07, -0.36, -0.37, 0.82, 0.39, -0.09, 1.05, -0.36, -0.37, 1.05, -0.36, -0.37, 0.82, 0.39, -0.09, 1.05, 0.51, 1.17, -0.85, 0.39, -0.09, -1.07, -0.1, 1.39, -1.07, 0.51, 1.17, -0.85, 0.39, -0.09, -1.07, -0.36, -0.37, -1.07, -0.1, 1.39],
    fit: { move: [0, 0, -0.35] },
    note: "the canopy runs back over the eye and its front is 24 cm ahead: moved 35 cm forward",
  },
  MD: {
    // maddog
    tris: [0.59, 0.17, 0.0, 0.43, -0.49, -1.81, -0.46, -0.49, -1.81, 0.59, 0.17, 0.0, -0.46, -0.49, -1.81, -0.62, 0.17, 0.0],
    fit: { normal: 0.2 },
    note: "the eye sits 16 cm under the sloped panel, 47 cm from it straight ahead: lifted 20 cm",
  },
  MR: {
    // marauder
    tris: [0.36, -0.3, -1.63, -0.36, -0.3, -1.63, -0.72, 0.0, -1.75, 0.36, -0.3, -1.63, -0.72, 0.0, -1.75, -0.36, 0.3, -1.87, 0.36, -0.3, -1.63, -0.36, 0.3, -1.87, 0.36, 0.3, -1.87, 0.36, -0.3, -1.63, 0.36, 0.3, -1.87, 0.72, 0.0, -1.75],
    fit: { move: [0, 0, 1.0] },
    note: "the slit is 1.75 m ahead of the eye, a +/-12 degree view: brought 1 m nearer",
  },
  NV: {
    // nova
    tris: [-0.65, -0.7, -1.8, -0.75, 0.41, 0.94, -0.43, 0.28, -0.79, 0.41, 0.28, -0.79, 0.73, 0.41, 0.94, 0.63, -0.7, -1.8, -0.43, 0.28, -0.79, 0.41, 0.28, -0.79, 0.63, -0.7, -1.8, -0.43, 0.28, -0.79, 0.63, -0.7, -1.8, -0.65, -0.7, -1.8, -0.75, 0.41, 0.94, 0.73, 0.41, 0.94, 0.41, 0.28, -0.79, -0.75, 0.41, 0.94, 0.41, 0.28, -0.79, -0.43, 0.28, -0.79],
  },
  RF: {
    // rifleman
    tris: [-0.44, -0.41, -0.75, -0.44, 0.61, -0.75, 0.54, 0.61, -0.75, -0.44, -0.41, -0.75, 0.54, 0.61, -0.75, 0.54, -0.41, -0.75],
  },
  SC: {
    // strmcrow
    tris: [0.44, 0.31, 0.11, 0.38, -0.66, -1.03, -0.36, -0.66, -1.03, 0.44, 0.31, 0.11, -0.36, -0.66, -1.03, -0.42, 0.31, 0.11],
    fit: { normal: 0.2 },
    note: "the eye sits 16 cm under the panel, 25 cm from it straight ahead: lifted 20 cm",
  },
  SU: {
    // summoner
    tris: [0.44, 0.29, -0.04, 0.52, 0.07, -0.24, -0.31, 0.29, -0.03, -0.39, 0.07, -0.23, -0.74, 0.07, 0.12, -0.54, 0.29, 0.2, -0.39, 0.07, -0.23, -0.54, 0.29, 0.2, -0.31, 0.29, -0.03, -0.31, 0.29, -0.03, 0.52, 0.07, -0.24, -0.39, 0.07, -0.23, 0.88, 0.07, 0.11, 0.52, 0.07, -0.24, 0.44, 0.29, -0.04, 0.88, 0.07, 0.11, 0.44, 0.29, -0.04, 0.68, 0.29, 0.2],
    fit: { move: [0, -0.18, -0.2] },
    note: "the band runs along the top of the head above the eye: lowered 18 cm and moved 20 cm forward, a visor at eye level",
  },
  TR: {
    // tarantul
    tris: [1.67, -0.58, -1.46, 1.33, 0.25, -0.03, 1.66, -0.08, 2.34, -1.38, 0.25, -0.04, -1.71, -0.58, -1.48, -1.73, -0.08, 2.32, -1.38, 0.25, -0.04, 1.33, 0.25, -0.03, 1.67, -0.58, -1.46, -1.38, 0.25, -0.04, 1.67, -0.58, -1.46, -1.71, -0.58, -1.48],
    fit: { move: [0, 0.3, -0.3] },
    note: "a long flat sheet over the top of the body, the eye on its surface: raised 30 cm and moved 30 cm forward, a low wide windscreen over the body",
  },
  TW: {
    // timbrwlf
    tris: [-0.57, 0.29, -1.05, -0.02, 0.52, -1.05, -0.02, -0.56, -2.16, -0.57, 0.29, -1.05, -0.02, -0.56, -2.16, -0.3, -0.68, -2.16, -0.77, 0.64, 0.42, -0.02, 0.95, 0.42, -0.02, 0.52, -1.05, -0.77, 0.64, 0.42, -0.02, 0.52, -1.05, -0.57, 0.29, -1.05, -0.3, -0.68, -2.16, -0.91, -0.31, -1.05, -0.57, 0.29, -1.05, -0.02, 0.52, -1.05, 0.52, 0.29, -1.05, 0.25, -0.68, -2.16, -0.02, 0.52, -1.05, 0.25, -0.68, -2.16, -0.02, -0.56, -2.16, -0.02, 0.95, 0.42, 0.72, 0.64, 0.42, 0.52, 0.29, -1.05, -0.02, 0.95, 0.42, 0.52, 0.29, -1.05, -0.02, 0.52, -1.05, 0.52, 0.29, -1.05, 0.86, -0.31, -1.05, 0.25, -0.68, -2.16, 0.72, 0.64, 0.42, 0.86, -0.31, -1.05, 0.52, 0.29, -1.05, -0.57, 0.29, -1.05, -0.91, -0.31, -1.05, -0.77, 0.64, 0.42],
  },
  WH: {
    // warhammr
    tris: [0.96, -0.4, -1.35, -0.9, -0.4, -1.35, -0.7, 0.22, 0.08, 0.96, -0.4, -1.35, -0.7, 0.22, 0.08, 0.75, 0.22, 0.08],
    fit: { normal: 0.18 },
    note: "the eye sits 17 cm under the panel: lifted 18 cm",
  },
  WK: {
    // warhawk
    tris: [-0.94, -0.28, 0.54, -0.94, 0.49, -1.4, -0.56, -0.28, -0.2, -0.94, -0.28, 0.54, -1.55, 0.49, 0.54, -0.94, 0.49, -1.4, -0.56, -0.28, -0.2, -0.94, 0.49, -1.4, 0.94, 0.49, -1.4, -0.56, -0.28, -0.2, 0.94, 0.49, -1.4, 0.56, -0.28, -0.2, 0.94, -0.28, 0.54, 0.94, 0.49, -1.4, 1.55, 0.49, 0.54, 0.94, -0.28, 0.54, 0.56, -0.28, -0.2, 0.94, 0.49, -1.4],
  },
};
