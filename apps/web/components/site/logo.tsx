/**
 * The mark, drawn once (A-063's sibling problem, applied to SVG): a two-strand
 * curl that reads as an S. Every surface — header, footer, favicon-sized —
 * renders THIS, so the logo cannot drift between pages the way a pasted path
 * would.
 *
 * `currentColor` on the main strand and one clay highlight: the reversed
 * lockup on ink needs no second copy, it just inherits a different colour.
 */
export function Mark({ size = 36 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 48 48"
      fill="none"
      aria-hidden="true"
      className="shrink-0"
    >
      <path
        d="M32 9C20 6 11 13 14 21C17 29 30 28 32 34.5C34 41 26 45.5 16.5 42"
        stroke="currentColor"
        strokeWidth="4"
        strokeLinecap="round"
      />
      <path
        d="M38.5 14C32 11 25.5 14.5 26.5 19.5"
        stroke="#B26B47"
        strokeWidth="3"
        strokeLinecap="round"
      />
    </svg>
  );
}

/** Mark plus wordmark. The salon's own name, never a hardcoded string. */
export function Logo({ name, size = 36 }: { name: string; size?: number }) {
  return (
    <span className="flex items-center gap-3">
      <Mark size={size} />
      <span className="font-serif text-2xl leading-none">{name}</span>
    </span>
  );
}
