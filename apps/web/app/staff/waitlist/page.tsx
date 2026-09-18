import Link from 'next/link';
import { prisma } from '@bookable/db';
import { listProviders, listServices } from '@bookable/db/settings';
import { listWaitlistEntries, matchFreedSlot, nextBookedFor } from '@bookable/db/waitlist';
import { openWeekdays } from '@bookable/db/availability';
import { findClient, listCallMarks } from '@bookable/db/clients';
import { fromDate, instant, instantFromIso, toDate, toLabel, zoneId } from '@bookable/core/time';
import { dayPartWords } from '@bookable/core/waitlist';
import { requireStaff } from '@/lib/auth/session';
import { readableDay, readableInstant } from '@/lib/customer-format';
import { OFFER_WORDS } from '@/lib/waitlist/offer-words';
import { EntryForm } from './entry-form';
import { EntryStatusButton } from './entry-status-button';
import { recordOffer } from '@/lib/waitlist/offer-actions';
import { CallMarkButtons } from '@/components/call-mark-buttons';
import { PhoneLink } from '@/components/ui/phone-link';

export const dynamic = 'force-dynamic';

/**
 * A-023 — the waitlist, staff half (WAIT-01, WAIT-02).
 *
 * Two things on one screen: the standing queue (add, and close out), and —
 * when reached from the appointment detail page's "who wants this slot?"
 * link with a freed interval named in the URL — who actually fits it.
 *
 * Automation (OQ-4's soft-hold offer) is explicitly NOT this row; this page
 * only ever answers a human "who", never sends anything itself.
 */
