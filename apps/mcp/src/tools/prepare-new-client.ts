/**
 * prepare_new_client → commit_proposal → a Client row, exactly as the desk's
 * "add somebody" does (`createClientForBooking`): name and phone, the
 * database canonicalising the number (D-55's trigger). A phone the salon
 * already has is refused with the existing record's id, so the model cannot
 * create a duplicate of somebody who is already a client.
 */
import { findClientsByPhone } from '@bookable/db/clients';
import { z } from 'zod';
import { ToolFailure, invalidArgument } from '../errors';
import { defineWrite } from './proposals';

export interface NewClientCanonical {
  name: string;
  phone: string;
  [key: string]: string;
}

const last4 = (phone: string) => phone.replace(/\D/g, '').slice(-4);

export const newClientAction = defineWrite({
  name: 'prepare_new_client',
  description:
    'Preview adding a client who is not on the books yet — run find_client first. Needs a name and a phone number; if the number already belongs to a client, the preview is refused and names them so you can book that client instead.',
  inputSchema: {
    name: z.string().min(1).max(120).describe('As the human gave it.'),
    phone: z.string().min(7).max(32).describe('Digits, with or without spaces, brackets or a leading +.'),
  },
  outputSchema: {
    client_id: z.string(),
    name: z.string(),
    phone_last4: z.string(),
  },
  async prepare(ctx, args, deps) {
    const name = args.name.trim();
    if (!name) throw invalidArgument('name', 'A client needs a name.');
    const digits = args.phone.replace(/\D/g, '');
    if (digits.length < 7) throw invalidArgument('phone', 'That does not look like a phone number — at least seven digits.');

    const existing = await findClientsByPhone(deps.prisma, ctx.businessId, args.phone);
    if (existing.length > 0) {
      const names = existing.map((c) => `${c.name ?? '(no name)'} (client_id ${c.id})`).join(', ');
      throw new ToolFailure({
        error: 'AMBIGUOUS_CLIENT',
        message: `A client with a phone ending ${last4(args.phone)} is already on the books: ${names}. Book them, or ask the human if this is somebody else.`,
        field: 'phone',
        next: { tool: 'find_client', why: 'confirm who this is' },
      });
    }
    const canonical: NewClientCanonical = { name, phone: args.phone.trim() };
    return { canonical, summary: `Add client ${name}, phone ending ${last4(args.phone)}.` };
  },
  async commit(ctx, c, deps) {
    const row = await deps.prisma.client.create({
      data: { businessId: ctx.businessId, name: c.name, phone: c.phone },
      select: { id: true, name: true, phone: true },
    });
    return {
      summary: `added ${row.name} (client_id ${row.id}).`,
      data: { client_id: row.id, name: row.name ?? c.name, phone_last4: last4(row.phone ?? c.phone) },
    };
  },
});
