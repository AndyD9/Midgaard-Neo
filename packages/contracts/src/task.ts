/**
 * @file Modèle de tâche et machine à états, partagés par le daemon, le serveur
 * MCP, la CLI et le dashboard.
 *
 * La machine à états est déclarée ici sous forme de **table de transitions
 * légales** plutôt que dispersée dans des `if` : c'est elle qui est testée
 * unitairement (y compris les transitions illégales), et le daemon refuse toute
 * transition absente de la table.
 *
 * ```text
 *   queued → preparing → running ⇄ waiting_approval → completed
 *                           ⇅             │
 *                     waiting_input       │
 *   sorties : failed, cancel_requested → cancelled, timed_out,
 *             budget_exceeded, interrupted
 * ```
 *
 * `waiting_input` (Slice 6) : la tâche attend un **message**, de l'utilisateur
 * (une conversation) ou de la tâche qui l'a déléguée (une question, une
 * proposition à relire). {@link Task.awaiting_input} dit lequel.
 */
import { z } from 'zod'
import { taskWorkspaceSchema } from './workspace.ts'
import { usageSchema } from './usage.ts'

/** Statuts finaux : une tâche qui y entre n'en sort plus. */
export const TERMINAL_STATUSES = [
  'completed',
  'failed',
  'cancelled',
  'timed_out',
  'budget_exceeded',
  'interrupted',
] as const

/** Statuts actifs : la tâche est encore en vie et peut changer d'état. */
export const ACTIVE_STATUSES = [
  'queued', 'preparing', 'running', 'waiting_approval', 'waiting_input', 'cancel_requested',
] as const

/** Tous les statuts possibles d'une tâche. */
export const TASK_STATUSES = [...ACTIVE_STATUSES, ...TERMINAL_STATUSES] as const

export type TaskStatus = (typeof TASK_STATUSES)[number]

export const taskStatusSchema = z.enum(TASK_STATUSES)

/**
 * Transitions autorisées, état par état.
 *
 * Quelques choix explicites :
 *  - `waiting_approval → cancelled` est direct : la tâche est déjà à l'arrêt,
 *    un refus humain n'a pas besoin de passer par `cancel_requested` ;
 *  - `cancel_requested → completed` est autorisé : une tâche peut franchir sa
 *    dernière étape avant d'avoir pris connaissance de l'annulation, et mentir
 *    sur ce qui s'est réellement passé serait pire ;
 *  - `interrupted` est accessible depuis **tous** les états actifs, puisqu'il
 *    est appliqué en bloc au redémarrage du daemon ;
 *  - `waiting_input` ne mène qu'à `running` pour continuer : le message reçu
 *    relance la boucle, et c'est elle, pas l'attente, qui conclut. Même
 *    l'acceptation d'une proposition repasse par `running`, le temps que le
 *    harness commite. Une annulation passe par `cancel_requested`, pour que le
 *    moteur qui attend le message la voie et rende la main ; `timed_out` sanctionne
 *    une attente restée sans réponse.
 */
export const TRANSITIONS: Readonly<Record<TaskStatus, readonly TaskStatus[]>> = Object.freeze({
  queued: ['preparing', 'running', 'cancel_requested', 'failed', 'timed_out', 'interrupted'],
  preparing: ['running', 'cancel_requested', 'failed', 'timed_out', 'interrupted'],
  running: [
    'waiting_approval', 'waiting_input', 'completed', 'failed', 'cancel_requested',
    'timed_out', 'budget_exceeded', 'interrupted',
  ],
  waiting_approval: ['running', 'cancelled', 'cancel_requested', 'failed', 'timed_out', 'interrupted'],
  waiting_input: ['running', 'cancel_requested', 'timed_out', 'interrupted'],
  cancel_requested: ['cancelled', 'completed', 'failed', 'interrupted'],
  completed: [],
  failed: [],
  cancelled: [],
  timed_out: [],
  budget_exceeded: [],
  interrupted: [],
})

