import Link from 'next/link';
import { duration, money, salon, siteServices } from '@/lib/site/content';

export const dynamic = 'force-dynamic';

export const metadata = { title: 'Services & prices' };

/**
 * The price list.
 *
 * Desk-only services (A-058) appear here with a way to act, never hidden: a
 * catalogue without balayage tells a visitor we do not do balayage. What they
 * lose is the online button, which is the whole meaning of the flag —
 * "deactivated" and "we book this one ourselves" are different things.
 */
export default async function ServicesPage() {
  const business = await salon();
  // The layout renders its own "not set up yet" page instead of this one, so
  // nothing here is ever seen. It exists because the page renders BESIDE the
  // layout, not inside its decision — see `salon()`.
  if (!business) return null;
  const services = await siteServices(business.id);
  const online = services.filter((s) => s.bookableOnline);
  const byConsultation = services.filter((s) => !s.bookableOnline);

  return (
    <main className="mx-auto w-full max-w-4xl flex-1 px-6 py-16">
      <header className="flex flex-col gap-4">
        <h1 className="font-serif text-5xl">Services &amp; prices</h1>
        <p className="max-w-prose text-lg leading-relaxed text-[#4A423B] text-pretty">
          Every price is what you pay at the desk, and every time is how long the chair is yours —
          the developing time in a colour included, not billed as a gap.
        </p>
      </header>

      <ul className="mt-12 flex flex-col">
        {online.map((service) => (
          <li
            key={service.id}
            className="flex flex-wrap items-baseline justify-between gap-4 border-b border-[#E2DACD] py-5"
          >
            <span className="font-serif text-2xl">{service.name}</span>
            <span className="flex items-center gap-6">
              <span className="text-[#5B534B]">{duration(service.durationMinutes)}</span>
              <span className="w-20 text-right text-lg font-semibold">{money(service.priceCents)}</span>
              <Link
                href="/book"
                className="flex min-h-11 items-center border border-[#171310] px-4 text-[15px] font-semibold text-[#171310] no-underline hover:bg-[#171310] hover:text-[#F5F0E8]"
              >
                Book
              </Link>
            </span>
          </li>
        ))}
      </ul>

      {byConsultation.length > 0 ? (
        <section className="mt-14 border border-[#E2DACD] bg-[#FBF9F5] p-8">
          <h2 className="font-serif text-3xl">By consultation</h2>
          <p className="mt-3 max-w-prose leading-relaxed text-[#4A423B] text-pretty">
            These we book at the desk rather than online — the result depends on what is already on
            your hair, and a fifteen-minute chat first saves an afternoon. Ring us on [YOUR PHONE].
          </p>
          <ul className="mt-6 flex flex-col">
            {byConsultation.map((service) => (
              <li
                key={service.id}
                className="flex flex-wrap items-baseline justify-between gap-4 border-t border-[#E2DACD] py-4"
              >
                <span className="font-serif text-2xl">{service.name}</span>
                <span className="flex items-center gap-6">
                  <span className="text-[#5B534B]">{duration(service.durationMinutes)}</span>
                  <span className="w-20 text-right text-lg font-semibold">
                    {money(service.priceCents)}
                  </span>
                  <span className="text-[15px] font-semibold text-clay-ink">Call us</span>
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section className="mt-14 flex flex-col gap-4">
        <h2 className="font-serif text-3xl">If you need to change it</h2>
        <p className="max-w-prose leading-relaxed text-[#4A423B] text-pretty">
          Every confirmation carries a link that moves or cancels the appointment — no phone queue,
          no account. Tell us in good time and there is nothing to pay; a chair left empty at short
          notice is the one thing a four-chair salon cannot absorb.
        </p>
        <Link
          href="/book"
          className="mt-2 flex min-h-12 w-fit items-center bg-[#171310] px-7 text-base font-semibold text-[#F5F0E8] no-underline hover:bg-black"
        >
          Book a chair
        </Link>
      </section>
    </main>
  );
}
