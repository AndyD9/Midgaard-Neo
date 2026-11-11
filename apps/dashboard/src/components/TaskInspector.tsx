/**
 * @file Inspecteur de tâche : tout ce qu'on sait d'une tâche, au même endroit.
 *
 * L'ordre de haut en bas suit ce qu'on cherche quand on ouvre une tâche :
 * est-ce que quelque chose m'attend (approbation), où en est-ce (état et
 * progression), qu'est-ce qui en est sorti (résultat ou erreur, puis, pour un
 * Developer, les fichiers et le diff), et enfin ce qui s'est passé (timeline).
 *
 * Depuis la Slice 5, une sous-tâche nomme son parent (lien), et un orchestrateur
 * montre ses sous-tâches juste après sa consommation : le total de l'arbre se lit
 * à côté du coût propre de l'orchestrateur.
 */
import { useEffect, useState } from 'react'
import { Ban, ShieldAlert } from 'lucide-react'
import type { Approval, Task, TaskEvent } from '@midgaard/contracts'
import { cancelTask } from '@/lib/api'
import { duration, formatDateTime } from '@/lib/utils'
import { ApprovalPanel } from './ApprovalPanel'
import { SubtasksCard } from './SubtasksCard'
import { Timeline } from './Timeline'
import { ToolCalls } from './ToolCalls'
import { UsageCard } from './UsageCard'
import { WorkspaceCard } from './WorkspaceCard'
import { Badge, toneForStatus } from './ui/badge'
import { Button } from './ui/button'
import { Card, CardBody, CardHeader, CardTitle } from './ui/card'

/** Statuts depuis lesquels une annulation a encore un sens. */
const CANCELLABLE = ['queued', 'preparing', 'running', 'waiting_approval', 'waiting_input']