/**
 * Manière dont une tâche converse, **posée par le daemon seul** (Slice 6,
 * décision 2), comme `parent_task_id` :
 *  - `oneshot` : un objectif, un `submit_result`, la fin. Tout ce que délègue
 *    Claude par MCP, et tout ce qui existait avant la Slice 6 ;
 *  - `chat` : une conversation avec l'utilisateur, ouverte du dashboard. Une
 *    réponse sans outil attend le message suivant au lieu d'échouer ;
 *  - `review` : un Developer délégué par un orchestrateur. Son `submit_result`
 *    est une proposition, que le parent accepte ou renvoie.
 */
export const TASK_MODES = ['oneshot', 'chat', 'review'] as const
export type TaskMode = (typeof TASK_MODES)[number]
export const taskModeSchema = z.enum(TASK_MODES)

/**
 * Ce qu'attend une tâche en `waiting_input` :
 *  - `chat` : la réponse de l'utilisateur ;
 *  - `question` : la réponse de son parent à une question qu'elle lui a posée ;
 *  - `proposal` : le verdict de son parent sur le résultat qu'elle propose.
 *
 * Un seul champ plutôt qu'un « de qui » et un « pourquoi » : les deux se
 * déduisent l'un de l'autre, et deux champs pourraient se contredire.
 */
export const INPUT_REQUESTS = ['chat', 'question', 'proposal'] as const
export type InputRequest = (typeof INPUT_REQUESTS)[number]
export const inputRequestSchema = z.enum(INPUT_REQUESTS)

/**
 * Qui doit répondre à une attente : l'utilisateur, ou la tâche parente.
 * @param request ce qu'attend la tâche
 */
export function inputFrom(request: InputRequest): 'user' | 'parent' {
  return request === 'chat' ? 'user' : 'parent'
}

/** Indique si un statut est final. */
export function isTerminal(status: TaskStatus): boolean {
  return (TERMINAL_STATUSES as readonly string[]).includes(status)
}

/** Indique si une transition est permise par {@link TRANSITIONS}. */
export function canTransition(from: TaskStatus, to: TaskStatus): boolean {
  return TRANSITIONS[from].includes(to)
}

/**
 * Erreur levée par le daemon quand une transition interdite est tentée.
 * Une transition illégale est un bug, pas une condition de course attendue :
 * elle doit remonter bruyamment plutôt que corrompre l'historique.
 */
export class IllegalTransitionError extends Error {
  // Champs déclarés puis affectés, et non des propriétés de paramètres : celles-ci
  // produisent du code à l'exécution, que Node ne peut pas simplement effacer
  // (`erasableSyntaxOnly`), et le TypeScript ne tournerait plus sans compilation.
  readonly taskId: string
  readonly from: TaskStatus
  readonly to: TaskStatus

  constructor(taskId: string, from: TaskStatus, to: TaskStatus) {
    super(`transition interdite pour la tâche ${taskId} : ${from} → ${to}`)
    this.name = 'IllegalTransitionError'
    this.taskId = taskId
    this.from = from
    this.to = to
  }
}

/**
 * Résultat structuré d'une tâche terminée.
 *
 * L'agent le produit en appelant l'outil terminal `submit_result`, jamais en
 * laissant la boucle deviner la fin depuis du texte libre (§4 du plan) : un
 * modèle qui écrit « voilà, j'ai fini » sans appeler l'outil n'a pas fini, il a
 * seulement arrêté de parler.
 *
 * `untrusted` est le champ qui compte pour la sécurité : il dit si `details`
 * contient du contenu venu du web. Quand il est vrai, le serveur MCP encadre le
 * résultat avant de le rendre à Claude (voir `wrapUntrusted`).
 */
