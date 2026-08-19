/**
 * THE DENSITY SEED (A-011, §9). Appointments on top of A-025's setup seed.
 *
 * ANCHORED TO FIXED DATE CONSTANTS, never to `now` (CLAUDE.md). A seed
 * anchored to the current date makes the DST fixtures exist in March and
 * vanish in July with nothing failing — the demo silently loses the two days
 * the whole project is about, and no test goes red to say so.
 *
 * DETERMINISTIC. The only randomness is a seeded PRNG, so the same command
 * produces byte-identical data every time: a demo that differs run to run
 * cannot be walked through with anybody, and a "flaky" screenshot test built
 * on it is unfixable.
 *
 * Booked through the REAL write path (`bookAppointment`), not raw inserts.
 * That is slower and worth it: the seed then proves the booking path,
 * the engine, the availability chain and the constraint all agree, and any
 * appointment it produces is one a user could actually have made.
 */
import { bookAppointment } from '../booking';
import { computeDaySlots } from '../scheduling';
import { transitionAppointment } from '../appointments';
import { staffActor } from '../../core/auth';
import { instantFromIso, toDate } from '../../core/time';
import type { PrismaClient } from '../generated/client/index.js';
import { upsertDateOverride } from '../availability';

/** The Tuesday the demo week starts. FIXED — see the module comment. */
export const SEED_ANCHOR_DAY = '2026-06-09';
/** Spring forward: 02:00 → 03:00, a 23-hour day (spec §3.A). */
export const SPRING_FORWARD_DAY = '2026-03-08';
/** Fall back: 02:00 CDT → 01:00 CST, a 25-hour day with a doubled hour (§3.B). */
export const FALL_BACK_DAY = '2026-11-01';

/** The demo week: Tuesday through Saturday, the days the salon opens. */
export const DEMO_WEEK = ['2026-06-09', '2026-06-10', '2026-06-11', '2026-06-12', '2026-06-13'] as const;

const STAFF_STAMP = { createdByActor: 'staff' as const, actorRef: 'seed' };

/** mulberry32 — small, fast, and seeded. `Math.random()` would make the seed
 *  non-reproducible, which defeats most of its purpose. */
