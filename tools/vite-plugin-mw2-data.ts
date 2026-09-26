/**
 * Serves the original game files to the browser without copying them into
 * port/. The game reads its data at runtime exactly as MW2.EXE did - from
 * MW2.PRJ, MW2.EXE and the loose files beside them - so the dev server only
 * has to hand those files over.
 *
 *   /mw2/<file>      from MW2_ROOT (the install): whitelisted names only
 *   /mw2-ref/<path>  from MW2_DECOMPILED: exported C and listings, for the
 *                    editor's source view. Dev only; never part of a build.
 *
 * DOS filenames are case-insensitive, and so is the lookup here.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { Connect, Plugin } from 'vite';
import { mw2Decompiled, mw2Root } from './paths.ts';

const GAME_WHITELIST = [
  /^MW2\.PRJ$/i,
  /^MW2\.EXE$/i,
  /^[A-Z0-9_]+\.BWD$/i,
  /^[A-Z0-9_]+\.MAP$/i,
  /^MW2[A-Z]*\.CFG$/i,
  /^MW2\.INI$/i,
  /^MEK\/[A-Z0-9_]+\.MEK$/i,
  /^GIDDI\/[A-Z0-9_]+\.(DLL|STD|CAL)$/i,
];

const REF_WHITELIST = [/^mw2\/src\/.+\.[ch]$/i, /^mw2\/include\/.+\.h$/i, /^mw2\/listing\/[^/]+\.(txt|csv)$/i];

/** Resolve `rel` under `root` ignoring case, one path segment at a time. */
export function resolveCaseInsensitive(root: string, rel: string): string | null {
  let cur = root;
  for (const seg of rel.split('/')) {
    if (seg === '' || seg === '.' || seg === '..') return null;
    let entries: string[];
    try {
      entries = fs.readdirSync(cur);
    } catch {
      return null;
    }
    const hit = entries.find((e) => e.toLowerCase() === seg.toLowerCase());
    if (!hit) return null;
    cur = path.join(cur, hit);
  }
  return cur;
}

/** GET /mw2/__list/<dir>: the whitelisted files in one install directory ('' for the root), as JSON. */
function listDir(root: string, whitelist: RegExp[], rel: string): string[] {
  const dir = rel === '' ? root : resolveCaseInsensitive(root, rel);
  if (!dir || !fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return [];
  return fs
    .readdirSync(dir)
    .map((f) => (rel === '' ? f : `${rel}/${f}`))
    .filter((f) => whitelist.some((re) => re.test(f)));
}

function serveFrom(root: string, whitelist: RegExp[]): Connect.NextHandleFunction {
  return (req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();
    const rel = decodeURIComponent((req.url ?? '').split('?')[0]!.replace(/^\/+/, ''));
    const list = /^__list\/?(.*)$/.exec(rel);
    if (list) {
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Cache-Control', 'no-store');
      res.end(JSON.stringify(listDir(root, whitelist, list[1]!.replace(/\/+$/, ''))));
      return;
    }
    if (!whitelist.some((re) => re.test(rel))) {
      res.statusCode = 404;
      res.end(`not served: ${rel}`);
      return;
    }
    const file = resolveCaseInsensitive(root, rel);
    if (!file || !fs.statSync(file).isFile()) {
      res.statusCode = 404;
      res.end(`not found under ${root}: ${rel}`);
      return;
    }
    const size = fs.statSync(file).size;
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Content-Type', /\.(txt|csv|c|h)$/i.test(rel) ? 'text/plain; charset=utf-8' : 'application/octet-stream');
    const range = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range ?? '');
    if (range) {
      const start = Number(range[1]);
      const end = range[2] ? Number(range[2]) : size - 1;
      res.statusCode = 206;
      res.setHeader('Content-Range', `bytes ${start}-${end}/${size}`);
      res.setHeader('Content-Length', String(end - start + 1));
      if (req.method === 'HEAD') return res.end();
      fs.createReadStream(file, { start, end }).pipe(res);
      return;
    }
    res.setHeader('Content-Length', String(size));
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(file).pipe(res);
  };
}

export function mw2Data(env: Record<string, string | undefined> = process.env): Plugin {
  const root = mw2Root(env);
  const ref = mw2Decompiled(env);
  const install = (mw: Connect.Server, withRef: boolean) => {
    mw.use('/mw2', serveFrom(root, GAME_WHITELIST));
    if (withRef) mw.use('/mw2-ref', serveFrom(ref, REF_WHITELIST));
  };
  return {
    name: 'mw2-data',
    configureServer(server) {
      server.config.logger.info(`  mw2 data: ${root}`);
      install(server.middlewares, true);
    },
    configurePreviewServer(server) {
      install(server.middlewares, false);
    },
  };
}
