import type { z } from 'zod';
import { findClientTool, getClientHistoryTool } from './clients';
import type { ToolDef } from './define';
import { findOpenTimesTool } from './find-open-times';
import { getAppointmentTool } from './get-appointment';
import { getDayTool } from './get-day';
import { getWeekReportTool } from './get-week-report';
import { listProvidersTool } from './list-providers';
import { listServicesTool } from './list-services';
import { listWaitlistTool } from './list-waitlist';

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- a heterogeneous list; each entry is fully typed where it is defined
export type AnyToolDef = ToolDef<any, any>;

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
];

export type Shape = z.ZodRawShape;
