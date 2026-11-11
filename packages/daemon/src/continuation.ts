/**
 * @file Le relevé d'une tâche terminée, remis à la tâche qui la prolonge.
 *
 * Une tâche finie ne repart pas : ses statuts finaux sont sans sortie, et la
 * conversation de l'agent avec son modèle n'a vécu qu'en mémoire du moteur.
 * Quand l'utilisateur rebondit sur elle (`POST /api/tasks/:id/continue`), le
 * daemon crée donc une **nouvelle** tâche et lui remet, en contexte, ce que la
 * base a gardé de la première : la demande, les répliques, le résultat soumis,
 * les sous-tâches et leurs branches. Ce module compose ce texte ; il ne lit
 * que la base, n'écrit rien et ne lance rien.
 *
 * Deux règles de sécurité, les mêmes que pour le résultat d'une sous-tâche :
 *
 *  - **ce qu'un modèle a écrit est encadré** (`wrapUntrusted`, avec nonce) :
 *    répliques, résultat, résumés des sous-tâches. Ce texte a pu être écrit
 *    sous l'influence d'une page web ou d'une sortie de commande ; remis nu
 *    dans une nouvelle conversation, il y aurait l'autorité d'une consigne.
 *    Seule la demande d'origine, tapée par l'humain, reste hors du cadre ;
 *  - rien n'est relu sur le disque ni réexpurgé : tout vient du journal et des
 *    résultats, qui ont été expurgés avant d'être écrits.
 *
 * Le relevé est en anglais : c'est un modèle qui le lit.
 */
import { wrapUntrusted, type Task, type TaskEvent } from '@midgaard/contracts'
import type { HarnessStore } from '@midgaard/persistence'

/** Tâches remontées au plus le long d'une chaîne de suites : au-delà, les plus anciennes sont omises, et le relevé le dit. */
export const MAX_CHAIN = 8
/** Taille du relevé entier. Il est renvoyé au modèle à **chaque** appel de la suite : il se paie à chaque étape. */
export const MAX_RECORD_CHARS = 60_000
/** Taille des répliques gardées d'une tâche ; on garde la fin, là où la conversation en était. */
const MAX_TRANSCRIPT_CHARS = 12_000
/** Taille du corps d'un résultat. */
const MAX_DETAILS_CHARS = 24_000
/** Taille de l'objectif et du résumé d'une sous-tâche, dans la liste. */
const MAX_SUBTASK_CHARS = 400

/**
 * La chaîne des tâches qu'une suite prolonge, **la plus ancienne d'abord**,
 * `source` en dernier.
 *
 * @param store  dépôt du daemon
 * @param source la tâche sur laquelle l'utilisateur rebondit
 * @returns la chaîne, et combien de tâches plus anciennes ont été laissées de côté
 */
export function continuationChain(store: HarnessStore, source: Task): { chain: Task[]; omitted: number } {
  const chain: Task[] = [source]
  const seen = new Set([source.id])
  let next = source.continues_task_id
  let omitted = 0
  // `seen` : une base modifiée à la main ne doit pas faire tourner le daemon en rond.
  while (next && !seen.has(next)) {
    const task = store.getTask(next)
    if (!task) break
    seen.add(task.id)
    if (chain.length < MAX_CHAIN) chain.unshift(task)
    else omitted += 1
    next = task.continues_task_id
  }
  return { chain, omitted }
}

/**
 * Compose le relevé remis à la suite d'une tâche.
 *
 * Quand la chaîne dépasse {@link MAX_RECORD_CHARS}, ce sont les tâches **les
 * plus anciennes** qui partent, entières, et une ligne le dit : un relevé
 * tronqué en silence ferait croire à l'agent qu'il sait tout ce qui a précédé.
 *
 * @param store  dépôt du daemon
 * @param source la tâche sur laquelle l'utilisateur rebondit
 * @returns le texte du contexte de la nouvelle tâche
 */
export function continuationRecord(store: HarnessStore, source: Task): string {
  const { chain, omitted } = continuationChain(store, source)
  const sections = chain.map((task) => taskRecord(store, task))
  let dropped = omitted
  let size = sections.reduce((n, s) => n + s.length, 0)
  // La tâche sur laquelle on rebondit reste toujours : c'est elle qu'on prolonge.
  while (sections.length > 1 && size > MAX_RECORD_CHARS) {
    size -= sections.shift()!.length
    dropped += 1
  }
  const head = dropped > 0 ? [`[${dropped} older task(s) of this conversation are not shown: the record would be too long.]`] : []
  return [...head, ...sections].join('\n\n')
}

/** Le relevé d'une tâche : la demande de l'humain, puis, encadré, ce que des modèles ont écrit. */
function taskRecord(store: HarnessStore, task: Task): string {
  const written: string[] = []

  const transcript = transcriptOf(store.taskEvents(task.id))
  if (transcript) written.push(`## Conversation\n\n${transcript}`)

  if (task.result) {
    const details = clip(task.result.details, MAX_DETAILS_CHARS)
    written.push(`## Result you submitted\n\nSummary: ${task.result.summary}${details ? `\n\n${details}` : ''}`)
  } else {
    written.push(
      `## No result\n\nThe task ended as "${task.status}" without a submitted result` +
        `${task.error ? `: ${task.error}` : '.'}`,
    )
  }

  const children = store.childTasks(task.id)
  if (children.length > 0) {
    written.push(`## Subtasks you delegated (all ended)\n\n${children.map(subtaskLine).join('\n')}`)
  }

  const id = task.id.slice(0, 8)
  return [
    `### Earlier task ${id} — ${task.status}, ended ${task.ended_at ?? 'at an unknown time'}`,
    `The user asked:\n\n${task.objective}`,
    wrapUntrusted(`record of earlier task ${id}`, written.join('\n\n')),
  ].join('\n\n')
}

/**
 * Les répliques d'une tâche, dans l'ordre : ce que l'agent a écrit à
 * l'utilisateur, et ce que l'utilisateur a répondu. Les notes du harness
 * (`note: true`) n'en font pas partie : ce ne sont pas des paroles.
 */
function transcriptOf(events: readonly TaskEvent[]): string {
  const lines: string[] = []
  for (const event of events) {
    const payload = event.payload as Record<string, unknown>
    if (event.type === 'agent.message' && payload.note !== true && typeof payload.message === 'string') {
      lines.push(`You: ${payload.message}`)
    } else if (event.type === 'message.user' && typeof payload.text === 'string') {
      lines.push(`User: ${payload.text}`)
    }
  }
  const text = lines.join('\n\n')
  if (text.length <= MAX_TRANSCRIPT_CHARS) return text
  return `[…earlier replies omitted]\n\n${text.slice(-MAX_TRANSCRIPT_CHARS)}`
}

/** Une sous-tâche en une ligne : qui, comment elle a fini, ce qu'on lui demandait, ce qu'elle a rendu, sa branche. */
function subtaskLine(child: Task): string {
  const branch = child.result?.workspace?.branch
  const outcome = child.result ? clip(child.result.summary, MAX_SUBTASK_CHARS) : (child.error ?? 'no result')
  return (
    `- ${child.agent_id} (${child.id.slice(0, 8)}, ${child.status}): ${clip(oneLine(child.objective), MAX_SUBTASK_CHARS)}` +
    ` → ${oneLine(outcome)}` +
    (branch ? ` [branch ${branch}${child.result?.workspace?.commit ? '' : ', nothing committed'}]` : '')
  )
}

/** Coupe un texte trop long, en le disant. */
function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}\n[…truncated]`
}

/** Ramène un texte sur une ligne, pour une entrée de liste. */
function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}
