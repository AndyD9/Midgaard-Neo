/**
 * @file Timeline d'une tâche : le journal, rendu lisible.
 *
 * Les événements viennent de `task_events`, append-only et numérotés par
 * `task_seq`. L'ordre affiché est donc celui de la base, pas celui de l'arrivée
 * des messages — ce qui reste juste après une reconnexion, où des événements
 * rejoués arrivent après des événements plus récents.
 */
import {
  Archive, CircleCheck, CircleSlash, CircleX, Coins, Flag, FolderGit2, FolderX, Hourglass, MessageCircleQuestion,
  Globe, MessageSquare, MessagesSquare, Play, ShieldCheck, ShieldQuestion, SquareTerminal, TimerOff, User, UserPlus, Wallet, Wrench,
} from 'lucide-react'
import type { EventType, TaskEvent } from '@midgaard/contracts'
import { formatCost, formatDateTime, formatTime } from '@/lib/utils'
import { closedReasonText } from '@/lib/browser'

/** Aspect d'une ligne de la timeline. */
interface Look { icon: typeof Flag; label: string; className: string }

/** Icône et libellé français de chaque type d'événement. */
const EVENT_LOOK: Record<EventType, Look> = {
  'task.created': { icon: Flag, label: 'Tâche créée', className: 'text-muted' },
  'task.started': { icon: Play, label: 'Démarrage', className: 'text-running' },
  'task.progress': { icon: Hourglass, label: 'Étape', className: 'text-running' },
  'task.completed': { icon: CircleCheck, label: 'Terminée', className: 'text-done' },
  'task.failed': { icon: CircleX, label: 'Échec', className: 'text-danger' },
  'task.cancelled': { icon: CircleSlash, label: 'Annulation', className: 'text-danger' },
  'task.interrupted': { icon: CircleSlash, label: 'Interrompue par un redémarrage', className: 'text-danger' },
  'task.budget_exceeded': { icon: Wallet, label: 'Budget atteint', className: 'text-waiting' },
  'task.timed_out': { icon: TimerOff, label: 'Délai dépassé', className: 'text-waiting' },
  'agent.message': { icon: MessageSquare, label: 'Message', className: 'text-muted' },
  'approval.requested': { icon: ShieldQuestion, label: 'Approbation demandée', className: 'text-waiting' },
  'approval.resolved': { icon: ShieldCheck, label: 'Approbation tranchée', className: 'text-done' },
  'tool.requested': { icon: Wrench, label: 'Outil demandé', className: 'text-running' },
  'tool.completed': { icon: Wrench, label: 'Outil terminé', className: 'text-muted' },
  'usage.updated': { icon: Coins, label: 'Consommation', className: 'text-muted' },
  'workspace.created': { icon: FolderGit2, label: 'Worktree créé', className: 'text-running' },
  'workspace.kept': { icon: Archive, label: 'Worktree conservé', className: 'text-muted' },
  'workspace.removed': { icon: FolderX, label: 'Worktree retiré', className: 'text-muted' },
  'subtask.waiting': { icon: Hourglass, label: 'Attend une sous-tâche', className: 'text-waiting' },
  'input.requested': { icon: MessageCircleQuestion, label: 'Attend un message', className: 'text-waiting' },
  'message.user': { icon: User, label: 'Message de l\'utilisateur', className: 'text-running' },
  'message.agent': { icon: MessagesSquare, label: 'Message de la tâche parente', className: 'text-running' },
  'exec.output': { icon: SquareTerminal, label: 'Sortie de commande', className: 'text-muted' },
  'browser.opened': { icon: Globe, label: 'Navigateur ouvert', className: 'text-running' },
  'browser.closed': { icon: Globe, label: 'Navigateur fermé', className: 'text-muted' },
  'agent.created': { icon: UserPlus, label: 'Agent créé', className: 'text-running' },
}

/** Ce qu'attend une tâche en `waiting_input`, dit à l'utilisateur. */
const AWAITING: Record<string, string> = {
  chat: 'votre réponse',
  question: 'la réponse de la tâche parente à sa question',
  proposal: 'le verdict de la tâche parente sur sa proposition',
}

/**
 * Résume la charge utile d'un événement en une ligne.
 *
 * Volontairement sélectif : la timeline doit se lire d'un coup d'œil. La charge
 * complète reste dans l'infobulle.
 */
