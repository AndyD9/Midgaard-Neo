/**
 * @file Journal d'événements : le récit append-only de ce qui est arrivé à chaque tâche.
 *
 * Deux numéros de séquence, parce qu'ils répondent à deux questions différentes :
 *  - `seq` est **global** et strictement croissant sur tout le journal. C'est lui
 *    que le dashboard renvoie après une coupure WebSocket (« j'en étais à 412 »)
 *    pour récupérer exactement ce qu'il a manqué. Sans un compteur global, une
 *    reconnexion laisserait un trou invisible dans la timeline ;
 *  - `task_seq` est **local à une tâche** et commence à 1. C'est l'ordre d'affichage
 *    d'une timeline de tâche, stable même si d'autres tâches tournent en parallèle.
 *
 * Les deux sont attribués par la base, dans la même transaction que la mise à jour
 * de la tâche : un événement ne peut donc pas décrire un état qui n'a pas été
 * persisté, ni l'inverse.
 */
import { z } from 'zod'
import { taskStatusSchema } from './task.ts'

/**
 * Types d'événements émis.
 *
 * Le vocabulaire suit le plan (§6). `agent.message` portait en Slice 1 la
 * narration des étapes simulées ; il porte désormais aussi le texte produit par
 * un vrai modèle à chaque itération. La Slice 2 ajoute les quatre derniers :
 *
 *  - `tool.requested` / `tool.completed` encadrent chaque appel d'outil. Les
 *    deux, et pas seulement le second : un outil qui ne rend jamais la main
 *    laisserait sinon un trou que rien n'explique dans la timeline. Un appel
 *    autorisé sans humain porte `allow_reason` (Slice 9) : la règle qui l'a
 *    permis, préfixe de liste blanche compris ;
 *  - `usage.updated` suit la consommation après chaque appel modèle. C'est lui
 *    qui permet de voir un budget se remplir **pendant** la tâche, au lieu de
 *    découvrir la facture à la fin ;
 *  - `task.budget_exceeded` et `task.timed_out` sont distincts de `task.failed` :
 *    rien n'a échoué, une limite a été atteinte, et confondre les deux enverrait
 *    l'utilisateur chercher un bug qui n'existe pas.
 *
 * La Slice 3 ajoute les trois `workspace.*`, qui racontent le cycle de vie du
 * worktree d'un agent écrivant. Ils sont écrits dans la même transaction que la
 * ligne `workspaces` qu'ils décrivent, comme toute transition de tâche :
 *
 *  - `workspace.created` — le worktree existe, sa branche et son commit de départ ;
 *  - `workspace.kept` — la tâche est finie, le worktree est conservé pour lecture ;
 *  - `workspace.removed` — un humain l'a nettoyé ; la branche, elle, reste.
 *
 * La Slice 5 ajoute `subtask.waiting`, écrit sur la tâche **parente** quand
 * un orchestrateur se met à attendre une sous-tâche : son statut ne change pas
 * (`running`), et sans lui le dashboard montrerait un orchestrateur immobile
 * sans dire qui il attend. Le nouveau type ne demande pas de nouveau protocole :
 * aucun client ne valide le type d'un événement à l'exécution, et un daemon
 * antérieur ne fait simplement jamais attendre de sous-tâche.
 *
 * La Slice 6 ajoute quatre types, pour les conversations et le terminal :
 *
 *  - `input.requested` — la tâche passe en `waiting_input`. Charge :
 *    `{ request, text? }` — ce qu'elle attend et, pour une question ou une
 *    proposition, le texte que le destinataire doit lire ;
 *  - `message.user` — un message de l'utilisateur, `{ text }`, écrit sur la
 *    tâche qui le reçoit ; il la remet en `running` quand elle l'attendait ;
 *  - `message.agent` — un message d'une tâche à une autre (le parent qui répond
 *    ou renvoie une proposition), `{ from_task_id, text }`, écrit sur la tâche
 *    qui le **reçoit**. Le fil d'un arbre se reconstitue en lisant ses tâches ;
 *  - `exec.output` — des lignes de sortie d'une commande `exec` en cours,
 *    expurgées, `{ tool_call_id, stream, text, omitted_bytes? }`, pour le
 *    terminal du dashboard. Un lot par flux et par quart de seconde ;
 *    `omitted_bytes` sur le dernier, si le plafond par commande a été atteint.
 *    Le statut ne change pas.
 *
 * Tous les textes sont expurgés avant d'être écrits, comme le reste du journal.
 *
 * Comme pour `subtask.waiting`, aucun ne demande à lui seul un nouveau
 * protocole ; c'est le statut `waiting_input` qui l'impose (`PROTOCOL_VERSION`).
 *
 * La Slice 7 ajoute deux types, qui encadrent une session de navigateur :
 *
 *  - `browser.opened` — la session approuvée est ouverte,
 *    `{ objective, start_url, max_duration_s, expires_at, planned_inputs }`,
 *    ces derniers expurgés (les textes approuvés avec la session) ;
 *  - `browser.closed` — elle est fermée, `{ reason }` : par l'agent, à son
 *    échéance, par l'humain, ou avec la tâche.
 *
 * Les actions entre les deux sont au journal comme appels d'outil. **Aucune
 * capture n'y est écrite** : une image peut montrer un secret, et
 * l'expurgation ne sait pas la lire. Pas de nouveau protocole non plus, pour
 * la raison de `subtask.waiting`.
 *
 * `artifact.created`, prévu au plan, n'est pas créé : le diff d'un worktree se
 * calcule à la demande contre son commit de départ, et un artefact figé en
 * serait une seconde copie, vraie au moment de l'écrire seulement.
 */
export const EVENT_TYPES = [
  'task.created',
  'task.started',
  'task.progress',
  'task.completed',
  'task.failed',
  'task.cancelled',
  'task.interrupted',
  'task.budget_exceeded',
  'task.timed_out',
  'agent.message',
  'approval.requested',
  'approval.resolved',
  'tool.requested',
  'tool.completed',
  'usage.updated',
  'workspace.created',
  'workspace.kept',
  'workspace.removed',
  'subtask.waiting',
  'input.requested',
  'message.user',
  'message.agent',
  'exec.output',
  'browser.opened',
  'browser.closed',
  'agent.created',
] as const
export type EventType = (typeof EVENT_TYPES)[number]

/** Une ligne du journal, telle qu'elle est persistée et diffusée. */
export const taskEventSchema = z.object({
  /** Séquence globale, strictement croissante, jamais réutilisée. Clé de la reprise WebSocket. */
  seq: z.number().int().positive(),
  /** Séquence locale à la tâche, à partir de 1. */
  task_seq: z.number().int().positive(),
  task_id: z.uuid(),
  type: z.enum(EVENT_TYPES),
  at: z.iso.datetime(),
  /** Statut de la tâche juste après l'événement : évite au dashboard de recouper. */
  status: taskStatusSchema,
  /** Charge utile propre au type d'événement. Toujours un objet, jamais `null`. */
  payload: z.record(z.string(), z.unknown()),
})
export type TaskEvent = z.infer<typeof taskEventSchema>

/** Événement avant persistance : la base attribue `seq`, `task_seq` et `at`. */
export type NewTaskEvent = Omit<TaskEvent, 'seq' | 'task_seq' | 'at'> & { at?: string }
