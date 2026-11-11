/**
 * @file Le fil d'un arbre de tâches (Slice 6) : la conversation avec
 * l'utilisateur et les échanges entre l'orchestrateur et ses sous-tâches,
 * reconstitués depuis le journal. Fonctions pures, sans rendu.
 *
 * Rien n'est inventé ici : chaque élément du fil est un événement du journal,
 * à sa place (`seq` global). Le journal garde ce que l'agent a réellement lu
 * — un message expurgé est lu expurgé (étape 2) —, et le fil le montre tel quel.
 *
 * Ce qui est montré, par tâche :
 *  - **la racine** : l'objectif ou le message d'ouverture, les messages de
 *    l'utilisateur, les répliques de l'orchestrateur, sa fin ;
 *  - **chaque sous-tâche** : sa délégation, ses questions et propositions, les
 *    réponses et verdicts du parent, sa fin. Les notes d'exécution du harness
 *    (relances, avertissements) restent dans la timeline : le fil raconte qui a
 *    dit quoi à qui, pas le fonctionnement interne ;
 *  - **pour toutes, les images lues** par `read_image` (Slice 7) : l'élément
 *    porte le chemin et le début de l'empreinte que l'outil a journalisés ; le
 *    panneau relit l'image sur le disque et dit si ce n'est plus la même.
 *    Les captures du navigateur n'y sont pas : aucune n'est gardée.
 */
import type { Task, TaskEvent } from '@midgaard/contracts'

/** Nature d'un élément du fil. */
export type ThreadKind =
  | 'user'
  | 'agent'
  | 'delegation'
  | 'question'
  | 'proposal'
  | 'reply'
  | 'verdict'
  | 'result'
  | 'ended'
  | 'image'

/** Un élément du fil, tel qu'il s'affiche. */
export interface ThreadItem {
  /** Clé stable : la séquence globale de l'événement. */
  key: string
  seq: number
  at: string
  /** Tâche dont le journal porte l'événement. */
  taskId: string
  kind: ThreadKind
  /** Qui parle. */
  from: string
  /** À qui, quand ce n'est pas l'utilisateur ou tout le monde. */
  to?: string | undefined
  text: string
  /** Détail affiché sous le texte : la branche d'un résultat, le motif d'une fin. */
  detail?: string | undefined
  /** Pour une image lue : son chemin dans la tâche et le début de son SHA-256 au moment de la lecture. */
  image?: { path: string; sha256Prefix: string } | undefined
}

/** Le résumé que `read_image` journalise : « chemin · type · n octets · sha256 <16 hex> ». */
const READ_IMAGE_SUMMARY = /^(.+) · image\/[a-z]+ · \d+ octets · sha256 ([0-9a-f]{16})$/

/** Les images lues par une tâche, dans son journal. */
function imagesRead(events: readonly TaskEvent[], from: string, base: (e: TaskEvent) => Omit<ThreadItem, 'kind' | 'from' | 'text'>): ThreadItem[] {
  const reads = new Set<string>()
  const out: ThreadItem[] = []
  for (const e of events) {
    if (e.type === 'tool.requested' && e.payload.name === 'read_image') reads.add(String(e.payload.tool_call_id))
    if (e.type !== 'tool.completed' || !reads.has(String(e.payload.tool_call_id)) || e.payload.status !== 'succeeded') continue
    const match = READ_IMAGE_SUMMARY.exec(String(e.payload.summary ?? ''))
    if (!match) continue
    out.push({ ...base(e), kind: 'image', from, text: match[1]!, image: { path: match[1]!, sha256Prefix: match[2]! } })
  }
  return out
}

/** Libellés des statuts de fin, en français. */
const ENDED: Record<string, string> = {
  'task.failed': 'a échoué',
  'task.cancelled': 'a été annulée',
  'task.interrupted': 'a été interrompue par un redémarrage du daemon',
  'task.budget_exceeded': 'a atteint son budget',
  'task.timed_out': 'a dépassé son délai',
}

