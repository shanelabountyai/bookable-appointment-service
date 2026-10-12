/**
 * commit_proposal — the ONE write tool (PRD §7, §8). `destructiveHint: true`
 * so clients ask the human first; that prompt is the human gate, and what the
 * server guarantees is narrower and real: what commits is byte-for-byte what
 * was previewed, by the person who previewed it, once, within ten minutes,
 * and re-validated by the domain function at the moment of writing.
 */
import type { Prisma } from '@bookable/db';
import { claimProposal, recordOutcome } from '@bookable/db/mcp';
import { z } from 'zod';
import { ToolFailure, mapDomainError } from '../errors';
import { timeOutOf } from '../time';
import { ALL_ROLES, defineTool } from './define';
import type { WriteAction } from './proposals';

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- heterogeneous registry; each action is fully typed where it is defined
export type AnyWriteAction = WriteAction<any, any, any>;

export function commitProposalTool(actions: readonly AnyWriteAction[]) {
  const byName = new Map(actions.map((a) => [a.name, a]));
  return defineTool({
    name: 'commit_proposal',
    roles: ALL_ROLES,
    description:
      'Carry out a proposal made by a prepare_* tool, exactly as its summary said. This is the only tool that changes the book. Show the summary to the human and get their go-ahead first. ' +
      'Each proposal commits once; a second call returns PROPOSAL_USED. If the world changed since the preview (the time was taken, the status moved) the result is the specific error and nothing is written — run the prepare_* tool again.',
    inputSchema: {
      proposal_id: z.string().describe('From a prepare_* tool.'),
    },
    outputSchema: {
      action: z.string(),
      summary: z.string(),
      committed_at: z.object({ label: z.string(), iso: z.string() }),
      result: z.record(z.string(), z.unknown()).describe('The action\'s own result — ids and times to use next.'),
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    async handler(ctx, args, deps) {
      const now = deps.now();
      const claim = await claimProposal(deps.prisma, {
        id: args.proposal_id,
        businessId: ctx.businessId,
        staffUserId: ctx.staffUserId,
        now,
      });
      if (!claim.ok) {
        if (claim.reason === 'not-found') {
          throw new ToolFailure({
            error: 'NOT_FOUND',
            message: 'No proposal with that id for this token. Proposal ids come from a prepare_* tool, and only the person who prepared one can commit it.',
            field: 'proposal_id',
          });
        }
        if (claim.reason === 'used') {
          throw new ToolFailure({
            error: 'PROPOSAL_USED',
            message: `This proposal was already committed at ${timeOutOf(claim.usedAt, ctx.timezone).label}. Nothing was done twice.`,
            field: 'proposal_id',
          });
        }
        throw new ToolFailure({
          error: 'PROPOSAL_EXPIRED',
          message: `This proposal expired at ${timeOutOf(claim.expiresAt, ctx.timezone).label}. Prepare it again to get a fresh preview.`,
          field: 'proposal_id',
        });
      }

      const { proposal } = claim;
      const action = byName.get(proposal.action);
      if (!action) throw new Error(`McpProposal ${proposal.id} names an action this server does not know: ${proposal.action}`);

      try {
        const result = await action.commit(ctx, proposal.args, deps, proposal.id);
        await recordOutcome(deps.prisma, proposal.id, { ok: true, result: result.data as Prisma.InputJsonValue });
        return {
          summary: `Done: ${result.summary}`,
          data: { action: proposal.action, summary: proposal.summary, committed_at: timeOutOf(now, ctx.timezone), result: result.data },
        };
      } catch (error) {
        // The claim stands: a refused proposal is not retried, it is re-prepared
        // against the world as it is now. `next` says which tool.
        const mapped = mapDomainError(error, { retryTool: proposal.action });
        await recordOutcome(deps.prisma, proposal.id, mapped ? { ok: false, error: mapped.error, message: mapped.message } : { ok: false, error: 'INTERNAL' });
        if (mapped) throw new ToolFailure({ ...mapped, next: mapped.next ?? { tool: proposal.action, why: 'preview again against the current state' } });
        throw error;
      }
    },
  });
}