function prng(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface DensitySeedResult {
  appointmentsCreated: number;
  clientsCreated: number;
  /** Per-provider counts, so a caller (or a test) can assert the density
   *  targets actually landed rather than trusting the loop. */
  byProvider: Record<string, number>;
  springForwardCount: number;
  fallBackCount: number;
}

export async function seedDensity(
  prisma: PrismaClient,
  opts: { randomSeed?: number } = {},
): Promise<DensitySeedResult> {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('seedDensity refuses to run with NODE_ENV=production.');
  }

  const random = prng(opts.randomSeed ?? 20260609);
  const business = await prisma.business.findFirstOrThrow();
  const providers = await prisma.provider.findMany({
    where: { businessId: business.id, active: true },
    orderBy: { displayOrder: 'asc' },
  });
  const services = await prisma.service.findMany({
    where: { businessId: business.id, active: true },
    orderBy: { displayOrder: 'asc' },
  });
  if (providers.length < 4 || services.length < 4) {
    throw new Error('seedDensity needs the A-025 setup seed first (4 providers, 8 services).');
  }

  // Both DST days are SUNDAYS, and the setup seed opens Tue–Sat. Without
  // these overrides the two fixtures the whole project exists for would
  // contain zero appointments — and nothing would fail to say so. Opening
  // them explicitly is what makes the DST demo real.
  for (const day of [SPRING_FORWARD_DAY, FALL_BACK_DAY]) {
    for (const providerId of [null, ...providers.map((p) => p.id)]) {
      await upsertDateOverride(
        prisma,
        {
          businessId: business.id,
          providerId,
          day,
          isClosed: false,
          reason: 'DST fixture day — open for the seeded demo',
          windows: [{ open: '00:00', close: '06:00', endsNextDay: false }],
        },
        STAFF_STAMP,
      );
    }
  }

  const clients = await seedClients(prisma, business.id);

  // ORDERED, and then sorted again per provider. A findMany without an
  // orderBy returns rows in whatever order Postgres finds convenient, which
  // differs between runs — so the seeded PRNG would pick a different service
  // from a differently-ordered list and produce a different book each time.
  // A seeded generator only yields reproducible output if everything it
  // indexes into is itself in a fixed order.
  const qualifications = await prisma.serviceProvider.findMany({
    where: { businessId: business.id },
    orderBy: [{ providerId: 'asc' }, { serviceId: 'asc' }],
    select: { providerId: true, serviceId: true },
  });
  const servicesFor = new Map<string, string[]>();
  for (const q of qualifications) {
    servicesFor.set(q.providerId, [...(servicesFor.get(q.providerId) ?? []), q.serviceId]);
  }
  for (const list of servicesFor.values()) list.sort();

  const byProvider: Record<string, number> = {};
  let appointmentsCreated = 0;
  const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)]!;

  /** Books a fraction of a day's offered slots, front-loaded so the book
   *  looks like a real morning-heavy salon rather than random confetti. */
  async function fill(providerId: string, day: string, fraction: number, label: string): Promise<number> {
    // Only services this provider is actually qualified for (SVC-02). The
    // setup seed deliberately leaves the junior stylist unqualified for
    // colour work, so picking from the whole catalogue threw.
    const eligible = servicesFor.get(providerId) ?? [];
    if (eligible.length === 0) return 0;
    const serviceId = pick(eligible);
    const now = toDate(instantFromIso(`${day}T00:00:00-05:00`));
    const { slots } = await computeDaySlots(prisma, {
      businessId: business.id,
      providerId,
      serviceIds: [serviceId],
      day,
      now,
      audience: 'staff',
    });
    if (slots.length === 0) return 0;

    // A day of N slots does NOT hold N appointments: slots overlap at the
    // grid interval, so an 8-hour day offering 29 sixty-minute starts holds
    // about 7 of them. Sizing the target off `slots.length` filled every
    // column and the ~40% provider came out solid — the seed's whole purpose
    // is that the columns look DIFFERENT. Size it off how many actually fit.
    const first = slots[0]!;
    const last = slots[slots.length - 1]!;
    const spanMinutes = (last.blockedEnd - first.blockedStart) / 60_000;
    const eachMinutes = Math.max(1, (first.blockedEnd - first.blockedStart) / 60_000);
    const capacity = Math.max(1, Math.floor(spanMinutes / eachMinutes));
    const target = Math.max(1, Math.round(capacity * fraction));
    let booked = 0;
    for (const slot of slots) {
      if (booked >= target) break;
      try {
        await bookAppointment(prisma, {
          businessId: business.id,
          providerId,
          serviceIds: [serviceId],
          clientId: pick(clients).id,
          startAt: toDate(slot.start),
          now,
          actor: staffActor('seed'),
          audience: 'staff',
          idempotencyKey: `seed:${label}:${providerId}:${slot.start}`,
        });
        booked++;
      } catch {
        // A slot the engine offered can still be taken by the time we write
        // it — the seed books greedily and simply moves on, exactly as a
        // front desk would.
      }
    }
    byProvider[providerId] = (byProvider[providerId] ?? 0) + booked;
    appointmentsCreated += booked;
    return booked;
  }

  const [dana, priya, marcus, tess] = providers as [typeof providers[0], typeof providers[0], typeof providers[0], typeof providers[0]];

  // §9's density targets. Each one exists to make a specific screen honest:
  // a busy column, a quiet one, a day with genuinely nothing left, and a
  // provider whose day has a hole in the middle of it.
  for (const day of DEMO_WEEK) {
    await fill(dana.id, day, 0.85, 'dana');   // ~85% — the senior stylist's book
    await fill(priya.id, day, 0.4, 'priya');  // ~40% — room to move
  }

  // A-024's utilization tile (RPT-02) needs real {completed, no_show} minutes
  // to be anything but zero — by the time anyone views the dashboard, DEMO_WEEK
  // (June) is long past, and a real salon's week ends with appointments that
  // actually happened, not sitting forever in `booked`. Dana's week is the
  // frozen constant's provider (P) and week (W) — walked through the REAL
  // transition table (`booked → checked_in → in_progress → completed`), same
  // discipline as booking through `bookAppointment` above.
  //
  // Ordered by `startAt`, so which two are "the two seeded offenders" (demo
  // checkpoint 3's late-cancel tile) is deterministic under a fixed random
  // seed, same as everything else this file produces.
  const danaWeek = await prisma.appointment.findMany({
    where: { businessId: business.id, providerId: dana.id, startDay: { in: [...DEMO_WEEK] } },
    orderBy: { startAt: 'asc' },
    select: { id: true },
  });
  const lateCancelIds = new Set(danaWeek.slice(-2).map((a) => a.id));
  const transitionedAt = toDate(instantFromIso(`${DEMO_WEEK[DEMO_WEEK.length - 1]}T18:00:00-05:00`));
  for (const appointment of danaWeek) {
    if (lateCancelIds.has(appointment.id)) {
      await transitionAppointment(prisma, {
        appointmentId: appointment.id,
        to: 'cancelled_late',
        actor: staffActor('seed'),
        now: transitionedAt,
      });
      continue;
    }
    for (const to of ['checked_in', 'in_progress', 'completed'] as const) {
      await transitionAppointment(prisma, { appointmentId: appointment.id, to, actor: staffActor('seed'), now: transitionedAt });
    }
  }

  // Fully booked, three CONSECUTIVE days: the case where a customer must be
  // told "nothing that week" and the date picker has to grey days out.
  for (const day of DEMO_WEEK.slice(0, 3)) {
    await fill(tess.id, day, 1, 'tess-full');
  }

  // Marcus already has the split shift (A-025). Give him mid-window time off
  // on the Thursday so the gap is inside a working window rather than at its
  // edge — the shape that catches a break/absence confusion.
  await prisma.timeOff.create({
    data: {
      businessId: business.id,
      providerId: marcus.id,
      startAt: toDate(instantFromIso('2026-06-11T10:00:00-05:00')),
      endAt: toDate(instantFromIso('2026-06-11T11:30:00-05:00')),
      reason: 'Supplier meeting',
      createdByActor: 'staff',
      actorRef: 'seed',
    },
  });
  for (const day of DEMO_WEEK) {
    await fill(marcus.id, day, 0.5, 'marcus');
  }

  // The two fixture days. Booking them at all is the point: the fall-back
  // day's doubled hour must contain real, distinguishable appointments.
  const springForwardCount = await fill(dana.id, SPRING_FORWARD_DAY, 0.5, 'dst-spring');
  const fallBackCount = await fill(dana.id, FALL_BACK_DAY, 0.5, 'dst-fall');

  // Counted: these are rows in Appointment, so omitting them made the seed's
  // own log under-report its total (225 reported against 228 present). A-024
  // asserts an exact seeded utilization constant, so the total has to be true.
  appointmentsCreated += await seedNoShowHistory(
    prisma,
    business.id,
    dana.id,
    services[0]!.id,
    clients,
  );

  return {
    appointmentsCreated,
    clientsCreated: clients.length,
    byProvider,
    springForwardCount,
    fallBackCount,
  };
}

