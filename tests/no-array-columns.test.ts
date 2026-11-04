import {readdirSync, readFileSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';

import {describe, expect, it} from 'vitest';

/**
 * The live database is reached through src/platform/db-socket.ts (Prisma's Prisma Postgres driver),
 * which mishandles Postgres arrays: writing a `String[]` fails (`malformed array literal`), reading
 * one crashes, and a JavaScript array bound as a raw-SQL parameter is sent as "a,b". Local Postgres
 * hides all of it, so this guard keeps arrays out (docs/agent/database.md: lists are `Json`).
 */
const ROOT = fileURLToPath(new URL('..', import.meta.url));

/** Source files under these folders (bounded: our own code only, no node_modules). */
function sources(...dirs: string[]) {
  return dirs.flatMap((dir) =>
    (readdirSync(join(ROOT, dir), {recursive: true}) as string[])
      .filter((f) => /\.(ts|tsx|astro|mts)$/.test(f))
      .map((f) => ({file: `${dir}/${f}`, text: readFileSync(join(ROOT, dir, f), 'utf8')})),
  );
}

/** Lines matching `pattern`, as "file:line: text", for a readable failure. */
function hits(files: {file: string; text: string}[], pattern: RegExp) {
  return files.flatMap(({file, text}) => text.split('\n').flatMap((line, i) => (pattern.test(line) ? [`${file}:${i + 1}: ${line.trim()}`] : [])));
}

describe('no Postgres arrays (the live driver can not handle them)', () => {
  it('prisma/schema.prisma has no scalar list fields (String[], Int[], an enum list…)', () => {
    const schema = readFileSync(join(ROOT, 'prisma/schema.prisma'), 'utf8');
    const models = new Set([...schema.matchAll(/^model\s+(\w+)\s*\{/gm)].map((m) => m[1]));
    const lists = schema
      .split('\n')
      .map((line, i) => ({line: line.replace(/\/\/.*$/, ''), n: i + 1}))
      .flatMap(({line, n}) => {
        const m = /^\s+\w+\s+(\w+)\[\]/.exec(line);
        return m && !models.has(m[1]) ? [`schema.prisma:${n}: ${line.trim()}`] : []; // a relation list (Model[]) is fine
      });
    expect(lists).toEqual([]);
  });

  const code = sources('src/server', 'src/pages');

  it('raw SQL binds no array parameter (`${list}::text[]`, `ANY(${list})`): use IN (${Prisma.join(list)})', () => {
    expect(hits(code, /\}::"?\w+"?\[\]/)).toEqual([]);
    expect(hits(code, /\bANY\s*\(\s*\$\{/)).toEqual([]);
  });

  it('no Prisma scalar-list operators (has / hasSome / hasEvery / isEmpty / push): use array_contains / equals on Json', () => {
    expect(hits(code, /\bhas(Some|Every)\s*:/)).toEqual([]);
    expect(hits(code, /\bisEmpty\s*:/)).toEqual([]);
    expect(hits(code, /\{\s*has\s*:/)).toEqual([]);
    expect(hits(code, /\{\s*push\s*:/)).toEqual([]);
  });
});
