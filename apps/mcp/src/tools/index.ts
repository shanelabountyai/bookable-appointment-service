import type { z } from 'zod';
import type { ToolDef } from './define';
import { findOpenTimesTool } from './find-open-times';
import { getAppointmentTool } from './get-appointment';
import { getDayTool } from './get-day';
import { listProvidersTool } from './list-providers';
import { listServicesTool } from './list-services';

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- a heterogeneous list; each entry is fully typed where it is defined
export type AnyToolDef = ToolDef<any, any>;

/** Every tool the server knows. Listing per role happens in server.ts. */
export const TOOLS: readonly AnyToolDef[] = [listServicesTool, listProvidersTool, findOpenTimesTool, getDayTool, getAppointmentTool];

export type Shape = z.ZodRawShape;