/** Nom affiché d'une tâche : son profil, et l'identifiant court d'une sous-tâche. */
export function speaker(task: Task, isRoot: boolean): string {
  const name = task.agent_id.charAt(0).toUpperCase() + task.agent_id.slice(1)
  return isRoot ? name : `${name} · ${task.id.slice(0, 8)}`
}

/** Texte d'une charge utile, s'il y en a un. */
function text(e: TaskEvent, field = 'text'): string {
  const value = e.payload[field]
  return typeof value === 'string' ? value : ''
}

/**
 * Compose le fil d'un arbre : la racine et ses sous-tâches, dans l'ordre du
 * journal.
 *
 * @param events timelines chargées, par tâche ; une timeline absente n'apporte
 *               rien au fil, elle ne le bloque pas
 */
export function buildThread(root: Task, children: Task[], events: Record<string, TaskEvent[] | undefined>): ThreadItem[] {
  const items: ThreadItem[] = []
  const rootName = speaker(root, true)
  const base = (e: TaskEvent) => ({ key: String(e.seq), seq: e.seq, at: e.at, taskId: e.task_id })

  items.push(...imagesRead(events[root.id] ?? [], rootName, base))
  for (const e of events[root.id] ?? []) {
    if (e.type === 'task.created') {
      items.push({ ...base(e), kind: 'user', from: 'Vous', to: rootName, text: root.objective })
    } else if (e.type === 'message.user') {
      items.push({
        ...base(e),
        kind: 'user',
        from: 'Vous',
        to: rootName,
        text: text(e),
        ...(e.payload.conclude === true ? { detail: 'demande de conclure' } : {}),
      })
    } else if (e.type === 'agent.message' && e.payload.note !== true) {
      const said = text(e, 'message')
      if (said) items.push({ ...base(e), kind: 'agent', from: rootName, text: said })
    } else if (e.type === 'task.completed') {
      const result = e.payload.result as { summary?: string } | undefined
      items.push({ ...base(e), kind: 'result', from: rootName, text: result?.summary ?? 'terminée' })
    } else if (ENDED[e.type] && e.status !== 'cancel_requested') {
      items.push({ ...base(e), kind: 'ended', from: rootName, text: `La tâche ${ENDED[e.type]}.`, detail: text(e, 'reason') || undefined })
    }
  }

  for (const child of children) {
    const name = speaker(child, false)
    items.push(...imagesRead(events[child.id] ?? [], name, base))
    for (const e of events[child.id] ?? []) {
      if (e.type === 'task.created') {
        items.push({ ...base(e), kind: 'delegation', from: rootName, to: name, text: child.objective })
      } else if (e.type === 'input.requested' && e.payload.request === 'question') {
        items.push({ ...base(e), kind: 'question', from: name, to: rootName, text: text(e) })
      } else if (e.type === 'input.requested' && e.payload.request === 'proposal') {
        items.push({ ...base(e), kind: 'proposal', from: name, to: rootName, text: text(e) })
      } else if (e.type === 'message.agent' && e.payload.verdict === 'accepted') {
        items.push({ ...base(e), kind: 'verdict', from: rootName, to: name, text: 'Proposition acceptée.' })
      } else if (e.type === 'message.agent') {
        items.push({ ...base(e), kind: 'reply', from: rootName, to: name, text: text(e) })
      } else if (e.type === 'task.completed') {
        const result = e.payload.result as { summary?: string; workspace?: { branch?: string } | null } | undefined
        items.push({
          ...base(e),
          kind: 'result',
          from: name,
          text: result?.summary ?? 'terminée',
          ...(result?.workspace?.branch ? { detail: `branche ${result.workspace.branch}` } : {}),
        })
      } else if (ENDED[e.type] && e.status !== 'cancel_requested') {
        items.push({ ...base(e), kind: 'ended', from: name, text: `La sous-tâche ${ENDED[e.type]}.`, detail: text(e, 'reason') || undefined })
      }
    }
  }

  return items.sort((a, b) => a.seq - b.seq)
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
