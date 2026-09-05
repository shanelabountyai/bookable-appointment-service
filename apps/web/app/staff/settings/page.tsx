import { prisma } from '@bookable/db';
import { getBusinessSettings } from '@bookable/db/settings';
import { requireStaff } from '@/lib/auth/session';
import { SettingsForm } from './settings-form';

export default async function SettingsPage() {
  const staff = await requireStaff();
  const settings = await getBusinessSettings(prisma, staff.businessId);

  if (!settings) {
    return (
      <main className="mx-auto w-full max-w-2xl p-8">
        <p className="text-zinc-500">This staff account is not attached to a business.</p>
      </main>
    );
  }

  return (
    <main className="mx-auto flex w-full max-w-2xl flex-1 flex-col gap-8 p-8">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Settings</h1>
      </div>
      <SettingsForm settings={settings} />
    </main>
  );
}
