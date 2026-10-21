/**
 * W-006 (API PRD §7) — ADDING A CLIENT, ONE FUNCTION FOR EVERY DOOR.
 *
 * Until W-006 there were three copies of the same insert: the desk's
 * `createClientForBooking` (a server action), MCP's `prepare_new_client`
 * commit, and — about to be — the API's `POST /v1/clients`. Three copies of a
 * write is three places a later rule (D-55's canonical phone, a required
 * field) has to be added, and the one that is forgotten is the one an
 * integration uses at 3 a.m. The canonicalisation itself is the database's
 * (the `client_identity` trigger, D-55); this function owns everything else:
 * trimming, the empty-phone rule, and the business scope.
 *
 * It does NOT decide duplicates. `findClientsByPhone` lists the matches; the
 * caller decides what a match means — the desk shows them (a household shares
 * a number, D-17), MCP and the API refuse with AMBIGUOUS_CLIENT unless told
 * the duplicate is intended. Nothing here may merge two people.
 */
import type { Prisma, PrismaClient } from '../generated/client/index.js';

type Db = Prisma.TransactionClient | PrismaClient;

export class ClientRejected extends Error {
  readonly field: string;
  constructor(field: string, message: string) {
    super(message);
    this.name = 'ClientRejected';
    this.field = field;
  }
}

export interface CreateClientInput {
  businessId: string;
  name: string;
  /** Free-form; the database stores its canonical form (D-55). Blank = none. */
  phone?: string | null;
  email?: string | null;
}

export interface CreatedClient {
  id: string;
  name: string | null;
  phone: string | null;
  email: string | null;
}

export async function createClient(db: Db, input: CreateClientInput): Promise<CreatedClient> {
  const name = input.name.trim();
  if (!name) throw new ClientRejected('name', 'A client needs a name.');
  const phone = input.phone?.trim() || null;
  const email = input.email?.trim() || null;
  return db.client.create({
    data: { businessId: input.businessId, name, phone, email },
    select: { id: true, name: true, phone: true, email: true },
  });
}
