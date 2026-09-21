-- A-133 / D-63(2) — THE MINUTES PUSHES TOOK OFF THE DELTA.
--
-- D-43 reduces the stored delta by what a push moved, and the push never moves
-- the client in the chair — so without this the head is projected at the
-- REDUCED delta and every pushed minute is counted twice. Written in the
-- push's transaction; gone with the row when the delta is cleared.

ALTER TABLE "ProviderRunningLate" ADD COLUMN "pushedOffMinutes" INTEGER NOT NULL DEFAULT 0;
