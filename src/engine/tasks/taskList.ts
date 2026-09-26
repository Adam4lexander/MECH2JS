/**
 * Scheduled tasks: singly linked lists of 0x18-byte nodes, each a callback
 * run every `period` ticks. The callback protocol, from its four senders:
 *   0 INIT  (task_create)   - returning 0 aborts the task
 *   1 TICK  (task_list_run) - returning 0 removes the task
 *   2 DESTROY (task_remove)
 *  -1 REBUILT (task_list_notify_rebuilt) - the task's object was replaced
 * Called as callback(message, arg, simTick, period). While a callback runs,
 * currentTask is its node, which is how it reaches its own `data`.
 */
import type { CodeFn } from '../codePtr.ts';
import { clock } from '../clock.ts';
import { registerGlobals } from '../globals.ts';

/** The 0x18-byte task node (no struct in mw2_types.h; layout from task_list_run). */
export class TaskNode {
  /** [0] the callback, also the liveness test */
  callback: CodeFn | null = null;
  /** [1] the task's own data (freed by task_remove) */
  data: unknown = null;
  /** [2] ticks between runs */
  period = 0;
  /** [3] simTick of the last run */
  lastRun = 0;
  /** [4] simTick the task is next due */
  due = 0;
  /** [5] the next node */
  next: TaskNode | null = null;
}

/** A list head (int ** in C). */
export interface TaskList {
  head: TaskNode | null;
}

export const taskGlobals = registerGlobals(
  'tasks',
  {
    /** 0x958a0: the node whose callback is running */
    currentTask: null as TaskNode | null,
    /** 0x95868: the mission's global task list (TSK chunks with no world-record target) */
    missionTaskList: { head: null } as TaskList,
  },
  () => {
    taskGlobals.currentTask = null;
    taskGlobals.missionTaskList = { head: null };
  },
);

/**
 * @mw2 task_create 0x00017310
 * @fidelity exact
 * @divergence the node is a JS object rather than static_malloc(0x18) from the TLIS arena
 */
export function taskCreate(list: TaskList, callback: CodeFn | null, period: number, arg: unknown): TaskNode | null {
  const t = new TaskNode();
  t.data = null;
  t.period = period | 0;
  t.callback = callback;
  t.lastRun = clock.simTick;
  t.due = clock.simTick;
  taskGlobals.currentTask = t;
  t.next = list.head;
  list.head = t;
  if (callback && callback(0, arg, clock.simTick, period) === 0) {
    taskRemove(list, taskGlobals.currentTask);
    return null;
  }
  return t;
}

/**
 * @mw2 task_remove 0x000173a0
 * @fidelity exact
 */
export function taskRemove(list: TaskList, task: TaskNode | null): void {
  if (!task) return;
  if (task === list.head) list.head = task.next;
  else {
    let p = list.head;
    while (p && p.next !== task) p = p.next;
    if (p) p.next = task.next;
  }
  taskGlobals.currentTask = task;
  task.callback?.(2, 0, clock.simTick, task.period);
  task.data = null;
}

/**
 * @mw2 task_list_clear 0x00017400
 * @fidelity exact
 */
export function taskListClear(list: TaskList): void {
  let t = list.head;
  while (t) {
    taskRemove(list, t);
    t = t.next;
  }
}

/**
 * @mw2 task_list_notify_rebuilt 0x00017450
 * @fidelity exact
 */
export function taskListNotifyRebuilt(list: TaskList): void {
  for (let t = list.head; t; t = t.next) t.callback?.(-1, 0, clock.simTick, t.period);
}

/**
 * Runs every due task, reschedules it by its period, drops those returning 0.
 *
 * @mw2 task_list_run 0x000174a0
 * @fidelity exact
 */
export function taskListRun(list: TaskList): void {
  let t = list.head;
  for (;;) {
    taskGlobals.currentTask = t;
    if (!t) break;
    if (t.callback && t.due <= clock.simTick) {
      t.due = (clock.simTick + t.period) | 0;
      const r = t.callback(1, 0, clock.simTick, t.period);
      if (r === 0) taskRemove(list, taskGlobals.currentTask);
      else taskGlobals.currentTask!.lastRun = clock.simTick;
    }
    t = taskGlobals.currentTask!.next;
  }
}
