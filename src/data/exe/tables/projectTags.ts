/**
 * The project-file vocabulary: 72 four-byte chunk tags at 0x9ed18 and, in a
 * parallel array at 0x9ebf4, the source keyword each compiled from.
 * project_tag_to_keyword pairs them by index.
 */
import type { ExeImage } from '../ExeImage.ts';

export const PROJECT_TAGS = 0x9ed18;
export const PROJECT_KEYWORDS = 0x9ebf4;
export const PROJECT_TAG_COUNT = 0x48;

export interface ProjectTag {
  id: number;
  /** the tag as it appears in the file, trailing NULs dropped ("BWD", "REPR") */
  tag: string;
  /** the tag as the little-endian dword the game compares */
  code: number;
  keyword: string;
}

/**
 * @mw2 project_tag_to_keyword 0x0004bad0
 * @fidelity exact
 */
export function readProjectTags(exe: ExeImage): ProjectTag[] {
  const out: ProjectTag[] = [];
  for (let i = 0; i < PROJECT_TAG_COUNT; i++) {
    const code = exe.u32(PROJECT_TAGS + i * 4);
    out.push({ id: i, tag: exe.latin1(PROJECT_TAGS + i * 4, 4).replace(/\0+$/, ''), code, keyword: exe.cstrAt(exe.u32(PROJECT_KEYWORDS + i * 4)) });
  }
  return out;
}
