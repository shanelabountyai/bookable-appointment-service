import { prisma } from '@bookable/db';
import { listSwitchableStaff } from '@bookable/db/auth';
import { countUnfinished, listOpenedSlots } from '@bookable/db/appointments';
import { countFailedNotifications } from '@bookable/db/notifications';
import { currentStaff } from '@/lib/auth/session';
import { DeskBar } from './desk-bar';
import { StaffNav } from './staff-nav';

/**
 * A-037, extended by A-085 (D-49) — THE STAFF SHELL, on every staff screen.
 *
 * A layout rather than a component pasted onto twenty pages: the switcher and
 * the nav are only useful if they are wherever the person already is, and a
 * per-page copy is twenty chances to forget one.
 *
 * `currentStaff()` and NOT `requireStaff()`, because `/staff/login` is inside
 * this segment — a guard here would redirect the login page to itself. Every
 * page below still guards itself, exactly as it did before this file existed;
 * this only decides whether to draw the chrome.
 *
 * THE THREE COUNTS ARE OWNED HERE, and that is the load-bearing part of A-085
 * rather than a convenience. §5.5 requires all three visible from anywhere, and
 * the day toolbar used to compute two of them itself. Two readers of one fact
 * is this repo's most-found defect, and `listOpenedSlots` makes it worse than
 * usual: the count is not a `COUNT(*)`, it is the result of deriving whether
 * each freed span is STILL empty. Any cheaper number in the badge would be a
 * second, weaker answer to the chooser's question — the checkpoint-6 class —
 * and a badge that says 3 over a screen showing 1 is a badge the desk stops
 * reading. So the shell asks the real question once and `/staff/day` no longer
 * asks it at all.
 *
 * ponytail: three queries on every staff page render, one of them per-candidate
 * over a fortnight of freed time. That is what "visible from anywhere" costs at
 * a salon's scale. If it ever shows up, the fix is a cached count that is still
 * derived from `listOpenedSlots`, never a cheaper predicate.
 */
export default async function StaffLayout({ children }: { children: React.ReactNode }) {
  const staff = await currentStaff();
  if (!staff) return <>{children}</>;

  const now = new Date();
  const [options, opened, unfinished, failedMessages] = await Promise.all([
    listSwitchableStaff(prisma, staff.businessId),
    listOpenedSlots(prisma, { businessId: staff.businessId, now }),
    countUnfinished(prisma, { businessId: staff.businessId, now }),
    countFailedNotifications(prisma, staff.businessId),
  ]);

  return (
    <>
      <DeskBar currentName={staff.name} options={options} />
      <StaffNav
        counts={{ opened: opened.length, unfinished, failedMessages }}
        isOwner={staff.role === 'owner'}
      />
      {children}
    </>
  );
}
