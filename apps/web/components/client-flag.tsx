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
  const parts: string[] = [];
  if (reliability.noShows > 0) {
    parts.push(`${reliability.noShows} no-show${reliability.noShows === 1 ? '' : 's'}`);
  }
  if (reliability.lateCancels > 0) {
    parts.push(`${reliability.lateCancels} late cancel${reliability.lateCancels === 1 ? '' : 's'}`);
  }
  if (parts.length === 0) return null;

  // The window is named every time. "3 no-shows" with no period attached is
  // the sentence that gets a long-standing client refused for something that
  // happened four years ago.
  const counted = `${parts.join(' and ')} in the last 12 months`;
  return reliability.selfServeBlocked ? `${counted}. She cannot book online — the desk can.` : counted;
}

export function ClientFlag({ reliability }: { reliability: ClientReliability | undefined }) {
  const sentence = reliability ? flagSentence(reliability) : null;
  if (!sentence) return null;

  // A span, not a paragraph: this renders inside a link on the search list
  // and inside one on the booking panel, and a block-level element there is
  // invalid HTML that only some browsers forgive.
  return <span className="block text-sm font-medium text-amber-700 dark:text-amber-500">⚑ {sentence}</span>;
}
