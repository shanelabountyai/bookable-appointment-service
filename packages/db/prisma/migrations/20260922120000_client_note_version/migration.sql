-- A-146 (D-72, OQ-23a) — the pinned note's history, and the token a stale
-- save is refused against.
--
-- CREATE TABLE
CREATE TABLE "ClientNoteVersion" (
    "id"         TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "clientId"   TEXT NOT NULL,
    "text"       TEXT NOT NULL,
    "actor"      "Actor" NOT NULL,
    "actorRef"   TEXT,
    "createdAt"  TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ClientNoteVersion_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ClientNoteVersion_clientId_createdAt_idx" ON "ClientNoteVersion"("clientId", "createdAt");

-- Restrict, not Cascade: same reasoning as `AppointmentEvent` — this table IS
-- the audit trail for CLIENT-03's safety surface, not a note about it.
ALTER TABLE "ClientNoteVersion" ADD CONSTRAINT "ClientNoteVersion_businessId_fkey"
  FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ClientNoteVersion" ADD CONSTRAINT "ClientNoteVersion_clientId_fkey"
  FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Append-only, same mechanism as `AppointmentEvent` (§5 of the core migration).
CREATE OR REPLACE FUNCTION "client_note_version_append_only"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'ClientNoteVersion is append-only (attempted % on id=%)', TG_OP, OLD."id"
    USING ERRCODE = 'restrict_violation';
END $$;

CREATE TRIGGER "client_note_version_no_update_delete"
  BEFORE UPDATE OR DELETE ON "ClientNoteVersion"
  FOR EACH ROW EXECUTE FUNCTION "client_note_version_append_only"();
