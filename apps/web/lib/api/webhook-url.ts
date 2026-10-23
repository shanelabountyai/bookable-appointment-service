/**
 * W-009 — where a webhook may be sent (API PRD §8: "https only, no private
 * ranges — validated at registration and at send").
 *
 * Checked TWICE because a hostname is not an address: a name that resolved to
 * a public IP when the owner registered it can point at 169.254.169.254 (the
 * cloud metadata service) by the time the sweep runs. The send-time check
 * resolves the name and refuses if ANY address is private.
 *
 * `WEBHOOK_ALLOW_PRIVATE=1` lifts both rules (http, loopback, private) for a
 * local receiver — the demo and the e2e run one on localhost (W-D21). It is
 * set in `.env.test` only, never on a deployment.
 */
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

export class WebhookUrlRejected extends Error {
  constructor(public readonly why: string) {
    super(`webhook url rejected: ${why}`);
    this.name = 'WebhookUrlRejected';
  }
}

export const allowPrivateWebhooks = (): boolean => process.env.WEBHOOK_ALLOW_PRIVATE === '1';

function v4Private(ip: string): boolean {
  const [a, b] = ip.split('.').map(Number) as [number, number];
  return (
    a === 0 || a === 10 || a === 127 ||
    (a === 100 && b >= 64 && b <= 127) || // CGNAT
    (a === 169 && b === 254) || // link-local, incl. cloud metadata
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    a >= 224 // multicast, reserved, broadcast
  );
}

export function isPrivateAddress(ip: string): boolean {
  if (isIP(ip) === 4) return v4Private(ip);
  const v6 = ip.toLowerCase();
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(v6);
  if (mapped) return v4Private(mapped[1]!);
  return v6 === '::' || v6 === '::1' || /^f[cd]/.test(v6) || /^fe[89ab]/.test(v6);
}

/** Parses and checks the URL's shape (no network). Returns the normalised URL string. */
export function checkWebhookUrl(raw: string, allowPrivate = allowPrivateWebhooks()): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new WebhookUrlRejected('not a URL');
  }
  if (url.protocol !== 'https:' && !(allowPrivate && url.protocol === 'http:')) throw new WebhookUrlRejected('must be https');
  if (url.username || url.password) throw new WebhookUrlRejected('must not carry credentials');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (!allowPrivate && (host === 'localhost' || (isIP(host) && isPrivateAddress(host)))) throw new WebhookUrlRejected('must not point at a private address');
  return url.toString();
}

/**
 * The send-time check: every address the name resolves to must be public.
 * ponytail: resolve-then-fetch leaves a DNS-rebinding window of milliseconds;
 * closing it means pinning the resolved IP into the connection (a custom
 * dispatcher), worth it the day this sends anywhere but the owner's own tools.
 */
export async function assertDeliverable(raw: string, allowPrivate = allowPrivateWebhooks()): Promise<void> {
  const url = new URL(checkWebhookUrl(raw, allowPrivate));
  if (allowPrivate) return;
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const addresses = isIP(host) ? [{ address: host }] : await lookup(host, { all: true });
  if (addresses.length === 0 || addresses.some((a) => isPrivateAddress(a.address))) throw new WebhookUrlRejected('resolves to a private address');
}
