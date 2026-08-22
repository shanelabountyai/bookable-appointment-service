'use client';

import { useActionState } from 'react';
import type { StaffRow } from '@bookable/db/auth';
import { type PeopleState, savePerson, setPersonActive } from '@/lib/auth/people-actions';

const initial: PeopleState = {};
const field = 'rounded-md border border-zinc-400 bg-transparent px-2 py-1 text-sm dark:border-zinc-600';
const small = 'rounded-md border border-zinc-400 px-2 py-1 text-xs font-medium dark:border-zinc-600';

/**
 * `canSetPins` is FALSE whenever somebody has taken the desk (A-044) — a PIN
 * is the credential the whole audit trail rests on, so it is issued by the
 * account the terminal signed in with and nobody else. The fields simply are
 * not drawn; `savePerson` refuses the posted values regardless, which is where
 * the actual control lives.
 */
export function PeopleList({ people, canSetPins }: { people: StaffRow[]; canSetPins: boolean }) {
  return (
    <div className="flex flex-col gap-6">
      {canSetPins ? null : (
        <p className="rounded-md border border-zinc-300 px-4 py-3 text-sm text-zinc-700 dark:border-zinc-700 dark:text-zinc-300">
          Desk PINs are set by whoever signed this terminal in. Names and the roster are still yours to change.
        </p>
      )}
      <ul className="flex flex-col gap-3">
        {people.map((person) => (
          <PersonRow key={person.id} person={person} canSetPins={canSetPins} />
        ))}
      </ul>
      <AddPerson canSetPins={canSetPins} />
    </div>
  );
}

function PersonRow({ person, canSetPins }: { person: StaffRow; canSetPins: boolean }) {
  const [saveState, save, saving] = useActionState(savePerson, initial);
  const [activeState, toggle, toggling] = useActionState(setPersonActive, initial);

  return (
    <li
      className={`flex flex-col gap-2 rounded-md border p-4 ${
        person.active ? 'border-zinc-300 dark:border-zinc-700' : 'border-zinc-200 opacity-60 dark:border-zinc-800'
      }`}
    >
      {/* The name AS TEXT, not only inside the field that edits it — this is
          the screen whose whole subject is what the history calls people, and
          a name you can only read by inspecting an input's value is a name the
          screen does not actually show. */}
      <p className="font-medium">{person.name}</p>

      <form action={save} className="flex flex-wrap items-end gap-2">
        <input type="hidden" name="id" value={person.id} />
        <label className="flex flex-col gap-1 text-sm">
          Name
          <input name="name" defaultValue={person.name} className={field} />
        </label>
        {canSetPins ? (
          <label className="flex flex-col gap-1 text-sm">
            {/* Never pre-filled and never readable: the hash does not leave the
                database layer, so this is "set a new one", not "here is theirs". */}
            {person.hasPin ? 'New desk PIN' : 'Desk PIN'}
            <input name="pin" type="password" inputMode="numeric" autoComplete="off" className={`${field} w-28`} />
          </label>
        ) : null}
        {canSetPins && person.hasPin ? (
          <label className="flex items-center gap-1 py-2 text-xs">
            <input type="checkbox" name="clearPin" />
            Remove PIN
          </label>
        ) : null}
        <button type="submit" disabled={saving} className={small}>
          {saving ? 'Saving…' : 'Save'}
        </button>
        <span aria-live="polite" className="text-xs">
          {saveState.message ?? ''}
        </span>
      </form>

      <form action={toggle} className="flex items-center gap-2">
        <input type="hidden" name="id" value={person.id} />
        <input type="hidden" name="name" value={person.name} />
        <input type="hidden" name="active" value={person.active ? 'false' : 'true'} />
        <button type="submit" disabled={toggling} className={small}>
          {person.active ? 'Take off the roster' : 'Put back on the roster'}
        </button>
        <span className="text-xs text-zinc-600 dark:text-zinc-400">
          {person.email ? person.email : 'No sign-in — desk PIN only'}
          {person.active ? '' : ' · off the roster'}
        </span>
        <span aria-live="polite" className="text-xs">
          {activeState.message ?? ''}
        </span>
      </form>
    </li>
  );
}

/** Adding a NAME stays open to everybody — that is the roster, and A-044's
 *  guard is about the credential, not the list. Only the PIN field goes. */
function AddPerson({ canSetPins }: { canSetPins: boolean }) {
  const [state, action, pending] = useActionState(savePerson, initial);
  return (
    <form
      action={action}
      className="flex flex-wrap items-end gap-2 rounded-md border border-zinc-300 p-4 dark:border-zinc-700"
    >
      <h2 className="w-full text-sm font-semibold uppercase tracking-wide text-zinc-600 dark:text-zinc-400">
        Add somebody
      </h2>
      <label className="flex flex-col gap-1 text-sm">
        Name
        <input name="name" placeholder="Priya" className={field} />
      </label>
      {canSetPins ? (
        <label className="flex flex-col gap-1 text-sm">
          Desk PIN
          <input name="pin" type="password" inputMode="numeric" autoComplete="off" className={`${field} w-28`} />
        </label>
      ) : null}
      <button
        type="submit"
        disabled={pending}
        className="rounded-md bg-zinc-900 px-3 py-2 text-sm font-medium text-white disabled:opacity-60 dark:bg-zinc-100 dark:text-zinc-900"
      >
        {pending ? 'Adding…' : 'Add'}
      </button>
      <p aria-live="polite" className="w-full text-sm text-zinc-700 dark:text-zinc-300">
        {state.message ?? ''}
      </p>
    </form>
  );
}
