import { clsx, type ClassValue } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

/**
 * A-094 — TAILWIND-MERGE HAS TO BE TOLD WHICH `text-*` CLASSES ARE SIZES, AND
 * UNTIL IT WAS, A-088's TYPE SCALE NEVER REACHED THE PAGE.
 *
 * `tailwind-merge` resolves conflicts from a built-in map of Tailwind's own
 * class names. It knows `text-sm` and `text-base` are font sizes; it has never
 * heard of `text-body`, so it falls through to the catch-all and files it as a
 * text COLOUR — and then drops it as superseded the moment a real colour
 * follows in the same merge:
 *
 *     twMerge('text-body text-ink-primary')  // → 'text-ink-primary'
 *
 * Which is every primitive A-089 built. `Button`'s size string carries
 * `text-body` and all four of its variant strings carry a `text-ink-*`, so no
 * Button in the product has ever rendered at 14px; `Field`'s label loses
 * `text-caption` to `text-ink-secondary`, `EmptyState` and `Tab` the same way.
 * They rendered at the inherited 16px instead, which is a plausible size —
 * nothing looked broken, nothing failed, and the five roles A-088 measured
 * this product into were applied nowhere a colour rode along.
 *
 * Found by mutation: A-094's spec asserts the booking form's inputs are ≥16px
 * (iOS Safari zooms below that), and putting the 14px back did not make it
 * fail. An assertion that cannot fail is the only thing that could have
 * surfaced this, because both classes are strings of the same shape, the
 * compiler sees two valid class names, and axe measures contrast rather than
 * size.
 *
 * The roles are listed here rather than derived from `globals.css` because
 * this runs in the browser bundle; `packages/design/type-scale.test.ts` reads
 * the CSS and asserts the two lists are the SAME SET, so a sixth role cannot
 * be added to the scale and silently left out of this one.
 */
const twMerge = extendTailwindMerge({
  extend: {
    classGroups: {
      'font-size': [{ text: ['display', 'page-title', 'section', 'body', 'caption'] }],
    },
  },
});

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
