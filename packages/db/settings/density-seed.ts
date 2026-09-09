/**
 * THE DENSITY SEED (A-011, §9). Appointments on top of A-025's setup seed.
 *
 * TWO BOOKS, TWO ANCHORS, and the distinction is the whole of A-081.
 *
 * The FIXED book is anchored to date constants, never to `now` (CLAUDE.md): a
 * seed anchored to the current date makes the DST fixtures exist in March and
 * vanish in July with nothing failing — the demo silently loses the two days
 * the whole project is about, and no test goes red to say so.
 *
 * The MOVING book (A-081, at the bottom of `seedDensity`) is anchored to `now`
 * on purpose and does not replace it. Every date-relative surface built in
 * Phases 6-8 renders its empty state once the fixed book is twelve weeks old —
 * measured, `unfinished 0, opened up 0, on today's book 0` against 227 seeded
 * appointments — so a fresh install demonstrated none of them. The two do not
 * interfere: the moving window skips any day near the fixed fixtures.
 *
 * DETERMINISTIC GIVEN `randomSeed` AND `now`. The only randomness is a seeded
 * PRNG, so the same command produces byte-identical data: a demo that differs
 * run to run cannot be walked through with anybody, and a "flaky" screenshot
 * test built on it is unfixable. A-081 added `now` to that list rather than
 * breaking it — the moving book below shifts with the calendar by design, so
 * any test asserting an exact shape must FREEZE `now`, exactly as every engine
 * test already does.
 *
 * Booked through the REAL write path (`bookAppointment`), not raw inserts.
 * That is slower and worth it: the seed then proves the booking path,
 * the engine, the availability chain and the constraint all agree, and any
 * appointment it produces is one a user could actually have made.
 */
import { bookAppointment } from '../booking';
// Direct file imports, not the `../notifications` barrel: that barrel pulls in
// reminders.ts, which reaches back into `../appointments` — the same cycle
// reminders.ts's own header warns about, through the other door.
import { dispatchPendingNotifications } from '../notifications/dispatch';
import { computeDaySlots } from '../scheduling';
import {
  listOpenedSlots,
  listUnconfirmedTomorrow,
  recordCallAttempt,
  releaseNoShowTime,
  transitionAppointment,
} from '../appointments';
import { recordCallMark } from '../clients';
import { LAPSED_WEEKS, listLapsedClients } from '../reports';
import { createWaitlistEntry } from '../waitlist';
import { staffActor } from '../../core/auth';
import { LOGGING_ADAPTER_ID } from '../../core/notifications';
import type { ChannelAdapter, SendResult } from '../../core/notifications';
import {
  type ZoneId,
  addDays,
  calendarDay,
  fromDate,
  instant,
  instantFromIso,
  resolve,
  toDate,
  toLabel,
  wallTime,
  zoneId,
} from '../../core/time';
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

/** A-081 — how far either side of `now` the moving book runs. Nine and nine:
 *  enough past for a fortnight of unclosed rows (`UNFINISHED_LOOKBACK_DAYS` is
 *  21) and enough future for `/staff/opened` to have somewhere to sell to
 *  (`FREED_LOOKBACK_DAYS` is 14). */
const RECENT_BACK_DAYS = 9;
const RECENT_FORWARD_DAYS = 9;

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
  /** A-081 — the days of the `now`-anchored book, fixed-fixture collisions
   *  already removed. A caller (or a test) asserts against these rather than
   *  recomputing the window and quietly disagreeing about the margin. */
  recentDays: string[];
  /** How many recent past appointments were deliberately left open, so a test
   *  can assert `/staff/unfinished` has something on it rather than trusting
   *  the modulo. */
  leftUnfinished: number;
  /** A-108 — outbox rows actually SENT rather than merely written. Returned
   *  and printed for A-095's reason: the number that was silently zero for
   *  eight items is the number worth being able to notice. */
  dispatched: number;
  /** A-095 — the four tables that were empty on a book with hundreds of
   *  appointments in it. Returned as counts for the same reason
   *  `leftUnfinished` is: whether the demo has anything on these screens is
   *  the property this half of the seed exists to guarantee, and a caller
   *  must be able to assert it rather than trust a loop. */
  waitlistEntries: number;
  callMarks: number;
  callDownAttempts: number;
  lapsedClients: number;
}