export const taskResultSchema = z.object({
  /** Une phrase : la réponse, pas le récit de la recherche. */
  summary: z.string(),
  /** Corps du résultat, en Markdown. Vide pour une tâche simulée. */
  details: z.string().default(''),
  /** Étapes franchies, telles que l'exécutant les a rapportées. */
  steps: z.array(z.string()).default([]),
  /** Sources citées par l'agent. Une affirmation sans source se repère ainsi. */
  citations: z
    .array(z.object({ title: z.string(), url: z.string() }))
    .default([]),
  /** Vrai si le résultat reprend du contenu extérieur, donc non fiable. */
  untrusted: z.boolean().default(false),
  /**
   * Le worktree d'une tâche Developer : branche, commit de fin, ampleur du
   * changement. `null` pour les profils qui n'écrivent pas.
   */
  workspace: taskWorkspaceSchema.nullable().default(null),
})
export type TaskResult = z.infer<typeof taskResultSchema>

/** Une tâche déléguée, telle que le daemon la stocke et l'expose. */
export const taskSchema = z.object({
  /** UUID v4, rendu à Claude par `harness_delegate_task`. */
  id: z.uuid(),
  /** Ce que l'exécutant doit accomplir, en langage naturel. */
  objective: z.string(),
  status: taskStatusSchema,
  /** Étape courante ; `0` tant que la tâche n'a pas démarré. */
  step: z.number().int().min(0),
  steps_total: z.number().int().min(1),
  /** Profil d'agent qui exécute. `simulated` pour les tâches factices de la Slice 1. */
  agent_id: z.string(),
  /** Contexte fourni par Claude à la délégation. L'agent ne refait pas l'exploration du dépôt (§4 du plan). */
  context: z.string().nullable(),
  /**
   * Dossier que l'agent a le droit de lire. `null` pour une tâche simulée.
   *
   * **Ce n'est pas une frontière de privilège** : le daemon tourne sous le
   * compte de l'utilisateur. C'est une frontière d'intention, qui empêche un
   * agent dérapant — ou manipulé par une page web — d'aller fouiller ailleurs
   * que dans le dépôt d'où la tâche a été déléguée.
   */
  project_dir: z.string().nullable(),
  /**
   * Tâche qui a délégué celle-ci ; `null` pour une tâche née d'un client
   * (serveur MCP, dashboard).
   *
   * **Posé par le daemon seul** (Slice 5, décision 8) : le champ est absent de
   * `POST /api/tasks`, et un client qui l'y glisse est ignoré. Sans cela, n'importe
   * quel client rattacherait une tâche à un arbre qui n'est pas le sien — et
   * l'annulation en cascade d'un parent emporterait des tâches qu'il n'a pas créées.
   */
  parent_task_id: z.uuid().nullable(),
  /**
   * Tâche **terminée** dont celle-ci est la suite ; `null` pour une tâche qui
   * ne prolonge rien.
   *
   * Une tâche finie ne repart pas (ses statuts finaux sont sans sortie, et sa
   * conversation avec le modèle n'a vécu qu'en mémoire) : rebondir sur elle
   * crée donc une **nouvelle** tâche, qui reçoit en contexte ce que le journal
   * a gardé de la première et hérite des agents qu'elle avait créés.
   *
   * **Posé par le daemon seul**, comme `parent_task_id` : le champ est absent
   * de `POST /api/tasks`, et seule `POST /api/tasks/:id/continue` le produit,
   * après avoir vérifié la tâche prolongée.
   */
  continues_task_id: z.uuid().nullable(),
  /** Manière dont la tâche converse ; posée par le daemon seul, comme `parent_task_id`. */
  mode: taskModeSchema,
  /**
   * Ce qu'attend la tâche, tant qu'elle est en `waiting_input` ; `null` sinon.
   * Posé par le dépôt avec le statut et effacé à sa sortie : une propriété du
   * statut, comme `ended_at`.
   */
  awaiting_input: inputRequestSchema.nullable(),
  /** Consommation cumulée, et d'où vient le montant. Toujours présente, à zéro pour une tâche simulée. */
  usage: usageSchema,
  /** Vrai tant qu'une étape exige encore une approbation humaine. */
  needs_approval: z.boolean(),
  /**
   * Numéro de la dernière pause d'approbation ; `0` s'il n'y en a eu aucune.
   * Permet de distinguer une pause déjà signalée à un client d'une nouvelle
   * (voir {@link isActionable}) — correctif du défaut n° 2 de la Slice 0.
   */
  approval_seq: z.number().int().min(0),
  /**
   * Durée totale simulée, en secondes. **N'a de sens que pour le profil
   * `simulated`** : un agent réel s'arrête sur son résultat, son budget ou ses
   * limites, jamais sur un minuteur. Conservée parce que le profil simulé reste
   * le seul moyen d'exercer le harness sans dépenser de jetons.
   */
  duration_s: z.number().int().min(1),
  created_at: z.iso.datetime(),
  updated_at: z.iso.datetime(),
  /**
   * Première sortie de la file vers l'exécution (`preparing` ou `running`),
   * posée par le dépôt. `null` tant que la tâche attend, et pour toujours si
   * elle a été annulée ou interrompue avant de démarrer.
   */
  started_at: z.iso.datetime().nullable(),
  /** Entrée dans un statut final, posée par le dépôt ; `null` tant que la tâche est active. */
  ended_at: z.iso.datetime().nullable(),
  /** Présent uniquement sur une tâche `completed`. */
  result: taskResultSchema.nullable(),
  /** Explication d'une fin anormale : échec, annulation, interruption, expiration. */
  error: z.string().nullable(),
})
export type Task = z.infer<typeof taskSchema>

