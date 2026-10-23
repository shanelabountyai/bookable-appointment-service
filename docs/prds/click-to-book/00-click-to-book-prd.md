# Click a time on the day grid to book it (A-162)

Requested by the owner 2026-10-22, after the project closed (D-76): *"in the staff
day screen I would expect to be able to click in a time frame like Outlook and
open an appointment I can select."*

## Problem

Every free stretch on `/staff/day` is already a link to `/staff/book` (A-017), but
the link always carries the gap's **first** instant. Click 15:35 in a free
afternoon that starts at 10:45 and the booking panel opens at 10:45. A calendar
user expects the time under the pointer.

## Behaviour

1. **Pointer click inside a free gap** opens `/staff/book` for that stylist with `at` = the quarter hour under
   the pointer, snapped **down**, never before the gap's start, never at or past
   its end.
   **A colour's processing gap (A-149) is the exception** and still books its
   start. That gap exists to fit a service in before the colour resumes, and a
   click halfway down would make the panel preselect a time after it resumes
   (caught by `segments.spec.ts` › A-030).
2. **Hover** shows a 15-minute band where the click will land.
3. **The booking panel is unchanged**: it already says "Starting from … at 15:30"
   and preselects the first bookable time at or after `at` once a service is
   chosen (A-017, A-042).
4. **Keyboard is unchanged**: one Tab stop per gap, Enter books the gap's start.
   Ctrl/⌘/Shift-click and middle-click open the href (gap start) in a new tab.

## Rules it must keep

- **D-4**: the link carries the instant, never `{date, time}`. The click is a
  pixel offset on the grid's **physical** minute axis added to the gap's
  instant, so the fall-back day's two 01:30s stay two places.
- `day-grid.tsx` stays free of `Date`. The conversion lives in `lib/day/scale.ts`.

## Not built

- Clicking breaks, time off or appointments (an appointment opens its detail page,
  as now).
- Drag to choose a length. The service decides the length.
- An inline pop-up form. The existing booking page is the form.
- Reading `business.slotIntervalMinutes` for the snap. Fifteen is the default, and
  "first bookable at or after" absorbs any other interval.

## Acceptance

- Unit (`lib/day/scale.test.ts`): snapping across the 2026-03-08 jump; clamped
  into the gap; end exclusive; `bookHrefAt` replaces only `at`.
- e2e (`day-grid.spec.ts` › A-162): a real click at 15:35 lands on
  `at=2026-06-09T20:30:00.000Z` and "Starting from Tuesday 9 June at 15:30";
  the band shows on hover; Enter on the focused gap still books its start.
