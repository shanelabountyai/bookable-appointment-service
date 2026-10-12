/**
 * The error envelope (PRD §6.6). One shape for every failure, so a model can
 * read `error`, fix `field`, and know which tool comes `next`.
 *
 * Domain errors from `packages/db` are mapped HERE and nowhere else, with a
 * test per code (`errors.test.ts`). Anything this module does not recognise
 * is rethrown: a bug must reach the log as a bug, not as a polite envelope.
 */
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { ExclusionReason } from '@bookable/core/scheduling';
import {
  AppointmentAlreadyMoved,
  AppointmentMovedFirst,
  RescheduleRefused,
  TransitionRefused,
} from '@bookable/db/appointments';
import { BookingRejected, NoResourceFree, SlotNotOffered, SlotTaken } from '@bookable/db/booking';
import { WaitlistEntryRejected } from '@bookable/db/waitlist';

export type ErrorCode =
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  | 'INVALID_ARGUMENT'
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
  /** Up to five other times that ARE offered, when a time was refused. */
  alternatives?: { label: string; iso: string }[];
}

/** Thrown by a tool handler to fail with a specific envelope. The server catches it. */
export class ToolFailure extends Error {
  constructor(readonly envelope: ToolError) {
    super(envelope.message);
    this.name = 'ToolFailure';
  }
}

/**
 * The envelope travels in `content` as JSON text and NOT in `structuredContent`:
 * a client that has seen `tools/list` validates `structuredContent` against the
 * tool's OUTPUT schema, error or not, and refuses the whole result when it does
 * not match (found by the eval harness, M-015 — Claude's clients validate). An
 * `isError` result has no structured payload by the protocol's own rules.
 */
