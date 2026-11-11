/**
 * @file Les worktrees vus de l'API : le diff d'une tâche, la liste de tous avec
 * leur état réel sur le disque, leur retrait, et la liste blanche `exec` d'un
 * dépôt.
 *
 * Séparé du routeur parce qu'aucune logique de Git n'a sa place dans un
 * routeur, et que `harness workspaces` et `harness exec` en sont les clients.
 *
 * **Rien n'est supprimé d'office.** Le retrait est toujours demandé, un
 * worktree dont la tâche tourne n'est jamais retiré, un worktree sale ne l'est
 * qu'avec `force`, et un dossier orphelin n'est que montré.
 *
 * Le diff n'est **jamais mis en cache**. Il se recalcule à chaque lecture contre
 * le commit de départ : un diff conservé serait vrai au moment de l'écrire, puis
 * faux sans le dire dès que l'agent écrit un fichier de plus — et c'est
 * précisément pendant que l'agent travaille qu'on le regarde.
 */
import { existsSync } from 'node:fs'
import { readdir, realpath } from 'node:fs/promises'
import { join } from 'node:path'
import {
  execPrefixRefusal,
  isTerminal,
  type ExecAllowEntry,
  type ExecAllowResponse,
  type ExecAllowRule,
  type HarnessConfig,
  type TaskWorkspaceResponse,
  type Workspace,
  type WorkspaceListing,
  type WorkspacesResponse,
} from '@midgaard/contracts'
import type { HarnessStore } from '@midgaard/persistence'
import { diffWorktree, inspectRepository, removeWorktree, worktreeState, WorkspaceError } from '@midgaard/workspace'
import type { EventBus } from './bus.ts'

/**
 * Le worktree d'une tâche et son diff.
 *
 * Ne lève pas : chaque impossibilité devient une phrase dans `unavailable`,
 * qui dit **où retrouver le travail** quand il existe encore — la branche
 * survit au worktree.
 */
export async function workspaceView(store: HarnessStore, taskId: string): Promise<TaskWorkspaceResponse> {
  const workspace = store.workspaceForTask(taskId)
  if (!workspace) {
    return { workspace: null, diff: null, unavailable: 'cette tâche n\'a pas de worktree : son profil n\'écrit pas' }
  }
  const atBranch =
    `la branche ${workspace.branch} reste dans le dépôt : ` +
    `git diff ${workspace.base_commit.slice(0, 12)} ${workspace.branch}`
  if (workspace.status === 'removed') {
    return { workspace, diff: null, unavailable: `worktree retiré ; ${atBranch}` }
  }
  if (!existsSync(workspace.worktree_path)) {
    return { workspace, diff: null, unavailable: `le dossier du worktree a disparu (${workspace.worktree_path}) ; ${atBranch}` }
  }
  try {
    return { workspace, diff: await diffWorktree(workspace.worktree_path, workspace.base_commit), unavailable: null }
  } catch (e) {
    return { workspace, diff: null, unavailable: `diff impossible : ${(e as Error).message}` }
  }
}

/**
 * Tous les worktrees connus, avec ce qu'il y a **réellement** sur le disque, et
 * les dossiers orphelins.
 *
 * L'état sur le disque est relu à chaque fois : la base dit ce que le harness a
 * fait, pas ce que l'utilisateur a fait depuis — un `rm -rf` à la main, un
 * fichier modifié dans le worktree pour essayer quelque chose.
 */
export async function listWorkspaces(store: HarnessStore, config: HarnessConfig): Promise<WorkspacesResponse> {
  const all = store.listWorkspaces()
  const workspaces: WorkspaceListing[] = []
  for (const workspace of all) {
    const task = store.getTask(workspace.task_id)
    let exists = false
    let dirty: number | null = null
    if (workspace.status !== 'removed') {
      const state = await worktreeState(workspace.worktree_path).catch(() => null)
      exists = state?.exists ?? existsSync(workspace.worktree_path)
      dirty = state?.exists ? state.dirty : null
    }
    workspaces.push({ workspace, task_status: task?.status ?? null, exists, dirty })
  }

  // Un dossier par dépôt, puis un par tâche : deux niveaux, pas davantage.
  const known = new Set(all.filter((w) => w.status !== 'removed').map((w) => w.worktree_path))
  const orphans: string[] = []
  const base = await realpath(config.worktreesDir).catch(() => null)
  if (base) {
    for (const repo of await readdir(base, { withFileTypes: true }).catch(() => [])) {
      if (!repo.isDirectory()) continue
      for (const entry of await readdir(join(base, repo.name), { withFileTypes: true }).catch(() => [])) {
        const path = join(base, repo.name, entry.name)
        if (entry.isDirectory() && !known.has(path)) orphans.push(path)
      }
    }
  }
  return { workspaces, orphans, worktrees_dir: config.worktreesDir }
}

