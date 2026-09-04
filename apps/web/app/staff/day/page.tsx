import Link from 'next/link';
import { prisma } from '@bookable/db';
import { loadDayView } from '@bookable/db/day';
import { countUnfinished, listOpenedSlots } from '@bookable/db/appointments';
import { clientReliability } from '@bookable/db/clients';
import { resolveStaffNames } from '@bookable/db/auth';
import { addDays, calendarDay, fromDate, toLabel, zoneId } from '@bookable/core/time';
import { requireStaff } from '@/lib/auth/session';
import { readableDay } from '@/lib/customer-format';
import { toGridModel } from '@/lib/day/view-model';
import { flagSentence } from '@/components/client-flag';
import { DateJump } from '@/components/date-jump';
import { Tab, Tabs } from '@/components/ui/tabs';
import { DayGrid } from './day-grid';
import { DaySheet } from './day-sheet';
import { ProviderDay } from './provider-day';
import { RoomStrip } from './room-strip';

export const dynamic = 'force-dynamic';

/**
 * THE ONE SCREEN (Goal 3): every provider's day, side by side.
 *
 * The day is always the BUSINESS's calendar day — "today" here is the salon's
 * today, never the browser's. A front desk on a laptop still set to the last
 * holiday's timezone must see the same grid as the one beside it.
 *
 * `?provider=` switches to the single-column list a stylist reads on her own
 * phone between clients: the same data, without the horizontal scrolling that
 * a four-column grid forces on a small screen.
 */
