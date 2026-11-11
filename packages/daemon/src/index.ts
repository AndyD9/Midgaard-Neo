/**
 * @file Point d'entrée de `@midgaard/daemon`.
 *
 * Expose de quoi démarrer un daemon dans le processus courant (tests), et les
 * briques que le serveur MCP ou la CLI doivent connaître.
 */
export { startDaemon, defaultDashboardDir } from './daemon.ts'
export type { Daemon, StartOptions } from './daemon.ts'
export { EventBus } from './bus.ts'
export { TaskManager, STEPS_TOTAL, APPROVAL_STEP, MAX_CREATED_AGENTS } from './task-manager.ts'
export type { Refusal, TaskView } from './task-manager.ts'
export { SimulatedEngine } from './engines/simulated.ts'
export { keyCommand, visionOf } from './engines/agent.ts'
export { secretRefFor, upsertProvider } from './providers.ts'
export { checkMcpCommand, mcpSecretRef, stderrExcerpt } from './mcp-servers.ts'
export type { McpServiceDeps } from './mcp-servers.ts'
export type { EngineContext, TaskEngine } from './engines/types.ts'
export {
  CREATED_ROLE_HEADING,
  MCP_CAPABLE_KINDS,
  ensureBuiltinAgents,
  reconcileAgents,
  resolveCreatedAgent,
  setAgentLimits,
  setAgentMcpServers,
  RESEARCHER_AGENT_ID,
  RESEARCHER_TOOLS,
  RESEARCHER_SYSTEM_PROMPT,
  DEVELOPER_SYSTEM_PROMPT,
  ORCHESTRATOR_AGENT_ID,
  ORCHESTRATOR_SYSTEM_PROMPT,
  ORCHESTRATOR_TOOLS,
  NAVIGATOR_AGENT_ID,
  NAVIGATOR_SYSTEM_PROMPT,
  NAVIGATOR_TOOLS,
  updateAgentModel,
} from './agents.ts'
export { execRulesForTask } from './workspaces.ts'
export { acquireLock, readLockPid, releaseLock, tryCreateLock } from './lock.ts'
export { WS_PATH } from './ws.ts'
export { checkProjectDir } from './project-dir.ts'
export { BrowserSessions, defaultBrowserGuard } from './browsers.ts'
export type { BrowserFrame, BrowserSessionsDeps } from './browsers.ts'
export { StaticFiles } from './static-files.ts'
export { installation, sameInstallation } from './installation.ts'
export type { Installation } from './installation.ts'
