import Link from 'next/link';
import { prisma } from '@bookable/db';
import { listProviders, listServices } from '@bookable/db/settings';
import { listWaitlistEntries, matchFreedSlot } from '@bookable/db/waitlist';
import { openWeekdays } from '@bookable/db/availability';
import { findClient, listCallMarks } from '@bookable/db/clients';
import { fromDate, instantFromIso, toDate, toLabel, zoneId } from '@bookable/core/time';
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

  const freed = freedSlotFrom(params, business.timezone, providers, services);
  const matches = freed ? await matchFreedSlot(prisma, { ...freed.query, businessId: staff.businessId }) : null;
  // A-072. Who has already been rung about THIS span — one read for the whole
  // list, keyed on A-067's derived row key so a span freed twice is two rounds
  // of calls rather than one that remembers the wrong answers.
  const subject = freed?.key ? `freed:${freed.key}` : null;
  const marks = subject
    ? (await listCallMarks(prisma, { businessId: staff.businessId, subjects: [subject] })).get(subject) ?? []
    : [];
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
          <p className="text-sm text-zinc-600 dark:text-zinc-400">
            {freed.serviceName} with {freed.providerName}
            {/* A-098. The span is real and sellable; the stylist is not
                available to sell it. Saying so here is what stops the desk
                promising Tess to whoever answers the phone. */}
            {freed.providerActive ? '' : ' (off the roster — this goes to somebody else)'},{' '}
            {readableInstant(toDate(instantFromIso(freed.at)), business.timezone)}.
          </p>
          {matches && matches.length === 0 ? (
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
                  </span>
                  <span className="flex items-center gap-2">
                    <Link
                      /* A-098. `provider=any` when the stylist whose time this
                         was has left: booking HER is refused, so a link naming
                         her is an offer the write cannot honour. The instant
                         and the day carry over unchanged — it is the same hour
                         of the same Saturday, with whoever is free. */
                      href={`/staff/book?provider=${freed.providerActive ? freed.providerId : 'any'}&at=${encodeURIComponent(freed.at)}&day=${freed.query.day}`}
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
                      {entry.serviceName} · {providerNames} · {readableDay(entry.fromDay)}–{readableDay(entry.toDay)}
                      {entry.dayParts.length ? ` · ${entry.dayParts.join(', ')}` : ''}
                    </p>
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

/** Reads the freed-interval context off the URL — set by the appointment
 *  detail page's link, never typed by hand. Malformed or partial params fall
 *  back to "no freed slot", quietly: this is internal navigation state, not a
 *  form a person fills in. */
function freedSlotFrom(
  params: Awaited<PageProps<'/staff/waitlist'>['searchParams']>,
  timezone: string,
  providers: { id: string; displayName: string; active: boolean }[],
  services: { id: string; name: string }[],
) {
  const providerId = typeof params.providerId === 'string' ? params.providerId : null;
  const serviceId = typeof params.serviceId === 'string' ? params.serviceId : null;
  const at = typeof params.at === 'string' ? params.at : null;
  const minutes = typeof params.minutes === 'string' ? Number(params.minutes) : null;
  // A-072. Absent on a link built before this shipped, and absent is simply
  // "no marks on this screen" — never a crash and never a reason to refuse the
  // matcher, which is the useful half.
  const key = typeof params.key === 'string' ? params.key : null;
  const appointmentId = typeof params.appointmentId === 'string' ? params.appointmentId : null;
  if (!providerId || !serviceId || !at || !minutes || !Number.isFinite(minutes) || minutes <= 0) return null;

  const provider = providers.find((p) => p.id === providerId);
  const service = services.find((s) => s.id === serviceId);
  if (!provider || !service) return null;

  let label;
  try {
    label = toLabel(instantFromIso(at), zoneId(timezone));
  } catch {
    return null;
  }

  return {
    providerId,
    providerName: provider.displayName,
    /** A-098. Whether the Book button below may name her at all. */
    providerActive: provider.active,
    serviceName: service.name,
    at,
    key,
    appointmentId,
    query: { providerId, serviceId, day: label.day, time: label.time, freedMinutes: minutes },
  };
}

/**
 * A-110 — the booking panel's refusal, carried across as form defaults.
 *
 * `serviceId` is deliberately the SAME parameter the freed-slot link above
 * reads: it means the same thing on both doors — the service in question —
 * and prefilling the form with it is right either way. The freed-slot reader
 * needs `at` and `minutes` as well, so a prefill link can never be mistaken
 * for one.
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
    // be "colour then cut". A waitlist entry is one service, so the first is
    // the default and the rest are said out loud on the form rather than
    // silently dropped.
    serviceIds: many('serviceId'),
    providerIds: many('providerIds'),
    fromDay: one('fromDay'),
    toDay: one('toDay'),
    dayParts: many('dayParts'),
  };
}
