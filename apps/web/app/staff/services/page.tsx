import Link from 'next/link';
import { prisma } from '@bookable/db';
import {
  listProviders,
  listQualifications,
  listResourceTypeChoices,
  listServices,
  segmentsByService,
} from '@bookable/db/settings';
import { requireStaff } from '@/lib/auth/session';
import { AddServiceForm } from './add-service-form';
import { ServiceCard } from './service-card';

export default async function ServicesPage() {
  const staff = await requireStaff();
  const [services, providers, qualifications, segments, resourceTypes] = await Promise.all([
    listServices(prisma, staff.businessId),
    listProviders(prisma, staff.businessId, false), // only active providers can be qualified
    listQualifications(prisma, staff.businessId),
    segmentsByService(prisma, staff.businessId),
    listResourceTypeChoices(prisma, staff.businessId),
  ]);

  return (
    <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-8 p-8">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Services</h1>
        <p className="mt-1 text-sm text-zinc-500">
          Deactivating a service stops it being offered for new bookings. It never deletes it, and never touches
          appointments already in the book. &ldquo;Needs&rdquo; is what a client occupies for the whole visit — set the
          chairs themselves in <Link href="/staff/resources" className="underline underline-offset-4">the room</Link>.
        </p>
      </div>

      <AddServiceForm resourceTypes={resourceTypes} />

      {services.length === 0 ? (
        <p className="text-zinc-500">No services yet.</p>
      ) : (
        <ul className="flex flex-col gap-3">
          {services.map((service) => (
            <ServiceCard
              key={service.id}
              service={service}
              providers={providers}
              resourceTypes={resourceTypes}
              qualifications={qualifications.filter((q) => q.serviceId === service.id)}
              segments={segments.get(service.id) ?? []}
            />
          ))}
        </ul>
      )}
    </main>
  );
}
