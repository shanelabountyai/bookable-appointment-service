import Link from 'next/link';
import { Logo, Mark } from '@/components/site/logo';
import { salon } from '@/lib/site/content';

/**
 * THE BRAND WRAPPER — the public face, and only the public face.
 *
 * A route group rather than the root layout, deliberately. `/book` and
 * `/manage/[token]` are public too, but they are the salon's TOOLS: a header
 * carrying the salon's name above a booking flow that also names the salon
 * gives every text locator on those pages two matches, which is exactly how
 * A-062's print sheet broke three specs. The marketing pages get the chrome;
 * the transactional ones stay bare.
 *
 * The site commits to the light palette and paints it explicitly. It is a
 * brand surface with a bone ground — inheriting `prefers-color-scheme` would
 * hand half the visitors a colour scheme nobody designed.
 */
const NAV = [
  { href: '/services', label: 'Services' },
  { href: '/stylists', label: 'Stylists' },
  { href: '/visit', label: 'Visit' },
];

export default async function SiteLayout({ children }: { children: React.ReactNode }) {
  const business = await salon();

  // An install with no salon row yet. Every page below answers this for
  // itself as well — see `salon()`; this branch is what the visitor reads,
  // not what makes the pages safe.
  if (!business) {
    return (
      <main className="mx-auto flex w-full max-w-2xl flex-1 flex-col justify-center gap-4 px-6 py-24">
        <h1 className="font-serif text-4xl">This salon is not set up yet.</h1>
        <p className="leading-relaxed text-[#4A423B]">
          There is no business configured on this installation, so there is nothing to show and
          nothing to book. Sign in to the staff area and add the salon, its stylists and its
          services, and this page becomes the front door.
        </p>
      </main>
    );
  }

  return (
    <div className="flex min-h-full flex-1 flex-col bg-[#F5F0E8] font-[family-name:var(--font-body)] text-[#171310]">
      <header className="border-b border-[#E2DACD] bg-[#FBF9F5]">
        <div className="mx-auto flex w-full max-w-6xl flex-wrap items-center justify-between gap-4 px-6 py-4">
          <Link href="/" className="text-[#171310] no-underline">
            <Logo name={business.name} />
          </Link>

          <nav aria-label="Main" className="flex flex-wrap items-center gap-1">
            {NAV.map((item) => (
              <Link
                key={item.href}
                href={item.href}
                className="rounded-sm px-3 py-2 text-[15px] text-[#4A423B] no-underline hover:text-[#171310]"
              >
                {item.label}
              </Link>
            ))}
            <Link
              href="/book"
              className="ml-2 flex min-h-11 items-center bg-[#171310] px-5 text-[15px] font-semibold text-[#F5F0E8] no-underline hover:bg-black"
            >
              Book a chair
            </Link>
          </nav>
        </div>
      </header>

      {children}

      <footer className="border-t border-[#E2DACD] bg-[#FBF9F5]">
        <div className="mx-auto flex w-full max-w-6xl flex-wrap items-center justify-between gap-4 px-6 py-6 text-sm text-muted-ink">
          <span className="flex items-center gap-2">
            <Mark size={20} />
            {[business.name, business.addressLine, business.phone].filter(Boolean).join(' · ')}
          </span>
          <Link href="/book" className="text-clay-ink no-underline hover:text-clay-ink-hover">
            Book a chair
          </Link>
        </div>
      </footer>
    </div>
  );
}
