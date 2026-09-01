/**
 * A-068 — WHO WAS THIS? (BOOK-04, CLIENT-01, D-17).
 *
 * An appointment's client could not be attached or corrected after it was
 * booked. Two cases the salon has every week, and the workaround for the
 * second one brands an innocent client.
 *
 * (a) A WALK-IN IS TYPED IN AS NOTHING BUT A TIME. That is BOOK-04 and it is
 *     right — you do not take a phone number while she is standing at the
 *     counter. She rebooks at the till, and her visit is ORPHANED forever: on
 *     no client record, counting toward no reliability, reachable by no
 *     reminder, and if she comes back with her daughter A-063's `holderKey`
 *     reads them as two strangers. `schema.prisma` has promised this door
 *     since the beginning — *"NULLABLE — BOOK-04 requires booking with no
 *     client record, identity attached later"* — and nothing opened it.
 *
 * (b) THE DESK PICKS THE WRONG SARAH JONES, of the two D-17 guarantees will
 *     exist, and finds out at check-in. The only correction available was
 *     cancel-and-rebook, and since A-060 that cancel DERIVES `cancelled_late`
 *     — a late cancellation on an innocent client's twelve-month count, for
 *     the desk's own typo. That is precisely the harm A-055 and A-060 exist to
 *     prevent, arriving through the one door nobody had closed.
 *
 * ONE ACTION, THREE WORDS. Attach, change and detach are the same write with
 * different arguments, and they write ONE event naming both sides — a separate
 * `client_detached` path would be a second place to get the chair arithmetic
 * right (see below), which is how the codebase's constraint bugs have always
 * arrived.
 *
 * IT IS AN ORDINARY ROW `UPDATE`, deliberately, because that is what makes
 * `appointment_write_resource_hold` re-derive `holderKey` — checkpoint 5's
 * lesson. A-063 keyed the chair on the CLIENT (`COALESCE(clientId, 'appt:' ||
 * id)`) so that a client's own sequential visits may share a chair while two
 * bodies never do. This file is the one place in the product that changes that
 * key on a live row, so it is the one place where the room's arithmetic can be
 * invalidated by a write that touches no time at all:
 *
 *   * ATTACHING can only ever RELAX the envelope constraint — two holds that
 *     were different holders become the same one. It cannot fail on the
 *     resource axis.
 *   * DETACHING and CHANGING can TIGHTEN it. Her two visits legally sharing a
 *     chair under A-063 stop being the same holder the moment one of them
 *     belongs to somebody else, and the chair that was admissible is not.
 *
 * So the chair is RE-PICKED on every write through `chairForMove` — the same
 * helper the reschedule and the service change use, preferring the chair it
 * already holds — rather than left to a `23P01` nobody would be able to
 * explain. A move never starts or stops holding a chair (RES-03) and neither
 * does this.
 *
 * NOTHING IS SENT. Not on any of the three. Attaching is a correction to the
 * record, made either while she is standing there or weeks later; a message
 * saying "your appointment has changed" would be false on every arm. A test
 * asserts the outbox does not move.
 */
import type { Actor } from '../../core/auth';
import { ACTIVE_STATUSES } from '../../core/scheduling';
import { NoResourceFree } from '../booking/errors';
import { chairForMove, chairHeldByHolder, resourceTypeName } from '../booking/resources';
import type { Prisma, PrismaClient } from '../generated/client/index.js';

/** Somebody else changed who this appointment belongs to while we were
 *  deciding. The same shape as `VisitAlreadyChanged` and
 *  `AppointmentAlreadyMoved`, for the same reason: the write is conditional on
 *  the value we decided against. */
export class ClientAlreadyChanged extends Error {
  constructor() {
    super('Somebody else has already changed who this appointment is for.');
    this.name = 'ClientAlreadyChanged';
  }
}

