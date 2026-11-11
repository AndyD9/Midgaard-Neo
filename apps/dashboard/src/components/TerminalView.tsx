/**
 * @file La vue terminal d'un arbre de tâches : l'interface du dashboard.
 *
 * Le journal de la racine et de ses sous-tâches, fondu en un flux monospace qui
 * défile au fil de l'eau ; sous le flux, **les demandes d'approbation de
 * l'arbre**, puis l'invite vers l'orchestrateur. Tout ce qui demande un acte
 * humain est donc au même endroit, au pied de ce qu'on lit : une approbation
 * se décide en voyant la commande et la sortie qui la précèdent.
 *
 * Elle **lit** le même journal que la timeline des détails, par la même
 * WebSocket ; elle n'écrit que le message de l'invite, une décision
 * d'approbation et une annulation. Tout texte est nettoyé par {@link plain} :
 * aucune séquence d'échappement, aucune couleur venue d'une sortie — la couleur
 * est portée par une classe CSS. L'humain lit ce qui s'est passé, pas ce qu'une
 * sortie a voulu peindre.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import type { Approval, Task, TaskEvent } from '@midgaard/contracts'
import { cancelTask } from '@/lib/api'
import { buildStream, type StreamLine, type StreamTone } from '@/lib/stream'
import { formatTime } from '@/lib/utils'
import { ApprovalPanel } from './ApprovalPanel'
import { Composer, ReadImage } from './Composer'

/** Teinte d'une ligne → classe CSS. Les mêmes que la timeline. */
const TONE: Record<StreamTone, string> = {
  muted: 'text-muted',
  running: 'text-running',
  done: 'text-done',
  danger: 'text-danger',
  waiting: 'text-waiting',
  accent: 'text-accent',
}

/** Statuts depuis lesquels une annulation a encore un sens. */
const CANCELLABLE = ['queued', 'preparing', 'running', 'waiting_approval', 'waiting_input']

/** Teinte du statut de la racine, dans l'en-tête. */
function statusTone(status: string): StreamTone {
  if (status === 'completed') return 'done'
  if (status === 'waiting_approval' || status === 'waiting_input') return 'waiting'
  if (['queued', 'preparing', 'running', 'cancel_requested'].includes(status)) return 'running'
  return 'danger'
}

/**
 * @param root      racine de l'arbre affiché
 * @param tasks     toutes les tâches connues : les sous-tâches en sont tirées
 * @param events    timelines chargées, par tâche
 * @param approvals demandes en attente ; seules celles de l'arbre sont montrées
 * @param onError   remonte un refus du daemon au bandeau
 */
export function TerminalView({
  root,
  tasks,
  events,
  approvals,
  onError,
}: {
  root: Task
  tasks: Task[]
  events: Record<string, TaskEvent[] | undefined>
  approvals: Approval[]
  onError: (error: string | null) => void
}) {
  const children = useMemo(
    () => tasks.filter((t) => t.parent_task_id === root.id).sort((a, b) => a.created_at.localeCompare(b.created_at)),
    [root, tasks],
  )

  // La racine en tête, puis ses sous-tâches : l'ordre fixe les étiquettes.
  const lines = useMemo(() => {
    const sources = [root, ...children].map((t) => ({ taskId: t.id, label: `${t.agent_id}·${t.id.slice(0, 4)}`, objective: t.objective }))
    return buildStream(sources, events)
  }, [root, children, events])

  // Les demandes de l'arbre, la plus ancienne d'abord : c'est elle qui expire en premier.
  const pending = useMemo(() => {
    const ids = new Set([root.id, ...children.map((c) => c.id)])
    return approvals.filter((a) => ids.has(a.task_id))
  }, [root, children, approvals])

  // Suit le bas tant que l'humain n'a pas remonté : un flux qui saute sous les
  // yeux de qui lit plus haut est illisible.
  const scroller = useRef<HTMLDivElement>(null)
  const [follow, setFollow] = useState(true)
  useEffect(() => {
    if (follow) scroller.current?.scrollTo({ top: scroller.current.scrollHeight })
  }, [lines.length, pending.length, follow])

  function onScroll(): void {
    const el = scroller.current
    if (!el) return
    // À 24 px du bas, on considère qu'on suit encore.
    setFollow(el.scrollHeight - el.scrollTop - el.clientHeight < 24)
  }

  const [cancelling, setCancelling] = useState(false)
  async function cancel(): Promise<void> {
    setCancelling(true)
    onError(null)
    try {
      await cancelTask(root.id, 'annulée depuis le dashboard')
    } catch (e) {
      onError(`annulation refusée : ${(e as Error).message}`)
    } finally {
      setCancelling(false)
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-canvas" data-testid="terminal-view" data-root={root.id}>
      <header className="flex items-center gap-2 border-b border-border/60 px-3 py-1 font-mono text-[11px] text-muted">
        <span className="text-ink">{root.agent_id}</span>
        <span className={TONE[statusTone(root.status)]}>{root.status}</span>
        <span className="truncate" title="Identifiant de la tâche racine">
          {root.id}
        </span>
        <span className="ml-auto shrink-0">
          {/* Sans appel de modèle, aucun montant : zéro est un coût, pas une ignorance. */}
          {root.usage.model_calls > 0 && `${root.usage.cost_source === 'unknown' ? 'coût inconnu' : `$${root.usage.cost_usd.toFixed(4)}`} · `}
          {lines.length} ligne(s)
        </span>
        {!follow && (
          <button type="button" className="shrink-0 hover:text-ink" onClick={() => setFollow(true)} data-testid="terminal-follow">
            [↓ suivre]
          </button>
        )}
        {CANCELLABLE.includes(root.status) && (
          <button type="button" className="shrink-0 text-danger hover:text-ink disabled:opacity-40" onClick={() => void cancel()} disabled={cancelling} data-testid="terminal-cancel">
            [annuler]
          </button>
        )}
      </header>

      <div
        ref={scroller}
        onScroll={onScroll}
        className="min-h-0 flex-1 overflow-y-auto px-3 py-2 font-mono text-[12px] leading-[1.5]"
        data-testid="terminal-stream"
      >
        {lines.length === 0 ? (
          <p className="text-muted">Chargement du journal…</p>
        ) : (
          lines.map((line) => <Line key={line.key} line={line} />)
        )}
      </div>

      {pending.length > 0 && (
        <div className="max-h-[55%] shrink-0 space-y-2 overflow-y-auto border-t border-waiting/40 p-2" data-testid="terminal-approvals">
          {pending.map((a) => (
            <ApprovalPanel key={a.id} approval={a} onError={onError} />
          ))}
        </div>
      )}

      <Composer root={root} onError={onError} />
    </div>
  )
}

/** Une ligne du flux : horodatage, étiquette de sous-tâche, mot, puis le texte. */
function Line({ line }: { line: StreamLine }) {
  return (
    <div className="flex gap-2 whitespace-pre-wrap break-words" data-testid="terminal-line" data-type={line.label || 'sortie'}>
      <time className="shrink-0 text-muted/60" dateTime={line.at}>
        {formatTime(line.at)}
      </time>
      {line.tag && <span className="shrink-0 text-accent/80">{line.tag}</span>}
      {line.raw ? (
        <span className={TONE[line.tone]}>{line.text}</span>
      ) : (
        <span className="min-w-0">
          <span className={TONE[line.tone]}>{line.label}</span>
          {line.text && <span className="text-ink/90"> {line.text}</span>}
          {line.image && <ReadImage taskId={line.taskId} path={line.image.path} sha256Prefix={line.image.sha256Prefix} />}
        </span>
      )}
    </div>
  )
}
