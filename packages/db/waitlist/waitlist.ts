/**
 * A-023 — waitlist entries and fit-aware matching (WAIT-01, WAIT-02).
 *
 * v1 is the staff panel only: entries, and "who wants this slot?" for one
 * freed interval. Automated offer-with-soft-hold is OQ-4's follow-on and
 * touches none of this — this module never SENDS anything, it only answers
 * "who".
 */
import { DAY_PART_TAGS, matchesDayParts, tagsFor } from '../../core/waitlist';
import type { CalendarDay, WallTime } from '../../core/time';
import { effectiveDurationMinutes } from '../../core/settings';
import type { Prisma, PrismaClient, WaitlistStatus } from '../generated/client/index.js';

type Db = Prisma.TransactionClient | PrismaClient;

export class WaitlistEntryRejected extends Error {
  readonly field: string;
  constructor(field: string, message: string) {
    super(message);
    this.name = 'WaitlistEntryRejected';
    this.field = field;
  }
}

export interface WaitlistEntryRow {
  id: string;
  clientId: string;
  clientName: string | null;
  clientPhone: string | null;
  serviceId: string;
  serviceName: string;
  providerIds: string[];
  fromDay: string;
  toDay: string;
  dayParts: string[];
  status: WaitlistStatus;
  createdAt: Date;
}

const rowSelect = {
  id: true,
  clientId: true,
  serviceId: true,
  providerIds: true,
  fromDay: true,
  toDay: true,
  dayParts: true,
  status: true,
  createdAt: true,
  client: { select: { name: true, phone: true } },
  service: { select: { name: true } },
} as const;

type RawRow = Prisma.WaitlistEntryGetPayload<{ select: typeof rowSelect }>;

function shape(row: RawRow): WaitlistEntryRow {
  return {
    id: row.id,
    clientId: row.clientId,
    clientName: row.client.name,
    clientPhone: row.client.phone,
    serviceId: row.serviceId,
    serviceName: row.service.name,
    providerIds: row.providerIds,
    fromDay: row.fromDay,
    toDay: row.toDay,
    dayParts: row.dayParts,
    status: row.status,
    createdAt: row.createdAt,
  };
}

/** The live queue — everything staff need to work it, oldest first (first
 *  come, first offered, whenever someone gets to calling). */
export async function listWaitlistEntries(
  db: Db,
  businessId: string,
  status: WaitlistStatus = 'active',
): Promise<WaitlistEntryRow[]> {
  const rows = await db.waitlistEntry.findMany({
    where: { businessId, status },
    orderBy: { createdAt: 'asc' },
    select: rowSelect,
  });
  return rows.map(shape);
}

export interface CreateWaitlistEntryInput {
  businessId: string;
  clientId: string;
  serviceId: string;
  /** Empty = any qualified provider. */
  providerIds: string[];
  fromDay: string;
  toDay: string;
  dayParts: string[];
}

export async function createWaitlistEntry(db: Db, input: CreateWaitlistEntryInput): Promise<WaitlistEntryRow> {
  if (input.fromDay > input.toDay) {
    throw new WaitlistEntryRejected('toDay', 'That range ends before it starts.');
  }
  const badTag = input.dayParts.find((tag) => !(DAY_PART_TAGS as readonly string[]).includes(tag));
  if (badTag) throw new WaitlistEntryRejected('dayParts', `Not a day-part: ${badTag}`);

  const [client, service, providers] = await Promise.all([
    db.client.findFirst({ where: { id: input.clientId, businessId: input.businessId } }),
    db.service.findFirst({ where: { id: input.serviceId, businessId: input.businessId } }),
    input.providerIds.length
      ? db.provider.findMany({ where: { id: { in: input.providerIds }, businessId: input.businessId } })
      : Promise.resolve([]),
  ]);
  if (!client) throw new WaitlistEntryRejected('clientId', 'No such client.');
  if (!service) throw new WaitlistEntryRejected('serviceId', 'No such service.');
  if (providers.length !== input.providerIds.length) {
    throw new WaitlistEntryRejected('providerIds', 'One of those is not on the roster.');
  }

  const row = await db.waitlistEntry.create({
    data: {
      businessId: input.businessId,
      clientId: input.clientId,
      serviceId: input.serviceId,
      providerIds: input.providerIds,
      fromDay: input.fromDay,
      toDay: input.toDay,
      dayParts: input.dayParts,
    },
    select: rowSelect,
  });
  return shape(row);
}

