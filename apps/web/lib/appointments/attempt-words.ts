import type { CallAttemptOutcome } from '@bookable/db/appointments';

/**
 * A-061's two call-down outcomes in the desk's own words.
 *
 * ITS OWN MODULE (A-077), and not tidiness. It lived beside its buttons in a
 * `'use client'` file and is read by `/staff/call-down/page.tsx`, which is a
 * SERVER component — the identical shape that produced a blank 500 on
 * `/staff/opened` when A-072 did the same thing, because Next replaces a client
 * module with a client-reference proxy on the server and every lookup comes
 * back `undefined`.
 *
 * That one worked, and "it demonstrably works" was never a reason: it worked
 * because Next happens to resolve that import today. The Phase 7 close called
 * it load-bearing and it is moved here beside `offer-words.ts`, which is where
 * the same lesson already lives.
 *
 * TOTAL over the enum, so a third outcome is a compile error rather than a raw
 * value on a screen.
 */
export const ATTEMPT_WORDS = {
  no_answer: 'No answer',
  left_message: 'Left a message',
} satisfies Record<CallAttemptOutcome, string>;
