// mainLoopFrame against main's own loop in the decompiled source: every call,
// in order. Port functions are matched to originals through their @mw2 tags,
// so a step that is swapped, dropped, doubled or tagged with the wrong
// original fails here.
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { MW2_DECOMPILED, hasDecompiled } from '../support/env.ts';

function portTags(): Map<string, string> {
  const tags = new Map<string, string>();
  const walk = (d: string) => {
    for (const f of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, f.name);
      if (f.isDirectory()) walk(p);
      else if (p.endsWith('.ts')) {
        const s = fs.readFileSync(p, 'utf8');
        const re = /@mw2 (\w+) 0x[0-9a-f]+[\s\S]*?\*\/\s*export (?:function\*?|const) (\w+)/g;
        for (let m; (m = re.exec(s)); ) tags.set(m[2]!, m[1]!);
      }
    }
  };
  walk(path.join(__dirname, '..', '..', 'src'));
  return tags;
}

describe.runIf(hasDecompiled)('main loop', () => {
  it('mainLoopFrame makes main\'s calls in main\'s order', () => {
    const c = fs.readFileSync(path.join(MW2_DECOMPILED, 'mw2', 'src', 'boot', 'game_boot.c'), 'utf8');
    const start = c.indexOf('while (quitCountdown < 3) {');
    const body = c.slice(start, c.indexOf('if ((quitRequested != 0)', start));
    const original = [...body.matchAll(/^\s+(?:\w+ = )?(\(\*DAT_00097074\)|\w+)\(/gm)].map((m) => (m[1] === '(*DAT_00097074)' ? 'DAT_00097074' : m[1]!));

    const ts = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'mission', 'mainLoop.ts'), 'utf8');
    const fn = ts.slice(ts.indexOf('export function mainLoopFrame'));
    const frame = fn.slice(0, fn.indexOf('\n}\n'));
    const tags = portTags();
    const ported = [...frame.matchAll(/^ {2}(mainLoop\.renderHook\?\.|\w+)\(/gm)].map((m) =>
      m[1] === 'mainLoop.renderHook?.' ? 'DAT_00097074' : (tags.get(m[1]!) ?? `untagged:${m[1]}`),
    );
    expect(original.length).toBe(25);
    expect(ported).toEqual(original);
  });
});