/** The client named does not belong to this business, or has been merged away.
 *  Merged is refused rather than followed: the survivor is a different person
 *  from the one the desk picked, and silently attaching to it would be the
 *  product choosing which Sarah Jones this was. */
export class ClientNotAttachable extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ClientNotAttachable';
  }
}

export interface SetAppointmentClientInput {
  businessId: string;
  appointmentId: string;
  /** `null` DETACHES — "that wasn't her". Not a missing argument. */
  clientId: string | null;
  actor: Actor;
  reason?: string | null;
}

export interface AppointmentClientChanged {
  appointmentId: string;
  /** Both sides, because the sentence the desk reads back needs both. */
  from: { id: string; name: string | null } | null;
  to: { id: string; name: string | null } | null;
  /** 'attached' | 'changed' | 'detached' — the word, decided here so the log
   *  and the screen cannot word the same write differently. */
  kind: 'attached' | 'changed' | 'detached';
}

/**
 * Attaches, changes or detaches the client on an existing appointment.
 *
 * ALLOWED FROM EVERY STATUS, terminal ones included, and that is the point
 * rather than an oversight. "She was a no-show and it turns out she is Mrs
 * Kerr" is a real correction, and attaching a past no-show DOES move her
 * twelve-month count — correctly, because it is now on the right person's
 * record. The mirror matters more: detaching from a `cancelled_late` row is
 * the only way to undo case (b)'s harm on a client who was never involved.
 * A status guard here would close the door this file exists to open.
 */
export async function setAppointmentClient(
  prisma: PrismaClient,
  input: SetAppointmentClientInput,
): Promise<AppointmentClientChanged> {
  return prisma.$transaction(async (tx) => {
    const appointment = await tx.appointment.findFirst({
      where: { id: input.appointmentId, businessId: input.businessId },
      select: {
        id: true,
        businessId: true,
        clientId: true,
        status: true,
        startAt: true,
        endAt: true,
        blockedStart: true,
        blockedEnd: true,
        resourceId: true,
        client: { select: { id: true, name: true } },
        // Only ever read on the refusal path, to name the room in the sentence
        // a human gets ("Every chair is taken for that time").
        lines: { select: { serviceId: true } },
      },
    });
    if (!appointment) throw new ClientNotAttachable('That appointment is not in this business.');

    const toClientId = input.clientId?.trim() || null;
    if (toClientId === appointment.clientId) {
      // Writing an event that says nothing happened is the refusal
      // `rescheduleAppointment` makes for a move to where it already is.
      throw new ClientNotAttachable('This appointment is already recorded against that person.');
    }

    const to = toClientId === null ? null : await loadAttachable(tx, input.businessId, toClientId);

    const resourceId = await rechair(tx, appointment, toClientId);

    // CONDITIONAL ON THE CLIENT WE DECIDED AGAINST. Two people at two
    // stations correcting the same wrong Sarah Jones would otherwise both
    // pass their reads and both write, leaving one client and two events that
    // disagree about where it came from.
    const written = await tx.appointment.updateMany({
      where: { id: appointment.id, clientId: appointment.clientId },
      data: {
        clientId: toClientId,
        // RES-03: a write re-picks the chair it already holds and never starts
        // or stops holding one. `resourceId` stays untouched when there was
        // none — a staff override (D-30) or a service that needs no resource.
        ...(appointment.resourceId ? { resourceId } : {}),
      },
    });
    if (written.count === 0) throw new ClientAlreadyChanged();

    const from = appointment.client ? { id: appointment.client.id, name: appointment.client.name } : null;
    const kind = from === null ? 'attached' : to === null ? 'detached' : 'changed';

    await tx.appointmentEvent.create({
      data: {
        businessId: appointment.businessId,
        appointmentId: appointment.id,
        // ONE type, three sentences. The words are the reader's job — a
        // `client_attached`/`client_detached`/`client_changed` triple would be
        // three rows in every list that reads the log, for one write.
        type: 'client_changed',
        actor: input.actor.type,
        actorRef: input.actor.ref,
        reason: input.reason?.trim() || null,
        payload: {
          // BOTH SIDES (D-31). The row now names one person and the log is the
          // only record that it ever named the other — which is the entire
          // audit trail for "who moved this no-show onto my client".
          fromClientId: from?.id ?? null,
          fromClientName: from?.name ?? null,
          toClientId: to?.id ?? null,
          toClientName: to?.name ?? null,
          kind,
        } satisfies Prisma.InputJsonValue,
      },
    });

    return { appointmentId: appointment.id, from, to, kind };
  });
}