/** Refus d'un retrait, à traduire en code HTTP. */
export interface RemoveRefusal {
  error: string
  status: number
  reason: string
}

/**
 * Retire le worktree d'une tâche finie, et écrit `workspace.removed` dans son
 * journal. La branche reste.
 *
 * @returns le worktree après coup, ou un refus qui dit pourquoi
 */
export async function removeWorkspace(
  deps: { store: HarnessStore; bus: EventBus; config: HarnessConfig },
  id: string,
  options: { force: boolean; by: string },
): Promise<{ workspace: Workspace; outcome: 'removed' | 'already_gone' } | RemoveRefusal> {
  const workspace = deps.store.getWorkspace(id)
  if (!workspace) return { error: 'workspace_not_found', status: 404, reason: 'aucun worktree avec cet identifiant' }
  if (workspace.status === 'removed') {
    return { error: 'already_removed', status: 409, reason: `déjà retiré le ${workspace.removed_at}` }
  }
  const task = deps.store.getTask(workspace.task_id)
  // Un agent qui écrit dans un worktree qu'on retire sous lui produirait des
  // erreurs incompréhensibles, et un diff qui ment. On attend la fin.
  if (task && !isTerminal(task.status)) {
    return {
      error: 'task_active',
      status: 409,
      reason: `la tâche ${task.id.slice(0, 8)} est ${task.status} : annule-la ou attends sa fin`,
    }
  }
  try {
    const outcome = await removeWorktree({
      repoDir: workspace.repo_dir,
      worktreePath: workspace.worktree_path,
      worktreesDir: deps.config.worktreesDir,
      force: options.force,
    })
    const done = deps.bus.setWorkspaceStatus(workspace.id, 'removed', {
      by: options.by,
      forced: options.force,
      reason: outcome === 'already_gone' ? 'dossier déjà absent' : `retiré par ${options.by}`,
    })
    return { workspace: done?.workspace ?? workspace, outcome }
  } catch (e) {
    const reason = e instanceof WorkspaceError ? e.message : (e as Error).message
    const dirty = /non commité/.test(reason)
    return { error: dirty ? 'worktree_dirty' : 'remove_refused', status: 409, reason }
  }
}

/**
 * Liste blanche `exec` du dépôt qui contient `projectDir`, et la globale.
 *
 * La racine est résolue par Git puis canonicalisée, comme le fera le moteur :
 * une entrée enregistrée sous un autre chemin du même dépôt ne serait jamais
 * retrouvée, et elle aurait l'air de fonctionner.
 *
 * @throws {WorkspaceError} si le dossier n'est pas dans un dépôt Git
 */
export async function execAllowFor(
  store: HarnessStore,
  config: HarnessConfig,
  projectDir: string,
): Promise<ExecAllowResponse> {
  const repo = await inspectRepository(projectDir)
  return { repo_dir: repo.toplevel, entries: store.listExecAllow(repo.toplevel), global: config.execAllow }
}

/**
 * Les règles `exec` d'une tâche : la liste globale (exacte), puis celle du
 * dépôt, dont chaque **préfixe est rejugé** par `execPrefixRefusal`.
 *
 * Pourquoi rejuger ce que la route a déjà jugé : la règle peut se durcir d'une
 * version à l'autre (un interpréteur de plus), et une entrée ajoutée avant
 * resterait sinon une porte ouverte que plus rien n'accepterait. Un préfixe
 * écarté ne devient pas une entrée exacte : il ne vaut plus rien, et c'est dit.
 *
 * @param global  `config.execAllow` (`MIDGAARD_EXEC_ALLOW`)
 * @param entries la liste du dépôt, lue au départ de la tâche
 * @returns les règles retenues, et les préfixes écartés avec leur motif
 */
export function execRulesForTask(
  global: readonly (readonly string[])[],
  entries: readonly ExecAllowEntry[],
): { rules: ExecAllowRule[]; ignored: { argv: string[]; reason: string }[] } {
  const rules: ExecAllowRule[] = global.map((argv) => ({ argv, prefix: false }))
  const ignored: { argv: string[]; reason: string }[] = []
  for (const e of entries) {
    const refusal = e.prefix ? execPrefixRefusal(e.argv) : null
    if (refusal) ignored.push({ argv: e.argv, reason: refusal })
    else rules.push({ argv: e.argv, prefix: e.prefix })
  }
  return { rules, ignored }
}