export default async function WaitlistPage({ searchParams }: PageProps<'/staff/waitlist'>) {
  const staff = await requireStaff();
  const params = await searchParams;

  const business = await prisma.business.findUniqueOrThrow({
    where: { id: staff.businessId },
    select: { timezone: true },
  });

  // A-110. The salon's own calendar day, in the salon's zone — what an entry
  // expires against. Never the server's.
  const today = toLabel(fromDate(new Date()), zoneId(business.timezone)).day;

  const [entries, providers, services, weekdays] = await Promise.all([
    listWaitlistEntries(prisma, { businessId: staff.businessId, today }),
    // A-098 — THE WHOLE ROSTER, then narrowed at the one place that needs it.
    //
    // This read was `includeInactive: false`, and it is used for three
    // different questions. Only ONE of them is about bookability. Naming a
    // departed stylist made `freedSlotFrom` below return null, which took the
    // entire "who wants this slot?" panel off the screen silently — the freed
    // span still existed, the link still worked, the page just rendered as if
    // it had been reached with no parameters at all. It also rendered a `?`
    // instead of her name against every waiting client who had asked for her.
    listProviders(prisma, staff.businessId, true),
    listServices(prisma, staff.businessId, false),
    // A-110 — the days somebody could actually be waiting for. The checkbox
    // list was the seven weekday names, so "Sunday and Monday only" was an
    // offerable preference at a salon that shuts on both.
    openWeekdays(prisma, staff.businessId),
  ]);

  // A-110 — WHAT THE BOOKING PANEL ALREADY HAD IN ITS HANDS.
  //
  // The refusal this list exists for is on `/staff/book`, and reaching here
  // from it used to mean searching for the same client a second time on a
  // form whose every field was on the screen just abandoned, with her still
  // on the phone. `addWaitlistEntry` is untouched — this is a prefill, not a
  // second write path.
  const prefill = readPrefill(params);
  const prefillClient = prefill.clientId ? await findClient(prisma, staff.businessId, prefill.clientId) : null;

  const now = new Date();
  const freed = freedSlotFrom(params, business.timezone, providers);
  // A-124/D-60. The matcher derives the run itself from this range — the
  // minutes in the URL are what the link SAID, and by the time somebody reads
  // this screen a blow-dry may have gone into the front of it.
  const matched = freed
    ? await matchFreedSlot(prisma, {
        businessId: staff.businessId,
        providerId: freed.providerId,
        from: freed.from,
        to: freed.to,
        now,
      })
    : null;
  const matches = matched?.entries ?? null;
  const span = matched?.span ?? null;
  // A-072. Who has already been rung about THIS span — one read for the whole
  // list, keyed on A-067's derived row key so a span freed twice is two rounds
  // of calls rather than one that remembers the wrong answers.
  const subject = freed?.key ? `freed:${freed.key}` : null;
  const marks = subject
    ? (await listCallMarks(prisma, { businessId: staff.businessId, subjects: [subject] })).get(subject) ?? []
    : [];
  // A-125/D-61. What each waiting client already holds, named on her row and
  // never used to hide her — see `nextBookedFor`.
  const booked = await nextBookedFor(prisma, {
    businessId: staff.businessId,
    clientIds: [...new Set([...entries, ...(matches ?? [])].map((entry) => entry.clientId))],
    now,
  });
  const bookedLine = (clientId: string) => {
    const next = booked.get(clientId);
    return next ? (
      <span className="mt-0.5 block text-xs font-medium text-amber-800 dark:text-amber-300">
        Already booked {readableInstant(next.startAt, business.timezone)} with {next.providerName}
      </span>
    ) : null;
  };
  const offerFor = (clientId: string | null) =>
    clientId ? marks.find((mark) => mark.clientId === clientId) : undefined;

  return (
    <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-6 p-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Waitlist</h1>
      </div>

      {freed ? (
        <section className="flex flex-col gap-3 rounded-md border border-emerald-500 p-4 dark:border-emerald-700">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-emerald-800 dark:text-emerald-400">
            Who wants this slot?
          </h2>
          {/* D-56 — THE SPAN, NOT WHATEVER FREED IT. This read "Colour with
              Priya", which was the service the matcher filtered the waitlist
              on. It no longer filters on anything of the sort, and on a
              released no-show's span — which decays all afternoon (A-109) —
              the name was of a service that no longer fitted the minutes
              beside it. What is for sale is a length of Priya's Saturday. */}
          {/* A-124/D-60 — THE SPAN AS IT IS NOW, not as the link described it.
              The heading used to read the minutes straight off the URL, so a
              range with a blow-dry already sold into its front announced its
              original length and then listed people for it. What the desk
              reads now is the remainder, and — when the free time around it is
              longer — the run that is actually on offer, because that is what
              the names below were matched against. */}
          <p className="text-sm text-zinc-600 dark:text-zinc-400">
            {span ? minutesWords(span.remainder.minutes) : minutesWords(freed.minutes)} with {freed.providerName}
            {/* A-098. The span is real and sellable; the stylist is not
                available to sell it. Saying so here is what stops the desk
                promising Tess to whoever answers the phone. */}
            {freed.providerActive ? '' : ' (off the roster — this goes to somebody else)'},{' '}
            {readableInstant(span ? span.remainder.start : toDate(instantFromIso(freed.at)), business.timezone)}.
            {span && span.run.minutes > span.remainder.minutes ? (
              <>
                {' '}
                Free either side of it —{' '}
                <span className="font-medium">
                  {readableInstant(span.run.start, business.timezone)}, {minutesWords(span.run.minutes)}
                </span>
                , which is what these fit into.
              </>
            ) : null}
          </p>
          {span === null ? (
            /* D-60. Gone, not empty: resold, or the time has passed, or the
               stylist is not working that day any more. The old screen listed
               names here and its Book links opened a refusal. */
            <p className="text-sm text-ink-muted">
              That time has gone — it has been booked, or it is past. Nothing to offer anybody.
            </p>
          ) : matches && matches.length === 0 ? (
            <p className="text-sm text-ink-muted">Nobody on the waitlist fits this one.</p>
          ) : (
            <ul className="flex flex-col gap-2">
              {matches?.map((entry) => (
                <li
                  key={entry.id}
                  className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-zinc-300 px-4 py-3 text-sm dark:border-zinc-700"
                >
                  <span>
                    <span className="font-medium">{entry.clientName ?? 'No name'}</span>{' '}
                    {/* A-043: the resolution to this list is a phone call, so
                        the number is dialable, same as every other staff list. */}
                    {entry.clientPhone ? (
                      <PhoneLink phone={entry.clientPhone} />
                    ) : null}
                    {/* D-56 — WHAT SHE IS WAITING FOR, ON THE ROW THAT IS
                        RUNG FROM. The span no longer names her services and
                        never could name a second one, so this is the only
                        place the caller can read "cut and colour" before
                        dialling. The footprint beside it is the number that
                        had to fit: "185 min of the 190 free" is a sentence
                        the desk can check against the screen it came from. */}
                    <span className="mt-0.5 block text-xs text-ink-muted">
                      {entry.serviceNames.join(' then ')} · {entry.footprintMinutes} min
                    </span>
                    {bookedLine(entry.clientId)}
                  </span>
                  <span className="flex items-center gap-2">
                    <Link
                      /* A-098. `provider=any` when the stylist whose time this
                         was has left: booking HER is refused, so a link naming
                         her is an offer the write cannot honour. The instant
                         and the day carry over unchanged — it is the same hour
                         of the same Saturday, with whoever is free.

                         D-56 — AND HER WHOLE VISIT, plus her id. The matcher
                         now offers a span because the whole visit fits it, so
                         a Book link that preselects one service (or none)
                         hands the desk a form that disagrees with the row it
                         was clicked from. `services` and `client` are the
                         parameters A-040's rebook already uses. */
                      /* A-124/D-60 — THE ENGINE'S OWN INSTANT, PER ROW. This
                         carried `freed.at` — the start of the range that was
                         freed — for everybody, which is the instant the write
                         refuses the moment anything is sold into the front of
                         it, and which is not where a 185-minute visit starts
                         inside a four-hour run anyway. `entry.startAt` is a
                         start `computeSlotsIn` offered for THIS visit, so the
                         offer and the write are answering the same question.

                         A-125/D-61 — AND THE ENTRY, so the booking write closes
                         it in its own transaction and she is not rung again
                         tomorrow about a slot she already has. */
                      href={`/staff/book?provider=${freed.providerActive ? freed.providerId : 'any'}&at=${encodeURIComponent(entry.startAt.toISOString())}&day=${dayOf(entry.startAt, business.timezone)}&client=${entry.clientId}&waitlistEntry=${entry.id}${entry.serviceIds.map((id) => `&services=${id}`).join('')}`}
                      className="rounded-md border border-zinc-400 px-2 py-1 text-xs font-medium dark:border-zinc-600"
                    >
                      Book
                    </Link>
                    <EntryStatusButton entryId={entry.id} status="fulfilled" label="Fulfilled" />
                  </span>

                  {/* A-072 — the marks, on the screen that has the names and
                      the numbers on it. A RECORD, not a hold: the Book button
                      above stays live for anybody throughout. */}
                  {freed.key && freed.appointmentId && entry.clientId ? (
                    <span className="w-full">
                      <CallMarkButtons
                        words={OFFER_WORDS}
                        current={offerFor(entry.clientId)?.outcome}
                        hidden={{
                          subject: subject!,
                          appointmentId: freed.appointmentId,
                          clientId: entry.clientId,
                        }}
                        action={recordOffer}
                        undoLabel="Not asked"
                        about={entry.clientName ?? 'No name'}
                      />
                      {offerFor(entry.clientId) ? (
                        <span className="mt-1 block text-xs text-zinc-600 dark:text-zinc-400">
                          {OFFER_WORDS[offerFor(entry.clientId)!.outcome]}
                          {offerFor(entry.clientId)!.calledByName
                            ? ` — ${offerFor(entry.clientId)!.calledByName}`
                            : ''}
                        </span>
                      ) : null}
                    </span>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </section>
      ) : null}

      {/* The one question here that IS about bookability: who a new waiting
          client may ask for. A stylist who has left is not on that list. */}
      <EntryForm
        services={services}
        providers={providers.filter((p) => p.active)}
        weekdays={weekdays}
        prefill={{ ...prefill, client: prefillClient }}
      />

      <section className="flex flex-col gap-3">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-zinc-600 dark:text-zinc-400">
          Waiting ({entries.length})
        </h2>
        {entries.length === 0 ? (
          <p className="text-sm text-ink-muted">Nobody is waiting on anything right now.</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {entries.map((entry) => {
              const providerNames = entry.providerIds.length
                ? entry.providerIds.map((id) => providers.find((p) => p.id === id)?.displayName ?? '?').join(' or ')
                : 'Any provider';
              return (
                <li
                  key={entry.id}
                  className="flex flex-wrap items-start justify-between gap-3 rounded-md border border-zinc-300 px-4 py-3 text-sm dark:border-zinc-700"
                >
                  <div>
                    <p className="font-medium">
                      {entry.clientName ?? 'No name'} <span className="font-normal text-ink-muted">{entry.clientPhone ?? ''}</span>
                    </p>
                    <p className="text-zinc-600 dark:text-zinc-400">
                      {entry.serviceNames.join(' then ')} · {providerNames} ·{' '}
                      {readableDay(entry.fromDay)}–{readableDay(entry.toDay)}
                      {/* A-119 ride-along. This joined the stored cell raw —
                          "· saturday, morning" — which is a database row, not
                          a thing anybody at a desk says. `dayPartWords` also
                          renders "no preference" out loud, where the raw join
                          rendered nothing at all and looked like a missing
                          field. */}
                      {' · '}
                      {dayPartWords(entry.dayParts)}
                    </p>
                    {bookedLine(entry.clientId)}
                  </div>
                  <div className="flex gap-2">
                    <EntryStatusButton entryId={entry.id} status="fulfilled" label="Fulfilled" />
                    <EntryStatusButton entryId={entry.id} status="cancelled" label="Remove" />
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </main>
  );
}

/** The salon's own calendar day for an instant — never the server's, and
 *  never `toISOString().slice(0, 10)` (banned repo-wide). */
function dayOf(at: Date, timezone: string): string {
  return toLabel(fromDate(at), zoneId(timezone)).day;
}

/** D-56 — the span's length as the desk would say it. Two hours and ten
 *  minutes of a Saturday is the thing being sold, and "130 min" is a unit of
 *  measurement rather than an offer. */
function minutesWords(minutes: number): string {
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours === 0) return `${rest} min free`;
  if (rest === 0) return `${hours} hr free`;
  return `${hours} hr ${rest} min free`;
}

/** Reads the freed-interval context off the URL — set by the appointment
 *  detail page's link, never typed by hand. Malformed or partial params fall
 *  back to "no freed slot", quietly: this is internal navigation state, not a
 *  form a person fills in. */
function freedSlotFrom(
  params: Awaited<PageProps<'/staff/waitlist'>['searchParams']>,
  timezone: string,
  providers: { id: string; displayName: string; active: boolean }[],
) {
  const providerId = typeof params.providerId === 'string' ? params.providerId : null;
  const at = typeof params.at === 'string' ? params.at : null;
  const minutes = typeof params.minutes === 'string' ? Number(params.minutes) : null;
  // A-072. Absent on a link built before this shipped, and absent is simply
  // "no marks on this screen" — never a crash and never a reason to refuse the
  // matcher, which is the useful half.
  const key = typeof params.key === 'string' ? params.key : null;
  const appointmentId = typeof params.appointmentId === 'string' ? params.appointmentId : null;
  if (!providerId || !at || !minutes || !Number.isFinite(minutes) || minutes <= 0) return null;

  const provider = providers.find((p) => p.id === providerId);
  if (!provider) return null;

  let start;
  try {
    start = toDate(instantFromIso(at));
    // Parsed in the salon's zone as well, so a timezone the business row no
    // longer has fails here rather than three reads later.
    toLabel(instantFromIso(at), zoneId(timezone));
  } catch {
    return null;
  }

  return {
    providerId,
    providerName: provider.displayName,
    /** A-098. Whether the Book button below may name her at all. */
    providerActive: provider.active,
    minutes,
    at,
    /** A-124/D-60 — the freed range as INSTANTS, which is all the matcher
     *  takes now. `day`/`time` are gone from `FreedSlot`: a wall-clock pair
     *  names two instants on fall-back day (D-4), and the matcher needs a
     *  range it can go and re-measure against the book. */
    from: start,
    to: toDate(instant(fromDate(start) + minutes * 60_000)),
    key,
    appointmentId,
  };
}

/**
 * A-110 — the booking panel's refusal, carried across as form defaults.
 *
 * `serviceId` here is the booking panel's own repeated parameter, and since
 * D-56 it is the ONLY reader of it on this page: the freed-slot link no
 * longer carries a service at all, so the two doors cannot be confused.
 *
 * Everything here is optional and every field stays editable: a prefill that
 * refuses to be corrected is worse than no prefill, because the desk is
 * reading it off a client who is changing her mind mid-sentence.
 */
function readPrefill(params: Awaited<PageProps<'/staff/waitlist'>['searchParams']>) {
  const one = (key: string) => (typeof params[key] === 'string' ? (params[key] as string) : null);
  const many = (key: string) => {
    const value = params[key];
    return typeof value === 'string' ? [value] : Array.isArray(value) ? value : [];
  };
  return {
    clientId: one('clientId'),
    // MANY, not one: the booking panel refuses a whole VISIT, and a visit can
    // be "colour then cut". D-56 made the entry the same shape, so every one
    // of them is now a DEFAULT on the form rather than a first line plus a
    // sentence about the others.
    serviceIds: many('serviceId'),
    providerIds: many('providerIds'),
    fromDay: one('fromDay'),
    toDay: one('toDay'),
    dayParts: many('dayParts'),
  };
}
