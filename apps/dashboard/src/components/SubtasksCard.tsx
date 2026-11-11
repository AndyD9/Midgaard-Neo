/**
 * @file Les sous-tâches d'un orchestrateur (Slice 5) : ce qu'il a délégué, à
 * qui, ce que chacune a coûté, ce que coûte l'arbre entier — et, depuis la
 * Slice 8, les exécutants qu'il a créés.
 *
 * La carte montre le **total** réellement dépensé par l'arbre, avec la plus
 * faible des provenances de ses termes (`treeTotal`) : aucun montant sans sa
 * provenance. Aucun budget ni plafond n'y figure : il n'y en a plus.
 *
 * **Les agents créés** sont lus dans le journal de l'orchestrateur
 * (`agent.created`) : nom, profil de base, modèle, serveurs MCP, et le **rôle**
 * qu'il a écrit — ajouté à la consigne du profil. C'est ici que l'humain le
 * relit (docs/SLICE8.md, décision 14).
 *
 * La sous-tâche que l'orchestrateur attend est désignée, d'après le dernier
 * `subtask.waiting` de sa timeline : son statut à lui reste `running`, et sans
 * cela on ne saurait pas ce qui le retient.
 */
import { GitBranch, Hourglass, Network, UserPlus } from 'lucide-react'
import type { Task, TaskEvent, Usage } from '@midgaard/contracts'
import { createdAgents, subtasksOf, treeTotal } from '@/lib/tree'
import { formatCost } from '@/lib/utils'
import { Badge, toneForStatus, type BadgeTone } from './ui/badge'
import { Card, CardBody, CardHeader, CardTitle } from './ui/card'

/** Provenance d'un montant, en clair. */
const SOURCE: Record<Usage['cost_source'], { label: string; tone: BadgeTone }> = {
  provider: { label: 'facturé', tone: 'done' },
  pricing_table: { label: 'estimé', tone: 'waiting' },
  unknown: { label: 'inconnu', tone: 'neutral' },
}

/** Statuts finaux : une sous-tâche finie n'est plus « attendue ». */
const ENDED = new Set(['completed', 'failed', 'cancelled', 'timed_out', 'budget_exceeded', 'interrupted'])

export function SubtasksCard({
  task,
  tasks,
  events,
  onSelect,
}: {
  task: Task
  tasks: Task[]
  events: TaskEvent[] | undefined
  onSelect: (id: string) => void
}) {
  const children = subtasksOf(tasks, task.id)
  // Un orchestrateur sans sous-tâche encore montre quand même la carte : son
  // plafond se lit avant qu'il ne délègue. Les autres profils n'en ont pas.
  if (children.length === 0 && task.agent_id !== 'orchestrator') return null

  const total = treeTotal([task, ...children])
  const created = createdAgents(events)
  const waitingOn = [...(events ?? [])].reverse().find((e) => e.type === 'subtask.waiting')?.payload.task_id
  const awaited = children.find((c) => c.id === waitingOn && !ENDED.has(c.status)) ?? null

  return (
    <Card data-testid="subtasks-card">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Network className="size-4 text-muted" /> Sous-tâches
        </CardTitle>
        <span className="text-xs text-muted" data-testid="subtasks-ceiling">
          {children.length} lancée(s)
        </span>
      </CardHeader>
      <CardBody className="space-y-3 text-sm">
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1" data-testid="subtasks-total">
          <span className="text-muted">Total de l'arbre :</span>
          {total ? (
            <>
              <span className="font-mono">{total.cost_source === 'unknown' ? '—' : formatCost(total.cost_usd)}</span>
              <Badge tone={SOURCE[total.cost_source].tone}>{SOURCE[total.cost_source].label}</Badge>
              <span className="text-xs text-muted">{total.counted} tâche(s) ayant appelé un modèle</span>
            </>
          ) : (
            <span className="text-muted">aucun appel de modèle encore</span>
          )}
        </div>
        {created.length > 0 && (
          <ul className="space-y-2 rounded-md border border-border px-3 py-2" data-testid="created-agents">
            {created.map((a) => (
              <li key={a.agent_id} className="space-y-1" data-testid={`created-agent-${a.agent_id}`}>
                <div className="flex flex-wrap items-center gap-2 text-xs">
                  <UserPlus className="size-3 text-muted" />
                  <span className="font-medium">{a.name}</span>
                  <span className="font-mono text-muted">{a.agent_id}</span>
                  <Badge tone="neutral">{a.base}</Badge>
                  <span className="text-muted">{a.model ?? 'modèle du profil'}</span>
                  {a.mcp_servers.length > 0 && <span className="text-muted">· MCP : {a.mcp_servers.join(', ')}</span>}
                </div>
                <p className="text-xs whitespace-pre-wrap text-muted">
                  <span className="text-ink">Rôle donné par l'orchestrateur</span>, ajouté à la consigne du profil :{' '}
                  {a.role}
                </p>
              </li>
            ))}
          </ul>
        )}

        {children.length > 0 && (
          <ul className="divide-y divide-border rounded-md border border-border" data-testid="subtasks-list">
            {children.map((child) => (
              <li key={child.id}>
                <button
                  type="button"
                  onClick={() => onSelect(child.id)}
                  className="w-full space-y-1 px-3 py-2 text-left hover:bg-canvas"
                >
                  <div className="flex items-center gap-2">
                    <Badge tone={toneForStatus(child.status)}>{child.status}</Badge>
                    <span className="font-mono text-xs">{child.agent_id}</span>
                    {awaited?.id === child.id && (
                      <span className="flex items-center gap-1 text-xs text-waiting">
                        <Hourglass className="size-3" /> attendue
                      </span>
                    )}
                    {child.result?.workspace && (
                      <span className="flex items-center gap-1 font-mono text-xs text-muted">
                        <GitBranch className="size-3" /> {child.result.workspace.branch}
                      </span>
                    )}
                    <span className="ml-auto font-mono text-xs text-muted">
                      {child.usage.model_calls === 0
                        ? '—'
                        : child.usage.cost_source === 'unknown'
                          ? 'coût inconnu'
                          : `${formatCost(child.usage.cost_usd)} ${SOURCE[child.usage.cost_source].label}`}
                    </span>
                  </div>
                  <p className="line-clamp-2 text-xs">{child.objective}</p>
                </button>
              </li>
            ))}
          </ul>
        )}
      </CardBody>
    </Card>
  )
}
