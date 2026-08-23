import Link from 'next/link';
import { prisma } from '@bookable/db';
import { listResourceTypes } from '@bookable/db/settings';
import { requireStaff } from '@/lib/auth/session';
import { AddResourceForm, AddResourceTypeForm, ResourceRowItem } from './resources-client';

export const dynamic = 'force-dynamic';

/**
 * A-046 — THE ROOM, AS SOMETHING THE OPERATOR OWNS (RES-01, D-30).
 *
 * Before this page, `ResourceType`, `Resource` and `Service.
 * requiredResourceTypeId` were written by the setup seed and by nothing else.
 * A salon could not add a fifth chair, retire one for the afternoon, or say
 * that a blow-dry at the basin needs none — while being refused bookings, and
 * told a client "stays: no chair free", on the authority of exactly those
 * rows. That is the complaint that ends with the salon booking on paper.
 */
export default async function ResourcesPage() {
  const staff = await requireStaff();
  const types = await listResourceTypes(prisma, staff.businessId);

  return (
    <main className="mx-auto flex w-full max-w-2xl flex-1 flex-col gap-8 p-8">
      <div>
        <Link href="/staff" className="text-sm text-zinc-500 hover:underline">
          ← Staff
        </Link>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight">The room</h1>
        <p className="mt-1 text-sm text-zinc-500">
          Chairs, basins, rooms — whatever a client occupies that is not a person. A client holds one for her whole
          visit including any developing time, so a colour keeps its chair through the hour her stylist is with somebody
          else. Which services need one is set on each service.
        </p>
      </div>

      <AddResourceTypeForm />

      {types.length === 0 ? (
        <p className="text-zinc-500">
          Nothing defined yet, so no service can require anything and the room never limits a booking.
        </p>
      ) : (
        types.map((type) => (
          <section key={type.id} className="flex flex-col gap-3">
            <div>
              <h2 className="text-lg font-semibold">{type.name}</h2>
              <p className="text-sm text-zinc-500">
                {type.capacity} in service.{' '}
                {type.requiringServices.length === 0
                  ? 'No service requires one, so this does not limit anything yet.'
                  : `Required by ${type.requiringServices.map((s) => s.name).join(', ')}.`}
              </p>
              {/* The one state that silently closes the salon: a type every
                  service requires, with nothing in service. The engine reports
                  it as an ordinary empty day, so this is the only place it can
                  be read. */}
              {type.capacity === 0 && type.requiringServices.some((s) => s.active) ? (
                <p className="mt-1 text-sm text-amber-800 dark:text-amber-300">
                  Nothing is in service, so none of those can be booked at all.
                </p>
              ) : null}
            </div>

            <AddResourceForm resourceTypeId={type.id} typeName={type.name} />

            {type.resources.length === 0 ? (
              <p className="text-zinc-500">None yet.</p>
            ) : (
              <ul className="flex flex-col">
                {type.resources.map((resource) => (
                  <ResourceRowItem key={resource.id} resource={resource} />
                ))}
              </ul>
            )}
          </section>
        ))
      )}
    </main>
  );
}
