'use client';

import { useRouter } from 'next/navigation';

/**
 * A NATIVE DATE INPUT that navigates, for any staff screen keyed on `?day=`.
 *
 * The desk is not browsing a calendar picker — "same again in six weeks" is
 * one gesture with a date box and forty-two taps with Previous/Next (A-039).
 * `basePath`/`extraParams` are plain data, not a function, because this is a
 * client component rendered from a server page and a function prop cannot
 * cross that boundary.
 */
export function DateJump({
  basePath,
  day,
  extraParams,
  label = 'Jump to date',
}: {
  basePath: string;
  day: string;
  extraParams?: Record<string, string>;
  label?: string;
}) {
  const router = useRouter();
  return (
    <label className="flex items-center gap-2 text-sm">
      <span className="sr-only">{label}</span>
      <input
        type="date"
        value={day}
        onChange={(event) => {
          if (!event.target.value) return;
          const params = new URLSearchParams(extraParams);
          params.set('day', event.target.value);
          router.push(`${basePath}?${params}`);
        }}
        className="rounded-md border border-zinc-400 bg-transparent px-3 py-2 text-sm dark:border-zinc-600"
      />
    </label>
  );
}
