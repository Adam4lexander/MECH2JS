// The rest of the static tables MW2.EXE carries, read by the port and printed
// the way the decompilation's dump tools print them, compared line by line.
// Where a listing also carries prose the dump tool writes by hand (notes,
// the users it collected from the exported source), that prose is reproduced
// here as the tool's own text - the port's reading is the data between it.
import fs from 'node:fs';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { ExeImage } from '../../src/data/exe/ExeImage.ts';
import { ProjectFile } from '../../src/data/prj/ProjectFile.ts';
import { IniFile, systemErrorText } from '../../src/data/config/ini.ts';
import { AI_BEHAVIOUR_NAME_COUNT, BEHAVIOUR_SETS, readBehaviourNames, readBehaviourTransitions } from '../../src/data/exe/tables/behaviours.ts';
import { EFFECT_COUNT, EFFECT_FIRST_MOUNT_ROW, EFFECT_STRIDE, EFFECT_TABLE, EFFECT_VARIANTS, readEffectTypes } from '../../src/data/exe/tables/effects.ts';
import { readWeaponTypes } from '../../src/data/exe/tables/weaponTypes.ts';
import { COMMAND_COUNT, COMMAND_NAMES, readCommandNames } from '../../src/data/exe/tables/commands.ts';
import { CHEAT_CODE_ADDRESSES, CHEAT_XOR, cheatMatch, readCheatCodes } from '../../src/data/exe/tables/cheats.ts';
import { readSystemErrorTable, systemErrorSeverity, type SystemErrorSeverity } from '../../src/data/exe/tables/systemErrors.ts';
import { readSoundCues, readSoundCueVariants, SOUND_CUE_VARIANTS, SOUND_CUES } from '../../src/data/exe/tables/soundCues.ts';
import { CONTROL_SLOTS, MENU_TABLES, readMenuCallbackTables, readMenuModule, type Menu, type MenuTableKind } from '../../src/data/exe/tables/menus.ts';
import { GAMEPIECE_CLASS_COUNT, readGamepieceClasses } from '../../src/data/exe/tables/gamepieceClasses.ts';
import { channelOffset, CONTROL_CHANNEL_COUNT, inputTorsoTilt, readControlChannels } from '../../src/data/exe/tables/controlChannels.ts';
import { schemaOf } from '../../src/engine/schema/read.ts';
import { buildPath, gameSource, hasDecompiled, hasGameData, listingPath, MW2_DECOMPILED, readListing } from '../support/env.ts';
import { expectSameLines, lines, padL, padR, pyHex } from '../support/listing.ts';

const hex2 = (v: number) => v.toString(16).padStart(2, '0');
const hex6 = (v: number) => v.toString(16).padStart(6, '0');
const hex8 = (v: number) => v.toString(16).padStart(8, '0');

/** Python's round(): half to even. */
function pyRound(x: number): number {
  const f = Math.floor(x);
  const d = x - f;
  if (d > 0.5) return f + 1;
  if (d < 0.5) return f;
  return f % 2 === 0 ? f : f + 1;
}

/** Python's repr() of a str, for the characters a Latin-1 string can hold. */
function pyStrRepr(s: string): string {
  const q = s.includes("'") && !s.includes('"') ? '"' : "'";
  let out = q;
  for (const ch of s) {
    const c = ch.charCodeAt(0);
    if (ch === '\\') out += '\\\\';
    else if (ch === q) out += '\\' + q;
    else if (ch === '\t') out += '\\t';
    else if (ch === '\n') out += '\\n';
    else if (ch === '\r') out += '\\r';
    else if (c < 0x20 || (c >= 0x7f && c <= 0xa0) || c === 0xad) out += '\\x' + hex2(c);
    else out += ch;
  }
  return out + q;
}

/** address -> name from functions.csv. */
function functionNames(): Map<number, string> {
  const m = new Map<number, string>();
  const rows = lines(fs.readFileSync(listingPath('functions.csv'), 'utf8'));
  const head = rows[0]!.split(',');
  const ia = head.indexOf('address');
  const iname = head.indexOf('name');
  for (const r of rows.slice(1)) {
    const c = r.split(',');
    m.set(parseInt(c[ia]!, 16), c[iname]!);
  }
  return m;
}

