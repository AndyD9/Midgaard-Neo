/**
 * @file Point d'entrée de `@midgaard/workspace` : les worktrees Git des agents
 * écrivants — création, commit du travail, diff, retrait.
 *
 * Le paquet ne connaît ni le daemon, ni la base, ni les agents. Il reçoit des
 * chemins et rend des faits sur le disque ; c'est le daemon qui les enregistre
 * dans la table `workspaces`, avec l'événement qui les raconte. Cette coupure
 * permet de l'éprouver sur de vrais dépôts Git jetables, sans rien démarrer.
 */
export { WorkspaceError, git, gitOk, gitEnv, HARDENING_ARGS, GIT_TIMEOUT_MS } from './git.ts'
export type { GitOptions, GitOutcome } from './git.ts'
export {
  inspectRepository,
  createWorktree,
  commitAll,
  agentIdentity,
  worktreeState,
  removeWorktree,
  countPorcelainEntries,
  listSubmodules,
  CHECKOUT_TIMEOUT_MS,
} from './worktree.ts'
export type { RepositoryInfo, CreatedWorktree, CommitIdentity, WorktreeState, RemoveOutcome } from './worktree.ts'
export { diffWorktree, parseNameStatus, parseNumstat, MAX_PATCH_BYTES } from './diff.ts'
