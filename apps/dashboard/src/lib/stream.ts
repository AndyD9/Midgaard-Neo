/**
 * @file Le flux terminal d'un arbre de tâches (Slice 10, étape 3) : tous les
 * événements de la racine et de ses sous-tâches, fondus en un seul flux
 * chronologique de **lignes façon terminal**. Fonctions pures, sans React,
 * testées dans `tests/unit/dashboard-stream.test.ts`.
 *
 * C'est la vue « moins d'interface, plus de lignes et de temps réel » : une
 * ligne par événement, l'identité de la sous-tâche en tête, la sortie `exec` au
 * fil de l'eau. Elle **lit** le même journal que la timeline et le terminal de
 * l'atelier ; elle n'écrit rien, hormis la dialogue box vers l'orchestrateur,
 * qui passe par l'API de conversation comme le panneau de chat.
 *
 * **Tout texte affiché est une donnée possiblement hostile** : messages d'agents,
 * sorties de commandes, résumés d'outils. Comme le terminal de l'atelier, cette
 * vue ne rend que du texte — mais en HTML, pas dans un vrai terminal. Une
 * séquence d'échappement n'y est pas interprétée ; {@link plain} les retire
 * **toutes**, couleur comprise (la couleur est portée par une classe CSS, pas
 * par des octets venus de la sortie), avec les caractères de contrôle qui
 * déplaceraient ou effaceraient ce que l'humain lit.
 */
import type { TaskEvent } from '@midgaard/contracts'

/** Teinte d'une ligne, traduite en classe CSS par la vue. */
export type StreamTone = 'muted' | 'running' | 'done' | 'danger' | 'waiting' | 'accent'

/** Une ligne du flux terminal. */
export interface StreamLine {
  /** Clé stable : la séquence globale, jamais réutilisée. */
  key: string
  seq: number
  at: string
  taskId: string
  /** Étiquette courte de la sous-tâche (son profil) ; vide pour la racine. */
  tag: string
  /** Mot de tête, façon niveau de log : `exec`, `approbation`, `outil`… */
  label: string
  /** Le détail, déjà nettoyé ; peut tenir sur plusieurs lignes pour `exec`. */
  text: string
  tone: StreamTone
  /** Vrai pour une sortie `exec` : rendue telle quelle, en pré-formaté. */
  raw: boolean
}

/** Une tâche dont le flux montre les événements, et son libellé. */
export interface StreamSource {
  taskId: string
  label: string
}

/**
 * Retire d'un texte **toutes** les séquences d'échappement (couleur comprise,
 * car elle n'est pas interprétée en HTML) et les caractères de contrôle, sauf
 * `\n` et `\t`. Sans ce nettoyage, une sortie de commande pourrait écrire des
 * octets que l'humain lirait comme l'interface, au moment où il décide.
 */
export function plain(raw: string): string {
  return (
    raw
      // OSC : ESC ] … terminé par BEL ou ESC \.
      .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?/g, '')
      // CSI : ESC [ … finale — couleur comprise, puisqu'elle ne serait pas interprétée.
      .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
      // Toute autre séquence ESC, et un ESC isolé.
      .replace(/\x1b(?!\[)[\x20-\x7e]?/g, '')
      // Contrôles C0 restants, sauf \t et \n, et DEL.
      .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '')
  )
}

/** Ce qu'attend une tâche en `waiting_input`, dit en clair. */
const AWAITING: Record<string, string> = {
  chat: 'votre réponse',
  question: 'la réponse du parent',
  proposal: 'le verdict du parent',
}

/** Mot de tête et teinte par type d'événement. Un type inconnu garde son nom, en sourdine. */
const LOOK: Partial<Record<string, { label: string; tone: StreamTone }>> = {
  'task.created': { label: 'tâche', tone: 'muted' },
  'task.started': { label: 'départ', tone: 'running' },
  'task.progress': { label: 'étape', tone: 'running' },
  'task.completed': { label: 'terminée', tone: 'done' },
  'task.failed': { label: 'échec', tone: 'danger' },
  'task.cancelled': { label: 'annulée', tone: 'danger' },
  'task.interrupted': { label: 'interrompue', tone: 'danger' },
  'task.budget_exceeded': { label: 'budget', tone: 'waiting' },
  'task.timed_out': { label: 'délai', tone: 'waiting' },
  'agent.message': { label: 'message', tone: 'muted' },
  'approval.requested': { label: 'approbation?', tone: 'waiting' },
  'approval.resolved': { label: 'approbation', tone: 'done' },
  'tool.requested': { label: 'outil', tone: 'running' },
  'tool.completed': { label: 'outil', tone: 'muted' },
  'usage.updated': { label: 'coût', tone: 'muted' },
  'workspace.created': { label: 'worktree', tone: 'running' },
  'workspace.kept': { label: 'worktree', tone: 'muted' },
  'workspace.removed': { label: 'worktree', tone: 'muted' },
  'subtask.waiting': { label: 'attend', tone: 'waiting' },
  'input.requested': { label: 'attend', tone: 'waiting' },
  'message.user': { label: 'vous', tone: 'accent' },
  'message.agent': { label: 'parent', tone: 'running' },
  'exec.output': { label: 'sortie', tone: 'muted' },
  'browser.opened': { label: 'navigateur', tone: 'running' },
  'browser.closed': { label: 'navigateur', tone: 'muted' },
  'agent.created': { label: 'agent créé', tone: 'running' },
}

