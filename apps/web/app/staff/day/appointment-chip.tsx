import Link from 'next/link';
import type { GridItem } from '@/lib/day/view-model';
import { StatusActions } from './status-actions';

/**
 * A-090 — `AppointmentChip`, THE ATOM OF THE PRODUCT (design brief §5.4.1, §8.5).
 *
 * Extracted from `day-grid.tsx` so that the thing with eight statuses × five
 * modifiers can be drawn as a MATRIX on `/staff/design` rather than only ever
 * appearing one happy-path instance at a time inside a real day. §5.4 asks for
 * exactly that, and this repo has now found six defects that were invisible
 * from inside the item that introduced them — a component with no gallery is a
 * component whose rare states nobody has ever looked at.
 *
 * THE THREE THINGS THIS FILE IS RESPONSIBLE FOR, in order of how badly they
 * fail when they are wrong:
 *
 * 1. THE TWO TIMES (§4, and the reason this item's row calls them "the risk").
 *    A chip in a column that is running late shows the time she was BOOKED for
 *    and the time she is LIKELY to start. Get it wrong and the paper book goes
 *    back on the counter. They are separated here by three signals at once —
 *    two lines, an arrow, and the word "likely" — and in the accessible name by
 *    naming both ("booked for 14:00, likely to start 14:40"), because a reader
 *    hearing four bare clock readings in one sentence has no way to tell which
 *    is which. Never instead of: her confirmation still says 14:00.
 *
 * 2. NEVER COLOUR ALONE (§4). The chip used to distinguish four of its eight
 *    statuses by fill alone, and two of those four — `checked_in` and
 *    `in_progress` — by two adjacent shades of the same hue. The accessible
 *    name carried the word, which helps a screen reader and does nothing at all
 *    for the colour-blind stylist reading the tablet. Every non-default status
 *    now carries a WORD on the chip, kept on screen while the client's name
 *    truncates around it, because "she is a no-show" survives a narrow column
 *    better than the last four letters of a surname.
 *
 * 3. TOKENS, NOT PALETTE (§5.1, A-088). The status map below spends the four
 *    intents. That is what puts the chip inside `tokens.test.ts`'s computed
 *    contrast assertions — and demo checkpoint 7 is why it matters: this
 *    component shipped a `completed` chip at 4.33:1 for months with a green axe
 *    run beside it, because a darker ground, a lighter ink and an `opacity-80`
 *    were each decided in a different place.
 *
 * WHY THE LINES INSIDE THE CHIP CARRY NO COLOUR OF THEIR OWN. The pinned note,
 * the reliability flag and the projected time were amber; they are now the
 * chip's own ink plus a glyph plus weight. An intent ink is asserted against
 * the three grounds and against ITS OWN fill — not against another intent's,
 * which is what amber-on-emerald was. The glyph is the signal, the colour was
 * decoration, and decoration that only works on one status is decoration that
 * is wrong on the other seven.
 */

/** Chip geometry, in MINUTES because that is the unit the chip is measured in:
 *  30 minutes is 45 pixels at 1.5px/min, which holds one line of text and a
 *  control; each further line costs about ten more. */
const ONE_LINE_AND_A_BUTTON = 30;
const MINUTES_PER_LINE = 10;

/**
 * STATUS → the ground it sits on, the stripe down its edge, and THE WORD.
 *
 * A TOTAL map, so a ninth status is a compile error here rather than an
 * invisible chip on a Saturday.
 *
 * `booked` has no word on purpose and is the only one that does not: it is the
 * overwhelming majority of every column, a word on all of them is a word on
 * none, and "no marker" is itself the signal — stated in the gallery, where the
 * eight are drawn side by side and the absence is visible.
 *
 * `checked_in` and `in_progress` share the `info` intent and are told apart by
 * their words, not by their fills. Two adjacent tints of one hue is what the
 * old sky-50/sky-100 pair was, and it is indistinguishable on a tablet under a
 * window — which is the sentence §4's dark-mode clause is about.
 */
const STATUS_STYLE = {
  booked: { chip: 'bg-ground-raised border-line-hairline', stripe: 'bg-line-control', word: null },
  confirmed: { chip: 'bg-positive-fill border-positive-line', stripe: 'bg-positive-line', word: 'Confirmed' },
  checked_in: { chip: 'bg-info-fill border-info-line', stripe: 'bg-info-line', word: 'Here' },
  in_progress: { chip: 'bg-info-fill border-info-line', stripe: 'bg-info-line', word: 'In chair' },
  completed: { chip: 'bg-ground-sunken border-line-hairline', stripe: 'bg-line-hairline', word: 'Done' },
  no_show: { chip: 'bg-attention-fill border-attention-line', stripe: 'bg-attention-line', word: 'No-show' },
  cancelled: { chip: 'bg-ground-page border-line-hairline line-through', stripe: 'bg-line-hairline', word: 'Cancelled' },
  cancelled_late: {
    chip: 'bg-ground-page border-line-hairline line-through',
    stripe: 'bg-line-hairline',
    word: 'Late cancel',
  },
} as const satisfies Record<NonNullable<GridItem['status']>, { chip: string; stripe: string; word: string | null }>;

export const CHIP_SHELL = 'absolute inset-x-1 overflow-hidden rounded-tight py-1 pl-2.5 pr-2 text-caption';

/** No `interactive` switch: the gallery's fixtures carry no `appointmentId`
 *  and no `available`, so no button can render against an invented row, and a
 *  prop whose only job is to say what the data already says is a prop with one
 *  caller and two sources of truth. */
