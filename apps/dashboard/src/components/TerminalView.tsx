/**
 * @file La vue terminal d'un arbre de tâches (Slice 10, étape 3).
 *
 * « Moins d'interface, plus de lignes de terminal, plus de temps réel » : le
 * journal de la racine et de ses sous-tâches, fondu en un flux monospace qui
 * défile au fil de l'eau, avec en pied une **dialogue box** vers l'orchestrateur
 * — la même que le panneau de conversation (`Composer`), avec le même refus du
 * daemon tant qu'il travaille.
 *
 * Elle **lit** le même journal que la timeline et le terminal de l'atelier, par
 * la même WebSocket ; elle n'écrit rien d'autre que le message de la dialogue
 * box. Tout texte est nettoyé par {@link plain} : aucune séquence d'échappement,
 * aucune couleur venue d'une sortie — la couleur est portée par une classe CSS.
 * C'est l'invariant du terminal de l'atelier, tenu ici aussi : l'humain lit ce
 * qui s'est passé, pas ce qu'une sortie a voulu peindre.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import type { Task, TaskEvent } from '@midgaard/contracts'
import { buildStream, type StreamLine, type StreamTone } from '@/lib/stream'
import { formatTime } from '@/lib/utils'
import { Composer } from './ChatPanel'

/** Teinte d'une ligne → classe CSS. Les mêmes que la timeline. */
const TONE: Record<StreamTone, string> = {
  muted: 'text-muted',
  running: 'text-running',
  done: 'text-done',
  danger: 'text-danger',
  waiting: 'text-waiting',
  accent: 'text-accent',
}

export function TerminalView({
  root,
  tasks,
  events,
  onError,
}: {
  /** Racine de l'arbre affiché ; `null` si aucune tâche n'est sélectionnée. */
  root: Task | null
  tasks: Task[]
  events: Record<string, TaskEvent[] | undefined>
  onError: (error: string | null) => void
}) {
  const children = useMemo(
    () => (root ? tasks.filter((t) => t.parent_task_id === root.id).sort((a, b) => a.created_at.localeCompare(b.created_at)) : []),
    [root, tasks],
  )

  // La racine en tête, puis ses sous-tâches : l'ordre fixe les étiquettes.
  const lines = useMemo(() => {
    if (!root) return []
    const sources = [{ taskId: root.id, label: root.agent_id }, ...children.map((c) => ({ taskId: c.id, label: c.agent_id }))]
    return buildStream(sources, events)
  }, [root, children, events])

  // Suit le bas tant que l'humain n'a pas remonté : un flux qui saute sous les
  // yeux de qui lit plus haut est illisible.
  const scroller = useRef<HTMLDivElement>(null)
  const [follow, setFollow] = useState(true)
  useEffect(() => {
    if (follow) scroller.current?.scrollTo({ top: scroller.current.scrollHeight })
  }, [lines.length, follow])

  function onScroll(): void {
    const el = scroller.current
    if (!el) return
    // À 24 px du bas, on considère qu'on suit encore.
    setFollow(el.scrollHeight - el.scrollTop - el.clientHeight < 24)
  }

  if (!root) {
    return (
      <div className="grid h-full place-items-center p-6 text-center text-sm text-muted" data-testid="terminal-view">
        Aucune tâche sélectionnée.
      </div>
    )
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-[#0b0e14]" data-testid="terminal-view" data-root={root.id}>
      <header className="flex items-center gap-2 border-b border-border/40 px-3 py-1.5 font-mono text-[11px] text-muted">
        <span className="text-ink">{root.agent_id}</span>
        <span className={TONE[root.status === 'failed' || root.status === 'cancelled' ? 'danger' : root.status === 'completed' ? 'done' : 'running']}>
          {root.status}
        </span>
        <span className="ml-auto">
          {root.usage.cost_source === 'unknown' ? 'coût inconnu' : `$${root.usage.cost_usd.toFixed(4)}`} · {lines.length} ligne(s)
        </span>
        {!follow && (
          <button type="button" className="rounded border border-border/60 px-1.5 py-0.5 hover:text-ink" onClick={() => setFollow(true)} data-testid="terminal-follow">
            ↓ suivre
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
          <p className="text-muted">Aucun événement.</p>
        ) : (
          lines.map((line) => <Line key={line.key} line={line} />)
        )}
      </div>

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
        </span>
      )}
    </div>
  )
}
