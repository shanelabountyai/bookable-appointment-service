/**
 * A-141 — the limiter's bucket for one client address.
 *
 * An IPv4 address is one household. An IPv6 address is not: an ISP hands a
 * home a whole /64 (2^64 addresses) and every device picks its own, so keying
 * on the full address gives a script a fresh bucket per request for free —
 * both limits (manage link, public booking) are then no limit at all. The /64
 * is what one subscriber actually holds, so that is the bucket.
 *
 * An IPv4-mapped address (`::ffff:203.0.113.7`) is the IPv4 address. Anything
 * that does not parse is returned as it came: an unparseable header is its own
 * bucket, which is what it was before this function existed.
 */
export function ipBucket(ip: string): string {
  if (!ip.includes(':')) return ip;
  const addr = ip.split('%')[0]!.toLowerCase();
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(addr);
  if (mapped) return mapped[1]!;

  const halves = addr.split('::');
  if (halves.length > 2) return ip;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves[1] ? halves[1].split(':') : [];
  const missing = 8 - head.length - tail.length;
  if (halves.length === 1 ? missing !== 0 : missing < 1) return ip;
  const groups = [...head, ...Array<string>(halves.length === 2 ? missing : 0).fill('0'), ...tail];
  if (!groups.every((g) => /^[0-9a-f]{1,4}$/.test(g))) return ip;

  return `${groups.slice(0, 4).map((g) => parseInt(g, 16).toString(16)).join(':')}::/64`;
}