export async function seedDensity(
  prisma: PrismaClient,
  opts: { randomSeed?: number; now?: Date } = {},
): Promise<DensitySeedResult> {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('seedDensity refuses to run with NODE_ENV=production.');
  }

  const random = prng(opts.randomSeed ?? 20260609);
  // A PARAMETER, defaulted — the moving half of this seed (A-081, below) needs
  // to know what day it is, and a test that cannot freeze that has no way to
  // assert the book it produces.
  const now = opts.now ?? new Date();
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

  // NOT IDEMPOTENT, and it refuses rather than pretending otherwise.
  //
  // `seedSetup` next door IS idempotent and is tested as such. This one cannot
  // cheaply be: `fill()` sizes its target off the slots still FREE, so a second
  // pass books into whatever the first pass left (and into the two slots the
  // `cancelled_late` transitions gave back), and the `booked → … → completed`
  // walk cannot be re-applied to a row already sitting in `completed`.
  //
  // Measured, before this guard existed: a second run wrote 11 more
  // appointments and THEN threw `completed → checked_in: not-permitted`,
  // leaving a book that was neither the first run's nor the second's. A clean
  // refusal costs three lines; the alternative is state-dependent arithmetic
  // for a case with no legitimate caller — every real one (`db:reset:test`,
  // `db:seed:dev` on a fresh database, and every test that seeds density)
  // starts from an empty book.
  const existingAppointments = await prisma.appointment.count({ where: { businessId: business.id } });
  if (existingAppointments > 0) {
    throw new Error(
      `seedDensity refuses to run on a book that already holds ${existingAppointments} appointments: ` +
        'it is not idempotent. Reset the database first (npm run db:reset:test).',
    );
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
    // BOOKED AS OF THAT DAY'S MIDNIGHT, not as of the seed's `now`: the write
    // path refuses a booking in the past, and half of A-081's moving book is
    // deliberately in it. Named `asOf` rather than `now` since A-081 gave the
    // seed a real `now` of its own, and the two are different questions.
    const asOf = toDate(instantFromIso(`${day}T00:00:00-05:00`));
    const { slots } = await computeDaySlots(prisma, {
      businessId: business.id,
      providerId,
      serviceIds: [serviceId],
      day,
      now: asOf,
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
          now: asOf,
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

  // ── A-081 (D-48) — THE BOOK THAT MOVES ─────────────────────────────────
  //
  // Everything above is anchored to fixed constants, and that is correct: a
  // `now`-anchored seed makes the DST fixtures exist in March and vanish in
  // July with nothing failing. Twelve weeks past `SEED_ANCHOR_DAY` the same
  // correctness meant every date-relative surface built in Phases 6-8 rendered
  // its EMPTY STATE on a freshly seeded database. Measured 2026-09-02 against
  // 227 seeded appointments: `unfinished 0, opened up 0, on today's book 0`,
  // with 176 rows past and still open — every one of them out of reach. Nobody
  // had ever seen `/staff/unfinished`, `/staff/opened` or the day grid on a
  // full book, and the e2e specs could not say so because `e2e/fixtures.ts`
  // TRUNCATEs and seeds its own rows. That is CLAUDE.md's "dormant on a fresh
  // install" trap wearing a demo hat.
  //
  // So a SECOND book, anchored to `now`, BESIDE the fixed one rather than
  // instead of it. The DST days and `DEMO_WEEK` do not move by a day, and any
  // date this window would land on near them is skipped — with a margin, since
  // A-024 asserts an exact utilization constant over DEMO_WEEK's whole ISO
  // WEEK and a Monday or Sunday added to it would be measured too.
  //
  // `now` is a parameter (see the top of this function). Nothing here reads the
  // clock, so a test can freeze the day and assert the book it produces.
  const zone = zoneId(business.timezone);
  const today = toLabel(fromDate(now), zone).day;
  const reserved = new Set<string>();
  for (const fixed of [...DEMO_WEEK, SPRING_FORWARD_DAY, FALL_BACK_DAY]) {
    for (let offset = -3; offset <= 3; offset += 1) reserved.add(addDays(calendarDay(fixed), offset));
  }
  const recentDays: string[] = [];
  for (let offset = -RECENT_BACK_DAYS; offset <= RECENT_FORWARD_DAYS; offset += 1) {
    const day = addDays(today, offset);
    // Days the salon does not open need no special case: `fill` finds no slots
    // and returns 0. Only a collision with the fixed fixtures does.
    if (!reserved.has(day)) recentDays.push(day);
  }

  // ALL FOUR COLUMNS, and A-095 is the item that noticed only two were here.
  //
  // The fixed book fills every provider; this one filled Dana and Priya, so
  // from today onwards Marcus and Tess were EMPTY — two of four columns blank
  // on every screen anybody demos, and, less visibly, THE ROOM NEVER BOUND.
  // Measured before this line existed: peak 2 concurrent chair holds in the
  // future book against 4 chairs, and a read-only sweep of ten future days ×
  // four providers × eight services returned 2,937 offers and NOT ONE
  // `no-resource-free`. Checkpoint 6's entire finding — the read model that
  // predicts the chair chooser's answer — is unreachable on a book where the
  // number of chairs in use never exceeds the number of stylists working.
  //
  // Four different fractions, for §9's reason: the columns must look DIFFERENT
  // or the day view is being demonstrated against a uniform book. Tess is the
  // busy one here (she is the one with no midday break) rather than Dana, so
  // the moving book is not simply the fixed book's shape again.
  for (const day of recentDays) {
    await fill(dana.id, day, 0.7, 'recent-dana');
    await fill(priya.id, day, 0.4, 'recent-priya');
    await fill(marcus.id, day, 0.55, 'recent-marcus');
    await fill(tess.id, day, 0.85, 'recent-tess');
  }

  // WHAT THE DESK ACTUALLY LEFT BEHIND. A real book does not end the week
  // tidy — A-076's opening paragraph is the whole fixture: check-in gets
  // tapped because the client is standing there, "complete" gets tapped maybe
  // two-thirds of the time because at the till you are taking money, rebooking
  // her and answering the phone. So the past half of this window is closed out
  // UNEVENLY and on purpose, one in four never checked in and one in four
  // checked in and never closed.
  //
  // Deterministic BY POSITION, never off the PRNG: whether `/staff/unfinished`
  // has anything on it is the property this fixture exists to guarantee, and a
  // random mix makes that a different answer every run.
  const recentPast = await prisma.appointment.findMany({
    where: { businessId: business.id, startDay: { in: recentDays }, endAt: { lt: now }, status: 'booked' },
    // `id` as the tiebreak, not decoration: two providers can start at the
    // same instant, and `findMany` would then order those two however Postgres
    // felt, which moves the modulo below and changes the fixture.
    orderBy: [{ startAt: 'asc' }, { id: 'asc' }],
    select: { id: true, startAt: true, endAt: true },
  });
  let leftUnfinished = 0;
  for (const [index, row] of recentPast.entries()) {
    // The visit's OWN clock, not the seed's. D-47 stamps a timestamp only
    // while the visit is plausibly still happening, so passing `now` here
    // would close every seeded visit with three NULL timestamps and give the
    // appointment panel nothing to render — the seed would be demonstrating
    // A-080's refusal rather than a salon's day.
    const stage = index % 4;
    if (stage === 0) {
      leftUnfinished += 1; // never checked in
      continue;
    }
    await transitionAppointment(prisma, { appointmentId: row.id, to: 'checked_in', actor: staffActor('seed'), now: row.startAt });
    if (stage === 1) {
      leftUnfinished += 1; // she was seen to arrive and nobody closed it
      continue;
    }
    await transitionAppointment(prisma, { appointmentId: row.id, to: 'in_progress', actor: staffActor('seed'), now: row.startAt });
    await transitionAppointment(prisma, { appointmentId: row.id, to: 'completed', actor: staffActor('seed'), now: row.endAt });
  }

  // A-043's cancellation and A-069's release, the two things `/staff/opened`
  // renders — and it too was empty on a fresh install.
  //
  // The CANCELLATION goes on a future row, because `listOpenedSlots` sells
  // FUTURE time: a Tuesday that has already happened is not a phone call.
  //
  // The RELEASE goes on today's LAST STARTED row — ordinarily the one still
  // running — and that is the honest place for it rather than a convenient
  // one. A-069's scene is a slot that has begun and a client who has not
  // arrived: she has to be past her start for there to be a no-show at all,
  // and the tail has to be ahead of `now` for there to be anything left to
  // sell. Seeded after closing there is no running row and it falls back to
  // the day's last finished one — still the cut range the day grid needs,
  // just with nothing left to offer. The cancellation is what keeps
  // `/staff/opened` non-empty either way.
  const recentFuture = await prisma.appointment.findMany({
    where: { businessId: business.id, startDay: { in: recentDays }, startAt: { gt: now }, status: 'booked' },
    orderBy: [{ startAt: 'asc' }, { id: 'asc' }],
    select: { id: true },
  });
  // Not the very next one: a cancellation inside the cutoff is `cancelled_late`
  // and a different fixture, and the demo wants an ordinary one.
  const toCancel = recentFuture[Math.min(3, recentFuture.length - 1)];
  if (toCancel) {
    await transitionAppointment(prisma, { appointmentId: toCancel.id, to: 'cancelled', actor: staffActor('seed'), now });
  }

  const todaysLast = await prisma.appointment.findFirst({
    where: { businessId: business.id, startDay: today, status: 'booked', startAt: { lt: now } },
    orderBy: [{ startAt: 'desc' }, { id: 'asc' }],
    select: { id: true, startAt: true, endAt: true },
  });
  if (todaysLast) {
    await transitionAppointment(prisma, { appointmentId: todaysLast.id, to: 'no_show', actor: staffActor('seed'), now: todaysLast.endAt });
    await releaseNoShowTime(prisma, {
      businessId: business.id,
      appointmentId: todaysLast.id,
      // Halfway through. The whole point of A-069 is that the range gets CUT
      // rather than freed, so a release at `startAt` (nothing occupied) or at
      // `endAt` (refused outright) would demonstrate neither.
      releasedAt: toDate(
        instant(fromDate(todaysLast.startAt) + Math.floor((fromDate(todaysLast.endAt) - fromDate(todaysLast.startAt)) / 2)),
      ),
      actor: staffActor('seed'),
      reason: 'Twenty minutes late and not answering',
    });
  }

  // ── A-095 — THE FOUR EMPTY TABLES ──────────────────────────────────────
  //
  // A-081 gave the book a moving half so the date-relative SCREENS stopped
  // rendering their empty state. This is the same trap one layer down: a
  // screen can be full of appointments and still be empty of the thing it is
  // FOR. Checkpoint 7 walked a seeded book of 453 appointments and this item
  // re-measured one of 411 at the seed tests' frozen `now`; both carried zero
  // waitlist entries, zero call marks, zero call-down attempts and zero
  // lapsed clients. So WAIT-01–04, A-021, A-023, A-043, A-072, A-073 and
  // `/staff/opened`'s "Who wants this slot?" all rendered *"Nobody on the
  // waitlist fits this one"* on a full book, and nobody had ever seen any of
  // them with a row on it.
  //
  // Everything here that CAN go in through its real write path does, for the
  // same reason the appointments do: the seed then proves the path, and any
  // row it produces is one a person at the desk could actually have made. The
  // one exception is `seedLapsedHistory`, whose rows are deliberately in the
  // past — see its own header for why that cannot use the write path.
  const lapsedClients = await seedLapsedHistory(prisma, business.id, now, zone, reserved, providers, services);

  // The waitlist is DERIVED FROM THE ROW THAT WAS CANCELLED, and getting that
  // wrong once is why this comment is long.
  //
  // `matchFreedSlot` is a conjunction — same service, this provider acceptable,
  // the day in range, EVERY day-part tag satisfied, and the service's whole
  // FOOTPRINT inside the freed minutes — so an entry invented independently of
  // the book matches nothing and the screen renders the same empty state it
  // did with no entries at all. That failure is INVISIBLE: the list is there,
  // it simply says nobody fits.
  //
  // Deriving it from "whichever span opened up" is not enough either, and that
  // version was written and measured before this one: `/staff/opened` carries
  // A-069's RELEASED TAIL as well as A-043's cancellation, and a tail is
  // twenty-five minutes of a two-hour colour. Its `primaryServiceId` is still
  // the colour, whose footprint is 150 minutes, so the last line of
  // `matchFreedSlot` refuses it — correctly, and silently, and the demo's
  // first click lands on "Nobody on the waitlist fits this one" exactly as it
  // did before the entry existed.
  //
  // THE CANCELLED ROW IS THE ONE SPAN WHOSE FREED MINUTES ARE THE WHOLE
  // FOOTPRINT, by construction: `blockedEnd - blockedStart` is buffers plus
  // the effective duration, which is what the footprint sums. So the match is
  // guaranteed by arithmetic rather than by whichever service `fill` happened
  // to pick — and `density-seed.test.ts`'s "puts a name against a slot that
  // actually opened up" asserts it by RUNNING `matchFreedSlot` against the
  // seed, rather than by trusting this paragraph or counting the rows.
  const freed = await listOpenedSlots(prisma, { businessId: business.id, now });
  let waitlistEntries = 0;
  let callMarks = 0;

  const wants = freed.find((slot) => slot.appointmentId === toCancel?.id && slot.primaryServiceId !== null);
  if (wants) {
    // NOT the client whose appointment freed it — she is the one who dropped
    // the slot, and offering it back to her is the one call the desk would
    // never make. `OpenedSlot` carries her NAME rather than her id (it is a
    // list built to be phoned from), so that is what this compares. Picked by
    // position from a fixed list, never off the PRNG: whether the demo's first
    // click finds a match is not a coin toss.
    const hopeful = clients.find((client) => client.name !== wants.clientName) ?? clients[1]!;
    const entry = await createWaitlistEntry(prisma, {
      businessId: business.id,
      clientId: hopeful.id,
      serviceId: wants.primaryServiceId!,
      // Any qualified stylist, no day-part preference: the entry that MUST
      // match, so the freed slot always has at least one name against it.
      providerIds: [],
      fromDay: recentDays[0]!,
      toDay: recentDays[recentDays.length - 1]!,
      dayParts: [],
    });
    waitlistEntries += 1;

    // A-072/A-073 — SHE HAS ALREADY BEEN RUNG, AND SHE IS THINKING ABOUT IT.
    // The whole reason that table exists is the second person at the desk
    // opening the same list at 4pm; a list where nobody has been rung yet
    // demonstrates the screen without demonstrating the point of it.
    if (
      await recordCallMark(prisma, {
        businessId: business.id,
        subject: `freed:${wants.key}`,
        appointmentId: wants.appointmentId,
        clientId: entry.clientId,
        outcome: 'thinking',
        actor: staffActor('seed'),
      })
    ) {
      callMarks += 1;
    }
  }

  // Two more that do NOT match that slot, because a list with one row on it
  // never shows the desk that entries are filtered rather than merely listed:
  // one narrowed to a single stylist, one to Saturday mornings.
  const saturdayHopeful = clients[4]!;
  const pickyHopeful = clients[5]!;
  for (const [clientId, providerIds, dayParts] of [
    [saturdayHopeful.id, [] as string[], ['saturday', 'morning']],
    [pickyHopeful.id, [dana.id], ['afternoon']],
  ] as const) {
    await createWaitlistEntry(prisma, {
      businessId: business.id,
      clientId,
      // The salon's signature service, and the one worth ringing about.
      serviceId: services.find((service) => service.name === 'Colour')?.id ?? services[0]!.id,
      providerIds: [...providerIds],
      fromDay: recentDays[0]!,
      toDay: addDays(calendarDay(recentDays[recentDays.length - 1]!), 21),
      dayParts: [...dayParts],
    });
    waitlistEntries += 1;
  }

  // A-073's second errand for the same table. One row so `/staff/dashboard/
  // lapsed` renders a rung client beside un-rung ones — A-092 measured that
  // screen at thirty rows and its axe test could only ever see the half of the
  // row that exists before anybody starts working the list.
  const lapsed = await listLapsedClients(prisma, { businessId: business.id, now });
  const rung = lapsed[0];
  if (
    rung &&
    (await recordCallMark(prisma, {
      businessId: business.id,
      subject: 'lapsed',
      appointmentId: rung.lastAppointmentId,
      clientId: rung.clientId,
      outcome: 'left_message',
      actor: staffActor('seed'),
    }))
  ) {
    callMarks += 1;
  }

  // A-021/A-061 — tomorrow's call-down, part-worked. Two attempts with
  // DIFFERENT outcomes: "no answer" and "left a message" are the two things
  // the row can say, and a fixture that only ever writes one of them leaves
  // half the screen unrendered on every walk-through.
  const tomorrow = addDays(today, 1);
  const unconfirmed = await listUnconfirmedTomorrow(prisma, { businessId: business.id, tomorrow });
  let callDownAttempts = 0;
  for (const [index, outcome] of ([[0, 'no_answer'], [2, 'left_message']] as const)) {
    const row = unconfirmed[index];
    if (!row) continue;
    if (
      await recordCallAttempt(prisma, {
        businessId: business.id,
        appointmentId: row.id,
        outcome,
        actor: staffActor('seed'),
      })
    ) {
      callDownAttempts += 1;
    }
  }

  // A-108 — DISPATCH WHAT THIS SEED ENQUEUED.
  //
  // Every booking above writes a confirmation through the real path, and
  // nothing on a fresh install ever sent one: measured at 713 outbox rows, all
  // `pending`, all never attempted. That made `/staff/messages` the one screen
  // a demo checkpoint could not walk truthfully — and after A-108 it is worse
  // than untruthful, because an hour later the seed's own backlog becomes a
  // 713-row alarm about a job that was never asked to run. The operator asked
  // for this HERE rather than in the screen: the screen is right, the book was
  // wrong.
  const dispatched = await drainOutbox(prisma);

  return {
    appointmentsCreated,
    clientsCreated: clients.length + lapsedClients,
    dispatched,
    byProvider,
    springForwardCount,
    fallBackCount,
    recentDays,
    leftUnfinished,
    waitlistEntries,
    callMarks,
    callDownAttempts,
    lapsedClients,
  };
}

/**
 * A-095 — CLIENTS WHO HAVE NOT BEEN IN, for `/staff/dashboard/lapsed` (§8.6a).
 *
 * The report's own definition is why the seed could never produce one by
 * accident: a lapsed client has a completed visit older than `LAPSED_WEEKS`
 * AND NOTHING BOOKED AHEAD OF HER. The density seed has eight clients and
 * books hundreds of appointments among them, so by construction every one of
 * them has something in the future — measured, zero lapsed clients on a book
 * of 713 appointments. A-092 built a thirty-row screen that nobody had ever
 * seen carry a row.
 *
 * So these are people the moving book cannot reach: created here, kept out of
 * the pool `fill` draws from, and given one completed visit each and nothing
 * since.
 *
 * RAW INSERTS, like `seedNoShowHistory` next door and for the same reason —
 * the write path refuses a booking in the past by design, and time-travelling
 * a clock the seed does not own is the more expensive lie. The triggers still
 * write `blockedStart`/`blockedEnd` and the chair hold, so the constraint sees
 * these rows exactly as it sees every other one.
 */
async function seedLapsedHistory(
  prisma: PrismaClient,
  businessId: string,
  now: Date,
  zone: ZoneId,
  reserved: ReadonlySet<string>,
  providers: { id: string }[],
  services: { id: string; durationMinutes: number; priceCents: number }[],
): Promise<number> {
  const WEEK_MS = 7 * 86_400_000;
  // MEASURED FROM `LAPSED_WEEKS`, never hand-typed. The report's threshold is
  // a constant somebody may raise; a seed that hard-coded "20 weeks ago" would
  // then stop producing lapsed clients and the screen would go quietly empty
  // again, which is the exact defect this function exists to close.
  const people = [
    ['Bea Lindqvist', '+15125550111', LAPSED_WEEKS + 8],
    ['Corinne Adeyemi', '+15125550112', LAPSED_WEEKS + 14],
    ['Harriet Vance', '+15125550113', LAPSED_WEEKS + 21],
    ['Joyce Tabora', '+15125550114', LAPSED_WEEKS + 29],
    ['Nell Fairweather', '+15125550115', LAPSED_WEEKS + 40],
  ] as const;

  let created = 0;
  for (const [index, [name, phone, weeksAgo]] of people.entries()) {
    // THE SAME COLLISION GUARD THE MOVING BOOK USES. `weeksAgo` is measured
    // back from `now`, which is the real clock in a demo — so on some future
    // October "twenty weeks ago" lands squarely on `DEMO_WEEK`, the raw insert
    // meets the exclusion constraint, and the seed dies on a date nobody chose.
    // `reserved` already holds every fixed fixture day ± 3; walk back off it.
    let day = toLabel(instant(fromDate(now) - weeksAgo * WEEK_MS), zone).day;
    for (let guard = 0; reserved.has(day) && guard < 10; guard += 1) day = addDays(day, -1);
    if (reserved.has(day)) continue;

    const client = await prisma.client.upsert({
      where: { id: `seed-lapsed-${index}` },
      create: {
        id: `seed-lapsed-${index}`,
        businessId,
        name,
        phone,
        email: `${name.split(' ')[0]!.toLowerCase()}@example.test`,
      },
      update: {},
      select: { id: true },
    });

    // A DIFFERENT PROVIDER AND A DIFFERENT HOUR each, so five history rows can
    // never overlap one another whichever day the guard above settled on.
    const provider = providers[index % providers.length]!;
    const service = services[index % services.length]!;
    const startWall = wallTime(`${String(9 + (index % 4)).padStart(2, '0')}:00`);
    // THE CONVERSION MODULE, not a hardcoded `-05:00`. The neighbouring
    // no-show fixture can interpolate an offset because its days are fixed
    // constants somebody checked; these days are derived from `now`, so half
    // the year they are CST and an assumed CDT would file the visit an hour
    // off its own wall label. 09:00-12:00 is never a DST transition, so
    // `earlier` and `unique` are the same instant — taking `earlier` is what
    // makes that true by construction rather than by assumption.
    const resolved = resolve(day, startWall, zone);
    const startAt = toDate(resolved.kind === 'unique' ? resolved.at : resolved.earlier);

    const id = `seed-lapsed-visit-${index}`;
    created += await prisma.$executeRawUnsafe(
      `INSERT INTO "Appointment"
         (id,"businessId","providerId","clientId",status,"startAt","endAt",
          "bufferBeforeMinutes","bufferAfterMinutes","isOverride","blockedStart","blockedEnd",
          "startDay","startWallTime","updatedAt")
       VALUES ($1,$2,$3,$4,'completed',$5::timestamptz,$5::timestamptz + ($6 || ' minutes')::interval,
               0,0,false,'epoch','epoch',$7,$8, now())
       ON CONFLICT (id) DO NOTHING`,
      id,
      businessId,
      provider.id,
      client.id,
      startAt.toISOString(),
      String(service.durationMinutes),
      day,
      startWall,
    );
    await prisma.$executeRawUnsafe(
      `INSERT INTO "AppointmentServiceLine" (id,"businessId","appointmentId","serviceId",ordinal,"priceCents","durationMinutes","updatedAt")
       VALUES ($1,$2,$3,$4,0,$5,$6, now()) ON CONFLICT (id) DO NOTHING`,
      `${id}-line`,
      businessId,
      id,
      service.id,
      service.priceCents,
      service.durationMinutes,
    );
  }
  return created;
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

/**
 * A-108 — send everything the seed queued, in pages, until nothing is left.
 *
 * A SILENT ADAPTER, and that is the only reason it is not `notificationAdapter`
 * itself: the wired one logs a line per message, and seven hundred of them bury
 * the seed's own summary — the one line anybody reads to see whether the book
 * came out right. It keeps `LOGGING_ADAPTER_ID`, so `reallyDelivered` still
 * answers "queued" on every row and no appointment panel claims a client was
 * genuinely texted (A-048's per-row `deliveredBy`).
 */
const SILENT_LOG_ADAPTER: ChannelAdapter = {
  id: LOGGING_ADAPTER_ID,
  supports: () => true,
  async send(): Promise<SendResult> {
    return {};
  },
};

async function drainOutbox(prisma: PrismaClient): Promise<number> {
  let sent = 0;
  // Bounded rather than `while (true)`: a row that fails permanently comes back
  // `failed` and stops being claimed, so the loop terminates on its own — but a
  // seed that spins forever on an unforeseen state is a worse failure than one
  // that leaves a few rows queued.
  for (let page = 0; page < 50; page++) {
    const result = await dispatchPendingNotifications(prisma, SILENT_LOG_ADAPTER, 200);
    sent += result.sent;
    if (result.sent + result.failed + result.retrying + result.suppressed === 0) break;
  }
  return sent;
}
