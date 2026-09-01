/**
 * WHAT THE PUBLIC SITE KNOWS ABOUT THE SALON.
 *
 * Every number on the marketing pages is READ FROM THE DATABASE — the price
 * list, the roster, the opening hours, the closed dates. A brochure site that
 * hardcodes "$55" is a site that lies the first Monday after a price rise, and
 * a salon with two front doors (the site says one thing, the booking flow
 * another) is worse than a salon with none.
 *
 * All server-side, all `force-dynamic` at the page: the same reasoning as
 * `/book` — a page prerendered at build time sells last month's catalogue.
 */
import { prisma } from '@bookable/db';
import { listWeeklyWindows, listDateOverrides } from '@bookable/db/availability';
import { listProviders, listQualifications, listServices } from '@bookable/db/settings';

const SALON_FIELDS = {
  id: true,
  name: true,
  timezone: true,
  addressLine: true,
  addressCity: true,
  phone: true,
  email: true,
} as const;

/**
 * The one business this deployment serves — the same lookup `/book` uses.
 *
 * NULLABLE at EVERY call site, and that is load-bearing rather than defensive.
 * Gating it once in the layout is not enough: a layout that declines to render
 * `{children}` does not stop Next from rendering the page beside it, and the
 * page's throw then lands AFTER the streamed shell has already flushed 200 —
 * a request that looks fine to the probe and shows the visitor an error
 * boundary. Every page answers the question for itself.
 *
 * Playwright's
 * `webServer` readiness probe GETs `/` before any seed has run, and it treats
 * anything outside 200–403 as "not started yet": a front door that threw on an
 * empty database timed out the entire e2e sweep after five minutes without
 * running one test. The product reading is the same — a fresh install should
 * say it is not set up, not serve a stack trace to the first visitor.
 */
export async function salon() {
  return prisma.business.findFirst({ select: SALON_FIELDS });
}

/** A dialable `tel:` — the digits only, so "(312) 555-0184" still calls. */
export const telHref = (phone: string) => `tel:${phone.replace(/[^\d+]/g, '')}`;

export const money = (cents: number) => `$${(cents / 100).toFixed(2)}`;

/** How many chairs the room has. The site's one boast — "four chairs, four
 *  stylists, nobody is double-booked" — is only allowed to be made because the
 *  exclusion constraint on `AppointmentResourceHold` makes it true (D-30). */
export async function chairCount(businessId: string): Promise<number> {
  return prisma.resource.count({ where: { businessId, active: true } });
}

/** "45 min", "2 hr", "1 hr 30 min" — physical minutes, never a wall-clock delta. */
export function duration(minutes: number): string {
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours === 0) return `${rest} min`;
  return rest === 0 ? `${hours} hr` : `${hours} hr ${rest} min`;
}

export interface SiteService {
  id: string;
  name: string;
  durationMinutes: number;
  priceCents: number;
  bookableOnline: boolean;
}

/**
 * The public price list.
 *
 * Desk-only services are KEPT, not filtered — A-058's rule, and the reason it
 * exists: a salon that offers balayage and shows a list without it has told
 * the visitor it does not do balayage, and she books it somewhere that does.
 * The page renders them "by consultation" with the one thing she can act on.
 */
export async function siteServices(businessId: string): Promise<SiteService[]> {
  const rows = await listServices(prisma, businessId, false);
  return rows.map((s) => ({
    id: s.id,
    name: s.name,
    durationMinutes: s.durationMinutes,
    priceCents: s.priceCents,
    bookableOnline: s.bookableOnline,
  }));
}

export interface SiteStylist {
  id: string;
  name: string;
  /** What she is qualified for, in catalogue order. Read, never written by
   *  hand: Tess cuts and blow-dries and does not colour, and a bio that says
   *  otherwise is a client booked with the wrong person. */
  services: string[];
}

export async function siteStylists(businessId: string): Promise<SiteStylist[]> {
  const [providers, services, quals] = await Promise.all([
    listProviders(prisma, businessId, false),
    listServices(prisma, businessId, false),
    listQualifications(prisma, businessId),
  ]);
  const nameOf = new Map(services.map((s) => [s.id, s.name]));
  const order = new Map(services.map((s, i) => [s.id, i]));

  return providers.map((p) => ({
    id: p.id,
    name: p.displayName,
    services: quals
      .filter((q) => q.providerId === p.id)
      .sort((a, b) => (order.get(a.serviceId) ?? 0) - (order.get(b.serviceId) ?? 0))
      .map((q) => nameOf.get(q.serviceId))
      .filter((n): n is string => Boolean(n)),
  }));
}

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'] as const;

export interface OpeningDay {
  weekday: string;
  /** Empty when the salon is closed that day — "Closed" is a real answer and
   *  the visitor standing outside on a Monday needs to read it. */
  windows: string[];
}

/**
 * The week, as the door reads it: business-level windows only.
 *
 * `WallTime` strings straight through — '09:00' is a rule, not an occurrence,
 * so nothing here converts to an instant and nothing can shift a day west.
 */
export async function openingHours(businessId: string): Promise<OpeningDay[]> {
  const windows = await listWeeklyWindows(prisma, businessId, null);
  return WEEKDAYS.map((weekday, i) => ({
    weekday,
    windows: windows.filter((w) => w.weekday === i).map((w) => `${w.open} – ${w.close}`),
  }));
}

/** Days the salon has said it will be shut. Ordered, so "next" is the first. */
export async function closedDates(businessId: string): Promise<{ day: string; reason: string | null }[]> {
  const overrides = await listDateOverrides(prisma, businessId, null);
  return overrides.filter((o) => o.isClosed).map((o) => ({ day: o.day, reason: o.reason }));
}