async function seedClients(prisma: PrismaClient, businessId: string) {
  const names = [
    ['Alice Hall', '+15125550101'],
    ['Jenny Moore', '+15125550102'],
    ['Sam Okafor', '+15125550103'],
    ['Rae Whitfield', '+15125550104'],
    ['Nadia Rahman', '+15125550105'],
    ['Tom Byrne', '+15125550106'],
    // D-17: a household shares a number. Two separate clients, one phone —
    // the exact case a unique index would have silently merged.
    ['Marcy Dunn', '+15125550107'],
    ['Ellie Dunn', '+15125550107'],
  ] as const;

  const created = [];
  for (const [name, phone] of names) {
    const existing = await prisma.client.findFirst({ where: { businessId, name } });
    created.push(
      existing ??
        (await prisma.client.create({
          data: { businessId, name, phone, email: `${name.split(' ')[0]!.toLowerCase()}@example.test` },
        })),
    );
  }
  return created;
}

/**
 * ≥1 client with a no-show history (§9), enough to cross CLIENT-04's default
 * threshold of 3 in a rolling 12 months.
 *
 * Booked into the PAST, which the write path refuses by design — so these go
 * in directly, then get their terminal status. The alternative (booking them
 * forward and time-travelling) would need a clock the seed does not own.
 */
async function seedNoShowHistory(
  prisma: PrismaClient,
  businessId: string,
  providerId: string,
  serviceId: string,
  clients: { id: string }[],
): Promise<number> {
  const offender = clients[0]!;
  const pastDays = ['2026-02-10', '2026-03-17', '2026-04-21'];
  // Counted from actual inserts, not from pastDays.length: the INSERT is
  // ON CONFLICT DO NOTHING, so re-seeding over existing rows creates none.
  let created = 0;

  for (const [index, day] of pastDays.entries()) {
    const startAt = `${day}T15:00:00-05:00`;
    const endAt = `${day}T16:00:00-05:00`;
    const id = `seed-noshow-${index}`;
    created += await prisma.$executeRawUnsafe(
      `INSERT INTO "Appointment"
         (id,"businessId","providerId","clientId",status,"startAt","endAt",
          "bufferBeforeMinutes","bufferAfterMinutes","isOverride","blockedStart","blockedEnd",
          "startDay","startWallTime","updatedAt")
       VALUES ($1,$2,$3,$4,'no_show',$5::timestamptz,$6::timestamptz,0,0,false,'epoch','epoch',$7,'15:00', now())
       ON CONFLICT (id) DO NOTHING`,
      id,
      businessId,
      providerId,
      offender.id,
      startAt,
      endAt,
      day,
    );
    await prisma.$executeRawUnsafe(
      `INSERT INTO "AppointmentServiceLine" (id,"businessId","appointmentId","serviceId",ordinal,"priceCents","durationMinutes","updatedAt")
       VALUES ($1,$2,$3,$4,0,5500,60, now()) ON CONFLICT (id) DO NOTHING`,
      `${id}-line`,
      businessId,
      id,
      serviceId,
    );
  }

  return created;
}
