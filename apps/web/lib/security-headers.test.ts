import { describe, expect, it } from 'vitest';
import nextConfig from '../next.config';

// K7 / K6: the header contract, read from the real next.config rather than restated.
async function rules() {
  if (!nextConfig.headers) throw new Error('next.config has no headers()');
  return nextConfig.headers();
}

const valueOf = (headers: { key: string; value: string }[], key: string) =>
  headers.find((h) => h.key.toLowerCase() === key.toLowerCase())?.value;

describe('security headers (K7)', () => {
  it('sends Referrer-Policy, nosniff, frame-ancestors, X-Frame-Options and HSTS on every path', async () => {
    const global = (await rules()).find((r) => r.source === '/:path*');
    expect(global).toBeDefined();
    const h = global!.headers;
    expect(valueOf(h, 'Referrer-Policy')).toBe('strict-origin-when-cross-origin');
    expect(valueOf(h, 'X-Content-Type-Options')).toBe('nosniff');
    expect(valueOf(h, 'Content-Security-Policy')).toContain("frame-ancestors 'none'");
    expect(valueOf(h, 'X-Frame-Options')).toBe('DENY');
    expect(valueOf(h, 'Strict-Transport-Security')).toMatch(/max-age=\d{7,}/);
  });

  it('lists the manage-link rule after the global one, so its no-referrer wins', async () => {
    const all = await rules();
    const globalAt = all.findIndex((r) => r.source === '/:path*');
    const manageAt = all.findIndex((r) => r.source === '/manage/:token*');
    expect(globalAt).toBeGreaterThanOrEqual(0);
    expect(manageAt).toBeGreaterThan(globalAt);
    expect(valueOf(all[manageAt]!.headers, 'Referrer-Policy')).toBe('no-referrer');
  });
});
