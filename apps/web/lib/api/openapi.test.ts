/**
 * W-012 — OpenAPI drift (API PRD §9.12). CI runs this, so a schema change
 * without regenerating `docs/api/openapi.json` fails the gate, and a route
 * added without an entry in `OPERATIONS` fails it too.
 * Regenerate: `npm run openapi:write`.
 */
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { OPERATIONS, openApiJson } from './openapi';

const ROOT = join(__dirname, '../../../..');
const COMMITTED = join(ROOT, 'docs/api/openapi.json');
const ROUTES = join(ROOT, 'apps/web/app/api/v1');

function routeFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? routeFiles(p) : name === 'route.ts' ? [p] : [];
  });
}

describe('OpenAPI', () => {
  it('the committed docs/api/openapi.json is what the schemas generate', () => {
    if (process.env.UPDATE_OPENAPI === '1') writeFileSync(COMMITTED, openApiJson());
    expect(readFileSync(COMMITTED, 'utf8')).toBe(openApiJson());
  });

  it('documents every /api/v1 route and method on disk, and nothing that is not there', () => {
    const onDisk: string[] = [];
    for (const file of routeFiles(ROUTES)) {
      const path = `/${relative(ROUTES, file).replace(/\/?route\.ts$/, '')}`.replace(/\[(\w+)\]/g, '{$1}');
      if (path === '/openapi.json') continue;
      const src = readFileSync(file, 'utf8');
      for (const m of ['GET', 'POST']) if (new RegExp(`export (async )?(function|const) ${m}\\b`).test(src)) onDisk.push(`${m.toLowerCase()} ${path}`);
    }
    expect(OPERATIONS.map((o) => `${o.method} ${o.path}`).sort()).toEqual(onDisk.sort());
  });

  it('a query schema change shows up in the document (one source)', () => {
    const doc = JSON.parse(openApiJson());
    const events = doc.paths['/api/v1/events'].get.parameters.map((p: { name: string }) => p.name);
    expect(events).toEqual(expect.arrayContaining(['since', 'cursor', 'limit']));
    expect(doc.paths['/api/v1/appointments'].post.parameters).toContainEqual(expect.objectContaining({ name: 'Idempotency-Key', required: true }));
  });
});
