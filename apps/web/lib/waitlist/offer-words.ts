import type { CallMarkOutcome } from '@bookable/db/clients';

/**
 * A-072 — the four outcomes in the desk's own words.
 *
 * ITS OWN MODULE, and that is not tidiness. It started life beside the buttons
 * in a `'use client'` file, which is where A-061's `ATTEMPT_WORDS` still lives
 * — and `/staff/opened` is a SERVER component. Next replaces a client module
 * with a client-reference proxy on the server, so the import resolved, the
 * page compiled, and every lookup came back `undefined`: the screen answered
 * with a 500 that said "a server error occurred" and nothing else.
 *
 * Caught because the spec asserted what the page SAYS rather than that it
 * answered (CLAUDE.md). A plain module has no boundary to cross.
 *
 * TOTAL over the enum, so a fifth outcome is a compile error rather than a raw
 * value on a screen — the discipline `STATUS_ACTION_LABELS` uses.
 *
 * A-091: "She took it" is now "Took it". These four words are read on the
 * lapsed report and the waitlist matcher about whoever the row names, and the
 * client record has no gender field to consult — the same correction the freed
 * row's own sentences got. The brief wrote the phrase about Mrs Patel; the
 * screen renders it about everybody.
 */
export const OFFER_WORDS = {
  no_answer: 'No answer',
  left_message: 'Left a message',
  thinking: 'Thinking about it',
  took_it: 'Took it',
} satisfies Record<CallMarkOutcome, string>;
