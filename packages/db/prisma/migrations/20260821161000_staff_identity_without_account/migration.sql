-- A-037 — a staff IDENTITY is not necessarily an ACCOUNT.
--
-- The stylist who needs her name on a check-in does not need a way to sign in
-- from home, and issuing her a credential to satisfy a NOT NULL would be a
-- credential nobody asked for and everybody has to rotate. No email means no
-- way to authenticate, which `authenticateStaff` enforces by matching on it.
--
-- Postgres treats NULLs as distinct under a unique index, so (businessId,
-- email) tolerates any number of PIN-only rows.
ALTER TABLE "StaffUser" ALTER COLUMN "email" DROP NOT NULL;
ALTER TABLE "StaffUser" ALTER COLUMN "passwordHash" DROP NOT NULL;
