/**
 * The error envelope (PRD §6.6). One shape for every failure, so a model can
 * read `error`, fix `field`, and know which tool comes `next`.
 *
 * M-003 ships `UNAUTHORIZED`; M-004 adds the domain codes and the mapping
 * from `packages/db` errors.
 */
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

export type ErrorCode =
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  | 'SLOT_TAKEN'
  | 'OUTSIDE_HOURS'
  | 'NOT_QUALIFIED'
  | 'INVALID_TRANSITION'
  | 'AMBIGUOUS_TIME'
  | 'AMBIGUOUS_CLIENT'
  | 'NOT_FOUND'
  | 'PROPOSAL_EXPIRED'
  | 'PROPOSAL_STALE'
  | 'PROPOSAL_USED'
  | 'RATE_LIMITED';

export interface ToolError {
  error: ErrorCode;
  /** Plain words a model can show the human as-is. */
  message: string;
  /** Which input argument to change, when one is. */
  field?: string;
  /** What to do next. Absent when the model cannot fix it alone. */
  next?: { tool: string; why: string };
  retry_after_s?: number;
}

export function toolError(err: ToolError): CallToolResult {
  return {
    isError: true,
    content: [{ type: 'text', text: JSON.stringify(err) }],
    structuredContent: { ...err },
  };
}

export const UNAUTHORIZED = toolError({
  error: 'UNAUTHORIZED',
  message: 'This token no longer works — it was revoked or its person is off the roster. Ask an owner for a new one.',
});

export const FORBIDDEN = toolError({
  error: 'FORBIDDEN',
  message: 'This tool is for owners, and this token belongs to a stylist.',
});
