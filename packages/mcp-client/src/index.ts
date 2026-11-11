/**
 * @file Point d'entrée de `@midgaard/mcp-client` (Slice 8) : le client MCP du
 * daemon, qui lance un serveur stdio déclaré par l'humain sous la garde des
 * processus, lit son catalogue et appelle ses outils.
 *
 * Le paquet ne connaît ni le daemon, ni la base, ni les approbations : il se
 * connecte, appelle, et dit ce qui s'est passé. Ce qu'un agent a le droit
 * d'appeler — liste blanche, approbation, encadrement du résultat — est
 * l'affaire des outils (étape 3).
 */
export {
  DEFAULT_LIST_TIMEOUT_MS,
  DEFAULT_STARTUP_TIMEOUT_MS,
  MAX_TOOLS,
  McpClientError,
  McpConnection,
} from './connection.ts'
export type { CallOptions, McpCallResult, McpTool, OpenOptions } from './connection.ts'
export { GuardedStdioTransport, MAX_MESSAGE_BYTES, MCP_KILL_GRACE_MS, STDERR_TAIL_BYTES, serverEnv } from './transport.ts'
export type { ServerExit, StdioServerSpec } from './transport.ts'
