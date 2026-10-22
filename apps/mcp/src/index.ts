/** What other workspaces may import. The web app mounts `handleMcpRequest` at /api/mcp. */
export { type CallerContext, contextForToken } from './context';
export { bearerToken, handleMcpRequest } from './http';
export { type Credential, createBookableServer, SERVER_INFO } from './server';
export { TOOLS, WRITE_ACTIONS } from './tools';
export type { ToolDeps } from './tools/define';
/** W-002: the API maps domain errors through the SAME classifier (one fact, one mapper). */
export { type ErrorCode, type ToolError, ToolFailure, mapDomainError } from './errors';
export { parseDay, parseInstant, timeOut, timeOutOf, type TimeOut } from './time';
/** W-002+: the API asks "is this exact instant offered?" with the SAME function MCP's previews use. */
export { offeredSlot } from './tools/offered';
