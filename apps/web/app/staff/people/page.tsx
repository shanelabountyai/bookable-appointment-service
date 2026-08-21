import Link from 'next/link';
import { listPeople } from '@/lib/auth/people-actions';
import { PeopleList } from './people-list';

export default async function PeoplePage() {
  const people = await listPeople();

  return (
    <main className="mx-auto flex w-full max-w-2xl flex-1 flex-col gap-8 p-8">
      <div>
        <Link href="/staff" className="text-sm text-zinc-500 hover:underline">
          ← Staff
        </Link>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight">Who works here</h1>
        <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
          Names on this list are the names the appointment history uses. Give somebody a PIN and they can say
          they’re at the desk from any screen.
        </p>
      </div>
      <PeopleList people={people} />
    </main>
  );
}
