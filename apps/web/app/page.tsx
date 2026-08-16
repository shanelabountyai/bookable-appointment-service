import Link from 'next/link';

export default function Home() {
  return (
    <main className="flex flex-1 flex-col items-center justify-center gap-4 p-16 text-center">
      <h1 className="text-2xl font-semibold tracking-tight">Bookable</h1>
      <p className="text-zinc-500">Appointment scheduling for a small service business.</p>
      <Link
        href="/book"
        className="rounded-md bg-zinc-900 px-4 py-2 text-sm font-medium text-white dark:bg-zinc-100 dark:text-zinc-900"
      >
        Book an appointment
      </Link>
    </main>
  );
}
