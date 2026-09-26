// The nine AIT rule tables parsed by the port (rules placed by
// ai_rules_rebuild's arithmetic), with the EXE's name, condition, action and
// selection tables read through ExeImage, printed the way
// tools/dump_ai_rules.py prints them and compared with listing/ai_rules.txt.
import { beforeAll, describe, expect, it } from 'vitest';
import { i16 } from '../../src/core/int/cint.ts';
import { ExeImage } from '../../src/data/exe/ExeImage.ts';
import { ProjectFile } from '../../src/data/prj/ProjectFile.ts';
import {
  AI_RULE_ACTION_COUNT,
  AI_RULE_CONDITION_COUNT,
  AI_RULE_SELECT,
  parseAit,
  readAiRuleActions,
  readAiRuleConditions,
  readAiRuleSelect,
  readAiStateNames,
  readTargetDesignatorNames,
} from '../../src/data/formats/ait.ts';
import { gameSource, hasDecompiled, hasGameData, readListing } from '../support/env.ts';
import { expectSameLines, lines, padR } from '../support/listing.ts';
import { readFunctionNames } from '../support/formatHelpers.ts';

const SENTINEL: Record<number, string> = { 0x40: '@sec', 0x2a: '*pri', 0x25: '%0' };
const TARGET_SENTINEL: Record<number, string> = { 0x40: '@sec', 0x2a: '*pri', 0x25: '%found' };
const RANGE_CODE: Record<number, string> = { [-1]: 'aiRangeOp1', [-2]: 'aiRangeOp2', [-4]: 'aiRangeOp4', [-3]: 'none' };
const RANGE_CONDS = new Set([1, 2, 3, 7]);
const CODE_CONDS = new Set([2, 7]);
const hex4 = (v: number) => '0x' + (v & 0xffff).toString(16).padStart(4, '0');

describe.runIf(hasGameData && hasDecompiled)('AIT rule tables', () => {
  let prj: ProjectFile;
  let exe: ExeImage;
  beforeAll(async () => {
    prj = new ProjectFile(await gameSource().read('MW2.PRJ'));
    exe = ExeImage.fromExe(await gameSource().read('MW2.EXE'));
  });

  it('ai_rules.txt corresponds', () => {
    const funcs = readFunctionNames();
    const states = new Map<number, string>();
    for (const s of readAiStateNames(exe)) states.set(s.value, s.name);
    const designators = new Map<number, string>();
    for (const d of readTargetDesignatorNames(exe)) designators.set(d.value, d.name);
    const conds = readAiRuleConditions(exe).map((a) => (a ? (funcs.get(a) ?? null) : null));
    const acts = readAiRuleActions(exe).map((a) => (a ? (funcs.get(a) ?? null) : null));
    const sname = (v: number) => `${v} ${states.get(v) ?? '?'}`;

    function operand(v: number, cond?: number, isRange = false, isTarget = false): string {
      if (isTarget && TARGET_SENTINEL[v] !== undefined) return TARGET_SENTINEL[v]!;
      if (isRange && cond !== undefined && RANGE_CONDS.has(cond)) {
        if (v === -3 || (CODE_CONDS.has(cond) && RANGE_CODE[v] !== undefined)) return RANGE_CODE[v]!;
        if (v === 0) return 'engage';
        return `${v}m`;
      }
      if (SENTINEL[v] !== undefined) return SENTINEL[v]!;
      const d = designators.get(v & 0xffff);
      if (d !== undefined) return d;
      if (v === 0) return '0';
      return hex4(v);
    }

    const L: string[] = [];
    let bad = 0;
    let nrules = 0;
    const named: Array<[number, string]> = [];
    const t = prj.type('AIT')!;
    for (let id = 0; id < t.entries.length; id++) {
      const name = prj.resourceName('AIT', id);
      if (!name) continue;
      named.push([id, name]);
      const c = prj.readResource('AIT', id)!;
      const a = parseAit(c);
      L.push(`AIT ${id} ${name}  (${c.length} bytes, ${a.stateCount} states)`);
      for (const s of a.states) {
        L.push(`  in state ${sname(s.aiState)}:`);
        for (const r of s.rules) {
          const cond = i16(r.condition);
          if (cond === 0) {
            L.push('    (condition 0 - the walk stops here)');
            break;
          }
          nrules++;
          const ok = cond > 0 && cond < AI_RULE_CONDITION_COUNT && !!conds[cond] && r.action < AI_RULE_ACTION_COUNT && !!acts[r.action];
          if (!ok) bad++;
          const cname = cond >= 0 && cond < AI_RULE_CONDITION_COUNT && conds[cond] ? conds[cond]! : `cond${cond}`;
          const aname = r.action < AI_RULE_ACTION_COUNT ? (acts[r.action] ?? 'None') : `act${r.action}`;
          L.push(
            `    if ${padR(cname, 28)}(${operand(r.operand1)}, ${operand(r.operand2, cond, true)}) -> ${padR(aname, 24)} next ${padR(sname(r.nextState), 12)} target ${operand(r.targetOperand, undefined, false, true)}${ok ? '' : '   <- OUT OF RANGE'}`,
          );
        }
        if (s.truncated) {
          L.push('    TRUNCATED');
          bad++;
        }
      }
      if (a.trailing) L.push(`  (${a.trailing} trailing bytes after the last counted rule: never reached)`);
      L.push('');
    }

    L.push('SELECTION - aiRuleTables slot for [ruleIndex] as (leader, follower), by gamepieceClass');
    for (const [cls, at] of AI_RULE_SELECT) {
      const entries = readAiRuleSelect(exe, at);
      for (const pair of entries) for (const v of pair) if (!(v >= 0 && v <= 9)) bad++;
      const extra = cls === 5 ? ' (and gamepieceClass 8)' : '';
      L.push(`  gamepieceClass ${cls}${extra}: ${entries.map(([x, y]) => `${x}/${y}`).join(' ')}`);
    }
    L.push('');
    L.push('slot -> AIT: ' + named.map(([id, n]) => `${id} ${n}`).join(', '));

    const head = [
      `MW2 AI rule tables - MW2.PRJ, ${named.length} AIT resources, ${nrules} counted rules, ${bad} cross-check failures`,
      'conditions: ' + conds.flatMap((n, i) => (n ? [`${i} ${n}`] : [])).join(', '),
      'actions: ' + acts.flatMap((n, i) => (n ? [`${i} ${n}`] : [])).join(', '),
      'operands: @sec targetSecondary, *pri targetPrimary, %0 zero (in a target, %found = the handle the condition returned); ranges in metres, engage = own engage range, aiRangeOpN = per-mech GPS range',
      '',
      'designators (targetDesignatorNames, resolved by resolve_target_designator): ' +
        [...designators.entries()]
          .sort((x, y) => x[0] - y[0])
          .map(([v, n]) => `${n} ${hex4(v)}`)
          .join(', '),
    ];
    L.unshift(...head);
    expect(bad).toBe(0);
    expectSameLines('ai_rules.txt', lines(readListing('ai_rules.txt')), L);
  });
});
