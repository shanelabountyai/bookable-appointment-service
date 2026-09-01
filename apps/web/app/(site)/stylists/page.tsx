import Link from 'next/link';
import { salon, siteStylists } from '@/lib/site/content';

export const dynamic = 'force-dynamic';

export const metadata = { title: 'The stylists' };

/**
 * Who works here, and what each of them actually does.
 *
 * The service list under each name is READ FROM THE QUALIFICATIONS, never
 * typed: a junior who cuts and blow-dries but does not colour must not be
 * listed as a colourist, because the booking flow will refuse that visit
 * (SVC-02) and the client will have read it here first.
 */
export default async function StylistsPage() {
  const business = await salon();
  // The layout renders its own "not set up yet" page instead of this one, so
  // nothing here is ever seen. It exists because the page renders BESIDE the
  // layout, not inside its decision — see `salon()`.
  if (!business) return null;
  const stylists = await siteStylists(business.id);

  return (
    <main className="mx-auto w-full max-w-5xl flex-1 px-6 py-16">
      <header className="flex flex-col gap-4">
        <h1 className="font-serif text-5xl">The stylists</h1>
        <p className="max-w-prose text-lg leading-relaxed text-[#4A423B] text-pretty">
          {stylists.length} of us, one chair each. Book by name and that is who you get — if the
          person you want is full, the desk will tell you when they are next free rather than quietly
          putting you with someone else.
        </p>
      </header>

      <ul className="mt-12 grid gap-8 sm:grid-cols-2">
        {stylists.map((stylist) => (
          <li key={stylist.id} className="flex flex-col gap-4 border border-[#E2DACD] bg-[#FBF9F5] p-8">
            <span className="flex h-16 w-16 items-center justify-center rounded-full bg-[#171310] text-2xl font-semibold text-[#F5F0E8]">
              {stylist.name.slice(0, 1)}
            </span>
            <h2 className="font-serif text-3xl">{stylist.name}</h2>

            <div className="flex flex-col gap-2">
              <span className="text-[11px] font-semibold tracking-[0.18em] text-muted-ink uppercase">
                Books for
              </span>
              <ul className="flex flex-wrap gap-2">
                {stylist.services.map((service) => (
                  <li
                    key={service}
                    className="border border-[#DDD3C4] px-3 py-1 text-sm text-[#4A423B]"
                  >
                    {service}
                  </li>
                ))}
              </ul>
            </div>

            <Link
              href="/book"
              className="mt-2 flex min-h-11 w-fit items-center border border-[#171310] px-5 text-[15px] font-semibold text-[#171310] no-underline hover:bg-[#171310] hover:text-[#F5F0E8]"
            >
              Book with {stylist.name}
            </Link>
          </li>
        ))}
      </ul>

      <p className="mt-12 max-w-prose leading-relaxed text-[#4A423B] text-pretty">
        Not sure who to ask for? Choose &ldquo;anyone available&rdquo; when you book — you will be told
        whose chair you are taking before you confirm, never afterwards.
      </p>
    </main>
  );
}
