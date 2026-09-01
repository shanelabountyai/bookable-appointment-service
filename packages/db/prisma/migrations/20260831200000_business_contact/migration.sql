-- The public site's contact details, read from the row rather than typed into
-- a page. All four are NULLABLE: an install that has not filled them in shows
-- no address block at all, which is honest, where a "[YOUR PHONE]" placeholder
-- and a `tel:[YOUR PHONE]` link are not.
ALTER TABLE "Business"
  ADD COLUMN "addressLine" TEXT,
  ADD COLUMN "addressCity" TEXT,
  ADD COLUMN "phone"       TEXT,
  ADD COLUMN "email"       TEXT;
