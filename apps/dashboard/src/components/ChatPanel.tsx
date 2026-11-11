/**
 * @file Le panneau de conversation (Slice 6) : le fil d'un arbre de tâches —
 * ce que vous dites à l'orchestrateur, ce qu'il répond, et ce que lui et ses
 * sous-tâches se disent — avec la saisie quand la conversation vous attend.
 *
 * Trois choix :
 *  - **la saisie ne s'ouvre que lorsque l'orchestrateur attend votre réponse** :
 *    le daemon refuse un message à une tâche qui travaille, et un champ ouvert
 *    qui refuse ensuite ferait croire à une panne. Le motif est affiché à la place ;
 *  - **le texte est rendu comme du texte** : il vient d'agents, qui ont pu lire
 *    le web. React l'échappe, rien n'en est interprété — ni Markdown, ni HTML ;
 *  - **une conversation ne survit pas au daemon**, et le panneau le dit tant
 *    qu'elle est en cours : la règle `interrupted` est un invariant, pas un
 *    défaut à cacher.
 *
 * Une image lue par un agent (Slice 7) est relue **sur le disque** et montrée
 * dans le fil. Aucune image n'est gardée par le daemon : si le fichier a changé
 * depuis, son empreinte diffère de celle journalisée, et le fil le dit plutôt
 * que de montrer une autre image comme celle que l'agent a vue.
 */
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { CircleCheck, CircleX, CornerDownRight, Image as ImageIcon, MessageCircleQuestion, Send, Sparkles, User } from 'lucide-react'
import type { Task, TaskEvent } from '@midgaard/contracts'
import { ApiError, fetchTaskImage, postMessage } from '@/lib/api'
import { buildThread, composerState, type ThreadItem, type ThreadKind } from '@/lib/thread'
import { cn, formatTime } from '@/lib/utils'
import { Badge, toneForStatus } from './ui/badge'
import { Button } from './ui/button'

/** Allure de chaque nature d'élément du fil. */
const LOOK: Record<ThreadKind, { icon: typeof User; className: string; label?: string }> = {
  user: { icon: User, className: 'border-accent/40 bg-accent-soft' },
  agent: { icon: Sparkles, className: 'border-border bg-surface' },
  delegation: { icon: CornerDownRight, className: 'border-running/40 bg-running/5', label: 'délègue' },
  question: { icon: MessageCircleQuestion, className: 'border-waiting/50 bg-waiting/10', label: 'demande' },
  proposal: { icon: MessageCircleQuestion, className: 'border-waiting/50 bg-waiting/10', label: 'propose' },
  reply: { icon: CornerDownRight, className: 'border-running/40 bg-running/5', label: 'répond' },
  verdict: { icon: CircleCheck, className: 'border-done/40 bg-done/10', label: 'accepte' },
  result: { icon: CircleCheck, className: 'border-done/40 bg-done/10', label: 'résultat' },
  ended: { icon: CircleX, className: 'border-danger/40 bg-danger/10' },
  image: { icon: ImageIcon, className: 'border-border bg-surface', label: 'regarde' },
}

export function ChatPanel({
  root,
  tasks,
  events,
  onSelect,
  onError,
}: {
  /** Racine de l'arbre affiché ; `null` si aucune tâche n'est sélectionnée. */
  root: Task | null
  tasks: Task[]
  events: Record<string, TaskEvent[] | undefined>
  onSelect: (taskId: string) => void
  onError: (error: string | null) => void
}) {
  const children = useMemo(
    () => (root ? tasks.filter((t) => t.parent_task_id === root.id).sort((a, b) => a.created_at.localeCompare(b.created_at)) : []),
    [root, tasks],
  )
  const thread = useMemo(() => (root ? buildThread(root, children, events) : []), [root, children, events])
  const bottom = useRef<HTMLDivElement>(null)

  // Le fil suit le dernier message, comme une conversation.
  useEffect(() => {
    bottom.current?.scrollIntoView({ block: 'end' })
  }, [thread.length])

  if (!root) {
    return (
      <div className="grid h-full place-items-center p-6 text-center text-sm text-muted" data-testid="chat-panel">
        <div className="space-y-3">
          <p>Aucune conversation sélectionnée.</p>
          <Button size="sm" onClick={() => (location.hash = '#/new')}>
            Nouvelle conversation
          </Button>
        </div>
      </div>
    )
  }

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="chat-panel" data-root={root.id}>
      <header className="space-y-1 border-b border-border px-3 py-2">
        <div className="flex items-center gap-2">
          <h2 className="mr-auto text-xs font-semibold tracking-wide text-muted uppercase">Conversation</h2>
          <Badge tone={toneForStatus(root.status)}>{root.status}</Badge>
        </div>
        {root.mode === 'chat' && ['queued', 'preparing', 'running', 'waiting_approval', 'waiting_input'].includes(root.status) && (
          <p className="text-[11px] text-muted">Une conversation ne survit pas à un redémarrage du daemon.</p>
        )}
      </header>

      <ol className="min-h-0 flex-1 space-y-2 overflow-y-auto px-3 py-3" data-testid="chat-thread">
        {thread.length === 0 ? (
          <li className="text-sm text-muted">Chargement du fil…</li>
        ) : (
          thread.map((item) => <ThreadEntry key={item.key} item={item} onSelect={onSelect} />)
        )}
        <div ref={bottom} />
      </ol>

      <Composer root={root} onError={onError} />
    </div>
  )
}

