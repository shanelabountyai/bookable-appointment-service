-- A-114 / D-55 — ONE CLIENT, HOWEVER TWO PEOPLE TYPE HER.
--
-- The website reused a client only on an exact (phone, name) match, and the
-- phone was normalised by a JS helper that kept a leading "+". So
-- "+1 512 555 0101", "1 512 555 0101" and "(512) 555-0101" were three
-- identities, every seeded phone was stored in the one form a US client never
-- types, and a client blocked under CLIENT-04 booked straight past the block
-- by writing her number with brackets. The name had the same fault one column
-- over: ILIKE folds neither accents nor Unicode form, so "Rae Nunez" was a
-- stranger to "Rae Núñez" and the desk's search for "nunez" found nobody.
--
-- BOTH FORMS ARE DEFINED HERE, ONCE, AND A TRIGGER OWNS THEM. Every writer —
-- the public flow, the desk, the seed, a hand-written test fixture, psql —
-- stores the same canonical row, the way `blockedStart`/`blockedEnd` are
-- derived rather than supplied. Readers ask these same functions about what
-- was typed. A JS copy of either rule would be the same fact under a second
-- name, and the backfill below would be a third.
--
-- D-17 is untouched: `phone` stays NOT unique, and a shared phone with a
-- different folded name is still a different person.

CREATE EXTENSION IF NOT EXISTS unaccent;

-- CANONICALISING, NOT VALIDATING. Nothing typed is refused here.
--   10 digits                  → +1XXXXXXXXXX   (the business default)
--   11 digits beginning 1      → +1XXXXXXXXXX
--   anything written with "+"  → + and its digits, as given
--   anything else (a 7-digit local number, a foreign number without "+")
--                              → its digits
--   no digits at all           → NULL
-- ponytail: the default country is NANP in this function, because every
-- business this product has is in the US. A salon outside it needs a
-- Business column read here, and every caller already passes businessId.
CREATE OR REPLACE FUNCTION "bookable_phone"(raw TEXT)
RETURNS TEXT LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN d = '' THEN NULL
    WHEN btrim(raw) LIKE '+%' THEN '+' || d
    WHEN length(d) = 10 THEN '+1' || d
    WHEN length(d) = 11 AND d LIKE '1%' THEN '+' || d
    ELSE d
  END
  FROM (SELECT regexp_replace(raw, '[^0-9]', '', 'g') AS d) digits
$$;

-- NFC first, so a name typed DECOMPOSED ("n" + U+0303) reaches unaccent as the
-- one character its rules know; then accents off, case off, whitespace
-- collapsed. The dictionary is schema-qualified so the function means the same
-- thing whatever search_path the caller has.
CREATE OR REPLACE FUNCTION "bookable_fold"(raw TEXT)
RETURNS TEXT LANGUAGE sql IMMUTABLE AS $$
  SELECT NULLIF(
    lower(btrim(regexp_replace(
      public.unaccent('public.unaccent'::regdictionary, normalize(raw, NFC)),
      '\s+', ' ', 'g'))),
    '')
$$;

ALTER TABLE "Client" ADD COLUMN "nameFolded" TEXT;

CREATE OR REPLACE FUNCTION "client_identity"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW."phone" := "bookable_phone"(NEW."phone");
  NEW."nameFolded" := "bookable_fold"(NEW."name");
  RETURN NEW;
END
$$;

-- No column list on UPDATE: a writer that sets `nameFolded` by hand must not
-- be able to store a fold the name does not have.
CREATE TRIGGER "client_identity"
  BEFORE INSERT OR UPDATE ON "Client"
  FOR EACH ROW EXECUTE FUNCTION "client_identity"();

-- The backfill IS the trigger: no second copy of either rule.
UPDATE "Client" SET "phone" = "phone";

-- Rows that were one person typed two ways now share (phone, nameFolded).
-- Nothing merges them here: a merge is not reversible by a second merge, and
-- "into which one?" is a person's decision (A-015). The client page names the
-- other record instead.
CREATE INDEX "Client_businessId_phone_nameFolded_idx" ON "Client"("businessId", "phone", "nameFolded");
