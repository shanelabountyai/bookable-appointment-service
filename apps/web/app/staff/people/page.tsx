import Link from 'next/link';
import { listPeople } from '@/lib/auth/people-actions';
import { PeopleList } from './people-list';

export default async function PeoplePage() {
  const { people, canSetPins, canSetCredentials } = await listPeople();

  return (
    <main className="mx-auto flex w-full max-w-2xl flex-1 flex-col gap-8 p-8">
      <div>
        <h1 className="text-page-title font-semibold tracking-tight">Who works here</h1>
        <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
          Names on this list are the names the appointment history uses. Give somebody a PIN and they can say
          they’re at the desk from any screen — for half an hour, after which the desk comes back here. Give
          yourself one too, so you can take it back sooner.
        </p>
        {/* This roster is sign-ins and PINs — whether somebody takes
            appointments is a separate question, answered on Providers. */}
        <p className="mt-1 text-sm">
          <Link href="/staff/providers" className="underline underline-offset-4">
            Looking for who takes appointments? See Providers.
          </Link>
        </p>
      </div>
      <PeopleList people={people} canSetPins={canSetPins} canSetCredentials={canSetCredentials} />
    </main>
  );
}
