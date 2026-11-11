/**
 * @file La conversation avec l'orchestrateur, côté règles : qui parle, et
 * quand la saisie s'ouvre. Fonctions pures, sans rendu.
 *
 * Le fil lui-même — qui a dit quoi à qui — est le flux terminal
 * (`lib/stream.ts`) : ce module ne garde que ce que la saisie et les libellés
 * ont besoin de savoir d'une tâche.
 */
import type { Task } from '@midgaard/contracts'

/** Nom affiché d'une tâche : son profil, et l'identifiant court d'une sous-tâche. */
export function speaker(task: Task, isRoot: boolean): string {
  const name = task.agent_id.charAt(0).toUpperCase() + task.agent_id.slice(1)
  return isRoot ? name : `${name} · ${task.id.slice(0, 8)}`
}

/**
 * Ce que l'utilisateur peut faire dans la conversation, en une phrase quand il
 * ne peut rien. La saisie n'est ouverte que lorsque la tâche attend sa réponse :
 * le daemon refuse un message à une tâche qui travaille (étape 2).
 */
export function composerState(root: Task): { open: true } | { open: false; reason: string } {
  if (root.mode !== 'chat') {
    return { open: false, reason: 'Cette tâche a été lancée en une fois : elle ne converse pas.' }
  }
  if (root.status === 'waiting_input' && root.awaiting_input === 'chat') return { open: true }
  if (root.status === 'waiting_input') return { open: false, reason: 'L\'orchestrateur attend une sous-tâche.' }
  if (root.status === 'waiting_approval') return { open: false, reason: 'Une approbation attend votre décision.' }
  if (['queued', 'preparing', 'running', 'cancel_requested'].includes(root.status)) {
    return { open: false, reason: 'L\'orchestrateur travaille…' }
  }
  return { open: false, reason: 'La conversation est terminée.' }
}

/** Statuts finaux d'une tâche : elle ne repart plus. */
const ENDED = ['completed', 'failed', 'cancelled', 'timed_out', 'budget_exceeded', 'interrupted']

/**
 * Identifiant du profil orchestrateur livré. Le dashboard n'importe de
 * `@midgaard/contracts` que des types, et une tâche ne porte pas le type de
 * son profil : c'est par cet identifiant qu'on le reconnaît ici. Le daemon
 * rejuge de toute façon (`continuation_unsupported`).
 */
const ORCHESTRATOR_ID = 'orchestrator'

/**
 * Vrai si l'utilisateur peut **rebondir** sur cette tâche : elle est terminée,
 * de premier niveau, et c'est un orchestrateur qui l'a menée. Le daemon ne la
 * rouvre pas — il crée la tâche qui la prolonge (`POST /api/tasks/:id/continue`),
 * avec le relevé de celle-ci en contexte et ses agents créés.
 */
export function canContinue(root: Task): boolean {
  return ENDED.includes(root.status) && root.parent_task_id === null && root.agent_id === ORCHESTRATOR_ID
}