/** Un élément du fil. */
function ThreadEntry({ item, onSelect }: { item: ThreadItem; onSelect: (taskId: string) => void }) {
  const look = LOOK[item.kind]
  const Icon = look.icon
  return (
    <li className={cn('rounded-md border px-2.5 py-2 text-sm', look.className)} data-testid="chat-item" data-kind={item.kind}>
      <div className="mb-1 flex items-center gap-1.5 text-[11px] text-muted">
        <Icon className="size-3.5 shrink-0" />
        <button type="button" className="font-medium text-ink hover:underline" onClick={() => onSelect(item.taskId)}>
          {item.from}
        </button>
        {look.label && <span>{look.label}</span>}
        {item.to && <span>→ {item.to}</span>}
        <time className="ml-auto font-mono" dateTime={item.at}>
          {formatTime(item.at)}
        </time>
      </div>
      <p className="break-words whitespace-pre-wrap">{item.text}</p>
      {item.image && <ReadImage taskId={item.taskId} path={item.image.path} sha256Prefix={item.image.sha256Prefix} />}
      {item.detail && <p className="mt-1 text-[11px] text-muted">{item.detail}</p>}
    </li>
  )
}

/**
 * L'image qu'un agent a lue, relue sur le disque. Montrée seulement si son
 * empreinte est celle que `read_image` a journalisée : sinon, ce ne serait pas
 * l'image que l'agent a vue, et le fil le dit.
 */
function ReadImage({ taskId, path, sha256Prefix }: { taskId: string; path: string; sha256Prefix: string }) {
  const [state, setState] = useState<{ url: string } | { note: string } | null>(null)
  useEffect(() => {
    let abandoned = false
    let made: string | null = null
    fetchTaskImage(taskId, path)
      .then(({ blob, sha256 }) => {
        if (abandoned) return
        if (!sha256?.startsWith(sha256Prefix)) {
          setState({ note: 'Le fichier a changé depuis que l\'agent l\'a lu : il n\'est pas montré.' })
          return
        }
        made = URL.createObjectURL(blob)
        setState({ url: made })
      })
      .catch((e: unknown) => {
        if (!abandoned) setState({ note: e instanceof ApiError && e.reason ? `Image illisible : ${e.reason}.` : 'Image illisible.' })
      })
    return () => {
      abandoned = true
      if (made) URL.revokeObjectURL(made)
    }
  }, [taskId, path, sha256Prefix])
  if (!state) return null
  if ('note' in state) return <p className="mt-1 text-[11px] text-muted" data-testid="chat-image-note">{state.note}</p>
  return <img src={state.url} alt={`Image lue par l'agent : ${path}`} className="mt-1.5 max-h-48 rounded border border-border" data-testid="chat-image" />
}

/**
 * La saisie vers l'orchestrateur : ouverte seulement quand la conversation
 * attend votre réponse. Exportée pour la vue terminal (Slice 10), qui garde la
 * même dialogue box et le même refus du daemon tant qu'il travaille.
 */
export function Composer({ root, onError }: { root: Task; onError: (error: string | null) => void }) {
  const [text, setText] = useState('')
  const [sending, setSending] = useState(false)
  const state = composerState(root)

  async function send(conclude: boolean): Promise<void> {
    if (sending || (!conclude && !text.trim())) return
    setSending(true)
    try {
      await postMessage(root.id, text.trim(), conclude)
      setText('')
      onError(null)
    } catch (e) {
      onError(e instanceof ApiError && e.reason ? e.reason : `message refusé : ${(e as Error).message}`)
    } finally {
      setSending(false)
    }
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>): void {
    // Entrée envoie, Maj+Entrée va à la ligne : la convention des messageries.
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      void send(false)
    }
  }

  if (!state.open) {
    return (
      <p className="border-t border-border px-3 py-3 text-xs text-muted" data-testid="chat-closed">
        {state.reason}
      </p>
    )
  }
  return (
    <div className="space-y-2 border-t border-border p-2">
      <textarea
        className="w-full resize-none rounded-md border border-border bg-surface px-2.5 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-accent"
        rows={3}
        placeholder="Votre réponse à l'orchestrateur…"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={onKeyDown}
        disabled={sending}
        data-testid="chat-input"
        autoFocus
      />
      <div className="flex justify-end gap-2">
        <Button size="sm" variant="ghost" onClick={() => void send(true)} disabled={sending} data-testid="chat-conclude">
          Conclure
        </Button>
        <Button size="sm" onClick={() => void send(false)} disabled={sending || !text.trim()} data-testid="chat-send">
          <Send /> Envoyer
        </Button>
      </div>
    </div>
  )
}
