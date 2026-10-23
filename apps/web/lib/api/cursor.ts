/**
 * W-004 — cursor pagination (API PRD §6.4). Every list takes `limit` (≤ 100,
 * default 25) and `cursor`, and answers `nextCursor` or null. NO offset
 * pagination anywhere: an offset over a book that is being written to skips
 * or repeats rows; a keyset cursor does neither.
 *
 * The cursor is the sort key of the last row returned, base64url-encoded JSON,
 * and opaque to the caller (§6.3). A cursor that does not decode is a
 * VALIDATION error naming `cursor`, never a silent restart from page one.
 */
import { z } from 'zod';
import { fail } from './problem';

export const LIMIT_DEFAULT = 25;
export const LIMIT_MAX = 100;

export const limitField = z.coerce.number().int().min(1).max(LIMIT_MAX).default(LIMIT_DEFAULT);

export function encodeCursor(key: Record<string, string | number>): string {
  return Buffer.from(JSON.stringify(key), 'utf8').toString('base64url');
}

export function decodeCursor<T extends z.ZodType>(schema: T, cursor: string | undefined): z.infer<T> | null {
  if (cursor === undefined) return null;
  try {
    const parsed = schema.safeParse(JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')));
    if (parsed.success) return parsed.data;
  } catch {
    // fall through
  }
  throw fail('VALIDATION', 'That cursor is not one this API issued. Start again without it.', { errors: [{ field: 'cursor', message: 'not a valid cursor' }] });
}

/**
 * Fetch `limit + 1`, return `limit`: the extra row says whether there is a
 * next page without a second COUNT query.
 */
export function page<T>(rows: T[], limit: number, keyOf: (row: T) => Record<string, string | number>): { data: T[]; nextCursor: string | null } {
  if (rows.length <= limit) return { data: rows, nextCursor: null };
  const data = rows.slice(0, limit);
  return { data, nextCursor: encodeCursor(keyOf(data[data.length - 1]!)) };
}
