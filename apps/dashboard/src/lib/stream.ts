/**
 * @file Le flux terminal d'un arbre de tâches : tous les événements de la
 * racine et de ses sous-tâches, fondus en un seul flux chronologique de
 * **lignes façon terminal**. Fonctions pures, sans React, testées dans
 * `tests/unit/dashboard-workbench.test.ts`.
 *
 * C'est l'interface du dashboard : une ligne par événement, l'identité de la
 * sous-tâche en tête, la commande d'un `exec` et sa sortie au fil de l'eau, ce
 * que l'utilisateur et l'orchestrateur se disent, l'image qu'un agent a lue.
 * Elle **lit** le même journal que la timeline des détails ; elle n'écrit rien.
 *
 * **Tout texte affiché est une donnée possiblement hostile** : messages d'agents,
 * sorties de commandes, résumés d'outils. Cette vue ne rend que du texte, en
 * HTML, pas dans un vrai terminal. Une
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
  /**
   * Pour une image lue par `read_image` : son chemin dans la tâche et le début
   * de son SHA-256 au moment de la lecture. La vue la relit sur le disque et ne
   * la montre que si l'empreinte est encore celle-là.
   */
  image?: { path: string; sha256Prefix: string } | undefined
}

/** Une tâche dont le flux montre les événements, et son libellé. */
export interface StreamSource {
  taskId: string
  label: string
  /**
   * Objectif de la tâche, montré à la ligne de sa création : l'événement
   * `task.created` ne le porte pas, et c'est par lui qu'un flux commence —
   * ce que l'utilisateur a demandé, ou ce que l'orchestrateur a délégué.
   */
  objective?: string | undefined
}

/** Le résumé que `read_image` journalise : « chemin · type · n octets · sha256 <16 hex> ». */
const READ_IMAGE_SUMMARY = /^(.+) · image\/[a-z]+ · \d+ octets · sha256 ([0-9a-f]{16})$/

/**
 * Ligne de commande lisible depuis les arguments journalisés d'un `exec`. Un
 * argument qui porte un espace ou un caractère de shell est cité : `a;b` et
 * `a ; b` ne doivent pas se lire pareil.
 */
function commandLine(argumentsJson: unknown): string {
  try {
    const args = JSON.parse(String(argumentsJson)) as { command?: string; args?: string[]; cwd?: string }
    const argv = [args.command ?? '?', ...(args.args ?? [])].map((a) => (/[\s"'$`\\;|&]/.test(a) ? JSON.stringify(a) : a))
    return argv.join(' ') + (args.cwd && args.cwd !== '.' ? `   (dans ${args.cwd})` : '')
  } catch {
    // Arguments tronqués au journal (4000 caractères) : on montre ce qu'on a.
    return String(argumentsJson).slice(0, 200)
  }
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
  'task.created': { label: 'tâche', tone: 'accent' },
  'task.started': { label: 'départ', tone: 'running' },
  'task.progress': { label: 'étape', tone: 'running' },
  'task.completed': { label: 'terminée', tone: 'done' },
  'task.failed': { label: 'échec', tone: 'danger' },
  'task.cancelled': { label: 'annulée', tone: 'danger' },
  'task.interrupted': { label: 'interrompue', tone: 'danger' },
  'task.budget_exceeded': { label: 'budget', tone: 'waiting' },
  'task.timed_out': { label: 'délai', tone: 'waiting' },
  'agent.message': { label: 'message', tone: 'done' },
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
      return Number(p.steps_total) > 0 ? `${p.step}/${p.steps_total}` : String(p.step)
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
      // Une commande se lit en entier, là où elle part : c'est elle que
      // l'humain approuve, et sa sortie suit.
      if (p.name === 'exec') return `$ ${commandLine(p.arguments)}${p.decision === 'approval' ? '   (sous approbation)' : ''}`
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
    case 'task.completed': {
      const result = p.result as { summary?: string; workspace?: { branch?: string } | null } | undefined
      if (!result?.summary) return null
      return result.workspace?.branch ? `${result.summary} — branche ${result.workspace.branch}` : result.summary
    }
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
    /** Appels `read_image` de cette tâche : leur fin porte l'image à montrer. */
    const imageCalls = new Set<string>()
    for (const e of events[source.taskId] ?? []) {
      const look = LOOK[e.type] ?? { label: e.type, tone: 'muted' as StreamTone }
      const payload = e.payload as Record<string, unknown>
      if (e.type === 'tool.requested' && payload.name === 'read_image') imageCalls.add(String(payload.tool_call_id))
      if (e.type === 'tool.completed' && payload.status === 'succeeded' && imageCalls.has(String(payload.tool_call_id))) {
        // Seule une lecture réussie montre une image : un échec reste une ligne d'outil.
        const match = READ_IMAGE_SUMMARY.exec(String(payload.summary ?? ''))
        if (match) {
          lines.push({
            key: `${e.seq}`, seq: e.seq, at: e.at, taskId: source.taskId, tag, label: 'image', text: plain(match[1]!),
            tone: 'running', raw: false, image: { path: match[1]!, sha256Prefix: match[2]! },
          })
          continue
        }
      }
      if (e.type === 'exec.output') {
        const body = plain(String((e.payload as Record<string, unknown>).text ?? ''))
        if (!body) continue
        const stderr = (e.payload as Record<string, unknown>).stream === 'stderr'
        lines.push({ key: `${e.seq}`, seq: e.seq, at: e.at, taskId: source.taskId, tag, label: '', text: body, tone: stderr ? 'danger' : 'muted', raw: true })
        continue
      }
      const d = e.type === 'task.created' ? (source.objective ?? null) : detail(e)
      // Une note du harness (relance, avertissement) n'est pas une parole de
      // l'agent : elle garde sa ligne, sous un autre mot.
      const label = e.type === 'agent.message' && payload.note === true ? 'note' : look.label
      lines.push({
        key: `${e.seq}`,
        seq: e.seq,
        at: e.at,
        taskId: source.taskId,
        tag,
        label,
        text: d ? plain(d) : '',
        tone: look.tone,
        raw: false,
      })
    }
  }
  return lines.sort((a, b) => a.seq - b.seq)
}
