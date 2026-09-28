'use client';

import { useRouter } from 'next/navigation';
import { useEffect } from 'react';

/**
 * The staleness bound the backlog asks for is 30 seconds, so a live staff
 * screen re-reads every 15 — half the budget, which leaves room for a slow
 * request without the screen ever being older than promised.
 *
 * `router.refresh()` re-runs the server component, so the refresh path is the
 * SAME code as the first render. A client-side fetch-and-merge would be a
 * second way of building the screen, and the two would drift.
 *
 * A-142 — ONE hook, not a copy per screen. It lived privately in `day-grid.tsx`
 * and the stylist's own list claimed in a comment to be kept fresh by it while
 * never mounting it, so the one screen she reads between clients went stale.
 */
const REFRESH_MS = 15_000;

/** Re-reads the server component on a timer. An interval is a subscription to
 *  an external system (the clock), which is what effects are for. */
export function useAutoRefresh(live = true) {
  const router = useRouter();
  useEffect(() => {
    if (!live) return;
    const timer = setInterval(() => router.refresh(), REFRESH_MS);
    return () => clearInterval(timer);
  }, [router, live]);
}

/** The same timer for a server component that has no client code of its own. */
export function AutoRefresh() {
  useAutoRefresh();
  return null;
}
