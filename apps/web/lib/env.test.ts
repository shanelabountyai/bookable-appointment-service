import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { envSchema, parseEnv } from './env';

const ROOT = resolve(__dirname, '../../..');
const VALID = { DATABASE_URL: 'postgresql://localhost/x', SESSION_SECRET: 's' };

describe('parseEnv (K11)', () => {
  it('accepts the minimum the app needs', () => {
    expect(parseEnv(VALID).SESSION_SECRET).toBe('s');
  });

  it('names a missing required key and never echoes values', () => {
    expect(() => parseEnv({ DATABASE_URL: 'postgresql://u:hunter2@localhost/x' })).toThrow('Invalid environment: SESSION_SECRET');
    expect(() => parseEnv({ DATABASE_URL: 'postgresql://u:hunter2@localhost/x' })).toThrow(
      expect.objectContaining({ message: expect.not.stringContaining('hunter2') }),
    );
  });

  it('treats an empty NAME= line as unset', () => {
    expect(() => parseEnv({ ...VALID, SESSION_SECRET: '' })).toThrow(/SESSION_SECRET/);
    expect(parseEnv({ ...VALID, CRON_SECRET: '' }).CRON_SECRET).toBeUndefined();
  });

  it('rejects a malformed escape hatch', () => {
    expect(() => parseEnv({ ...VALID, ALLOW_CLOUD_DB: 'yes' })).toThrow(/ALLOW_CLOUD_DB/);
  });
});

// INV-14: `.env.example` lists every variable the code reads, names only.
function exampleNames(): Set<string> {
  const text = readFileSync(join(ROOT, '.env.example'), 'utf8');
  return new Set([...text.matchAll(/^([A-Z][A-Z0-9_]*)=/gm)].map((m) => m[1]!));
}

const SKIP = new Set(['node_modules', 'generated', '.next', 'test-results', 'playwright-report']);
function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name)) continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) sourceFiles(path, out);
    else if (/\.(ts|tsx|mjs|js)$/.test(name)) out.push(path);
  }
  return out;
}

describe('.env.example (K11)', () => {
  it('names every key in the boot schema', () => {
    const names = exampleNames();
    expect(Object.keys(envSchema.shape).filter((k) => !names.has(k))).toEqual([]);
  });

  it('names every process.env variable read anywhere in the code', () => {
    const names = exampleNames();
    const read = new Set<string>();
    for (const dir of ['apps', 'packages', 'scripts']) {
      for (const file of sourceFiles(join(ROOT, dir))) {
        for (const m of readFileSync(file, 'utf8').matchAll(/process\.env\.([A-Z][A-Z0-9_]*)/g)) read.add(m[1]!);
      }
    }
    expect(read.size).toBeGreaterThan(10); // the scan itself found something
    expect([...read].filter((k) => !names.has(k)).sort()).toEqual([]);
  });

  it('carries no values for secrets', () => {
    const text = readFileSync(join(ROOT, '.env.example'), 'utf8');
    for (const m of text.matchAll(/^([A-Z][A-Z0-9_]*(SECRET|PASSWORD|TOKEN|KEY)[A-Z0-9_]*)=(.*)$/gm)) {
      expect({ key: m[1], value: m[3] }).toEqual({ key: m[1], value: '' });
    }
  });
});
