-- A-037 — named staff identity (D-9, D-33).
--
-- `actorRef` has carried the StaffUser id on every mutation since A-005; what
-- was missing was a NAME to render and a fast way to say who is at the desk.

-- Existing rows are the one shared credential this replaces, so they get the
-- name that credential effectively had. The default is dropped immediately
-- after: a staff row created from here on must be named deliberately.
ALTER TABLE "StaffUser" ADD COLUMN "name" TEXT NOT NULL DEFAULT 'Front desk';
ALTER TABLE "StaffUser" ALTER COLUMN "name" DROP DEFAULT;

-- Null = no fast switch for this person. Not a password: the account
-- credential is untouched, this only stamps who is acting within a session
-- that has already been authenticated (D-33).
ALTER TABLE "StaffUser" ADD COLUMN "pinHash" TEXT;

-- Deactivation, never deletion — see the schema comment.
ALTER TABLE "StaffUser" ADD COLUMN "active" BOOLEAN NOT NULL DEFAULT true;

