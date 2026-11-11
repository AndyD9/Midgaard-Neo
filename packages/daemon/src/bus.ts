/**
 * @file Bus d'événements : **le seul chemin d'écriture** vers l'état des tâches.
 *
 * Le dépôt garantit qu'un changement d'état et son événement sont écrits dans la
 * même transaction. Le bus ajoute la garantie complémentaire : tout ce qui est
 * écrit est diffusé. Comme personne d'autre dans le daemon n'appelle le dépôt en
 * écriture, aucun changement d'état ne peut échapper aux abonnés — ni les
 * long-polls du serveur MCP, ni les dashboards connectés.
 *
 * La diffusion est **synchrone et après commit** : au moment où un abonné est
 * réveillé, la base contient déjà l'état qu'il va lire.
 */
import type { Approval, Task, TaskEvent, TaskStatus, Workspace, WorkspaceStatus } from '@midgaard/contracts'
import type { EventInput, HarnessStore, Recorded, TaskPatch } from '@midgaard/persistence'

/** Ce qu'un abonné reçoit : l'événement, et l'état de la tâche juste après. */
export interface BusEvent {
  event: TaskEvent
  task: Task
}

type EventListener = (e: BusEvent) => void
type ApprovalListener = (a: Approval) => void

/** Diffuseur des changements d'état, et unique point d'écriture du daemon. */
export class EventBus {
  private readonly store: HarnessStore
  private readonly eventListeners = new Set<EventListener>()
  private readonly approvalListeners = new Set<ApprovalListener>()

  constructor(store: HarnessStore) {
    this.store = store
  }

  /**
   * S'abonne à tous les changements d'état.
   * @returns la fonction de désabonnement — **à appeler systématiquement**, sinon
   *          un long-poll terminé continuerait d'être réveillé à chaque événement
   */
  subscribe(listener: EventListener): () => void {
    this.eventListeners.add(listener)
    return () => this.eventListeners.delete(listener)
  }

  /** S'abonne aux créations et décisions d'approbation. @returns le désabonnement */
  subscribeApprovals(listener: ApprovalListener): () => void {
    this.approvalListeners.add(listener)
    return () => this.approvalListeners.delete(listener)
  }

  /** Crée une tâche, puis diffuse son `task.created`. */
  createTask(input: Parameters<HarnessStore['createTask']>[0]): Recorded {
    return this.emit(this.store.createTask(input))
  }

  /**
   * Applique une transition (ou journalise sans changer de statut si `to` vaut
   * `null`), puis diffuse.
   * @returns `null` si la tâche n'existe pas
   * @throws {import('@midgaard/contracts').IllegalTransitionError} sur transition interdite
   */
  record(id: string, to: TaskStatus | null, event: EventInput, patch: TaskPatch = {}): Recorded | null {
    const done = this.store.record(id, to, event, patch)
    return done ? this.emit(done) : null
  }

  /**
   * Enregistre le worktree d'une tâche, puis diffuse son `workspace.created`.
   * @returns `null` si la tâche n'existe pas
   */
  createWorkspace(input: Parameters<HarnessStore['createWorkspace']>[0]): (Recorded & { workspace: Workspace }) | null {
    const done = this.store.createWorkspace(input)
    return done ? { ...this.emit(done), workspace: done.workspace } : null
  }

  /**
   * Fait avancer un worktree (`kept`, `removed`), puis diffuse l'événement.
   * @returns `null` si la transition était sans objet
   */
  setWorkspaceStatus(
    id: string,
    to: Exclude<WorkspaceStatus, 'active'>,
    detail: Record<string, unknown> = {},
  ): (Recorded & { workspace: Workspace }) | null {
    const done = this.store.setWorkspaceStatus(id, to, detail)
    return done ? { ...this.emit(done), workspace: done.workspace } : null
  }

  /** Conserve les worktrees restés actifs après un redémarrage, et diffuse chaque `workspace.kept`. */
  keepActiveWorkspaces(): Workspace[] {
    return this.store.keepActiveWorkspaces().map((done) => {
      this.emit(done)
      return done.workspace
    })
  }

  /** Diffuse une approbation créée ou décidée (le dépôt l'a déjà écrite). */
  emitApproval(approval: Approval): Approval {
    for (const l of this.approvalListeners) l(approval)
    return approval
  }

  /**
   * Diffuse un changement déjà persisté.
   *
   * Une exception levée par un abonné ne doit pas empêcher les suivants d'être
   * prévenus : un dashboard dont la socket vient de mourir ne peut pas faire
   * rater sa transition au serveur MCP.
   */
  private emit(recorded: Recorded): Recorded {
    for (const l of this.eventListeners) {
      try {
        l({ event: recorded.event, task: recorded.task })
      } catch {}
    }
    return recorded
  }
}
