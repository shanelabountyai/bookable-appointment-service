import Link from 'next/link';
import { Mark } from '@/components/site/logo';
import {
  chairCount,
  duration,
  money,
  openingHours,
  salon,
  siteServices,
  siteStylists,
} from '@/lib/site/content';

export const dynamic = 'force-dynamic';

/** The salon's own name, from the same row the header reads. A hardcoded
 *  title is the one string that survives a rename and then contradicts every
 *  other surface.
 *
 *  Nullable because metadata runs OUTSIDE the layout's gate: on an install
 *  with no salon the layout renders its own fallback, but a throw here still
 *  turns the whole response into a 500. */
export async function generateMetadata() {
  const business = await salon();
  if (!business) return { title: 'Not set up yet' };
  return { title: business.name, description: `${business.name} — book a chair online.` };
}

/**
 * The front door.
 *
 * One offer, one action, repeated — not three competing buttons. Every figure
 * on it (the price list, the roster, the hours, the chair count) is read from
 * the same rows the desk works from, so the site cannot quietly disagree with
 * the diary.
 */
export default async function Home() {
  const business = await salon();
  // The layout renders its own "not set up yet" page instead of this one, so
  // nothing here is ever seen. It exists because the page renders BESIDE the
  // layout, not inside its decision — see `salon()`.
  if (!business) return null;

  const [services, stylists, hours, chairs] = await Promise.all([
    siteServices(business.id),
    siteStylists(business.id),
    openingHours(business.id),
    chairCount(business.id),
  ]);

  const open = hours.filter((d) => d.windows.length > 0);
  const shut = hours.filter((d) => d.windows.length === 0);
  const headline = services.filter((s) => s.bookableOnline).slice(0, 5);

  return (
    <main className="flex-1">
      {/* HERO */}
      <section className="border-b border-[#E2DACD] bg-[#FBF9F5]">
        <div className="mx-auto grid w-full max-w-6xl gap-12 px-6 py-20 md:grid-cols-[1.15fr_1fr] md:items-center md:py-28">
          <div className="flex flex-col items-start gap-6">
            <p className="text-[11px] font-semibold tracking-[0.18em] text-muted-ink uppercase">
              {open.length > 0 ? `${open[0]!.weekday} to ${open[open.length - 1]!.weekday}` : 'By appointment'}
              {/* The town, from the salon's own address row — never typed. */}
              {business.addressCity ? ` · ${business.addressCity.split(',')[0]}` : null}
            </p>
            <h1 className="font-serif text-5xl leading-[1.05] text-balance md:text-6xl">
              {chairs} chairs, {stylists.length} stylists, and nobody double-booked.
            </h1>
            <p className="max-w-prose text-lg leading-relaxed text-[#4A423B] text-pretty">
              The diary you book from online is the diary at the desk — same chairs, same minute. Pick
              your stylist, pick your time, and the chair is held for you before you close the tab.
            </p>
            <Link
              href="/book"
              className="flex min-h-12 items-center bg-[#171310] px-7 text-base font-semibold text-[#F5F0E8] no-underline hover:bg-black"
            >
              Book a chair
            </Link>
            <p className="text-sm text-muted-ink">
              No account, no deposit. We text you the night before to confirm.
            </p>
          </div>

          <div
            aria-hidden="true"
            className="hidden aspect-square items-center justify-center overflow-hidden border border-[#E2DACD] bg-[#F5F0E8] text-[#171310] md:flex"
          >
            <span className="scale-[2.4] opacity-90">
              <Mark size={180} />
            </span>
          </div>
        </div>
      </section>

      {/* WHY THIS SALON — answers to the three doubts, not a feature list */}
      <section className="mx-auto w-full max-w-6xl px-6 py-16">
        <div className="grid gap-10 md:grid-cols-3">
          <div className="flex flex-col gap-3">
            <h2 className="font-serif text-2xl">The chair is really yours</h2>
            <p className="leading-relaxed text-[#4A423B] text-pretty">
              Your stylist and your chair are both held for the whole visit — including the time your
              colour is developing. That is why we can only take {chairs} at once, and why we never
              have to move you to a basin halfway through.
            </p>
          </div>
          <div className="flex flex-col gap-3">
            <h2 className="font-serif text-2xl">The same hands each time</h2>
            <p className="leading-relaxed text-[#4A423B] text-pretty">
              Book by name and you get that stylist, not &ldquo;whoever is free&rdquo;. Ask for anyone
              available and we will tell you who you are getting before you confirm.
            </p>
          </div>
          <div className="flex flex-col gap-3">
            <h2 className="font-serif text-2xl">We ring, you answer or you don&rsquo;t</h2>
            <p className="leading-relaxed text-[#4A423B] text-pretty">
              A message the night before, and a call from the desk if we have not heard back. Nobody
              gets rung twice about the same appointment.
            </p>
          </div>
        </div>
      </section>

      {/* PRICE LIST */}
      <section className="border-y border-[#E2DACD] bg-[#FBF9F5]">
        <div className="mx-auto w-full max-w-6xl px-6 py-16">
          <div className="flex flex-wrap items-end justify-between gap-4 border-b border-[#E2DACD] pb-4">
            <h2 className="font-serif text-4xl">What we do</h2>
            <Link href="/services" className="text-clay-ink no-underline hover:text-clay-ink-hover">
              The full list and our policies →
            </Link>
          </div>

          <ul className="mt-8 grid gap-x-12 gap-y-5 md:grid-cols-2">
            {headline.map((service) => (
              <li
                key={service.id}
                className="flex flex-wrap items-baseline justify-between gap-3 border-b border-dashed border-[#DDD3C4] pb-4"
              >
                <span className="text-lg font-semibold">{service.name}</span>
                <span className="text-[#5B534B]">
                  {duration(service.durationMinutes)} · {money(service.priceCents)}
                </span>
              </li>
            ))}
          </ul>
        </div>
      </section>

      {/* STYLISTS */}
      <section className="mx-auto w-full max-w-6xl px-6 py-16">
        <h2 className="font-serif text-4xl">Who is in this week</h2>
        <ul className="mt-8 grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
          {stylists.map((stylist) => (
            <li key={stylist.id} className="flex flex-col gap-3 border border-[#E2DACD] bg-[#FBF9F5] p-6">
              <span className="flex h-12 w-12 items-center justify-center rounded-full bg-[#171310] text-lg font-semibold text-[#F5F0E8]">
                {stylist.name.slice(0, 1)}
              </span>
              <span className="font-serif text-2xl">{stylist.name}</span>
              <span className="text-sm leading-relaxed text-[#5B534B]">
                {stylist.services.join(' · ')}
              </span>
            </li>
          ))}
        </ul>
        <Link
          href="/stylists"
          className="mt-8 inline-block text-clay-ink no-underline hover:text-clay-ink-hover"
        >
          More about the team →
        </Link>
      </section>

      {/* HOURS + CLOSING CTA */}
      <section className="border-t border-[#E2DACD] bg-[#171310] text-[#F5F0E8]">
        <div className="mx-auto grid w-full max-w-6xl gap-12 px-6 py-16 md:grid-cols-2">
          <div>
            <h2 className="font-serif text-4xl">When we are open</h2>
            <dl className="mt-6 flex flex-col gap-2">
              {hours.map((day) => (
                <div key={day.weekday} className="flex justify-between border-b border-[#33291F] py-2">
                  <dt>{day.weekday}</dt>
                  <dd className="text-[#C4B9A9]">
                    {day.windows.length > 0 ? day.windows.join(', ') : 'Closed'}
                  </dd>
                </div>
              ))}
            </dl>
            {shut.length > 0 ? (
              <p className="mt-4 text-sm text-[#9A8F81]">
                Closed {shut.map((d) => d.weekday).join(' and ')} — the whole team gets the same two days.
              </p>
            ) : null}
          </div>

          <div className="flex flex-col items-start justify-center gap-6">
            <h2 className="font-serif text-4xl text-balance">Book the chair you want.</h2>
            <p className="max-w-prose leading-relaxed text-[#C4B9A9] text-pretty">
              Takes about a minute. If the time you want has gone, put your name down and we will call
              you the moment it opens up.
            </p>
            <Link
              href="/book"
              className="flex min-h-12 items-center bg-[#F5F0E8] px-7 text-base font-semibold text-[#171310] no-underline hover:bg-white"
            >
              Book a chair
            </Link>
            <Link href="/visit" className="text-[#D08B5F] no-underline hover:text-[#E0A176]">
              How to find us →
            </Link>
          </div>
        </div>
      </section>
    </main>
  );
}
