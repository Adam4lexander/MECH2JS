/**
 * TSK (keyword task, tag 47): a scheduled script attached to a piece of
 * scenery or to the global task list. project_chunk_exec's TSK branch
 * (0x4f757..0x4f805; the decompiled C loses the fourth call argument, so the
 * register reading is tools/dump_tasks.py's):
 *
 *   +0x08  short   task TYPE, 0..5 (anything else: system_error 0x33); it
 *                  indexes projectEntryHandlers for the callback
 *   +0x0a  dword   passed in EBX to task_create / world_record_task_create,
 *                  which store it as the task's PERIOD (node [2]):
 *                  task_list_run runs the task once that many ticks have
 *                  passed since its last run
 *   +0x0e  char[]  the ARGUMENT, handed to the callback in place (ECX =
 *                  chunk + 0xe). The branch finds the first ';', turns the
 *                  text before it into a number (clib_sub_0628fa - a
 *                  positional name; its callers use it as atoi, which the
 *                  decompilation has not established), mangles it
 *                  (project_mangle_id) and looks up a world record: found,
 *                  the task goes on that record's list; not found, or no ';'
 *                  at all, on the global missionTaskList. The handlers' INIT
 *                  paths find the same first ';' and sscanf what follows it
 *                  (task_object_rotate, 0x1b45x); a handler given no ';'
 *                  parses nothing.
 *
 * What each TYPE does with its parameters is its callback's business
 * (task_object_rotate, task_object_colour_cycle, task_object_drive,
 * anim_player_step, task_object_sound, task_object_track).
 */
import type { Chunk } from '../stream.ts';

export interface TskChunk {
  /** +0x08 projectEntryHandlers index, 0..5 */
  type: number;
  /** +0x0a the task's period in 182 Hz ticks; 0 runs it every frame */
  period: number;
  /** +0x0e the whole argument string, "<object id>;<parameters>" */
  argument: string;
  /** the text before the first ';' (the object id, still unparsed), or null when there is no ';' */
  objectIdText: string | null;
  /** the text after the first ';', which the handler parses; null when there is no ';' */
  parameters: string | null;
}

/**
 * Reads a TSK chunk: the three fields project_chunk_exec reads, and the split
 * at the first ';' that it and the handlers make.
 *
 * @portOnly the read half of project_chunk_exec's TSK branch
 */
export function decodeTsk(c: Chunk): TskChunk {
  const argument = c.str(0x0e, Math.max(0, c.bytes.length - 0x0e));
  const semi = argument.indexOf(';');
  return {
    type: c.i16(0x08),
    period: c.i32(0x0a),
    argument,
    objectIdText: semi < 0 ? null : argument.slice(0, semi),
    parameters: semi < 0 ? null : argument.slice(semi + 1),
  };
}
