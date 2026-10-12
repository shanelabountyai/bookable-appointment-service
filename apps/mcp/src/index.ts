/** What other workspaces may import. The web app mounts `handleMcpRequest` at /api/mcp. */
export { type CallerContext, contextForToken } from './context';
export { bearerToken, handleMcpRequest } from './http';
export { type Credential, createBookableServer, SERVER_INFO } from './server';
export { TOOLS, WRITE_ACTIONS } from './tools';
export type { ToolDeps } from './tools/define';
