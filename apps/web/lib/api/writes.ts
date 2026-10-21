/**
 * W-006 — `POST /v1/appointments`, `POST /v1/clients` (API PRD §7).
 *
 * Every write goes through the SAME `packages/db` function the desk calls —
 * `bookAppointment`, `createClient` — so the exclusion constraint, D-8, D-31
 * and D-32 apply unchanged (§2), with `apiActor(keyId)` (W-D1) and
 * `audience: 'staff'`. Before the write, the instant is asked of the engine
 * the way the write will ask it (`offeredSlot`, shared with MCP's previews):
 * not as the correctness mechanism — the domain function re-checks under its
 * lock and the constraint is the last word — but so a refusal names its
 * reason (OUTSIDE_HOURS vs SLOT_TAKEN) instead of "not offered".
 */
import { apiActor } from '@bookable/core/auth';
import { toDate } from '@bookable/core/time';
import { bookAppointment } from '@bookable/db/booking';
import { ClientRejected, createClient, findClientsByPhone } from '@bookable/db/clients';
import { qualifiedForVisit } from '@bookable/db/qualification';
import { offeredSlot } from '@bookable/mcp';
import { z } from 'zod';
import { appointmentView } from './appointments';
import { type RequestContext, hasScope, parseWith } from './http';
import { type IdempotencyHooks, idempotent } from './idempotent';
import { clientOf, providerOf, servicesOf } from './ids';
import { fail } from './problem';
import { parseInstant } from './time';

const bookBody = z
  .object({
    clientId: z.string().min(1),
    serviceIds: z.array(z.string().min(1)).min(1).max(10),
    /** A named provider (from GET /v1/providers). `any` is not accepted on a write in v1 (W-D17). */
    providerId: z.string().min(1),
    /** `YYYY-MM-DD HH:MM` in the salon's zone, or an ISO instant with offset (§6.2). */
    start: z.string().min(1),
    note: z.string().max(500).optional(),
  })
  .strict();

export function postAppointment(hooks: IdempotencyHooks = {}) {
  return (ctx: RequestContext) =>
    idempotent(
      ctx,
      async ({ body, db, caller, now, claimId }) => {
        const b = parseWith(bookBody, body, 'body');
        if (b.providerId === 'any') {
          throw fail('VALIDATION', 'Book with a named provider. GET /v1/availability?providerId=any says who the desk would assign.', {
            errors: [{ field: 'providerId', message: 'must be a provider id' }],
            next: { endpoint: 'GET /v1/availability', why: 'see who is free, per instant' },
          });
        }
        await servicesOf(db, caller.businessId, b.serviceIds);
        const provider = await providerOf(db, caller.businessId, b.providerId);
        const client = await clientOf(db, caller.businessId, b.clientId);
        const start = parseInstant(b.start, 'start', caller.timezone);
        if (!(await qualifiedForVisit(db, { businessId: caller.businessId, providerId: provider.id, serviceIds: b.serviceIds }))) {
          throw fail('NOT_QUALIFIED', `${provider.displayName} cannot do everything in this visit.`, {
            errors: [{ field: 'providerId', message: 'not qualified for every service' }],
            next: { endpoint: 'GET /v1/providers', why: 'pass these serviceIds to see who can' },
          });
        }
        // The engine's question, the write's way: same holder, staff audience.
        await offeredSlot({ prisma: db, now, businessId: caller.businessId, providerId: provider.id, serviceIds: b.serviceIds, holderKey: client.id, start, zone: caller.timezone });

        const booked = await bookAppointment(db, {
          businessId: caller.businessId,
          providerId: provider.id,
          serviceIds: b.serviceIds,
          clientId: client.id,
          startAt: toDate(start),
          now,
          actor: apiActor(caller.keyId),
          audience: 'staff',
          // Stable for the claim's lifetime; the outcome row is the replay, this is defence in depth.
          idempotencyKey: `api:${claimId}`,
          notes: b.note?.trim() || null,
        });
        const view = await appointmentView(db, { businessId: caller.businessId, id: booked.id, zone: caller.timezone, now });
        return { status: 201, body: view, headers: { Location: `/api/v1/appointments/${booked.id}` } };
      },
      hooks,
    );
}

const clientBody = z
  .object({
    name: z.string().trim().min(1).max(120),
    phone: z.string().trim().min(7).max(32),
    email: z.email().max(254).optional(),
    /** A household shares a number (D-17). Say so to add a second client on it. */
    allowDuplicate: z.boolean().default(false),
  })
  .strict();

const last4 = (phone: string | null) => (phone ? phone.replace(/\D/g, '').slice(-4) : null);

export function postClient(hooks: IdempotencyHooks = {}) {
  return (ctx: RequestContext) =>
    idempotent(
      ctx,
      async ({ body, db, caller }) => {
        const b = parseWith(clientBody, body, 'body');
        if (b.phone.replace(/\D/g, '').length < 7) {
          throw fail('VALIDATION', 'That does not look like a phone number — at least seven digits.', { errors: [{ field: 'phone', message: 'fewer than 7 digits' }] });
        }
        if (!b.allowDuplicate) {
          const existing = await findClientsByPhone(db, caller.businessId, b.phone);
          if (existing.length > 0) {
            // M-D13's rule, for a caller that cannot see the desk's list either.
            throw fail('AMBIGUOUS_CLIENT', `A client with a phone ending ${last4(b.phone)} is already on the book. Book them, or resend with "allowDuplicate": true if this is somebody else.`, {
              errors: [{ field: 'phone', message: 'already on the book' }],
              next: { endpoint: 'GET /v1/clients', why: 'confirm who this is' },
              matches: existing.map((c) => ({ id: c.id, name: c.name })),
            });
          }
        }
        let row;
        try {
          row = await createClient(db, { businessId: caller.businessId, name: b.name, phone: b.phone, email: b.email ?? null });
        } catch (error) {
          if (error instanceof ClientRejected) throw fail('VALIDATION', error.message, { errors: [{ field: error.field, message: error.message }] });
          throw error;
        }
        return {
          status: 201,
          body: {
            id: row.id,
            name: row.name,
            phoneLast4: last4(row.phone),
            ...(hasScope(caller, 'contacts') ? { phone: row.phone, email: row.email } : {}),
          },
          headers: { Location: `/api/v1/clients/${row.id}` },
        };
      },
      hooks,
    );
}
