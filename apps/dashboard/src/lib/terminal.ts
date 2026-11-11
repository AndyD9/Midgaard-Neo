/**
 * @file Le terminal du dashboard (Slice 6) : les commandes `exec` d'un arbre
 * de tâches et leur sortie, composées depuis le journal. Fonctions pures.
 *
 * Le terminal est **en lecture seule** : il ne lance rien et n'a pas de
 * clavier. Il montre, dans l'ordre du journal, pour chaque commande : la ligne
 * de commande et qui la lance, la sortie au fil de l'eau (`exec.output`), puis
 * sa fin — code de sortie, refus, ou attente d'approbation.
 *
 * **La sortie est une donnée hostile possible.** Elle vient d'une commande
 * lancée dans un worktree que l'agent a écrit, et l'humain la lit pour décider
 * d'une approbation. Une séquence d'échappement peut effacer l'écran, déplacer
 * le curseur et réécrire une ligne déjà affichée : le terminal montrerait autre
 * chose que ce qui s'est passé. {@link sanitizeOutput} ne laisse donc passer
 * que les couleurs (`ESC [ … m`) et les retours à la ligne et tabulations.
 */
import type { TaskEvent } from '@midgaard/contracts'

/** Un morceau à écrire dans le terminal, avec une clé stable pour n'écrire que le nouveau. */
export interface TerminalChunk {
  key: string
  seq: number
  text: string
}

/** Une tâche dont le terminal montre les commandes, et son libellé. */
export interface TerminalSource {
  taskId: string
  label: string
}

const RESET = '\x1b[0m'
const DIM = '\x1b[2m'
const CYAN = '\x1b[36m'
const RED = '\x1b[31m'
const YELLOW = '\x1b[33m'
const GREEN = '\x1b[32m'

/**
 * Ne garde d'une sortie que le texte, les couleurs, `\n`, `\r` et `\t`.
 *
 * Retirés : toute séquence CSI autre que la couleur (effacement, curseur,
 * défilement), les séquences OSC (titre, presse-papiers, liens), les autres
 * séquences `ESC x`, et les caractères de contrôle restants (dont la cloche).
 */
export function sanitizeOutput(raw: string): string {
  return (
    raw
      // OSC : ESC ] … terminé par BEL ou ESC \.
      .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?/g, '')
      // CSI : on garde la couleur (SGR, finale `m`), on retire le reste.
      .replace(/\x1b\[[0-?]*[ -/]*([@-~])/g, (seq: string, final: string) => (final === 'm' ? seq : ''))
      // Toute autre séquence ESC : ESC suivi d'un caractère quelconque —
      // `ESC c` réinitialise le terminal entier, `ESC 7` sauve le curseur pour
      // réécrire plus tard —, et un ESC isolé. Seule l'ouverture d'une couleur,
      // `ESC [`, laissée par la règle précédente, reste.
      .replace(/\x1b(?!\[)[\x20-\x7e]?/g, '')
      // Contrôles C0 restants, sauf \t \n \r, et DEL.
      .replace(/[\x00-\x08\x0b\x0c\x0e-\x1a\x1c-\x1f\x7f]/g, '')
  )
}

/** Ligne de commande lisible depuis les arguments journalisés d'un `exec`. */
function commandLine(argumentsJson: unknown): string {
  try {
    const args = JSON.parse(String(argumentsJson)) as { command?: string; args?: string[]; cwd?: string }
    const argv = [args.command ?? '?', ...(args.args ?? [])].map((a) => (/[\s"'$`\\]/.test(a) ? JSON.stringify(a) : a))
    return argv.join(' ') + (args.cwd && args.cwd !== '.' ? `   ${DIM}(dans ${args.cwd})${RESET}` : '')
  } catch {
    // Arguments tronqués au journal (4000 caractères) : on montre ce qu'on a.
    return String(argumentsJson).slice(0, 200)
  }
}

/**
 * Compose le terminal d'un ensemble de tâches : leurs commandes, dans l'ordre
 * global du journal.
 */
export function buildTerminal(sources: TerminalSource[], events: Record<string, TaskEvent[] | undefined>): TerminalChunk[] {
  const chunks: TerminalChunk[] = []
  for (const source of sources) {
    const execCalls = new Set<string>()
    for (const e of events[source.taskId] ?? []) {
      const id = String(e.payload.tool_call_id ?? '')
      if (e.type === 'tool.requested' && e.payload.name === 'exec') {
        execCalls.add(id)
        // L'issue de l'approbation se lit à la ligne de fin : code de sortie, ou refus.
        const pending = e.payload.decision === 'approval' ? `  ${YELLOW}(sous approbation)${RESET}` : ''
        chunks.push({
          key: `${e.seq}`,
          seq: e.seq,
          text: `${CYAN}${sanitizeOutput(source.label)}${RESET} ${GREEN}$${RESET} ${sanitizeOutput(commandLine(e.payload.arguments))}${pending}\n`,
        })
      } else if (e.type === 'exec.output' && execCalls.has(id)) {
        const body = sanitizeOutput(String(e.payload.text ?? ''))
        chunks.push({ key: `${e.seq}`, seq: e.seq, text: e.payload.stream === 'stderr' ? `${RED}${body}${RESET}` : body })
      } else if (e.type === 'tool.completed' && execCalls.has(id)) {
        const status = String(e.payload.status ?? '')
        const line =
          status === 'succeeded'
            ? `${DIM}── ${sanitizeOutput(String(e.payload.summary ?? 'terminée'))}${RESET}`
            : status === 'rejected'
              ? `${YELLOW}── refusée par un humain${RESET}`
              : `${RED}── ${sanitizeOutput(String(e.payload.error ?? status))}${RESET}`
        chunks.push({ key: `${e.seq}`, seq: e.seq, text: `${line}\n\n` })
      }
    }
  }
  return chunks.sort((a, b) => a.seq - b.seq)
}