export default async function DayPage({ searchParams }: PageProps<'/staff/day'>) {
  const staff = await requireStaff();
  const { day: dayParam, provider: providerParam, sheet: sheetParam } = await searchParams;

  const business = await prisma.business.findUniqueOrThrow({
    where: { id: staff.businessId },
    select: { timezone: true },
  });
  const now = new Date();
  const today = toLabel(fromDate(now), zoneId(business.timezone)).day;
  const day = safeDay(typeof dayParam === 'string' ? dayParam : undefined, today);

  const view = await loadDayView(prisma, { businessId: staff.businessId, day, now });

  // A-043: derived, never stored — and NOT scoped to the day being viewed.
  // What opened up is a fact about the weeks ahead, so paging to last Tuesday
  // must not empty the tab.
  const opened = await listOpenedSlots(prisma, { businessId: staff.businessId, now });
  // A-076. The COUNT, not just the link — the same reasoning A-043 gave for
  // "Opened up (N)": a door nobody knows to walk through is a door nobody walks
  // through, and eleven unclosed appointments are invisible by definition.
  const unfinished = await countUnfinished(prisma, { businessId: staff.businessId, now });

  // CLIENT-04, one grouped query for the whole day rather than one per chip.
  // Counted against TODAY, not the day being viewed: the window is "the last
  // 12 months" as of now, and paging back through March must not re-judge her
  // by what her record looked like in March.
  const flags = await clientReliability(prisma, {
    businessId: staff.businessId,
    clientIds: view.columns.flatMap((c) => c.appointments.map((a) => a.clientId).filter((id) => id !== null)),
    today,
  });
  const missedByClient = new Map(
    [...flags].flatMap(([id, reliability]) => {
      const sentence = flagSentence(reliability);
      return sentence ? [[id, sentence] as const] : [];
    }),
  );

  // A-059. "Told at 14:12 by Sam", not "by the front desk" — A-037's point,
  // and the reason the tick is worth anything to the second person at the desk.
  const staffNames = await resolveStaffNames(
    prisma,
    view.columns.flatMap((c) => c.lateCalls.map((call) => call.told?.actorRef).filter((ref) => ref != null)),
  );

  const model = toGridModel(view, now, readableDay(day), missedByClient, staffNames);
  const providerId = typeof providerParam === 'string' ? providerParam : null;
  const column = providerId ? model.columns.find((c) => c.providerId === providerId) : null;
  // A-062. The sheet REPLACES the grid rather than sitting beside it hidden:
  // a second copy of the day in the DOM is a second copy every text locator
  // has to know about, for a rendering only a printer ever sees. It is also
  // better on screen — the desk reads what is about to come out of the
  // printer before spending the paper on it.
  const asSheet = sheetParam === '1';

  return (
    <main className="mx-auto flex w-full max-w-6xl flex-1 flex-col gap-6 p-6">
      {/* Every control on the page is screen-only: a printed "Walk-in" button
          is ink, and the sheet carries its own heading. */}
      <div className="flex flex-col gap-6 print:hidden">
        <div className="flex flex-wrap items-baseline justify-between gap-3">
          <div>
            <Link href="/staff" className="text-sm text-zinc-500 hover:underline">
              ← Staff
            </Link>
            <h1 className="mt-1 text-2xl font-semibold tracking-tight">{model.dayLabel}</h1>
            {day === today ? null : <p className="text-sm text-zinc-500">Not today.</p>}
          </div>

          <nav aria-label="Day" className="flex items-center gap-3 text-sm">
            <Link href={link(addDays(calendarDay(day), -1), providerId)} className="underline underline-offset-4">
              ← Previous
            </Link>
            <Link href={link(today, providerId)} className="underline underline-offset-4">
              Today
            </Link>
            <Link href={link(addDays(calendarDay(day), 1), providerId)} className="underline underline-offset-4">
              Next →
            </Link>
            {/* A-039: "same again in six weeks" is one gesture, not forty-two
                taps of Next. */}
            <DateJump
              basePath="/staff/day"
              day={day}
              extraParams={providerId ? { provider: providerId } : undefined}
              label="Jump to a day"
            />
          </nav>
      </div>

      <div className="flex flex-wrap gap-2">
        {/* BOOK-04's walk-in: the client is standing at the desk, so the
            entry point is one tap from the day and asks the engine who can
            take her rather than making the front desk scan four columns. */}
        <Link
          href={`/staff/book?walkin=1&day=${day}`}
          className="rounded-md bg-zinc-900 px-3 py-2 text-sm font-medium text-white dark:bg-zinc-100 dark:text-zinc-900"
        >
          Walk-in
        </Link>
        {/* A-056 (SVC-02) — "anything Thursday? I don't mind who", which is
            the most common call the salon takes and had no door at all: the
            booking panel would not offer times without a stylist, so one day
            meant one pass per column. */}
        <Link
          href={`/staff/book?provider=any&day=${day}`}
          className="rounded-md border border-zinc-400 px-3 py-2 text-sm font-medium dark:border-zinc-600"
        >
          Anyone
        </Link>
        {/* AVAIL-05. One tap from the day, because the morning somebody calls
            in sick is the morning this has to be findable. */}
        <Link href={`/staff/conflicts?day=${day}`} className="rounded-md border border-zinc-400 px-3 py-2 text-sm font-medium dark:border-zinc-600">
          Conflicts
        </Link>
        {/* APPT-02: the desk's other daily errand — who tomorrow hasn't said
            yes yet. */}
        <Link href="/staff/call-down" className="rounded-md border border-zinc-400 px-3 py-2 text-sm font-medium dark:border-zinc-600">
          Call-down
        </Link>
        {/* A-062. The 8:45 errand: one column per page, pinned at each
            station, and the thing that still works when the broadband does
            not. `?provider=` carries through, so a stylist prints her own. */}
        <Link
          href={sheetLink(day, providerId)}
          className="rounded-md border border-zinc-400 px-3 py-2 text-sm font-medium dark:border-zinc-600"
        >
          Print sheet
        </Link>
        {/* A-043 (WAIT-02). A cancellation that arrives on a Saturday for next
            Thursday shows on the grid only on Thursday, which the desk has no
            reason to open. The count is the whole point of the tab: a door
            nobody knows to walk through is the gap this row closes. */}
        <Link
          href="/staff/opened"
          className="rounded-md border border-zinc-400 px-3 py-2 text-sm font-medium dark:border-zinc-600"
        >
          Opened up{opened.length > 0 ? ` (${opened.length})` : ''}
        </Link>
        {/* A-076 (D-46). The six-o'clock errand, on the screen the desk is
            already on. Hidden at zero like the count above: a permanent link to
            an empty list is a link that stops being read, and this one is only
            worth a tap when there is something behind it. */}
        {unfinished > 0 ? (
          <Link
            href="/staff/unfinished"
            className="rounded-md border border-zinc-400 px-3 py-2 text-sm font-medium dark:border-zinc-600"
          >
            Still open ({unfinished})
          </Link>
        ) : null}
      </div>

      {/* A-089. The same links, the same `aria-current`, through the primitive
          — which is also what gives the selected tab a print rule the hand-
          written version never had. */}
      <Tabs label="View">
        <Tab href={link(day, null)} current={!providerId}>
          Everyone
        </Tab>
        {model.columns.map((c) => (
          <Tab key={c.providerId} href={link(day, c.providerId)} current={providerId === c.providerId}>
            {c.providerName}
          </Tab>
        ))}
      </Tabs>
      </div>

      {asSheet ? (
        /* `?provider=` prints that one stylist; otherwise the whole salon,
           one column per page. */
        <DaySheet model={model} columns={column ? [column] : model.columns} />
      ) : (
        <div className="flex flex-col gap-6">
          {model.columns.length === 0 ? (
            <p className="text-zinc-500">No providers yet. Add one in Providers.</p>
          ) : column ? (
            <ProviderDay column={column} />
          ) : (
            <DayGrid model={model} />
          )}

          {/* A-046. Below the columns and on both views, because the room is
              shared: a stylist reading her own day on her phone is refused by
              the same four chairs as the desk is. */}
          <RoomStrip model={model} />
        </div>
      )}
    </main>
  );
}

function link(day: string, providerId: string | null): string {
  const params = new URLSearchParams({ day });
  if (providerId) params.set('provider', providerId);
  return `/staff/day?${params}`;
}

/** A-062's door, carrying whatever the desk was already looking at. */
function sheetLink(day: string, providerId: string | null): string {
  return `${link(day, providerId)}&sheet=1`;
}

/** A hand-edited `?day=` is ordinary input, not an error worth a 500. */
function safeDay(candidate: string | undefined, today: string): string {
  if (!candidate) return today;
  try {
    return calendarDay(candidate);
  } catch {
    return today;
  }
}
