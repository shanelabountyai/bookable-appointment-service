/**
 * W-009/W-010 — the sender's half of the webhook signature (API PRD §8).
 *
 *   Bookable-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256(secret, "<t>.<raw body>")>[,v1=…]
 *
 * One `v1=` per live secret: during a rotation both the new and the old secret
 * sign for 24 h, so a receiver holding either verifies (W-010). The receiver's
 * half — constant-time compare, ±300 s — is `scripts/webhook-receiver.ts`,
 * written separately on purpose so the tests check two implementations
 * against each other rather than one against itself.
 */
import { createHmac, randomBytes } from 'node:crypto';

export const SIGNATURE_HEADER = 'Bookable-Signature';

export function signatureHeader(secrets: readonly string[], t: number, body: string): string {
  return [`t=${t}`, ...secrets.map((s) => `v1=${createHmac('sha256', s).update(`${t}.${body}`).digest('hex')}`)].join(',');
}

/** `whsec_` + 32 random bytes, shown to the owner once. */
export const newWebhookSecret = (): string => `whsec_${randomBytes(32).toString('base64url')}`;
