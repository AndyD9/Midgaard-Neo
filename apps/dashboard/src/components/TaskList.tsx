/**
 * @file Liste des tâches, colonne de gauche.
 *
 * Triée de la plus récente à la plus ancienne. Les tâches qui attendent une
 * décision humaine sont signalées là aussi, et pas seulement dans l'inspecteur :
 * c'est la seule chose dans ce dashboard qui **bloque** quelqu'un.
 *
 * Depuis la Slice 5, la liste est un **arbre** à un niveau : les sous-tâches
 * d'un orchestrateur suivent leur parent, en retrait, dans l'ordre où elles ont
 * été déléguées (`taskTree`). Une approbation demandée par une sous-tâche se
 * voit donc sous l'orchestrateur qui l'attend.
 */
import { CircleDot, CornerDownRight } from 'lucide-react'
import type { Approval, Task } from '@midgaard/contracts'
import { taskTree } from '@/lib/tree'
import { cn, formatCost, formatDateTime, formatTime } from '@/lib/utils'
import { Badge, toneForStatus } from './ui/badge'

export function TaskList({
  tasks,
  approvals,
  selectedId,
  onSelect,
}: {
  tasks: Task[]
  approvals: Approval[]
  selectedId: string | null
  onSelect: (id: string) => void
}) {
  const awaiting = new Set(approvals.map((a) => a.task_id))

  if (tasks.length === 0) {
    return (
      <p className="px-4 py-6 text-sm text-muted">
        Aucune tâche. Lances-en une avec « Nouvelle tâche ».
      </p>
    )
  }

  return (
    <ul className="divide-y divide-border">
      {taskTree(tasks).map(({ task, depth, children }) => (
        <li key={task.id} data-testid={`task-row-${task.id}`} data-depth={depth}>
          <button
            type="button"
            onClick={() => onSelect(task.id)}
            aria-current={task.id === selectedId}
            className={cn(
              'w-full px-4 py-3 text-left transition-colors hover:bg-canvas',
              depth === 1 && 'border-l-2 border-l-accent/40 pl-8',
              task.id === selectedId && 'bg-accent-soft hover:bg-accent-soft',
            )}
          >
            <div className="flex items-center gap-2">
              {depth === 1 && <CornerDownRight className="-ml-5 size-3.5 shrink-0 text-muted" aria-label="sous-tâche" />}
              <Badge tone={toneForStatus(task.status)}>{task.status}</Badge>
              {awaiting.has(task.id) && (
                <span className="flex items-center gap-1 text-xs font-medium text-waiting">
                  <CircleDot className="size-3" /> décision requise
                </span>
              )}
              <span className="ml-auto font-mono text-[11px] text-muted" title={formatDateTime(task.created_at)}>
                {formatTime(task.created_at)}
              </span>
            </div>
            <p className="mt-1.5 line-clamp-2 text-sm">{task.objective}</p>
            <p className="mt-1 font-mono text-[11px] text-muted">
              {task.agent_id} · étape {task.step}/{task.steps_total}
              {children > 0 && ` · ${children} sous-tâche(s)`}
              {/* Le coût n'apparaît que s'il a été mesuré : afficher « 0 $ » sur
                  une tâche qui n'a appelé aucun modèle serait une mesure fausse. */}
              {task.usage.model_calls > 0 &&
                ` · ${task.usage.cost_source === 'unknown' ? 'coût inconnu' : formatCost(task.usage.cost_usd)}`}
            </p>
          </button>
        </li>
      ))}
    </ul>
  )
}
