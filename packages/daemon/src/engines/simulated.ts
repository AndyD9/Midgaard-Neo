/**
 * @file Moteur simulé : des étapes minutées, sans aucun appel de modèle.
 *
 * Hérité de la Slice 1, et **conservé volontairement**. Il n'est pas un vestige :
 * c'est le seul moyen d'exercer la machine à états, les pauses d'approbation,
 * l'attente bloquante et la reprise après redémarrage sans clé d'API, sans
 * réseau et sans dépense. Les douze scénarios de bout en bout et les sept
 * scénarios d'intégration de la Slice 1 reposent dessus.
 *
 * Déroulé d'une tâche de `duration_s` secondes :
 *
 * ```text
 *  t=0        queued      création
 *  t≈0        preparing   task.started
 *  t=1·D/5    running     étape 1
 *  …
 *  t=3·D/5    running     étape 3 — ou waiting_approval si needs_approval
 *  …
 *  t=5·D/5    completed   résultat
 * ```
 */
import type { Agent, AgentKind, Task } from '@midgaard/contracts'
import { isTerminal } from '@midgaard/contracts'
import type { EngineContext, TaskEngine } from './types.ts'

/** Nombre d'étapes d'une tâche simulée. */
export const STEPS_TOTAL = 5
/** Étape à laquelle une tâche `needs_approval` se met en pause. */
export const APPROVAL_STEP = 3

/** Moteur des tâches factices. */
export class SimulatedEngine implements TaskEngine {
  readonly kind: AgentKind = 'simulated'
  private readonly ctx: EngineContext
  /** Minuteur de la prochaine étape, par tâche. Vit dans ce processus seulement. */
  private readonly timers = new Map<string, NodeJS.Timeout>()

  constructor(ctx: EngineContext) {
    this.ctx = ctx
  }

  start(task: Task): void {
    // Démarrage au tour de boucle suivant : la réponse HTTP de création part
    // avant, donc l'appelant reçoit bien `queued` puis observe la suite.
    this.schedule(task.id, 1)
  }

  resume(task: Task): void {
    this.schedule(task.id, this.stepMs(task))
  }

  /** L'arrêt est immédiat : une tâche simulée n'a rien en vol à laisser finir. */
  cancel(task: Task): boolean {
    clearTimeout(this.timers.get(task.id))
    this.timers.delete(task.id)
    return true
  }

  stop(): void {
    for (const t of this.timers.values()) clearTimeout(t)
    this.timers.clear()
  }

  /** Durée d'une étape pour cette tâche, en millisecondes. */
  private stepMs(task: Task): number {
    return Math.max(1, Math.round((task.duration_s * 1000) / task.steps_total))
  }

  private schedule(taskId: string, delayMs: number): void {
    const timer = setTimeout(() => {
      this.timers.delete(taskId)
      try {
        this.tick(taskId)
      } catch (e) {
        this.ctx.log(`erreur sur la tâche ${taskId.slice(0, 8)} :`, e)
        this.ctx.bus.record(taskId, 'failed', { type: 'task.failed' }, { error: (e as Error).message })
      }
    }, delayMs)
    this.timers.set(taskId, timer)
  }

  /**
   * Fait avancer une tâche d'une étape.
   *
   * Relit l'état depuis la base à chaque fois plutôt que de le garder en
   * mémoire : une annulation ou une approbation a pu survenir entre la
   * programmation du minuteur et son déclenchement, et la base est la seule
   * source de vérité.
   */
  private tick(taskId: string): void {
    const task = this.ctx.store.getTask(taskId)
    if (!task) return
    // Garde-fou : une annulation a pu arriver entre la programmation et l'exécution.
    if (isTerminal(task.status) || task.status === 'waiting_approval') return

    if (task.status === 'queued') {
      this.ctx.bus.record(taskId, 'preparing', {
        type: 'task.started',
        payload: { message: 'préparation de l\'exécutant (tâche simulée : aucun modèle n\'est appelé)' },
      })
      this.schedule(taskId, this.stepMs(task))
      return
    }

    const step = task.step + 1

    if (step >= task.steps_total) {
      const result = {
        summary: `Tâche simulée terminée : ${task.objective}`,
        details: '',
        steps: Array.from({ length: task.steps_total }, (_, i) => `étape simulée ${i + 1}/${task.steps_total}`),
        citations: [],
        // Aucun contenu extérieur : une tâche simulée n'appelle ni modèle ni outil.
        untrusted: false,
        workspace: null,
      }
      // `cancel_requested → completed` est légal : une tâche peut franchir sa
      // dernière étape avant d'avoir pris connaissance de l'annulation.
      this.ctx.bus.record(taskId, 'completed', { type: 'task.completed', payload: { result } }, { step, result })
      this.ctx.log(`tâche ${taskId.slice(0, 8)} terminée`)
      return
    }

    if (task.needs_approval && step === APPROVAL_STEP) {
      this.ctx.requestApproval(
        task.id,
        `étape ${step}/${task.steps_total} de « ${task.objective} »`,
        { kind: 'simulated_step', step, steps_total: task.steps_total },
        { step },
      )
      return
    }

    this.ctx.bus.record(
      taskId,
      task.status === 'cancel_requested' ? null : 'running',
      { type: 'task.progress', payload: { step, steps_total: task.steps_total } },
      { step },
    )
    // Une annulation demandée pendant l'étape précédente est honorée ici : la
    // tâche s'arrête au premier point de contrôle, sans tuer quoi que ce soit.
    if (task.status === 'cancel_requested') return this.ctx.concludeCancellation(taskId)
    this.schedule(taskId, this.stepMs(task))
  }
}
