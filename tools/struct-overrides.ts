/**
 * How the generated live classes (src/generated/classes.gen.ts) deviate from a
 * mechanical reading of mw2_types.h. Every entry is a representation choice,
 * not a change of meaning:
 *
 *  - POINTERS the header declares as void * but whose target is established
 *    (by the field's own evidence note) get their real type.
 *  - VARIABLE-LENGTH TRAILING ARRAYS (declared [1] in C, sized at allocation)
 *    become JS arrays.
 *  - PORT-ONLY FIELDS stand in for C layouts that are byte offsets into a
 *    shared allocation - e.g. MeshPolygon.indexOffset, which points at index
 *    bytes stored after the polygon table, becomes MeshPolygon.indices.
 *
 * Code pointers (hooks, method tables) are typed `CodePtr` - an original code
 * address resolved through engine/codeRegistry.ts.
 */

export const POINTER_TYPES: Record<string, string> = {
  'SceneNode.parent': 'SceneNode',
  'SceneNode.firstChild': 'SceneNode',
  'SceneNode.nextSibling': 'SceneNode',
  'MeshBlock.next': 'MeshBlock',
  // six ints (min/max per axis) for class 0, a ground quadtree for class 5 - object_free_bounds
  'WorldObject.bounds': 'Int32Array | QuadtreeNode',
  'QuadtreeNode.children': 'QuadtreeNode',
  'MechLoadout.torsoNode': 'SceneNode',
  'MechLoadout.weaponAimNode': 'SceneNode',
  'MechLoadout.sectionNodes': 'SceneNode',
  'Destructible.onRelease': 'CodeFn',
  'GamepieceClass.createLoadout': 'CodePtr',
  'GamepieceClass.hooks': 'CodePtr',
  'MechEntity.hooks': 'CodeFn',
  // AiRule ** - the mech's six-slot record at 0xf44e8 (mech_ai_setup), a null-terminated rule list
  'MechEntity.ruleSet': '(AiRule | null)[]',
  'HudWidget.methods': 'CodeFn',
  'HudWidget.hooks': 'CodeFn',
  // the two halves of the channel's malloc(0x4000), and its read pointer into the SNDS data
  'SoundMixer.halfBuffers': 'SampleBuffer',
  'SoundMixer.data': 'SampleBuffer',
  // a caller's malloc'd sound (the mission-result lines)
  'VoiceLine.buffer': 'Uint8Array',
  'VoiceLine.bodyBuffer': 'Uint8Array',
};

/** Fields declared [1] in C whose real length is set at allocation. */
export const VARIABLE_ARRAYS = new Set<string>(['MeshBlock.vertices', 'QuadtreeNode.polys', 'ProjectHeader.types']);

/** Port-only fields appended to a class: name -> [TS type, initialiser, doc]. */
export const EXTRA_FIELDS: Record<string, Array<[string, string, string, string]>> = {
  MeshBlock: [['polygons', 'MeshPolygon[]', '[]', 'the polygon table that follows the vertices at polygonOffset in the C allocation']],
  MeshPolygon: [['indices', 'number[]', '[]', 'the vertex-index bytes the C record reaches through indexOffset']],
};

/**
 * Consecutive int fields the C treats as ONE block - e.g. SceneNode's
 * localMatrix[9] + localX/Y/Z, which transform_compose and transform_copy
 * address as a single 12-int transform. The class gets a backing Int32Array
 * under `block`; array fields become subarray views of it and scalar fields
 * become accessors, so both `node.localX` and `node.localBlock` see the same
 * ints (and stores wrap to int32 as in C).
 */
export const BLOCKS: Record<string, Array<{ block: string; fields: string[] }>> = {
  SceneNode: [
    { block: 'localBlock', fields: ['localMatrix', 'localX', 'localY', 'localZ'] },
    { block: 'worldBlock', fields: ['worldMatrix', 'worldPos'] },
  ],
};