/** A Python-style chunk walk (tools/dump_objectives.py chunks), as dump_effects counts XPLO with it. */
function* pyChunks(p: Uint8Array): Generator<[number, string, number]> {
  const dv = new DataView(p.buffer, p.byteOffset, p.byteLength);
  let pos = 0;
  while (pos + 8 <= p.length) {
    const tag = String.fromCharCode(p[pos]!, p[pos + 1]!, p[pos + 2]!, p[pos + 3]!);
    const size = tag === 'BWD\0' ? 0xc : dv.getUint32(pos + 4, true);
    if (size < 8 || pos + size > p.length) return;
    yield [pos, tag, size];
    pos += size;
  }
}

describe.runIf(hasGameData && hasDecompiled)('EXE tables 2', () => {
  let exe: ExeImage;
  let prj: ProjectFile;
  /** SNDS id -> name, from the record headers (dump_project_index.read_names) */
  let sounds: Map<number, string>;
  beforeAll(async () => {
    exe = ExeImage.fromExe(await gameSource().read('MW2.EXE'));
    prj = new ProjectFile(await gameSource().read('MW2.PRJ'));
    sounds = new Map(prj.list('SNDS').filter((r) => r.name).map((r) => [r.id, r.name]));
  });

  describe('behaviours', () => {
    it('behaviours.txt (tools/dump_behaviours.py)', () => {
      const names = new Map<number, string>();
      const recs = readBehaviourNames(exe);
      expect(recs).toHaveLength(AI_BEHAVIOUR_NAME_COUNT);
      for (const r of recs) if (r.name.trim()) names.set(r.value, r.name.trim());
      const nm = (v: number) => `${v} ${names.get(v) ?? '?'}`;
      const WHO: Record<string, string> = {
        behaviourTransitionsMech: 'gamepieceClass 1, mechs',
        behaviourTransitionsElemental: 'used instead of the mech set when loadout->tons == 1 (ELE00SPC, ELE00STD)',
        behaviourTransitionsHelicopter: 'gamepieceClass 5',
        behaviourTransitionsTransport: 'gamepieceClass 8',
        behaviourTransitionsIdle: 'gamepieceClass 2, 3, 4, 6 and 7',
      };
      const out = [
        'MW2 AI behaviour transitions - from MW2.EXE (image.bin), as ai_choose_behaviour reads them',
        'behaviours: ' + [...names.entries()].sort((a, b) => a[0] - b[0]).map(([v, n]) => `${v} ${n}`).join(', '),
        'a row: after <from>, the next behaviour is a uniform draw from its choices, so',
        'duplicates weight it; the percentages are that draw',
        '',
      ];
      for (const set of BEHAVIOUR_SETS) {
        out.push(`${set.label} @ ${hex6(set.rows)}  (${WHO[set.label]})`);
        const starts = set.rowCount - set.nonStartRows;
        out.push(`  ${set.rowCount} rows; first behaviour = the 'from' of a random row among the first ${starts}`);
        readBehaviourTransitions(exe, set).forEach((r, i) => {
          const n = r.choiceCount;
          if (n <= 0) {
            out.push(`  row ${padL(i, 2)}  from ${padR(nm(r.from), 12)}  (empty, choiceCount ${n})`);
            return;
          }
          // Counter.most_common: by count, ties in first-seen order
          const tally = new Map<number, number>();
          for (const c of r.choices.slice(0, n)) tally.set(c, (tally.get(c) ?? 0) + 1);
          const dist = [...tally.entries()]
            .map((e, k) => [...e, k] as const)
            .sort((a, b) => b[1] - a[1] || a[2] - b[2])
            .map(([v, c]) => `${nm(v)} ${pyRound((100 * c) / n)}%`)
            .join(', ');
          out.push(`  row ${padL(i, 2)}${i < starts ? '*' : ' '} from ${padR(nm(r.from), 12)} -> ${dist}`);
        });
        out.push('');
      }
      out.push("* = a row whose 'from' can be the first behaviour");
      // The rest of the listing is the tool's prose about ai_choose_behaviour.
      const want = lines(readListing('behaviours.txt'));
      expectSameLines('behaviours.txt', want.slice(0, out.length), out);
    });
  });

  describe('effects', () => {
    it('effects.txt (tools/dump_effects.py)', () => {
      const FLAGS = new Map<number, string>([
        [0x100, 'hit a mech'],
        [0x200, 'hit a gamething, or an object of type bit 0x400'],
        [0x400, 'hit the ground or plain scenery'],
        [0x1000, 'a Gauss round (projectile id 7) hit a mech'],
        [0x2000, "the player's mech hit in the head or a torso"],
        [0x4000, "the player's mech hit - NOT a variant bit: it only zeroes the impact sound's last sound_play_at argument (meaning not established)"],
      ]);
      const NOTES = new Map<number, string>([
        [3, 'also spawns code 0x10b'],
        [4, 'also spawns code 0x10b'],
        [5, '0x100 variant is placed at the SECOND position argument'],
        [0xb, 'DEBRIS: effect_spawn_fragments throws 8 / 4 with 0x100 or 0x200 / 16 with 0x1000 pre-built slots'],
      ]);
      // The dump tool's list of literal codes in the exported source.
      const CODE_USERS: [number, string][] = [
        [0x03, 'mech_death_update (effect_spawn_at)'],
        [0x07, 'mech_damage_slot, destructible_destroy (effect_spawn_at)'],
        [0x16, 'nuke_detonate (effect_spawn)'],
        [0x19, 'mech_jump_jet_effects, both legs (effect_spawn_on_mount)'],
        [0x03, 'gamething_apply_damage on a kill - 0x0d instead for family 0xb0'],
        [0x0d, 'gamething_apply_damage on a kill of a family-0xb0 thing'],
        [0x20b, 'gamething_apply_damage on a kill, after the explosion - four fragments'],
        [0x10b, 'effect_spawn itself, behind codes 3 and 4 - four fragments'],
      ];

      const users = new Map<number, string[]>();
      const use = (row: number) => users.get(row) ?? (users.set(row, []), users.get(row)!);
      for (const w of readWeaponTypes(exe)) {
        const roles: [number, string][] = [
          [w.impactEffect, 'impact'],
          [w.muzzleEffects[0]!, 'muzzle'],
          [w.muzzleEffects[1]!, 'muzzle'],
        ];
        for (const [code, role] of roles) if (code >= 0) use(code & 0xff).push(`${w.name} ${role}${code < 0x100 ? '' : ` (code ${pyHex(code)})`}`);
      }
      for (const [code, where] of CODE_USERS) use(code & 0xff).push(`code ${pyHex(code)}: ${where}`);

      // XPLO chunks pre-building slots of each row, over every named BWD stream.
      const xplo = new Map<number, number>();
      const bwd = prj.type('BWD')!;
      for (let id = 0; id < bwd.entries.length; id++) {
        if (!prj.resourceName('BWD', id)) continue;
        const p = prj.readResource('BWD', id);
        if (!p) continue;
        const dv = new DataView(p.buffer, p.byteOffset, p.byteLength);
        for (const [pos, tag] of pyChunks(p)) {
          if (tag !== 'XPLO') continue;
          const t = dv.getInt16(pos + 0xc, true);
          const row = t >= 0 && t <= 0x1f ? t : 3;
          xplo.set(row, (xplo.get(row) ?? 0) + 1);
        }
      }

      const variantOf = new Map<number, string[]>();
      for (const [row, vs] of EFFECT_VARIANTS) for (const [flag, v] of vs) (variantOf.get(v) ?? (variantOf.set(v, []), variantOf.get(v)!)).push(`${row}+${pyHex(flag)}`);

      const out = [
        `MW2 effect table (effectTypes, ${EFFECT_COUNT} x ${pyHex(EFFECT_STRIDE)} bytes at ${pyHex(EFFECT_TABLE, 10)})`,
        'life = lifetime in 182 Hz ticks; fade = screenFadePalette (only used with light); snd% = soundChance, -1 always',
        'light = lightsScene (point light at the effect while it lives); node = needsNode (pre-built geometry); area = areaQuery (hits what is near it)',
        "rows 0x17.. are mount-attached (effect_spawn_on_mount); a code's upper bits pick a variant row - see the VARIANTS section",
        '',
        'row  life    sec  fade  sound               snd%  light node area  xplo  used by',
      ];
      readEffectTypes(exe).forEach((e, i) => {
        const sname = e.soundId <= 0 ? '-' : `${e.soundId} ${sounds.get(e.soundId) ?? '?'}`;
        let u = users.get(i) ?? [];
        if (variantOf.get(i)) u = ['variant of ' + variantOf.get(i)!.join(', '), ...u];
        if (NOTES.has(i)) u = [...u, NOTES.get(i)!];
        out.push(
          `${pyHex(i, 4)} ${padL(e.lifetime, 5)} ${padL((e.lifetime / 182).toFixed(2), 6)} ${padL(e.screenFadePalette, 5)}  ${padR(sname, 18)} ${padL(e.soundChance, 4)}  ` +
            `${padL(e.lightsScene, 5)} ${padL(e.needsNode, 4)} ${padL(e.areaQuery, 4)}  ${padL(xplo.get(i) || '', 4)}  ` +
            `${i >= EFFECT_FIRST_MOUNT_ROW ? 'mount ' : ''}${u.join('; ') || '-'}`,
        );
      });
      out.push('', 'FLAGS (Projectile.impactFlags << 8, set by projectile_update):');
      for (const [flag, what] of [...FLAGS.entries()].sort((a, b) => a[0] - b[0])) out.push(`  ${pyHex(flag, 6)}  ${what}`);
      out.push('', "VARIANTS (effect_spawn's switch, first matching flag wins):");
      for (const [row, vs] of [...EFFECT_VARIANTS.entries()].sort((a, b) => a[0] - b[0])) {
        out.push(`  row ${row}: ${vs.map(([f, v]) => `+${pyHex(f)} (${FLAGS.get(f)}) -> row ${pyHex(v)}`).join(', ')}`);
      }
      out.push(`  row 0xb: ${NOTES.get(0xb)}`);
      expectSameLines('effects.txt', lines(readListing('effects.txt')), out);
    });
  });

  describe('commands', () => {
    it('commands.txt (tools/dump_commands.py)', async () => {
      const table = readCommandNames(exe);
      expect(table).toHaveLength(COMMAND_COUNT);
      // GAMEKEY.MAP read the way the dump tool reads it (comment headers are sections).
      const text = new TextDecoder('latin1').decode(await gameSource().read('GAMEKEY.MAP'));
      const binds = new Map<string, string[]>();
      const section = new Map<string, string>();
      let current = '';
      for (const raw of text.split(/\r\n|\r|\n/)) {
        const line = raw.trim();
        if (!line) continue;
        if (line.startsWith('#')) {
          const t = line.replace(/^[#* ]+|[#* ]+$/g, '').trim();
          if (t && !/^(MECHWARRIOR|MODIFY)/.test(t.toUpperCase())) current = t;
          continue;
        }
        const parts = line.split(/\s+/);
        if (parts.length >= 2) {
          const k = parts[0]!.toUpperCase();
          (binds.get(k) ?? (binds.set(k, []), binds.get(k)!)).push(parts[1]!);
          if (!section.has(k)) section.set(k, current);
        }
      }
      const known = new Set(table.map((c) => c.name.toUpperCase()));
      const out = [
        `MW2 player commands - commandNames (${pyHex(COMMAND_NAMES)}, ${table.length} records) with the default keys from GAMEKEY.MAP`,
        'id = the command number option_toggle and the other command handlers switch on',
        '',
        '  id  name                          default keys            map section',
      ];
      const sorted = [...table].sort((a, b) => a.id - b.id || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
      for (const c of sorted) {
        const keys = (binds.get(c.name.toUpperCase()) ?? []).join(', ') || '-';
        out.push(`  ${hex2(c.id)}  ${padR(c.name, 28)}  ${padR(keys, 22)}  ${section.get(c.name.toUpperCase()) ?? ''}`);
      }
      const ids = new Map<number, number>();
      for (const c of table) ids.set(c.id, (ids.get(c.id) ?? 0) + 1);
      const dup = [...ids.entries()].filter(([, n]) => n > 1).map(([c]) => c).sort((a, b) => a - b);
      const unbound = table.filter((c) => !binds.has(c.name.toUpperCase()));
      const unknown = [...binds.keys()].filter((n) => !known.has(n)).sort();
      out.push(
        '',
        `${table.length} commands, ${ids.size} distinct ids${dup.length ? '; ids shared by several names: ' + dup.map(hex2).join(', ') : ''}`,
        `${unbound.length} commands have no default key`,
        `map names the table does not know (the loader rejects these): ${unknown.join(', ') || 'none'}`,
      );
      expectSameLines('commands.txt', lines(readListing('commands.txt')), out);
    });
  });

  describe('cheats', () => {
    it('the addresses are every cheat_match argument in the exported source', () => {
      const call = /cheat_match\(\s*&?\w*?_?([0-9a-f]{8})\b/g;
      const found = new Set<number>();
      const src = path.join(MW2_DECOMPILED, 'mw2', 'src');
      for (const dir of fs.readdirSync(src)) {
        const d = path.join(src, dir);
        if (!fs.statSync(d).isDirectory()) continue;
        for (const f of fs.readdirSync(d).filter((n) => n.endsWith('.c'))) {
          for (const m of fs.readFileSync(path.join(d, f), 'utf8').matchAll(call)) found.add(parseInt(m[1]!, 16));
        }
      }
      expect([...found].sort((a, b) => a - b)).toEqual([...CHEAT_CODE_ADDRESSES].sort((a, b) => a - b));
    });

    it('cheats.txt (tools/dump_cheats.py)', () => {
      const codes = readCheatCodes(exe).sort((a, b) => a.address - b.address);
      const out = [
        `MW2 cheat codes - stored XOR 0x${hex2(CHEAT_XOR)}, matched by cheat_match`,
        'addresses taken from every cheat_match call in the export',
        '',
        `${padR('address', 10)} ${padR('as stored', 16)} typed`,
        '-'.repeat(46),
        ...codes.map((c) => `${hex8(c.address)}   ${padR(pyStrRepr(c.stored).slice(1, -1), 16)} ${c.typed}`),
        '',
        `${codes.length} codes`,
      ];
      expectSameLines('cheats.txt', lines(readListing('cheats.txt')), out);
    });

    it('cheat_match compares the newest keystrokes against the decoded code', () => {
      const blorb = readCheatCodes(exe).find((c) => c.typed === 'blorb')!;
      const keys = (s: string) => Array.from(s, (ch) => ch.charCodeAt(0));
      expect(cheatMatch(blorb.stored, keys('xxblorb'))).toBe(true);
      expect(cheatMatch(blorb.stored, keys('blorbx'))).toBe(false);
      expect(cheatMatch(blorb.stored, keys('lorb'))).toBe(false);
      expect(cheatMatch('', keys(''))).toBe(true);
    });
  });

  describe('system errors', () => {
    it('system_errors.txt (tools/dump_system_errors.py)', async () => {
      const bytes = await gameSource().read('MW2.INI');
      const ini = new IniFile(bytes);
      const t = readSystemErrorTable(exe);
      const LABEL: Record<SystemErrorSeverity, string> = { warning: 'warning', fatal: 'FATAL', fatalEarly: 'FATAL (early: video only)', silent: 'silent' };
      const out = [
        `MW2.EXE system errors - system_error (0x4ad30) codes 0..${pyHex(t.bound)}, table ${pyHex(t.table)}; text from MW2.INI [SystemError]`,
        'warning: printed, game continues. FATAL: printed, game exits with the code. silent: not reported.',
        '',
      ];
      const counts = new Map<string, number>();
      for (let code = 0; code <= t.bound; code++) {
        const sev = LABEL[systemErrorSeverity(t, code)];
        counts.set(sev, (counts.get(sev) ?? 0) + 1);
        // The dump strips the value and prints '?' for a missing key; the game
        // prints the value as is and '' when missing.
        const msg = systemErrorText(ini, code).trim() || '?';
        out.push(`${hex2(code)}  ${padR(sev, 26)} ${msg}`);
      }
      out.push('', [...counts.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)).map(([k, n]) => `${k} ${n}`).join('  '));
      // INI keys beyond the bound: enumerating a section is the dump tool's, not the game's.
      const keys: number[] = [];
      let inside = false;
      for (const raw of new TextDecoder('latin1').decode(bytes).split(/\r\n|\r|\n/)) {
        const line = raw.trim();
        if (line.startsWith('[')) inside = line.toLowerCase() === '[systemerror]';
        else if (inside && line.includes('=')) {
          const k = line.split('=')[0]!.trim().toLowerCase();
          if (/^[0-9a-f]*$/.test(k)) keys.push(parseInt(k, 16));
        }
      }
      const beyond = [...new Set(keys)].filter((c) => c > t.bound).sort((a, b) => a - b);
      if (beyond.length) out.push(`INI codes above the bound (reported silently if ever passed): ${beyond.map(hex2).join(' ')}`);
      expectSameLines('system_errors.txt', lines(readListing('system_errors.txt')), out);
      expect(systemErrorSeverity(t, 0x54)).toBe('silent');
      expect(systemErrorSeverity(t, -1)).toBe('silent');
    });

    it('ini_find_section / ini_get_value edge cases', () => {
      const ini = new IniFile(new TextEncoder().encode('; x\r\n\r\n  [Sect] trailing\r\nK=v1\r\nkey = no\r\nKEY=v2 \r\n[Next]\r\nlast=abc'));
      expect(ini.iniFindSection('sect')).toBe(0);
      expect(ini.iniGetValue('k')).toBe('v1');
      expect(ini.iniGetValue('key')).toBe('v2 ');
      expect(ini.iniGetValue('last')).toBe('');
      expect(ini.iniFindSection('next')).toBe(0);
      expect(ini.iniGetValue('last')).toBe('ab'); // no line end: the last character goes
      expect(ini.iniFindSection('none')).toBe(0x39);
      expect(ini.iniGetValue('k')).toBe('');
      expect(new IniFile(null).iniFindSection('x')).toBe(0x34);
    });
  });

  describe('sound triggers', () => {
    it('sound_triggers.txt table sections (tools/dump_sound_triggers.py)', () => {
      // The call-site sections are an analysis of the exported source, not a
      // table in MW2.EXE; the sections from '== weapon fire sounds' on are.
      const nm = (i: number) => `${sounds.get(i) ?? '?'}(${i})`;
      const out = ["== weapon fire sounds - WeaponType.fireSound (+0x24), played on a burst's first shot"];
      for (const w of readWeaponTypes(exe)) out.push(`  ${padR(w.name, 8)} ${w.fireSound > 0 ? nm(w.fireSound) : 'silent'}`);
      out.push('', '== effect sounds - EffectType.soundId with its soundChance, played by effect_spawn through sound_play_at; see listing/effects.txt');
      readEffectTypes(exe).forEach((e, i) => {
        if (e.soundId <= 0) return;
        out.push(`  effect ${pyHex(i, 4)}  ${sounds.get(e.soundId) ?? '?'}(${e.soundId})  ${e.soundChance === -1 ? 'always' : `chance ${e.soundChance}%`}`);
      });
      out.push('', `== voice cues - soundCues at ${pyHex(SOUND_CUES)}: index, SNDS sample, text`);
      readSoundCues(exe).forEach((c, i) => out.push(`  ${padL(i, 3)}  ${padR(nm(c.soundId), 16)} ${c.text}`));
      out.push(
        `  variants (soundCueVariants, ${pyHex(SOUND_CUE_VARIANTS)}): ` +
          readSoundCueVariants(exe)
            .map((c, i) => `${i} ${nm(c.soundId)} '${c.text}'`)
            .join(', '),
      );
      const want = lines(readListing('sound_triggers.txt'));
      const from = want.indexOf(out[0]!);
      expect(from).toBeGreaterThan(0);
      expectSameLines('sound_triggers.txt', want.slice(from), out);
    });
  });

  describe('menus', () => {
    it('menus.txt (tools/dump_menus.py)', () => {
      const tables = readMenuCallbackTables(exe);
      const fnames = functionNames();
      const used = Object.fromEntries(Object.keys(MENU_TABLES).map((k) => [k, new Set<number>()])) as Record<MenuTableKind, Set<number>>;
      const fn = (kind: MenuTableKind, idx: number): string => {
        used[kind].add(idx);
        const tbl = tables[kind];
        if (idx === 0) return '-';
        if (idx >= tbl.length) return `${idx}:OUT OF RANGE`;
        return `${idx}:${fnames.get(tbl[idx]!) ?? hex8(tbl[idx]!)}`;
      };
      const out = [
        'MW2.PRJ MENU resources, loaded as lx_module_load does and walked as menu_resolve_callbacks does.',
        'Callbacks: index -> function (index 0 = none). Control slots: init/get/preview/commit/revert.',
        '',
      ];
      const type = prj.type('MENU')!;
      for (let id = 0; id < type.entries.length; id++) {
        const [start, length] = type.entries[id]!;
        if (!start && !length) continue;
        const m = readMenuModule(prj, id)!;
        expect(m, `MENU ${id}`).not.toBeNull();
        // The loader's page-table quirk cannot bite: one paged object from page 1, the rest empty.
        const objs = m.module.objects;
        expect(objs[0]![3] === 1 && objs.slice(1).every((o) => o[4] === 0), `MENU ${id} layout`).toBe(true);
        out.push(`MENU ${id}  (${m.size} bytes, ${m.module.fixups.size} fixups)`);
        if (m.root === null) {
          out.push('  the first dword is not a relocated pointer - no root', '');
          continue;
        }
        if (!m.top) {
          const v = new DataView(m.module.block.buffer).getUint32(m.root + 0x65, true);
          out.push(
            `  root @${pyHex(m.root)}, but the dword at root+0x65 is ${pyHex(v)} and not relocated: no top menu. ` +
              'Through project_tables_menu_handler this module would fail to load (menu_resolve_callbacks(root, 0) returns 0); how it is used is NOT established',
            '',
          );
          continue;
        }
        const seenMenu = new Set<Menu>();
        const seenCtl = new Set<number>();
        const walk = (menu: Menu, depth: number) => {
          const pad = '  '.repeat(depth);
          if (seenMenu.has(menu)) {
            out.push(`${pad}menu @${pyHex(menu.at)} (again)`);
            return;
          }
          seenMenu.add(menu);
          out.push(`${pad}menu @${pyHex(menu.at)}  items ${menu.items.length}  onload ${fn('onload', menu.onLoad)}`);
          menu.items.forEach((it, i) => {
            out.push(`${pad}  item ${i}  type ${it.type}  draw ${fn('draw', it.draw)}${it.label ? `  '${it.label}'` : ''}`);
            const c = it.control;
            if (c) {
              if (seenCtl.has(c.at)) out.push(`${pad}    control @${pyHex(c.at)} (shared, resolved once)`);
              else {
                seenCtl.add(c.at);
                const slots = CONTROL_SLOTS.map(([k]) => `${k} ${fn(k, c.slots[k as keyof typeof c.slots])}`).join('  ');
                out.push(`${pad}    control @${pyHex(c.at)}  flags ${pyHex(c.flags)}  sel ${c.selector}  ${slots}`);
              }
            }
            if (it.submenu) walk(it.submenu, depth + 2);
          });
        };
        walk(m.top, 1);
        out.push('');
      }
      out.push('Indices used, per table (vs the run of code pointers labelled in MW2Types):');
      for (const [k, t] of Object.entries(MENU_TABLES) as [MenuTableKind, (typeof MENU_TABLES)[MenuTableKind]][]) {
        const u = [...used[k]].sort((a, b) => a - b);
        out.push(`  ${padR(t.label, 22)} ${pyHex(t.address)}  run ${padL(t.run, 2)}  used [${u.join(', ')}]${u.length && u[u.length - 1]! >= t.run ? '  OUT OF RANGE' : ''}`);
      }
      expectSameLines('menus.txt', lines(readListing('menus.txt')), out);
    });
  });

  describe('gamepiece classes', () => {
    it('nine classes, every code pointer the start of a known function', () => {
      const fnames = functionNames();
      const classes = readGamepieceClasses(exe);
      expect(classes).toHaveLength(GAMEPIECE_CLASS_COUNT);
      expect(classes.map((c) => c.classId)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
      const name = (a: number) => {
        if (a === 0) return '-';
        const n = fnames.get(a);
        expect(n, `0x${hex8(a)} is not a function start in functions.csv`).toBeDefined();
        return n!;
      };
      const got = classes.map((c) => `${c.classId}  ${name(c.createLoadout)}  ${c.hooks.map(name).join(' ')}`);
      const std = 'mech_std_create_loadout  mech_std_create mech_std_tick_terrain mech_std_tick_ai mech_std_tick_player mech_std_cockpit mech_std_cockpit_release';
      const want = [
        '0  -  - - - - - -',
        `1  ${std}`,
        `2  ${std}`,
        '3  mech_alt_create_loadout  mech_alt_create mech_alt_tick_terrain mech_alt_tick_ai - - mech_alt_hook5',
        `4  ${std}`,
        `5  ${std}`,
        `6  ${std}`,
        '7  door_create_loadout  door_create door_tick_move door_tick_ai - - door_hook5_nop',
        `8  ${std}`,
      ];
      console.log(['gamepieceClasses (classId  createLoadout  hooks[0..5]):', ...got].join('\n'));
      expectSameLines('gamepieceClasses', want, got);
    });
  });

  describe('control channels', () => {
    it('matches build/control_fields.csv row for row and the ControlState schema', () => {
      const ch = readControlChannels(exe);
      expect(ch).toHaveLength(CONTROL_CHANNEL_COUNT);
      const rows = ch
        .map((c) => ({ c, offset: channelOffset(c), size: c.kind === 0 ? 4 : 1 }))
        .sort((a, b) => a.offset - b.offset)
        .map(({ c, offset, size }) => `${offset},${size},${c.name},${c.kind},${c.min},${c.max},${c.shift}`);
      const want = lines(fs.readFileSync(buildPath('control_fields.csv'), 'utf8'));
      expectSameLines('control_fields.csv', want, ['offset,size,name,kind,min,max,shift', ...rows]);

      const schema = schemaOf('ControlState');
      const bad: string[] = [];
      for (const c of ch) {
        const f = schema.fields.find((x) => x.name === c.name);
        const size = c.kind === 0 ? 4 : 1;
        if (!f) bad.push(`${c.name}: no ControlState field`);
        else if (f.offset !== channelOffset(c) || f.size * f.count !== size) bad.push(`${c.name}: table +0x${channelOffset(c).toString(16)}/${size}, schema +0x${f.offset.toString(16)}/${f.size * f.count}`);
        expect(inputTorsoTilt(ch, c.name.toUpperCase())).toBe(c);
      }
      expect(bad).toEqual([]);
      expect(inputTorsoTilt(ch, 'no_such_channel')).toBeNull();
    });
  });
});
