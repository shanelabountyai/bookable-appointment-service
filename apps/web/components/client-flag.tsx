import 'server-only';

/**
 * CLIENT-04's flag, in one component because it appears on FOUR surfaces
 * (client search, client record, the booking panel's picker, the appointment
 * detail) and on the day grid as a sentence.
 *
 * "Surfaced everywhere the client appears" is the requirement, and a second
 * copy of this wording is how one of those surfaces ends up saying "3
 * no-shows" while another says "blocked" about the same person on the same
 * afternoon.
 *
 * Never colour alone (WCAG 1.4.1): the flag glyph and the words carry the
 * whole message, and the amber is decoration on top of them.
 */
import type { ClientReliability } from '@bookable/db/clients';

/**
 * The flag as one sentence. Exported separately because the day grid puts it
 * inside a chip's accessible name rather than rendering an element, and the
 * booking panel sends it across a server-action boundary as a string.
 */
export function flagSentence(reliability: ClientReliability): string | null {
  const counts = flagCounts(reliability);
  if (!counts) return null;

  // The window is named every time. "3 no-shows" with no period attached is
  // the sentence that gets a long-standing client refused for something that
  // happened four years ago.
  const counted = `${counts} in the last 12 months`;
  return reliability.selfServeBlocked ? `${counted}. Cannot book online — the desk can.` : counted;
}

/**
 * A-120 / D-57 — THE SAME FLAG FOR SOMETHING 180 PIXELS WIDE.
 *
 * `flagSentence` is 386 px of text and the day grid's chip is 178-185 px of
 * room, so on every ordinary chip the sentence was cut at *"3 no-shows in the
 * last 12 mo…"* — losing the only half of it the desk can act on, while the
 * accessible name carried the whole thing and axe and `getByRole` passed. Four
 * demo walk-throughs read it as correct.
 *
 * SO THE CHIP DROPS THE EVIDENCE AND KEEPS THE CONSEQUENCE, which is the
 * choice that fits: a flagged client the desk must book is a thing to DO, and
 * the count behind it is one tap away on a surface with room. Where there is
 * no consequence — she is flagged but not blocked — the counts are the whole
 * message and they are what shows. Both forms are built from the same parts
 * here rather than shortened from the sentence somewhere else: a second copy
 * of this wording is how one surface ends up saying "3 no-shows" while another
 * says "blocked" about the same person on the same afternoon.
 *
 * DELIBERATELY SHORTER THAN THE ROOM IT HAS, so it never truncates at all: a
 * short form that merely fits is the same bug at a rarer input — `Desk only ·
 * 3 no-shows` fits and `… and 1 late cancel` does not. `no-show-block.spec.ts`
 * measures it on an ordinary chip (184 px of room) and on an A-099 lane chip
 * (185 px — D-54 widens a double-booked column rather than halving its chips,
 * which is why the narrow surface here is the ordinary one).
 */
export function flagOnAChip(reliability: ClientReliability): string | null {
  const counts = flagCounts(reliability);
  if (!counts) return null;
  return reliability.selfServeBlocked ? 'Desk books only' : counts;
}

/** "3 no-shows and 1 late cancel" — the evidence, with no window and no
 *  consequence attached. Private: every caller wants one of the two forms
 *  above, and a third wording is what this file exists to prevent. */
function flagCounts(reliability: ClientReliability): string | null {
  const parts: string[] = [];
  if (reliability.noShows > 0) {
    parts.push(`${reliability.noShows} no-show${reliability.noShows === 1 ? '' : 's'}`);
  }
  if (reliability.lateCancels > 0) {
    parts.push(`${reliability.lateCancels} late cancel${reliability.lateCancels === 1 ? '' : 's'}`);
  }
  return parts.length > 0 ? parts.join(' and ') : null;
}

export function ClientFlag({ reliability }: { reliability: ClientReliability | undefined }) {
  const sentence = reliability ? flagSentence(reliability) : null;
  if (!sentence) return null;

  // A span, not a paragraph: this renders inside a link on the search list
  // and inside one on the booking panel, and a block-level element there is
  // invalid HTML that only some browsers forgive.
  return <span className="block text-sm font-medium text-amber-700 dark:text-amber-500">⚑ {sentence}</span>;
}