/** Le détail d'un événement, en une ligne compacte ; `null` si rien à dire. */
function detail(event: TaskEvent): string | null {
  const p = event.payload as Record<string, unknown>
  switch (event.type) {
    case 'task.progress':
      return `${p.step}/${p.steps_total}`
    case 'approval.requested':
      return String(p.operation ?? '')
    case 'approval.resolved': {
      const by = p.by ? ` par ${String(p.by)}` : ''
      const reason = p.reason ? ` — ${String(p.reason)}` : ''
      return `${String(p.decision)}${by}${reason}`
    }
    case 'input.requested': {
      const what = AWAITING[String(p.request)] ?? String(p.request)
      return typeof p.text === 'string' && p.text ? `${what} — ${p.text}` : what
    }
    case 'subtask.waiting':
      return `${String(p.agent_id)} ${String(p.task_id).slice(0, 8)} (${String(p.status)})`
    case 'tool.requested':
      return `${String(p.name)}${p.decision === 'allow' ? '' : ` (${String(p.decision)})`}`
    case 'tool.completed':
      return p.error ? `échec — ${String(p.error)}` : ((p.summary as string | null) ?? String(p.status))
    case 'usage.updated': {
      const u = p.usage as { cost_usd?: number; cost_source?: string; model_calls?: number } | undefined
      if (!u) return null
      const cost = u.cost_source === 'unknown' ? 'coût inconnu' : `$${(u.cost_usd ?? 0).toFixed(4)}`
      return `${u.model_calls} appel(s) · ${cost}`
    }
    case 'workspace.created':
    case 'workspace.kept':
    case 'workspace.removed':
      return String(p.branch ?? '')
    case 'agent.created':
      return `${String(p.name)} · ${String(p.agent_id)}`
    case 'browser.opened':
      return String(p.start_url ?? '')
    case 'message.user':
    case 'message.agent':
    case 'agent.message':
      return typeof p.message === 'string' ? p.message : typeof p.text === 'string' ? p.text : null
    case 'task.failed':
    case 'task.cancelled':
    case 'task.budget_exceeded':
    case 'task.timed_out':
      return (p.reason as string | undefined) ?? (p.error as string | undefined) ?? null
    default:
      return typeof p.message === 'string' ? p.message : null
  }
}

/**
 * Fond les événements d'un ensemble de tâches en un flux de lignes, dans l'ordre
 * **global** du journal (`seq`), jamais réutilisé. Une sortie `exec` devient une
 * ligne « brute » (rendue en pré-formaté) ; tout le reste, une ligne mot + détail.
 */
export function buildStream(sources: StreamSource[], events: Record<string, TaskEvent[] | undefined>): StreamLine[] {
  const lines: StreamLine[] = []
  for (const source of sources) {
    const isRoot = sources.length === 1 || source === sources[0]
    const tag = isRoot ? '' : plain(source.label).slice(0, 24)
    for (const e of events[source.taskId] ?? []) {
      const look = LOOK[e.type] ?? { label: e.type, tone: 'muted' as StreamTone }
      if (e.type === 'exec.output') {
        const body = plain(String((e.payload as Record<string, unknown>).text ?? ''))
        if (!body) continue
        const stderr = (e.payload as Record<string, unknown>).stream === 'stderr'
        lines.push({ key: `${e.seq}`, seq: e.seq, at: e.at, taskId: source.taskId, tag, label: '', text: body, tone: stderr ? 'danger' : 'muted', raw: true })
        continue
      }
      const d = detail(e)
      lines.push({
        key: `${e.seq}`,
        seq: e.seq,
        at: e.at,
        taskId: source.taskId,
        tag,
        label: look.label,
        text: d ? plain(d) : '',
        tone: look.tone,
        raw: false,
      })
    }
  }
  return lines.sort((a, b) => a.seq - b.seq)
}
