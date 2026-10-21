/**
 * W-002 — the error envelope (API PRD §6.5): `application/problem+json`
 * (RFC 9457) with `code` from the MCP server's vocabulary and `next` naming
 * the endpoint that fixes it.
 *
 * Domain errors are mapped ONCE, by the MCP module (`apps/mcp/src/errors.ts`
 * `mapDomainError`) — which owns the SQLSTATE-aware classification of every
 * `packages/db` error — and translated HERE into the HTTP envelope. A second
 * classifier would be the "one fact, two readers" defect waiting to diverge:
 * the day a new domain error is taught to the MCP mapper, the API learns it
 * too. Only the MCP-specific vocabulary (tool names, `INVALID_ARGUMENT`,
 * `PROPOSAL_*`) is re-spoken here (W-D12).
 *
 * Anything neither module recognises is NOT an envelope: it is rethrown, so a
 * bug reaches the log as a bug (500), not as a polite 4xx.
 */
import { isSlotTakenError } from '@bookable/db/errors';
import { type ErrorCode as McpCode, type ToolError, mapDomainError } from '@bookable/mcp';

export type ApiCode =
  | 'VALIDATION'
  | 'UNAUTHENTICATED'
  | 'FORBIDDEN_SCOPE'
  | 'NOT_FOUND'
  | 'IDEMPOTENCY_REQUIRED'
  | 'IDEMPOTENCY_MISMATCH'
  | 'IDEMPOTENCY_IN_PROGRESS'
  | 'SLOT_TAKEN'
  | 'OUTSIDE_HOURS'
  | 'NOT_QUALIFIED'
  | 'INVALID_TRANSITION'
  | 'AMBIGUOUS_TIME'
  | 'AMBIGUOUS_CLIENT'
  | 'PRECONDITION_FAILED'
  | 'CONFLICT'
  | 'RATE_LIMITED';

/** §6.5's table. One status per code, so a test per code can assert both. */
export const STATUS: Record<ApiCode, number> = {
  VALIDATION: 400,
  UNAUTHENTICATED: 401,
  FORBIDDEN_SCOPE: 403,
  NOT_FOUND: 404,
  IDEMPOTENCY_REQUIRED: 400,
  IDEMPOTENCY_MISMATCH: 422,
  IDEMPOTENCY_IN_PROGRESS: 409,
  SLOT_TAKEN: 409,
  OUTSIDE_HOURS: 422,
  NOT_QUALIFIED: 422,
  INVALID_TRANSITION: 409,
  AMBIGUOUS_TIME: 422,
  AMBIGUOUS_CLIENT: 409,
  PRECONDITION_FAILED: 412,
  CONFLICT: 409,
  RATE_LIMITED: 429,
};

const TITLES: Record<ApiCode, string> = {
  VALIDATION: 'The request was not valid',
  UNAUTHENTICATED: 'Missing or invalid API key',
  FORBIDDEN_SCOPE: 'This key lacks the scope for that',
  NOT_FOUND: 'Not found',
  IDEMPOTENCY_REQUIRED: 'Idempotency-Key header required',
  IDEMPOTENCY_MISMATCH: 'Idempotency-Key reused with a different request',
  IDEMPOTENCY_IN_PROGRESS: 'The first request with this Idempotency-Key is still running',
  SLOT_TAKEN: 'That time is taken',
  OUTSIDE_HOURS: 'Outside working hours',
  NOT_QUALIFIED: 'The stylist cannot do that visit',
  INVALID_TRANSITION: 'Not allowed from the current status',
  AMBIGUOUS_TIME: 'That wall time is not one moment',
  AMBIGUOUS_CLIENT: 'A client with that phone already exists',
  PRECONDITION_FAILED: 'The appointment changed since you read it',
  CONFLICT: 'The appointment changed while this ran',
  RATE_LIMITED: 'Too many requests',
};

export interface Next {
  endpoint: string;
  why: string;
}

export interface Problem {
  type: string;
  title: string;
  status: number;
  detail: string;
  code: ApiCode;
  next?: Next;
  /** VALIDATION only: which fields, and why. */
  errors?: { field: string; message: string }[];
  /** SLOT_TAKEN / OUTSIDE_HOURS: up to five times that ARE offered. */
  alternatives?: { startAt: string }[];
  /** AMBIGUOUS_CLIENT: the clients already on that phone — ids and names only (§6.8). */
  matches?: { id: string; name: string | null }[];
}

/** Thrown by a handler to fail with a specific problem. The wrapper catches it. */
export class ApiFailure extends Error {
  constructor(
    readonly problem: Problem,
    readonly headers: Record<string, string> = {},
  ) {
    super(problem.detail);
    this.name = 'ApiFailure';
  }
}

