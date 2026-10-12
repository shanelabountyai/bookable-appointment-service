/**
 * Preview-then-commit (PRD §8), the shape every write tool is written in.
 *
 * A `WriteAction` has two halves. `prepare(ctx, args, deps)` runs EVERY check
 * the commit will run — ids, qualification, the slot engine, the transition
 * table — writes nothing, and returns canonical args plus a human sentence.
 * `commit(ctx, canonicalArgs, deps)` runs the real `packages/db` function with
 * those stored args and nothing else. The `prepare_*` tool and
 * `commit_proposal` are generated from the action, so no write can exist
 * without a preview and no commit can take fresh arguments.
 */
import type { Prisma } from '@bookable/db';
import { PROPOSAL_TTL_MS, createProposal } from '@bookable/db/mcp';
import { z } from 'zod';
import type { CallerContext } from '../context';
import { timeOutOf } from '../time';
import { ALL_ROLES, type ToolDef, type ToolDeps, defineTool } from './define';

export interface Prepared<Canonical> {
  /** Exactly what `commit` will be called with. Stored as JSON; keep it plain. */
  canonical: Canonical;
  /** The sentence the human approves. */
  summary: string;
}

export interface WriteAction<In extends z.ZodRawShape, Canonical extends Prisma.InputJsonValue, Out extends z.ZodRawShape> {
  /** The `prepare_*` tool's name. The proposal row records it as `action`. */
  name: string;
  description: string;
  inputSchema: In;
  /** What `commit_proposal` returns for this action. */
  outputSchema: Out;
  prepare: (ctx: CallerContext, args: z.infer<z.ZodObject<In>>, deps: ToolDeps) => Promise<Prepared<Canonical>>;
  commit: (
    ctx: CallerContext,
    canonical: Canonical,
    deps: ToolDeps,
    proposalId: string,
  ) => Promise<{ summary: string; data: z.infer<z.ZodObject<Out>> }>;
}

export function defineWrite<In extends z.ZodRawShape, Canonical extends Prisma.InputJsonValue, Out extends z.ZodRawShape>(
  action: WriteAction<In, Canonical, Out>,
): WriteAction<In, Canonical, Out> {
  return action;
}

export const proposalShape = {
  proposal_id: z.string(),
  summary: z.string().describe('Show this to the human. commit_proposal does exactly this and nothing else.'),
  expires: z.object({ label: z.string(), iso: z.string() }),
};

/** The `prepare_*` tool for an action: validates, stores the proposal, writes nothing. */
export function prepareTool<In extends z.ZodRawShape, C extends Prisma.InputJsonValue, Out extends z.ZodRawShape>(
  action: WriteAction<In, C, Out>,
): ToolDef<In, typeof proposalShape> {
  return defineTool({
    name: action.name,
    roles: ALL_ROLES,
    description:
      action.description +
      ` Nothing is written: the result is a proposal_id and a one-line summary to show the human; call commit_proposal with the id to do it. Proposals expire after ${PROPOSAL_TTL_MS / 60_000} minutes and can be committed once.`,
    inputSchema: action.inputSchema,
    outputSchema: proposalShape,
    // Read-only in effect — a proposal row is bookkeeping, not a change to the book.
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    async handler(ctx, args, deps) {
      const prepared = await action.prepare(ctx, args, deps);
      const row = await createProposal(deps.prisma, {
        businessId: ctx.businessId,
        staffUserId: ctx.staffUserId,
        tokenId: ctx.tokenId,
        action: action.name,
        args: prepared.canonical,
        summary: prepared.summary,
        now: deps.now(),
      });
      return {
        summary: `Proposed: ${prepared.summary} Commit with proposal_id ${row.id}.`,
        data: { proposal_id: row.id, summary: prepared.summary, expires: timeOutOf(row.expiresAt, ctx.timezone) },
      };
    },
  });
}
