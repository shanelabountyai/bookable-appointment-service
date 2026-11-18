// K11: validate the environment once, when the Node server boots, so a missing
// DATABASE_URL or SESSION_SECRET fails the deployment's first start rather than
// a customer's first request. The edge runtime (middleware) reads only
// DEMO_ACCESS_PASSWORD and is not validated here.
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  const { parseEnv } = await import('./lib/env');
  parseEnv(process.env);
}
