import Link from 'next/link';
import { readableDay } from '@/lib/customer-format';
import { closedDates, openingHours, salon, telHref } from '@/lib/site/content';

export const dynamic = 'force-dynamic';

export const metadata = { title: 'Visit us' };

/**
 * Hours, closures and how to reach a human.
 *
 * The closed dates come from the SAME date overrides the slot engine reads
 * (AVAIL-02), so a bank holiday the owner marked in Settings appears here
 * without anyone editing a page — and cannot appear here while the diary still
 * sells that day.
 */
export default async function VisitPage() {
  const business = await salon();
  // The layout renders its own "not set up yet" page instead of this one, so
  // nothing here is ever seen. It exists because the page renders BESIDE the
  // layout, not inside its decision — see `salon()`.
  if (!business) return null;
  const [hours, closures] = await Promise.all([openingHours(business.id), closedDates(business.id)]);

  return (
    <main className="mx-auto w-full max-w-5xl flex-1 px-6 py-16">
      <header className="flex flex-col gap-4">
        <h1 className="font-serif text-5xl">Visit us</h1>
        <p className="max-w-prose text-lg leading-relaxed text-[#4A423B] text-pretty">
          We are a small room and we like it that way. Walk-ins are welcome when a chair is genuinely
          free — ring first and we will tell you honestly.
        </p>
      </header>

      <div className="mt-12 grid gap-12 md:grid-cols-2">
        <section>
          <h2 className="font-serif text-3xl">Opening hours</h2>
          <dl className="mt-6 flex flex-col">
            {hours.map((day) => (
              <div key={day.weekday} className="flex justify-between border-b border-[#E2DACD] py-3">
                <dt className="font-semibold">{day.weekday}</dt>
                <dd className="text-[#5B534B]">
                  {day.windows.length > 0 ? day.windows.join(', ') : 'Closed'}
                </dd>
              </div>
            ))}
          </dl>
          <p className="mt-4 text-sm text-muted-ink">
            All times are {business.name}&rsquo;s own — {business.timezone.replace('_', ' ')}.
          </p>
        </section>

        <section className="flex flex-col gap-10">
          {/* Rendered only for the details the salon has actually given. A
              placeholder address is a lie a visitor can act on, and a
              `tel:` link wrapped around one dials nothing. */}
          {business.addressLine || business.addressCity || business.phone || business.email ? (
            <div>
              <h2 className="font-serif text-3xl">Where we are</h2>
              <address className="mt-4 flex flex-col gap-1 text-lg leading-relaxed text-[#4A423B] not-italic">
                {business.addressLine ? <span>{business.addressLine}</span> : null}
                {business.addressCity ? <span>{business.addressCity}</span> : null}
                {business.phone ? (
                  <a
                    href={telHref(business.phone)}
                    className="mt-2 text-clay-ink no-underline hover:text-clay-ink-hover"
                  >
                    {business.phone}
                  </a>
                ) : null}
                {business.email ? (
                  <a
                    href={`mailto:${business.email}`}
                    className="text-clay-ink no-underline hover:text-clay-ink-hover"
                  >
                    {business.email}
                  </a>
                ) : null}
              </address>
            </div>
          ) : null}

          {closures.length > 0 ? (
            <div>
              <h2 className="font-serif text-3xl">Days we are shut</h2>
              <ul className="mt-4 flex flex-col gap-2">
                {closures.map((closure) => (
                  <li key={closure.day} className="border-b border-[#E2DACD] py-2 text-[#4A423B]">
                    <span className="font-semibold">{readableDay(closure.day)}</span>
                    {closure.reason ? <span className="text-[#5B534B]"> — {closure.reason}</span> : null}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </section>
      </div>

      <section className="mt-16 border border-[#E2DACD] bg-[#FBF9F5] p-8">
        <h2 className="font-serif text-3xl">Running late?</h2>
        <p className="mt-3 max-w-prose leading-relaxed text-[#4A423B] text-pretty">
          Ring the desk. We will tell you whether we can still fit the whole service in or whether it
          is better to move you — with {hours.filter((d) => d.windows.length > 0).length} days a week
          and one chair each, the honest answer is usually the quicker one.
        </p>
        <Link
          href="/book"
          className="mt-6 flex min-h-12 w-fit items-center bg-[#171310] px-7 text-base font-semibold text-[#F5F0E8] no-underline hover:bg-black"
        >
          Book a chair
        </Link>
      </section>
    </main>
  );
}
