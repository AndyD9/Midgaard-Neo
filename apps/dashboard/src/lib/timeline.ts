/**
 * @file Les timelines des tâches dans l'état du dashboard : chargées par HTTP,
 * tenues à jour par la WebSocket. Fonctions pures, sans React, testées dans
 * `tests/unit/dashboard-workbench.test.ts`.
 *
 * **La course à éviter.** Une timeline se charge par `GET /api/tasks/:id/events`
 * pendant que la WebSocket diffuse. Un événement émis **après** la lecture du
 * daemon et **avant** l'arrivée de la réponse n'est ni dans la réponse, ni gardé
 * s'il est jeté faute de timeline : il manque alors jusqu'au rechargement de la
 * page. C'est ce qui faisait échouer D14 par intermittence (macOS puis Linux, en
 * CI) : l'image lue par l'agent n'entrait jamais dans le fil. D'où l'ordre :
 * {@link watchTimeline} **avant** la requête, puis {@link mergeTimeline}, qui
 * fusionne au lieu de remplacer.
 */
import type { TaskEvent } from '@midgaard/contracts'

/** Les timelines chargées, par tâche. Une tâche absente n'a pas été demandée. */
export type Timelines = Record<string, TaskEvent[]>

/** Trie par séquence de tâche et retire les doublons (même `seq` global). */
function ordered(events: readonly TaskEvent[]): TaskEvent[] {
  const bySeq = new Map<number, TaskEvent>()
  for (const e of events) bySeq.set(e.seq, e)
  return [...bySeq.values()].sort((a, b) => a.task_seq - b.task_seq)
}

/**
 * Ouvre la timeline d'une tâche, vide, au moment où son chargement part : les
 * événements diffusés pendant la requête s'y accumulent au lieu d'être jetés.
 * Sans effet si elle existe déjà.
 */
export function watchTimeline(timelines: Timelines, taskId: string): Timelines {
  return timelines[taskId] ? timelines : { ...timelines, [taskId]: [] }
}

/**
 * Ferme une timeline dont le chargement a échoué : elle ne contiendrait que ce
 * qui a été diffusé depuis, une timeline partielle qui aurait l'air entière.
 */
export function unwatchTimeline(timelines: Timelines, taskId: string): Timelines {
  if (!(taskId in timelines)) return timelines
  const { [taskId]: _dropped, ...rest } = timelines
  return rest
}

/**
 * Ajoute un événement diffusé à la timeline de sa tâche **si elle est ouverte**.
 *
 * On n'en crée pas une pour une tâche jamais demandée : ce serait une timeline
 * partielle silencieuse, qui commencerait au moment de la connexion. Mieux
 * vaut la charger entière quand on ouvre la tâche. La déduplication est
 * nécessaire : à la reconnexion, les événements rejoués peuvent recouvrir ceux
 * déjà reçus.
 */
export function appendEvent(timelines: Timelines, event: TaskEvent): Timelines {
  const existing = timelines[event.task_id]
  if (!existing) return timelines
  if (existing.some((e) => e.seq === event.seq)) return timelines
  return { ...timelines, [event.task_id]: ordered([...existing, event]) }
}

/**
 * Range la timeline chargée par HTTP, **fusionnée** avec ce que la WebSocket a
 * déjà apporté pendant la requête.
 */
export function mergeTimeline(timelines: Timelines, taskId: string, fetched: readonly TaskEvent[]): Timelines {
  return { ...timelines, [taskId]: ordered([...(timelines[taskId] ?? []), ...fetched]) }
}
