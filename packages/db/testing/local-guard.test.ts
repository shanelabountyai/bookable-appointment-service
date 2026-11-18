import { describe, expect, it } from 'vitest';
import { assertLocalDatabase, isLocalDatabaseUrl } from './local-guard';

describe('local database guard (K12)', () => {
  it.each([
    'postgresql://postgres:postgres@localhost:5432/bookable_test',
    'postgres://u:p@127.0.0.1:5434/bookable_dev',
    'postgresql://u:p@[::1]:5432/db',
    'postgresql:///bookable_test?host=/var/run/postgresql',
  ])('accepts a local URL: %s', (url) => {
    expect(isLocalDatabaseUrl(url)).toBe(true);
    expect(() => assertLocalDatabase(url, {})).not.toThrow();
  });

  it.each([
    'postgresql://u:p@ep-cool-name-123456.us-east-2.aws.neon.tech/neondb?sslmode=require',
    'postgresql://u:p@db.abcdefgh.supabase.co:5432/postgres',
    'postgresql://u:p@mydb.c123.us-east-1.rds.amazonaws.com:5432/app',
    'postgresql://u:p@localhost.attacker.example:5432/db',
    'mysql://u:p@localhost:3306/db',
    'not a url',
  ])('refuses a non-local URL: %s', (url) => {
    expect(isLocalDatabaseUrl(url)).toBe(false);
    expect(() => assertLocalDatabase(url, {})).toThrow(/non-local DATABASE_URL/);
  });

  it('never echoes the URL (it carries the password)', () => {
    const url = 'postgresql://user:hunter2@ep-x.neon.tech/neondb';
    expect(() => assertLocalDatabase(url, {})).toThrow(expect.objectContaining({ message: expect.not.stringContaining('hunter2') }));
  });

  it('refuses an unset URL', () => {
    expect(() => assertLocalDatabase(undefined, {})).toThrow(/not set/);
  });

  it('lets ALLOW_CLOUD_DB=1 through deliberately', () => {
    expect(() => assertLocalDatabase('postgresql://u:p@ep-x.neon.tech/db', { ALLOW_CLOUD_DB: '1' })).not.toThrow();
  });
});