export function toolError(err: ToolError): CallToolResult {
  return {
    isError: true,
    content: [{ type: 'text', text: JSON.stringify(err) }],
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

export const rateLimited = (retryAfterS: number): CallToolResult =>
  toolError({
    error: 'RATE_LIMITED',
    message: `Too many calls for this token. Wait ${retryAfterS} seconds and try again.`,
    retry_after_s: retryAfterS,
  });

/** `NOT_FOUND` never says whether the id exists elsewhere (§6.3). `next` is the tool that hands out ids of this kind. */
export function notFound(what: string, field: string, nextTool: string): ToolFailure {
  return new ToolFailure({
    error: 'NOT_FOUND',
    message: `No ${what} with that id on this book. Ids must come from a previous tool result.`,
    field,
    next: { tool: nextTool, why: `get a current ${what} id` },
  });
}

export function invalidArgument(field: string, message: string): ToolFailure {
  return new ToolFailure({ error: 'INVALID_ARGUMENT', message, field });
}

const FIND_TIMES = { tool: 'find_open_times', why: 'pick another time' } as const;

/**
 * Reasons that mean "the stylist is not working then" — the model should look
 * at different hours. Everything else means "working, but taken" — it should
 * look at different times on the same hours. Split once here, not per tool.
 */
const HOURS_REASONS: ReadonlySet<string> = new Set<ExclusionReason | string>([
  'outside-working-window',
  'inside-break',
  'crosses-window-close',
  'overlaps-time-off',
  'overlaps-block',
  'in-the-past',
  'inside-lead-time',
]);
const DST_REASONS: ReadonlySet<string> = new Set<ExclusionReason>(['nonexistent-local-time', 'ambiguous-suppressed']);

export interface MapContext {
  /** How "that time" reads to a human — the caller knows the zone. */
  timeLabel?: string;
  /** Which `prepare_*` tool to repeat when the world moved under a proposal. */
  retryTool?: string;
  alternatives?: { label: string; iso: string }[];
}

/**
 * Domain error → envelope, or null when the error is not one of ours.
 * The order matters only where classes could be confused; they are disjoint.
 */
export function mapDomainError(error: unknown, ctx: MapContext = {}): ToolError | null {
  const when = ctx.timeLabel ?? 'that time';
  const alternatives = ctx.alternatives;

  if (error instanceof ToolFailure) return error.envelope;

  if (error instanceof SlotTaken) {
    return {
      error: 'SLOT_TAKEN',
      message: `${when} was booked a moment ago.`,
      field: 'start',
      next: FIND_TIMES,
      ...(alternatives ? { alternatives } : {}),
    };
  }

  if (error instanceof SlotNotOffered) {
    const reasons = error.reasons;
    if (reasons.some((r) => DST_REASONS.has(r))) {
      return {
        error: 'AMBIGUOUS_TIME',
        message: `${when} is not a single moment on that day (daylight saving changes). Ask the human which they meant, then send an ISO time with its offset.`,
        field: 'start',
      };
    }
    if (reasons.length > 0 && reasons.every((r) => HOURS_REASONS.has(r))) {
      return {
        error: 'OUTSIDE_HOURS',
        message: `${when} is outside the stylist's working hours (${reasons.join(', ')}).`,
        field: 'start',
        next: FIND_TIMES,
        ...(alternatives ? { alternatives } : {}),
      };
    }
    return {
      error: 'SLOT_TAKEN',
      message: `${when} is not free (${reasons.join(', ') || 'not offered'}).`,
      field: 'start',
      next: FIND_TIMES,
      ...(alternatives ? { alternatives } : {}),
    };
  }

  if (error instanceof NoResourceFree) {
    return {
      error: 'SLOT_TAKEN',
      message: `Every ${error.message.replace(/^.*?(\w+)s? (is|are) .*$/, '$1').toLowerCase() || 'chair'} is taken at ${when}.`,
      field: 'start',
      next: FIND_TIMES,
    };
  }

  if (error instanceof BookingRejected) {
    if (error.field === 'serviceIds' && /not qualified/i.test(error.message)) {
      return {
        error: 'NOT_QUALIFIED',
        message: 'That stylist cannot do everything in this visit.',
        field: 'provider_id',
        next: { tool: 'list_providers', why: 'see who can do all of these services' },
      };
    }
    if (error.field === 'toProviderId') {
      return {
        error: 'NOT_QUALIFIED',
        message: error.message,
        field: 'provider_id',
        next: { tool: 'list_providers', why: 'see who can take this visit' },
      };
    }
    if (error.field === 'providerId') return notFound('stylist', 'provider_id', 'list_providers').envelope;
    if (error.field === 'clientId') return notFound('client', 'client_id', 'find_client').envelope;
    return { error: 'INVALID_ARGUMENT', message: error.message, field: error.field };
  }

  if (error instanceof TransitionRefused || error instanceof RescheduleRefused) {
    const to = error instanceof TransitionRefused ? ` to ${error.to}` : '';
    return {
      error: 'INVALID_TRANSITION',
      message: `An appointment that is ${error.from} cannot be moved${to} (${error.refusal}).`,
      field: 'to',
      next: { tool: 'get_appointment', why: 'read allowed_actions for what it can do now' },
    };
  }

  if (error instanceof AppointmentMovedFirst || error instanceof AppointmentAlreadyMoved) {
    return {
      error: 'PROPOSAL_STALE',
      message: 'The appointment changed after this was previewed. Nothing was written.',
      ...(ctx.retryTool ? { next: { tool: ctx.retryTool, why: 'preview again against the current state' } } : {}),
    };
  }

  if (error instanceof WaitlistEntryRejected) {
    if (error.field === 'clientId') return notFound('client', 'client_id', 'find_client').envelope;
    if (error.field === 'serviceIds' && /No such/.test(error.message)) {
      return notFound('service', 'service_ids', 'list_services').envelope;
    }
    if (error.field === 'providerIds') return notFound('stylist', 'provider_id', 'list_providers').envelope;
    return { error: 'INVALID_ARGUMENT', message: error.message, field: error.field };
  }

  return null;
}