export function problem(code: ApiCode, detail: string, extra: Partial<Omit<Problem, 'code' | 'status'>> = {}): Problem {
  return {
    type: `https://appt.labintelligence.co/api/v1/problems/${code.toLowerCase().replaceAll('_', '-')}`,
    title: TITLES[code],
    status: STATUS[code],
    detail,
    code,
    ...extra,
  };
}

export function fail(code: ApiCode, detail: string, extra: Partial<Omit<Problem, 'code' | 'status'>> = {}, headers: Record<string, string> = {}): ApiFailure {
  return new ApiFailure(problem(code, detail, extra), headers);
}

export function problemResponse(p: Problem, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(p), {
    status: p.status,
    headers: { 'Content-Type': 'application/problem+json', 'Cache-Control': 'no-store', ...headers },
  });
}

/** `NOT_FOUND` never says whether the id exists elsewhere (§5). `next` is the list that hands out ids of this kind. */
export function notFound(what: string, field: string, endpoint: string): ApiFailure {
  return fail('NOT_FOUND', `No ${what} with that id on this book. Ids must come from a previous response.`, {
    errors: [{ field, message: 'unknown id' }],
    next: { endpoint, why: `get a current ${what} id` },
  });
}

/** The MCP tool that hands out an id, and the endpoint that does the same here. */
const TOOL_TO_ENDPOINT: Record<string, string> = {
  find_open_times: 'GET /v1/availability',
  list_providers: 'GET /v1/providers',
  list_services: 'GET /v1/services',
  find_client: 'GET /v1/clients',
  get_appointment: 'GET /v1/appointments/{id}',
  get_day: 'GET /v1/days/{day}',
};

/** MCP `field` names are the tool's snake_case arguments; the API's are camelCase. */
const FIELD: Record<string, string> = {
  provider_id: 'providerId',
  client_id: 'clientId',
  service_ids: 'serviceIds',
  appointment_id: 'id',
};

const MCP_TO_API: Partial<Record<McpCode, ApiCode>> = {
  SLOT_TAKEN: 'SLOT_TAKEN',
  OUTSIDE_HOURS: 'OUTSIDE_HOURS',
  NOT_QUALIFIED: 'NOT_QUALIFIED',
  INVALID_TRANSITION: 'INVALID_TRANSITION',
  AMBIGUOUS_TIME: 'AMBIGUOUS_TIME',
  AMBIGUOUS_CLIENT: 'AMBIGUOUS_CLIENT',
  NOT_FOUND: 'NOT_FOUND',
  INVALID_ARGUMENT: 'VALIDATION',
  // A row that moved between this request's read and its write (`expectedFrom`).
  PROPOSAL_STALE: 'CONFLICT',
  RATE_LIMITED: 'RATE_LIMITED',
};

/**
 * Any thrown value → the problem to send, or null when it is not one of ours
 * (the caller rethrows). `ApiFailure` passes through; everything else goes
 * through the MCP mapper first.
 */
export function toProblem(error: unknown): { problem: Problem; headers: Record<string, string> } | null {
  if (error instanceof ApiFailure) return { problem: error.problem, headers: error.headers };
  // A-078's rule, at this boundary too: a RAW exclusion-constraint refusal that
  // reached here unwrapped — in EITHER shape, the statement-time SQLSTATE or the
  // commit-time name-only message — is a lost race, never a 500. Every domain
  // function wraps its own; this is the net under any that does not.
  if (isSlotTakenError(error)) {
    return {
      problem: problem('SLOT_TAKEN', 'Somebody took that time a moment ago.', {
        errors: [{ field: 'start', message: 'taken' }],
        next: { endpoint: 'GET /v1/availability', why: 'pick another time' },
      }),
      headers: {},
    };
  }
  const mapped: ToolError | null = mapDomainError(error);
  if (!mapped) return null;
  const code = MCP_TO_API[mapped.error];
  if (!code) return null;
  const field = mapped.field ? (FIELD[mapped.field] ?? mapped.field) : undefined;
  const nextEndpoint = mapped.next ? TOOL_TO_ENDPOINT[mapped.next.tool] : undefined;
  const detail =
    code === 'CONFLICT'
      ? 'The appointment changed while this request ran. Nothing was written; read it again and retry.'
      : mapped.message.replace(/\bfind_open_times\b/g, 'GET /v1/availability');
  return {
    problem: problem(code, detail, {
      ...(field ? { errors: [{ field, message: mapped.message }] } : {}),
      ...(nextEndpoint && mapped.next ? { next: { endpoint: nextEndpoint, why: mapped.next.why } } : {}),
      ...(code === 'CONFLICT' ? { next: { endpoint: 'GET /v1/appointments/{id}', why: 'read the current state and allowedActions' } } : {}),
      ...(mapped.alternatives ? { alternatives: mapped.alternatives.map((a) => ({ startAt: a.iso })) } : {}),
    }),
    headers: {},
  };
}