export function AppointmentChip({ item, style }: { item: GridItem; style?: React.CSSProperties }) {
  const status = item.status ?? 'booked';
  const look = STATUS_STYLE[status];

  const body = (
    <>
      {/* LINE ONE, and the truncation order is the design decision on it: the
          status word is `shrink-0` and the name is what gives way. A column
          narrow enough to lose text should lose the tail of a surname, never
          the fact that this one never turned up. */}
      <span className="flex items-baseline gap-1">
        <span className="numeric shrink-0 font-medium">{item.startTime ?? item.time}</span>
        <span className="truncate font-medium">{item.title}</span>
        {look.word ? (
          <span className="ml-auto shrink-0 text-[10px] font-semibold uppercase tracking-wide">{look.word}</span>
        ) : null}
      </span>

      {item.detail ? <span className="block truncate">{item.detail}</span> : null}

      {/* APPT-03's projected start, BESIDE the booked time rather than instead
          of it. Three signals, because §4 calls this the one that puts the
          paper book back on the counter: its own line, an arrow, and the word.
          No colour of its own — see the header. */}
      {item.projected ? (
        <span className="block truncate font-semibold">→ likely {item.projected}</span>
      ) : null}

      {/* CLIENT-03's safety surface. Marked by the glyph, which survives
          greyscale, a colour-blind reader and a printed sheet. */}
      {item.pinnedNote ? <span className="block truncate font-medium">⚑ {item.pinnedNote}</span> : null}
      {item.missed ? <span className="block truncate font-medium">⚑ {item.missed}</span> : null}
      {/* A-070. VISUALLY DISTINCT from the pinned note above: ✎ and no amber,
          because this is about today rather than a safety line about her.
          Truncated here and whole in the accessible name. */}
      {item.visitNote ? <span className="block truncate">✎ {item.visitNote}</span> : null}
      {/* §5.4.11 — the single most important visual in the product. It means a
          human deliberately booked over the rules and typed a reason, and it
          has to stay rare: a border and a word, never a tint, so it reads the
          same on paper and cannot be mistaken for a status. */}
      {item.isOverride ? (
        <span className="mt-0.5 inline-block rounded-tight border border-current px-1 text-[10px] font-semibold uppercase tracking-wide">
          Override
        </span>
      ) : null}
      {/* A-069. She never came, and the rest of her slot is back on the market
          — so the bookable gap chip painting over this one is deliberate, not
          a double-booking. Her chip stays at its BOOKED extent because "who
          was due at ten?" is what the desk is looking for. */}
      {item.released ? (
        <span className="block truncate text-[10px] uppercase tracking-wide">time back from {item.released}</span>
      ) : null}
    </>
  );

  /**
   * A-035 — THE ONE BUTTON THE CHIP HAS ROOM FOR.
   *
   * Every line on a chip is truncated to exactly one line, so the space a
   * button needs is countable rather than guessable. A chip clips what does not
   * fit, and a CLIPPED BUTTON is worse than an absent one — invisible to the
   * eye and still in the tab order.
   */
  const linesInUse = [
    item.detail,
    item.projected,
    item.pinnedNote,
    item.missed,
    item.visitNote,
    item.isOverride,
    item.released,
  ].filter(Boolean).length;
  const roomForAButton = item.minutes >= ONE_LINE_AND_A_BUTTON + linesInUse * MINUTES_PER_LINE;

  const controls =
    item.appointmentId && item.status && item.available?.length && roomForAButton ? (
      <StatusActions
        appointmentId={item.appointmentId}
        status={item.status}
        moves={item.available.slice(0, 1)}
        className="mt-0.5 flex flex-wrap items-center gap-1 text-[11px]"
        buttonClassName="rounded-tight border border-current px-1.5 py-0.5 font-medium disabled:opacity-60"
      />
    ) : null;

  return (
    <li className={`${CHIP_SHELL} border ${look.chip}`} style={style}>
      {/* The stripe carries the 3:1 graphical bar and the status word carries
          the meaning; neither is load-bearing alone. Decorative to the
          accessibility tree, because the word is already in the name. */}
      <span aria-hidden="true" className={`absolute inset-y-0 left-0 w-1 ${look.stripe}`} />
      {/* The button is a SIBLING of the link, never inside it: a button nested
          in an anchor is invalid, and it is the accessibility footgun A-033
          named when it declined to put a second control on this chip. */}
      {item.href ? (
        <Link href={item.href} className={`block ${controls ? '' : 'h-full'}`} aria-label={item.label}>
          {body}
        </Link>
      ) : (
        <span aria-label={item.label}>{body}</span>
      )}
      {controls}
    </li>
  );
}

/** The eight, in the order the visit actually walks through them — for the
 *  gallery, so the matrix cannot fall out of step with the map above. */
export const CHIP_STATUSES = Object.keys(STATUS_STYLE) as (keyof typeof STATUS_STYLE)[];

/**
 * A-093 — THE WORD, for the OTHER renderer of this model.
 *
 * The printed sheet says "no-show" in the same word the tablet does, and it
 * says it because it reads this map rather than typing a ninth copy of the
 * status list. Three copies already existed (`STATUS_STYLE` here,
 * `STATUS_WORDS` in the view model for the accessible name, and the transition
 * table); a fourth on the paper is the "a status enum is never one edit" trap
 * with a printer attached. `booked` keeps its deliberate `null` — the majority
 * of every column, and a word on all of them is a word on none.
 */
export function statusWord(status: NonNullable<GridItem['status']>): string | null {
  return STATUS_STYLE[status].word;
}