/**
 * Consigne renvoyée à Claude avec chaque état de tâche, pour qu'il sache quoi
 * faire sans interpréter le statut lui-même :
 *  - `result_ready` : le résultat est joint, la tâche est finie ;
 *  - `call_wait_for_task_again` : toujours en cours, rappeler `harness_wait_for_task` ;
 *  - `human_approval_pending` : **nouvelle** pause — prévenir l'utilisateur,
 *    jamais tenter d'approuver ;
 *  - `still_waiting_for_human` : pause déjà signalée, l'humain n'a pas décidé.
 *    Produite uniquement par le serveur MCP, qui sait ce qu'il a déjà dit à son
 *    client ; le daemon ne la renvoie jamais ;
 *  - `task_ended_without_result` : finie sans résultat (annulée, échouée,
 *    interrompue, expirée).
 */
export const NEXT_ACTIONS = [
  'result_ready',
  'call_wait_for_task_again',
  'human_approval_pending',
  'still_waiting_for_human',
  'task_ended_without_result',
] as const
export type NextAction = (typeof NEXT_ACTIONS)[number]

/**
 * Traduit l'état d'une tâche en consigne pour Claude. C'est aussi le critère
 * d'arrêt du long-poll : on rend la main dès que la consigne n'est plus
 * `call_wait_for_task_again`.
 */
export function nextActionFor(task: Pick<Task, 'status'>): NextAction {
  // `waiting_input` tombe dans le cas général, « attendre encore » : Claude ne
  // délègue que des tâches `oneshot`, qui n'y entrent jamais. L'attente d'un
  // orchestrateur sur ses enfants a son propre critère (outil `wait_for_task`).
  if (task.status === 'completed') return 'result_ready'
  if (task.status === 'waiting_approval') return 'human_approval_pending'
  if (isTerminal(task.status)) return 'task_ended_without_result'
  return 'call_wait_for_task_again'
}

/**
 * Indique si l'état d'une tâche mérite d'interrompre une attente.
 *
 * Une fin de tâche l'est toujours. Une pause d'approbation ne l'est que si elle
 * est **plus récente** que la dernière déjà signalée au client (`knownApproval`).
 * Sans cette règle, rappeler l'attente sur une tâche déjà en pause rendait la
 * main aussitôt avec la même réponse : le client renonçait à attendre la décision
 * humaine, ou bouclait en consommant des tokens (défaut n° 2 de la Slice 0).
 *
 * @param knownApproval numéro de la dernière pause déjà signalée ; `0` si aucune
 */
export function isActionable(task: Pick<Task, 'status' | 'approval_seq'>, knownApproval = 0): boolean {
  const action = nextActionFor(task)
  if (action === 'call_wait_for_task_again') return false
  if (action === 'human_approval_pending') return task.approval_seq > knownApproval
  return true
}
