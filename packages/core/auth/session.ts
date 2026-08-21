/**
 * Session tokens (D-9): an HMAC-signed, expiring bearer value carried in a
 * cookie. `node:crypto` only — no JWT library, because none of what a JWT
 * library buys (algorithm negotiation, JWKS, third-party verifiers) applies
 * when one server signs and the same server verifies.
 *
 * This is NOT encryption. The payload is signed, not hidden — anyone holding
 * the cookie can read the staff-user id and the expiry. That is fine and
 * deliberate: nothing secret goes in it. What the signature guarantees is
 * that nobody can *forge* or *alter* one without the secret.
 *
 * Pure and injectable: the secret and `now` are parameters, so the whole thing
 * is unit-testable with no environment and no clock.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

export interface SessionPayload {
  /** The StaffUser id that AUTHENTICATED — the account whose email and
   *  password opened this session. Never changes for the life of the cookie. */
  sub: string;
  /**
   * A-037/D-33: the StaffUser id currently AT THE DESK, when it is not `sub`.
   *
   * The salon terminal signs in once in the morning and four people use it.
   * This is who the next mutation is stamped with, and it lives inside the
   * SIGNED payload for the obvious reason: an id a client could edit would
   * let anyone put anyone else's name on anything.
   *
   * Absent means "the account holder is at the desk" — one state, not two, so
   * a session written before this field existed still reads correctly.
   */
  act?: string;
  /** Expiry, epoch milliseconds. Inside the signed payload so it cannot be
   *  extended by editing the cookie — a cookie's own Max-Age is a hint to the
   *  browser, not a control the server can trust. */
  exp: number;
}

/** Thrown only for a misconfigured server, never for a bad cookie. */
export class MissingSessionSecret extends Error {
  constructor() {
    super(
      'SESSION_SECRET is not set. Refusing to sign sessions with a default — ' +
        'a fallback secret means every deployment that forgot to set one shares ' +
        'the same forgeable key.',
    );
    this.name = 'MissingSessionSecret';
  }
}

const b64url = (buf: Buffer): string => buf.toString('base64url');

function sign(data: string, secret: string): string {
  return b64url(createHmac('sha256', secret).update(data).digest());
}

export function signSession(payload: SessionPayload, secret: string): string {
  if (!secret) throw new MissingSessionSecret();
  const body = b64url(Buffer.from(JSON.stringify(payload), 'utf8'));
  return `${body}.${sign(body, secret)}`;
}

/**
 * Returns the payload, or null for anything wrong — bad shape, bad signature,
 * expired. Null rather than a reason: the caller's only correct response to
 * every one of those is "you are not logged in", and a differentiated error
 * would invite a caller to treat some of them as recoverable.
 */
export function verifySession(token: string, secret: string, now: number): SessionPayload | null {
  if (!secret) throw new MissingSessionSecret();

  const dot = token.indexOf('.');
  if (dot <= 0) return null;
  const body = token.slice(0, dot);
  const provided = token.slice(dot + 1);

  const expected = sign(body, secret);
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  // Length check first: timingSafeEqual throws on unequal lengths. A length
  // mismatch leaks only the length of an HMAC, which is a constant.
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;

  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    return null;
  }

  if (
    typeof payload !== 'object' ||
    payload === null ||
    typeof (payload as SessionPayload).sub !== 'string' ||
    typeof (payload as SessionPayload).exp !== 'number' ||
    // Optional, but never junk: an `act` of the wrong type would flow on to a
    // database lookup as an unvalidated value.
    !['string', 'undefined'].includes(typeof (payload as SessionPayload).act)
  ) {
    return null;
  }

  const session = payload as SessionPayload;
  if (!Number.isFinite(session.exp) || session.exp <= now) return null;
  return session;
}

/** Eight hours: long enough for a front desk to work a full shift without
 *  re-authenticating, short enough that a session left open on a shared
 *  reception machine is not valid tomorrow morning. */
export const SESSION_TTL_MS = 8 * 60 * 60 * 1000;
