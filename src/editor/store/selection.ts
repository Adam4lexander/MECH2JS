/**
 * What the editor has selected: any engine object (a SceneNode, WorldObject,
 * MechEntity, table row...) with a label and the struct name its schema is
 * read by.
 *
 * @portOnly
 */
import { editorStore } from './store.ts';

export interface Selection {
  label: string;
  /** the generated struct name for the inspector's schema, or null for a plain object */
  struct: string | null;
  target: object;
}

let current: Selection | null = null;

export function selected(): Selection | null {
  return current;
}

export function select(s: Selection | null): void {
  current = s;
  editorStore.bump();
}
