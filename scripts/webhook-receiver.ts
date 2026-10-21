/**
 * W-010 — the reference webhook RECEIVER (API PRD §8 "Signature").
 *
 * What a receiver must do, and nothing else, in Node's standard library so it
 * can be copied into any integration:
 *   1. read the RAW body (verify the bytes that were signed, never re-serialised JSON);
 *   2. parse `Bookable-Signature: t=<unix s>,v1=<hex>[,v1=<hex>]`;
 *   3. refuse a timestamp more than 300 s from now (a replayed capture);
 *   4. accept if ANY v1 matches HMAC-SHA256(secret, "<t>.<body>") for ANY of
 *      its secrets — constant-time — so a rotation (two v1 values, or two
 *      secrets here) never drops a delivery;
 *   5. dedupe on the event id: delivery is at-least-once.
 *
 * Run:  WEBHOOK_SECRET=whsec_… npx tsx scripts/webhook-receiver.ts
 *       (WEBHOOK_SECRET may be a comma-separated list during a rotation;
 *        WEBHOOK_RECEIVER_PORT defaults to 3310.)
 * Register http://localhost:3310/ as an endpoint with WEBHOOK_ALLOW_PRIVATE=1.
 *
 * Deliberately NOT imported from the app: the tests check this against the
 * sender's signer, two implementations of one spec.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';

export const TOLERANCE_SECONDS = 300;

export type Verdict = { ok: true; t: number } | { ok: false; why: string };

export function verifySignature(header: string | null | undefined, rawBody: string, secrets: readonly string[], nowSeconds: number): Verdict {
  if (!header) return { ok: false, why: 'missing Bookable-Signature' };
  let t = NaN;
  const sigs: string[] = [];
  for (const part of header.split(',')) {
    const [k, v] = part.split('=', 2) as [string, string | undefined];
    if (k === 't') t = Number(v);
    else if (k === 'v1' && v) sigs.push(v);
  }
  if (!Number.isInteger(t) || sigs.length === 0) return { ok: false, why: 'malformed Bookable-Signature' };
  if (Math.abs(nowSeconds - t) > TOLERANCE_SECONDS) return { ok: false, why: `timestamp outside ±${TOLERANCE_SECONDS}s` };
  for (const secret of secrets) {
    const expected = Buffer.from(createHmac('sha256', secret).update(`${t}.${rawBody}`).digest('hex'));
    for (const sig of sigs) {
      const got = Buffer.from(sig);
      if (got.length === expected.length && timingSafeEqual(got, expected)) return { ok: true, t };
    }
  }
  return { ok: false, why: 'no signature matches' };
}

/** Starts the receiver. `onEvent` sees every VERIFIED, first-seen event. */
export function startReceiver(opts: { port: number; secrets: readonly string[]; onEvent?: (event: Record<string, unknown>) => void; log?: (line: string) => void }) {
  const seen = new Set<string>();
  const log = opts.log ?? ((line: string) => console.log(line));
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      const verdict = verifySignature(req.headers['bookable-signature'] as string | undefined, raw, opts.secrets, Math.floor(Date.now() / 1000));
      if (!verdict.ok) {
        log(`REJECTED ${verdict.why}`);
        res.writeHead(401).end(verdict.why);
        return;
      }
      const event = JSON.parse(raw) as { id: string; type: string; seq: number; replayed: boolean; data: { appointment: { id: string; startAt: string } } };
      if (seen.has(event.id)) {
        log(`duplicate ${event.id} (attempt ${req.headers['bookable-attempt']}) — already processed, 200`);
      } else {
        seen.add(event.id);
        log(`VERIFIED #${event.seq} ${event.type} appointment=${event.data.appointment.id} start=${event.data.appointment.startAt}${event.replayed ? ' (replayed)' : ''}`);
        opts.onEvent?.(event);
      }
      res.writeHead(200).end('ok');
    });
  });
  return new Promise<typeof server>((resolve) => server.listen(opts.port, () => resolve(server)));
}

if (process.argv[1]?.endsWith('webhook-receiver.ts')) {
  const secrets = (process.env.WEBHOOK_SECRET ?? '').split(',').filter(Boolean);
  if (secrets.length === 0) {
    console.error('Set WEBHOOK_SECRET to the secret shown when the endpoint was registered.');
    process.exit(1);
  }
  const port = Number(process.env.WEBHOOK_RECEIVER_PORT ?? 3310);
  void startReceiver({ port, secrets }).then(() => console.log(`webhook receiver listening on http://localhost:${port}/`));
}