/** The whole lifecycle in one setter — `active → fulfilled | expired |
 *  cancelled` — because there is exactly one reader of the status column
 *  today and a status-transition table for a four-value enum with one
 *  reader is the abstraction CLAUDE.md's status-module rule exists to avoid
 *  building before it earns its keep. */
export async function setWaitlistEntryStatus(
  db: Db,
  args: { businessId: string; entryId: string; status: WaitlistStatus },
): Promise<void> {
  await db.waitlistEntry.updateMany({
    where: { id: args.entryId, businessId: args.businessId },
    data: { status: args.status },
  });
}

export interface FreedSlot {
  businessId: string;
  providerId: string;
  serviceId: string;
  day: CalendarDay;
  time: WallTime;
  /** The length of what actually opened up — `blockedEnd - blockedStart` of
   *  the appointment that freed it, in minutes. Buffer-inclusive, because
   *  that is the range the exclusion constraint just let go of. */
  freedMinutes: number;
}

export interface MatchedEntry {
  id: string;
  clientId: string;
  clientName: string | null;
  clientPhone: string | null;
  fromDay: string;
  toDay: string;
  dayParts: string[];
  createdAt: Date;
}

/**
 * WAIT-01/02 — "who wants this slot?", for one freed interval on one
 * provider. Candidates are pre-filtered in SQL to what could possibly match
 * (same service, this provider acceptable, the day in range); the day-part
 * tags and the fit check both need data the query alone can't express and
 * run in JS over what's left.
 */
export async function matchFreedSlot(db: Db, freed: FreedSlot): Promise<MatchedEntry[]> {
  const candidates = await db.waitlistEntry.findMany({
    where: {
      businessId: freed.businessId,
      status: 'active',
      serviceId: freed.serviceId,
      fromDay: { lte: freed.day },
      toDay: { gte: freed.day },
      OR: [{ providerIds: { isEmpty: true } }, { providerIds: { has: freed.providerId } }],
    },
    select: {
      id: true,
      clientId: true,
      fromDay: true,
      toDay: true,
      dayParts: true,
      createdAt: true,
      client: { select: { name: true, phone: true } },
    },
    orderBy: { createdAt: 'asc' },
  });
  if (candidates.length === 0) return [];

  // Every candidate wants the SAME service (filtered above) with THIS
  // provider, so "does it fit" is one lookup, not one per entry.
  const [service, override] = await Promise.all([
    db.service.findUniqueOrThrow({
      where: { id: freed.serviceId },
      select: { durationMinutes: true, bufferBeforeMinutes: true, bufferAfterMinutes: true },
    }),
    db.serviceProvider.findUnique({
      where: { serviceId_providerId: { serviceId: freed.serviceId, providerId: freed.providerId } },
      select: { durationOverrideMinutes: true },
    }),
  ]);
  const footprintMinutes =
    service.bufferBeforeMinutes +
    effectiveDurationMinutes(service.durationMinutes, override?.durationOverrideMinutes) +
    service.bufferAfterMinutes;
  if (footprintMinutes > freed.freedMinutes) return [];

  const tags = tagsFor(freed.day, freed.time);
  return candidates.filter((entry) => matchesDayParts(entry.dayParts, tags)).map((entry) => ({
    id: entry.id,
    clientId: entry.clientId,
    clientName: entry.client.name,
    clientPhone: entry.client.phone,
    fromDay: entry.fromDay,
    toDay: entry.toDay,
    dayParts: entry.dayParts,
    createdAt: entry.createdAt,
  }));
}