async function loadAttachable(
  tx: Prisma.TransactionClient,
  businessId: string,
  clientId: string,
): Promise<{ id: string; name: string | null }> {
  const client = await tx.client.findFirst({
    where: { id: clientId, businessId },
    select: { id: true, name: true, mergedIntoClientId: true },
  });
  if (!client) throw new ClientNotAttachable('That client is not in this business.');
  // Following the merge silently would be the product deciding which Sarah
  // Jones this was — the one question the desk is here to answer.
  if (client.mergedIntoClientId) {
    throw new ClientNotAttachable('That record has been merged into another. Pick the surviving one.');
  }
  return { id: client.id, name: client.name };
}

/**
 * The chair the appointment should hold once it belongs to somebody else.
 *
 * A-063 keys the envelope constraint on the HOLDER, so changing the holder can
 * make an admissible chair inadmissible without a single minute moving. The
 * same helper the reschedule uses answers it, with `preferResourceId` set to
 * the chair she is already in — so the ordinary case re-picks what it had and
 * writes the same value back.
 *
 * A cancelled row holds no chair (the constraint's predicate excludes it), so
 * there is nothing to re-pick and nothing that can refuse.
 */
async function rechair(
  tx: Prisma.TransactionClient,
  appointment: {
    id: string;
    businessId: string;
    resourceId: string | null;
    startAt: Date;
    endAt: Date;
    blockedStart: Date;
    blockedEnd: Date;
    status: string;
    lines: { serviceId: string }[];
  },
  toClientId: string | null,
): Promise<string | null> {
  if (appointment.resourceId === null) return null;
  if (!(ACTIVE_STATUSES as readonly string[]).includes(appointment.status)) return appointment.resourceId;

  // The key it will have AFTER the write — the whole question this asks.
  const holderKey = toClientId ?? `appt:${appointment.id}`;

  // THE MIRROR OF A-063, and the reason this is not simply `chairForMove` with
  // the chair it already has. A walk-in holds `appt:<id>` and is a stranger to
  // her own next visit, so the room seated them separately; naming her makes
  // them one holder and the two seats become one body in two chairs — the
  // exact double-hold A-063 exists to prevent, arriving through the door this
  // file opens. So the chair her OTHER visit holds wins over the one this
  // visit is in, and only when she holds none does it keep what it had.
  const shared = await chairHeldByHolder(tx, {
    businessId: appointment.businessId,
    appointmentId: appointment.id,
    resourceId: appointment.resourceId,
    holderKey,
    start: appointment.blockedStart,
    end: appointment.blockedEnd,
    bodyStart: appointment.startAt,
    bodyEnd: appointment.endAt,
  });

  const resourceId = await chairForMove(tx, {
    businessId: appointment.businessId,
    appointmentId: appointment.id,
    resourceId: shared ?? appointment.resourceId,
    start: appointment.blockedStart,
    end: appointment.blockedEnd,
    holder: { key: holderKey, bodyStart: appointment.startAt, bodyEnd: appointment.endAt },
  });
  if (resourceId === null) {
    // Detaching split a shared chair and there is no second one free. A
    // refusal naming the room, not a `23P01` nobody could explain.
    throw new NoResourceFree(await resourceTypeName(tx, appointment.lines.map((l) => l.serviceId)));
  }
  return resourceId;
}
