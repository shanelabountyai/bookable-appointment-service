/**
 * K12 (INV-18): tests run on a LOCAL Postgres, and the code says so.
 *
 * Every test path that resets a database goes through `resetDatabase`, and the
 * vitest run is set up through `vitest.setup.ts`; both call this first. A
 * TRUNCATE ... CASCADE pointed at the deployed Neon database is the demo's
 * whole book gone, so a convention ("tests use .env.test") is not enough.
 *
 * The rule is an ALLOWLIST of local hosts rather than a list of cloud ones: a
 * new provider's hostname should be refused by default, not let through
 * because nobody added it. ALLOW_CLOUD_DB=1 is the deliberate escape hatch.
 *
 * Dependency-free on purpose, so a config file can import it too.
 */
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

export function isLocalDatabaseUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'postgresql:' && parsed.protocol !== 'postgres:') return false;
  // A socket connection (`postgresql:///db?host=/var/run/postgresql`) has no
  // network host at all.
  if (parsed.hostname === '') {
    const socket = parsed.searchParams.get('host');
    return socket === null || socket.startsWith('/');
  }
  return LOCAL_HOSTS.has(parsed.hostname);
}

export function assertLocalDatabase(
  url: string | undefined,
  env: Record<string, string | undefined> = process.env,
): void {
  if (env.ALLOW_CLOUD_DB === '1') return;
  if (!url) throw new Error('DATABASE_URL is not set — refusing to run database tests.');
  if (!isLocalDatabaseUrl(url)) {
    // Never echo the URL: it carries the password.
    throw new Error(
      'Refusing to run database tests against a non-local DATABASE_URL. ' +
        'Tests run on local Postgres (INV-18); set ALLOW_CLOUD_DB=1 only to reach one deliberately.',
    );
  }
}