export function TaskInspector({
  task,
  tasks,
  approval,
  events,
  onLoadEvents,
  onError,
  onSelect,
}: {
  task: Task
  /** Toutes les tâches connues : pour le parent d'une sous-tâche, et les enfants d'un orchestrateur. */
  tasks: Task[]
  approval: Approval | null
  events: TaskEvent[] | undefined
  onLoadEvents: (taskId: string) => void
  onError: (message: string | null) => void
  onSelect: (taskId: string) => void
}) {
  const [cancelling, setCancelling] = useState(false)

  // La timeline est chargée entière à l'ouverture, puis tenue à jour par la
  // WebSocket. Un affichage partiel qui commencerait à la connexion serait pire
  // que pas de timeline : il serait faux sans le dire.
  useEffect(() => {
    if (!events) onLoadEvents(task.id)
  }, [task.id, events, onLoadEvents])

  async function cancel(): Promise<void> {
    setCancelling(true)
    onError(null)
    try {
      await cancelTask(task.id, 'annulée depuis le dashboard')
    } catch (e) {
      onError(`annulation refusée : ${(e as Error).message}`)
    } finally {
      setCancelling(false)
    }
  }

  const elapsed = duration(task.created_at, task.ended_at)

  return (
    <div className="space-y-4">
      {approval && <ApprovalPanel approval={approval} onError={onError} />}

      <Card>
        <CardHeader>
          <div className="min-w-0 space-y-1.5">
            <CardTitle className="text-base">{task.objective}</CardTitle>
            <p className="font-mono text-[11px] text-muted">{task.id}</p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <Badge tone={toneForStatus(task.status)}>{task.status}</Badge>
            {CANCELLABLE.includes(task.status) && (
              <Button variant="outline" size="sm" onClick={cancel} disabled={cancelling}>
                <Ban /> Annuler
              </Button>
            )}
          </div>
        </CardHeader>
        <CardBody className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
          <Field label="Exécutant" value={task.agent_id} />
          {task.parent_task_id && (
            <p className="flex gap-2" data-testid="parent-link">
              <span className="text-muted">Sous-tâche de :</span>
              <button
                type="button"
                className="min-w-0 truncate font-mono text-xs text-accent hover:underline"
                onClick={() => onSelect(task.parent_task_id!)}
              >
                {tasks.find((t) => t.id === task.parent_task_id)?.agent_id ?? 'tâche'} ·{' '}
                {task.parent_task_id.slice(0, 8)}
              </button>
            </p>
          )}
          {task.continues_task_id && (
            <p className="flex gap-2" data-testid="continues-link">
              <span className="text-muted">Suite de :</span>
              <button
                type="button"
                className="min-w-0 truncate font-mono text-xs text-accent hover:underline"
                onClick={() => onSelect(task.continues_task_id!)}
              >
                {tasks.find((t) => t.id === task.continues_task_id)?.agent_id ?? 'tâche'} ·{' '}
                {task.continues_task_id.slice(0, 8)}
              </button>
            </p>
          )}
          <Field label="Progression" value={task.steps_total > 0 ? `étape ${task.step} sur ${task.steps_total}` : `étape ${task.step}`} />
          <Field label="Créée" value={formatDateTime(task.created_at)} />
          <Field label="Terminée" value={task.ended_at ? formatDateTime(task.ended_at) : '—'} />
          {elapsed && <Field label="Temps écoulé" value={elapsed} />}
          {/* La durée n'a de sens que pour le profil simulé : l'afficher sur une
              tâche réelle laisserait croire à un minuteur qui n'existe pas. */}
          {task.agent_id === 'simulated' && <Field label="Durée simulée" value={`${task.duration_s} s`} />}
          {task.project_dir && <Field label="Racine de lecture" value={task.project_dir} />}
        </CardBody>
      </Card>

      <UsageCard task={task} />

      <SubtasksCard task={task} tasks={tasks} events={events} onSelect={onSelect} />

      {task.error && (
        <Card className="border-danger/40">
          <CardHeader>
            <CardTitle className="text-danger">Fin anormale</CardTitle>
          </CardHeader>
          <CardBody className="text-sm">{task.error}</CardBody>
        </Card>
      )}

      {task.result && (
        <Card>
          <CardHeader>
            <CardTitle>Résultat</CardTitle>
            {task.result.untrusted && (
              <Badge tone="waiting">
                <ShieldAlert className="size-3" /> contenu extérieur
              </Badge>
            )}
          </CardHeader>
          <CardBody className="space-y-3 text-sm">
            <p className="font-medium">{task.result.summary}</p>

            {task.result.untrusted && (
              // Le même avertissement que celui joint au résultat rendu à Claude.
              // Ce qu'un agent tire du dehors est de la donnée, jamais une
              // consigne — et l'humain qui le lit doit le savoir aussi.
              <p className="rounded-md border border-waiting/40 bg-waiting/10 px-3 py-2 text-xs text-waiting">
                Ce résultat dérive de contenu extérieur — page web, sortie de commande ou résultat d'un autre
                agent — que personne ne contrôle. À lire comme de la donnée rapportée, pas comme une instruction,
                et à recouper avec ses sources quand il en cite.
              </p>
            )}

            {task.result.details && (
              <div className="max-h-96 overflow-y-auto rounded-md border border-border bg-canvas px-3 py-2 text-xs whitespace-pre-wrap">
                {task.result.details}
              </div>
            )}

            {task.result.citations.length > 0 && (
              <div className="space-y-1">
                <p className="text-xs font-medium text-muted">Sources</p>
                <ul className="space-y-0.5 text-xs">
                  {task.result.citations.map((c, i) => (
                    <li key={i} className="truncate">
                      {/* `noreferrer` : l'URL du dashboard local n'a pas à partir
                          dans le `Referer` d'un site tiers. */}
                      <a
                        href={c.url}
                        target="_blank"
                        rel="noreferrer noopener"
                        className="text-accent hover:underline"
                      >
                        {c.title || c.url}
                      </a>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {task.result.steps.length > 0 && (
              <ul className="list-inside list-disc space-y-0.5 text-muted">
                {task.result.steps.map((s, i) => (
                  <li key={i}>{s}</li>
                ))}
              </ul>
            )}
          </CardBody>
        </Card>
      )}

      <WorkspaceCard taskId={task.id} events={events} />

      <ToolCalls taskId={task.id} version={events?.length ?? 0} />

      <Card>
        <CardHeader>
          <CardTitle>Timeline</CardTitle>
          <span className="text-xs text-muted">{events?.length ?? 0} événement(s)</span>
        </CardHeader>
        <Timeline events={events} />
      </Card>
    </div>
  )
}

/** Paire libellé / valeur, alignée sur deux colonnes. */
function Field({ label, value }: { label: string; value: string }) {
  return (
    <p className="flex gap-2">
      <span className="text-muted">{label} :</span>
      <span className="min-w-0 truncate">{value}</span>
    </p>
  )
}