function describe(event: TaskEvent): string | null {
  const p = event.payload as Record<string, unknown>
  if (typeof p.message === 'string') return p.message
  if (event.type === 'task.progress') return `étape ${p.step}/${p.steps_total}`
  if (event.type === 'approval.requested') return String(p.operation ?? '')
  if (event.type === 'approval.resolved') {
    const by = p.by ? ` par ${String(p.by)}` : ''
    const reason = p.reason ? ` — ${String(p.reason)}` : ''
    return `${String(p.decision)}${by}${reason}`
  }
  if (event.type === 'input.requested') {
    const what = AWAITING[String(p.request)] ?? String(p.request)
    return typeof p.text === 'string' && p.text ? `${what} — ${p.text}` : what
  }
  if (event.type === 'message.user' || event.type === 'message.agent' || event.type === 'exec.output') {
    return typeof p.text === 'string' ? p.text : null
  }
  if (event.type === 'browser.opened') return `${String(p.start_url)} — ${String(p.objective)}`
  if (event.type === 'browser.closed') return closedReasonText(String(p.reason))
  // Un agent créé par l'orchestrateur (Slice 8) : ce qu'il est, d'où il dérive.
  if (event.type === 'agent.created') {
    return `${String(p.name)} · ${String(p.agent_id)} — ${String(p.base_agent_id)}, ${String(p.model ?? 'modèle par défaut')}`
  }
  if (event.type === 'task.interrupted') return `statut précédent : ${String(p.previous_status)}`
  if (event.type === 'subtask.waiting') {
    return `${String(p.agent_id)} · ${String(p.task_id).slice(0, 8)} (${String(p.status)})`
  }
  if (event.type === 'workspace.created') {
    // Deux choses seulement surprennent ici, et l'agent ne les verra pas : les
    // fichiers non commités, absents du worktree, et les sous-modules, vides.
    const dirty = Number(p.base_dirty ?? 0)
    const submodules = Array.isArray(p.submodules) ? p.submodules.length : 0
    const notes = [
      dirty > 0 ? `${dirty} fichier(s) non commité(s) absent(s) du worktree` : '',
      submodules > 0 ? `${submodules} sous-module(s) vide(s)` : '',
    ].filter(Boolean)
    const base = `${String(p.branch)} depuis ${String(p.base_commit).slice(0, 8)}`
    return notes.length ? `${base} — ${notes.join(', ')}` : base
  }
  if (event.type === 'workspace.kept' || event.type === 'workspace.removed') {
    return p.reason ? `${String(p.branch)} — ${String(p.reason)}` : String(p.branch)
  }
  if (event.type === 'task.cancelled' && p.reason) return String(p.reason)
  if (event.type === 'tool.requested') {
    const decision = p.decision === 'allow' ? '' : ` (${String(p.decision)})`
    return `${String(p.name)}${decision}`
  }
  if (event.type === 'tool.completed') {
    return p.error ? `échec — ${String(p.error)}` : (p.summary as string | null) ?? String(p.status)
  }
  // La consommation est l'événement le plus fréquent d'une tâche réelle : son
  // résumé doit tenir en quelques caractères, sinon la timeline devient un
  // relevé comptable qu'on ne lit plus.
  if (event.type === 'usage.updated') {
    const usage = p.usage as { cost_usd?: number; cost_source?: string; model_calls?: number } | undefined
    if (!usage) return null
    const cost = usage.cost_source === 'unknown' ? 'coût inconnu' : formatCost(usage.cost_usd ?? 0)
    return `${usage.model_calls} appel(s) · ${cost}`
  }
  if (event.type === 'task.budget_exceeded' || event.type === 'task.timed_out') {
    return (p.reason as string | undefined) ?? null
  }
  return null
}

export function Timeline({ events }: { events: TaskEvent[] | undefined }) {
  if (!events) return <p className="px-4 py-6 text-sm text-muted">Chargement de la timeline…</p>
  if (events.length === 0) return <p className="px-4 py-6 text-sm text-muted">Aucun événement.</p>

  return (
    <ol className="relative px-4 py-3">
      {/* Filet vertical reliant les puces, purement décoratif. */}
      <span aria-hidden className="absolute top-5 bottom-5 left-[25px] w-px bg-border" />
      {events.map((event) => {
        // Un type que la table ignore vient d'un daemon plus récent que la
        // page : on le montre tel quel. Lire `.icon` sur `undefined` démontait
        // toute l'interface (constaté le 2026-11-05, `lib/bundle.ts`).
        const look: Look = (EVENT_LOOK as Partial<Record<string, Look>>)[event.type]
          ?? { icon: Flag, label: event.type, className: 'text-muted' }
        const Icon = look.icon
        const detail = describe(event)
        return (
          <li key={event.seq} className="relative flex gap-3 py-1.5">
            <span className="z-10 mt-0.5 grid size-[18px] shrink-0 place-items-center rounded-full border border-border bg-surface">
              <Icon className={`size-3 ${look.className}`} />
            </span>
            <div className="min-w-0 flex-1">
              <p className="text-sm">
                <span className="font-medium">{look.label}</span>
                {detail && <span className="text-muted"> — {detail}</span>}
              </p>
            </div>
            <time
              className="shrink-0 font-mono text-[11px] text-muted"
              dateTime={event.at}
              title={`${formatDateTime(event.at)} · séquence globale ${event.seq}`}
            >
              {formatTime(event.at)}
            </time>
          </li>
        )
      })}
    </ol>
  )
}
