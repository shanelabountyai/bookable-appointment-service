import Link from 'next/link';
import { prisma } from '@bookable/db';
import { listProviders, listQualifications, listServices } from '@bookable/db/settings';
import { requireStaff } from '@/lib/auth/session';
import { AddServiceForm } from './add-service-form';
import { ServiceCard } from './service-card';

export default async function ServicesPage() {
  const staff = await requireStaff();
  const [services, providers, qualifications] = await Promise.all([
    listServices(prisma, staff.businessId),
    listProviders(prisma, staff.businessId, false), // only active providers can be qualified
    listQualifications(prisma, staff.businessId),
  ]);

  return (
    <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-8 p-8">
      <div>
        <Link href="/staff" className="text-sm text-zinc-500 hover:underline">
          ← Staff
        </Link>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight">Services</h1>
        <p className="mt-1 text-sm text-zinc-500">
          Deactivating a service stops it being offered for new bookings. It never deletes it, and never touches
          appointments already in the book.
        </p>
      </div>

      <AddServiceForm />

      {services.length === 0 ? (
        <p className="text-zinc-500">No services yet.</p>
      ) : (
        <ul className="flex flex-col gap-3">
          {services.map((service) => (
            <ServiceCard
              key={service.id}
              service={service}
              providers={providers}
              qualifications={qualifications.filter((q) => q.serviceId === service.id)}
            />
          ))}
        </ul>
      )}
    </main>
  );
}
