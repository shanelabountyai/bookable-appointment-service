import { prisma } from '@bookable/db';
import { listSwitchableStaff } from '@bookable/db/auth';
import { currentStaff } from '@/lib/auth/session';
import { DeskBar } from './desk-bar';

/**
 * A-037 — WHO IS AT THE DESK, on every staff screen.
 *
 * A layout rather than a component pasted onto fifteen pages: the switcher is
 * only useful if it is wherever the person already is, and a per-page copy is
 * fifteen chances to forget one.
 *
 * `currentStaff()` and NOT `requireStaff()`, because `/staff/login` is inside
 * this segment — a guard here would redirect the login page to itself. Every
 * page below still guards itself, exactly as it did before this file existed;
 * this only decides whether to draw the bar.
 */
export default async function StaffLayout({ children }: { children: React.ReactNode }) {
  const staff = await currentStaff();
  const options = staff ? await listSwitchableStaff(prisma, staff.businessId) : [];

  return (
    <>
      {staff ? <DeskBar currentName={staff.name} options={options} /> : null}
      {children}
    </>
  );
}
