import type { z } from 'zod';
import { findClientTool, getClientHistoryTool } from './clients';
import { commitProposalTool, type AnyWriteAction } from './commit-proposal';
import type { ToolDef } from './define';
import { findOpenTimesTool } from './find-open-times';
import { getAppointmentTool } from './get-appointment';
import { getDayTool } from './get-day';
import { getWeekReportTool } from './get-week-report';
import { listProvidersTool } from './list-providers';
import { listServicesTool } from './list-services';
import { listWaitlistTool } from './list-waitlist';
import { bookingAction } from './prepare-booking';
import { newClientAction } from './prepare-new-client';
import { prepareTool } from './proposals';

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- a heterogeneous list; each entry is fully typed where it is defined
export type AnyToolDef = ToolDef<any, any>;

/** Every write the server can make. Each becomes a `prepare_*` tool; `commit_proposal` runs them. */
export const WRITE_ACTIONS: readonly AnyWriteAction[] = [bookingAction, newClientAction];

/** Every tool the server knows. Listing per role happens in server.ts. */
export const TOOLS: readonly AnyToolDef[] = [
  listServicesTool,
  listProvidersTool,
  findOpenTimesTool,
  getDayTool,
  getAppointmentTool,
  findClientTool,
  getClientHistoryTool,
  listWaitlistTool,
  getWeekReportTool,
  ...WRITE_ACTIONS.map(prepareTool),
  commitProposalTool(WRITE_ACTIONS),
];

export type Shape = z.ZodRawShape;
