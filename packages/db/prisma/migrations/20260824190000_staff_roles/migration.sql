-- A-050 — per-person staff credentials and a two-role split (D-36).
--
-- Before this migration the salon had four NAMES on the audit trail and ONE
-- credential under the desk: `StaffUser` has held many rows per business since
-- A-037, but only the seeded account carried an email and a password, and
-- anybody who signed in with it could open `/staff/dashboard` — revenue,
-- utilization, and every stylist's no-show count.
--
-- TWO roles and no more. `owner` sees the money and hands out credentials;
-- `staff` does everything a staff member could already do. A matrix is a
-- different product.

CREATE TYPE "StaffRole" AS ENUM ('owner', 'staff');

-- DEFAULT 'staff': somebody added to the roster gets the least access by
-- existing, which is the direction that fails safe. A default of 'owner' would
-- mean every future PIN-only stylist quietly became one.
ALTER TABLE "StaffUser" ADD COLUMN "role" "StaffRole" NOT NULL DEFAULT 'staff';

-- THE BACKFILL IS THE WHOLE MIGRATION. Every row that already had a password
-- is a row whose holder could already sign in and see everything, so making
-- them owners changes nothing about who can do what today — it only names the
-- access they already had. Backfilling the other way (nobody is an owner)
-- would lock the salon out of its own dashboard on deploy, with no screen left
-- that could grant the role back.
UPDATE "StaffUser" SET "role" = 'owner' WHERE "passwordHash" IS NOT NULL;
