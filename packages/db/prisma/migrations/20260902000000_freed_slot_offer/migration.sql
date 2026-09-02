-- A-072 / WAIT-02, D-37(b), D-41 — WHO HAS ALREADY BEEN OFFERED THIS SLOT.
--
-- Thursday's three-hour colour cancels on Saturday morning and lands on
-- `/staff/opened` with two waitlist matches and a tel: link — good, and that is
-- A-043 and A-067 working. The desk rings Mrs Patel, who says "let me check
-- with work". Then a walk-in arrives and the phone goes, and at 4pm the second
-- person at the desk opens the same list, sees the same slot and the same two
-- names, and rings Mrs Patel again — or promises it to the second name while
-- the first is still deciding.
--
-- A-061 fixed exactly this for the call-down list. The list with the money on
-- it never got it.
--
-- THIS IS A RECORD, NOT A HOLD, and that distinction is what makes it
-- buildable while OQ-4's soft-hold offer is correctly still blocked. The slot
-- stays sellable to anybody throughout; nothing here refuses a booking, delays
-- one, or reserves anything. It is a note about a phone call a human made,
-- exactly like `RunningLateTold` and `CallDownAttempt` — and like both of
-- those it **sends nothing** and must appear nowhere near `deliveryWord()`
-- (D-41's reasoning, unchanged).
--
-- SAME SHAPE AS A-061, deliberately, rather than a third invention: one row per
-- (slot, client) so a second call RE-STAMPS, a toggle rather than a one-way
-- tick, and actor-stamped because at 4pm "who rang her?" has to have an answer
-- and "the front desk" is four people (D-9).

-- ── 1. The outcomes, and why they are not `CallAttemptOutcome` ─────────────
-- A confirmation call and an offer are different questions with different
-- answers: "she took it" is meaningless on the call-down, and extending that
-- enum would put two dead buttons on a screen that has nothing to do with this
-- one. "A status enum is never one edit" cuts both ways — the cheap edit here
-- would have made every reader of `CallAttemptOutcome` wrong.
CREATE TYPE "FreedOfferOutcome" AS ENUM ('no_answer', 'left_message', 'thinking', 'took_it');

-- ── 2. The mark ────────────────────────────────────────────────────────────
CREATE TABLE "FreedSlotOffer" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,

    -- A-067's derived row key: `cancelled:<appointmentId>` for a whole
    -- cancellation, `<eventType>:<eventId>` for a span the event log freed.
    -- Stable for as long as the row exists and DIFFERENT for a span freed
    -- twice, which is what makes "cleared by the slot ceasing to be free" true
    -- with no clearing code: the list is derived, so when the slot goes the
    -- marks are simply never read again.
    "freedKey" TEXT NOT NULL,
    "appointmentId" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,

    "outcome" "FreedOfferOutcome" NOT NULL,

    -- D-9, again.
    "offeredByActor" "Actor" NOT NULL,
    "actorRef" TEXT,

    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "FreedSlotOffer_pkey" PRIMARY KEY ("id")
);

-- ONE ROW PER SLOT PER CLIENT, so a second call re-stamps rather than
-- appending: the useful fact is the most recent attempt and its outcome, and
-- two people at the desk pressing the same button in the same second is an
-- upsert rather than a list reading "rung, rung".
CREATE UNIQUE INDEX "FreedSlotOffer_freedKey_clientId_key" ON "FreedSlotOffer"("freedKey", "clientId");
CREATE INDEX "FreedSlotOffer_businessId_freedKey_idx" ON "FreedSlotOffer"("businessId", "freedKey");

ALTER TABLE "FreedSlotOffer" ADD CONSTRAINT "FreedSlotOffer_businessId_fkey"
  FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;
-- Cascade, not Restrict: this is a note about a phone call, not part of the
-- audit trail the appointment's own event log carries. Losing it with the
-- appointment costs nothing, and keeping it would strand rows nothing reads.
ALTER TABLE "FreedSlotOffer" ADD CONSTRAINT "FreedSlotOffer_appointmentId_fkey"
  FOREIGN KEY ("appointmentId") REFERENCES "Appointment"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "FreedSlotOffer" ADD CONSTRAINT "FreedSlotOffer_clientId_fkey"
  FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;
