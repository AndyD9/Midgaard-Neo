/**
 * @file Assemblage du contexte initial d'un agent.
 *
 * Le plan (§4) fixe la règle et sa raison : « c'est Claude Code qui fournit
 * `context`. Le runtime y ajoute seulement l'arborescence du workspace et les
 * consignes du profil. **L'agent ne refait pas l'exploration du dépôt — sinon le
 * coût explose et la délégation ne sert à rien.** »
 *
 * C'est le cœur économique du produit. Un agent qui commence par lire trente
 * fichiers pour comprendre où il est dépense plus que la question ne valait, et
 * déléguer devient plus cher que faire soi-même. L'orchestrateur a déjà
 * exploré ; ce qu'il sait est transmis.
 *
 * **Ce que lit le modèle ne nomme pas l'orchestrateur.** Ce fut Claude Code
 * seul ; depuis la Slice 5, ce peut être un orchestrateur intégré au daemon,
 * sur n'importe quel modèle. Une consigne qui nommerait le mauvais attirerait
 * l'agent vers des conventions qui ne sont pas celles de qui l'a délégué.
 *
 * L'arborescence est la seule exception, et elle est bornée : sans elle, l'agent
 * ne sait pas quels chemins existent et gaspille des appels à tâtonner.
 */
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { Agent, TaskMode } from '@midgaard/contracts'
import type { Message } from '@midgaard/providers'

/** Dossiers écartés de l'arborescence : beaucoup d'entrées, aucune information. */
const SKIP = new Set(['node_modules', '.git', 'dist', '.next', 'build', '.venv', '__pycache__', 'coverage'])
/** Profondeur de l'arborescence. Deux niveaux situent un projet sans le décrire. */
const TREE_DEPTH = 2
/** Entrées au maximum. Au-delà, l'arborescence coûte plus qu'elle n'oriente. */
const MAX_TREE_ENTRIES = 200

/**
 * Dresse une arborescence courte du projet.
 *
 * @returns les lignes de l'arborescence, ou un message si le dossier est illisible
 */
export async function workspaceTree(root: string): Promise<string> {
  const lines: string[] = []
  let truncated = false

  const walk = async (dir: string, prefix: string, depth: number): Promise<void> => {
    if (depth > TREE_DEPTH || truncated) return
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (SKIP.has(entry.name) || entry.name.startsWith('.')) continue
      if (lines.length >= MAX_TREE_ENTRIES) {
        truncated = true
        return
      }
      if (entry.isDirectory()) {
        lines.push(`${prefix}${entry.name}/`)
        await walk(join(dir, entry.name), `${prefix}  `, depth + 1)
      } else if (entry.isFile()) {
        lines.push(`${prefix}${entry.name}`)
      }
    }
  }

  await walk(root, '', 1)
  if (lines.length === 0) return '(project root is empty or unreadable)'
  return lines.join('\n') + (truncated ? `\n[…truncated at ${MAX_TREE_ENTRIES} entries]` : '')
}

/**
 * Ce qu'un agent écrivant doit savoir de son worktree, et qu'il ne peut pas
 * deviner : où il est, d'où il part, et ce qui **manque**.
 */
export interface WorkspaceBrief {
  branch: string
  baseCommit: string
  /** Chemins non commités du dépôt d'origine — absents du worktree. */
  baseDirty: number
  /** Sous-modules vides dans le worktree, relatifs à la racine de l'agent. */
  submodules: readonly string[]
  /** Dossier d'origine, tel que l'orchestrateur le cite dans son contexte. */
  originDir: string
}

/** Ce qu'il faut pour composer le premier tour de conversation. */
export interface ContextInput {
  agent: Agent
  objective: string
  /** Contexte fourni par l'orchestrateur à la délégation. */
  context: string | null
  root: string
  tree: string
  /** Le worktree, pour un agent écrivant ; absent pour un agent qui ne fait que lire. */
  workspace?: WorkspaceBrief | undefined
  /** Manière dont la tâche converse ; `oneshot` par défaut. */
  mode?: TaskMode | undefined
  /** Vrai si la tâche a été déléguée par une autre, à qui elle peut poser une question. */
  delegated?: boolean | undefined
}

/**
 * Ce que la consigne ajoute à une sous-tâche (Slice 6) : elle peut demander,
 * mais ça se paie des deux côtés — sinon le modèle demanderait ce qu'il
 * trouverait seul en lisant le projet.
 */
const DELEGATED_LINES = [
  'You were delegated by an orchestrator task, which you can ask:',
  '- If you are blocked by something the task and context do not settle (an ambiguous requirement, a choice ' +
    'between two designs), call ask_parent with one precise question. Its answer comes back as that call\'s ' +
    'result. It costs a step on both sides: never ask what you can find in the project yourself.',
]

/**
 * Ce que la consigne ajoute en mode `review` : `submit_result` est une
 * proposition, et le retour arrive en réponse à l'appel. Sans cette phrase, un
 * modèle renvoyé à sa copie croirait à une erreur de l'outil.
 */
const REVIEW_LINES = [
  '- Your submit_result is a PROPOSAL, reviewed by that orchestrator. It either accepts it (the harness then ' +
    'commits your work and the task ends) or sends it back with feedback, which you receive as the response ' +
    'to your submit_result call. Then fix what it asks in your workspace and call submit_result again with ' +
    'the complete, updated result.',
]

/**
 * Ce que la consigne ajoute pour une conversation (Slice 6), après celle du
 * profil. La consigne du profil est écrite pour une tâche en un coup (« finish
 * by calling submit_result exactly once ») ; ce bloc dit ce qui change, et le
 * redit au modèle plutôt que de le lui faire découvrir en attendant :
 *  - un texte sans outil **est** une réplique à l'utilisateur, qui répondra ;
 *  - `submit_result` reste la seule fin, quand l'utilisateur le demande ou que
 *    le travail est fait ;
 *  - chaque réplique est un appel de modèle payé : les garder courtes.
 */
const CHAT_LINES = [
  'This task is a CONVERSATION with the human user, who reads everything you write.',
  '- When you need the user\'s input, or have something to report before going on, reply in plain text without ' +
    'calling a tool. The harness then waits for the user\'s next message and gives it to you.',
  '- The first user message below is the user\'s opening request; later ones are their replies.',
  '- Call submit_result only when the user asks you to conclude or the work is done. Its summary and details ' +
    'cover the whole conversation. Writing "I am done" does not end the conversation.',
  '- Every reply is a paid model call. Keep replies short.',
]

/**
 * Compose les deux premiers messages : la consigne système, et la demande.
 *
 * **Le harness ne borne plus la tâche, et la consigne le dit** : ni étapes, ni
 * budget, ni délai ne l'arrêteront. Annoncer un plafond qui n'existe pas
 * serait décrire au modèle ce qui n'est pas ; ne rien dire le laisserait
 * explorer sans fin, aux frais de l'utilisateur. On lui dit donc ce qui est :
 * chaque appel est payé, et rien d'autre que `submit_result` ne conclut.
 */
export function buildMessages(input: ContextInput): Message[] {

  const system = [
    input.agent.system_prompt,
    '',
    'Cost: the harness sets no step limit, budget or deadline on this task. Every reply you make is a model ' +
      'call the user pays for, and only submit_result ends the task. Do what the objective needs, no more, ' +
      'and call submit_result as soon as you have the answer.',
    '',
    ...(input.workspace ? workspaceLines(input.root, input.workspace, input.mode === 'review') : [
      `Project root (the only directory you can read): ${input.root}`,
      'Paths you pass to tools may be relative to that root. Anything outside it is refused.',
    ]),
    ...(input.mode === 'chat' ? ['', ...CHAT_LINES] : []),
    ...(input.delegated ? ['', ...DELEGATED_LINES, ...(input.mode === 'review' ? REVIEW_LINES : [])] : []),
  ].join('\n')

  const parts = [input.mode === 'chat' ? `# User's opening message\n\n${input.objective}` : `# Task\n\n${input.objective}`]
  if (input.context?.trim()) {
    parts.push(
      '# Context from the orchestrator\n\n' +
        'This was assembled by the orchestrator that delegated this task, from what it already explored. ' +
        'Trust it and build on it; do not re-derive it.\n\n' +
        input.context.trim(),
    )
  }
  parts.push(`# Project tree (depth ${TREE_DEPTH})\n\n\`\`\`\n${input.tree}\n\`\`\``)
  parts.push(
    input.mode === 'chat'
      ? 'Begin. Reply to the user in plain text when you need them; call submit_result when the conversation is done.'
      : 'Begin. When you have the answer, call submit_result.',
  )

  return [
    { role: 'system', content: system },
    { role: 'user', content: parts.join('\n\n') },
  ]
}

/**
 * Ce que la consigne dit du worktree. Trois pièges y sont nommés, parce que
 * chacun coûte des étapes s'il est découvert en tâtonnant :
 *
 *  - l'orchestrateur cite les chemins **du dépôt d'origine** ; l'agent doit les lire
 *    comme relatifs, sans quoi chaque appel est refusé « hors du workspace » ;
 *  - le travail non commité de l'utilisateur **n'est pas là** ;
 *  - les sous-modules sont des **dossiers vides**, où rien ne s'écrit ;
 *  - rien de ce que fait l'agent n'atteint le dépôt sans un merge humain — ce
 *    qui l'autorise à travailler franchement, et lui interdit de prétendre
 *    avoir livré.
 */
function workspaceLines(root: string, w: WorkspaceBrief, review = false): string[] {
  const lines = [
    `Workspace root (a git worktree of the project; the only directory you can read and write): ${root}`,
    `It is on branch ${w.branch}, created for this task from commit ${w.baseCommit.slice(0, 12)}.`,
    'Paths you pass to tools should be relative to that root. Anything outside it is refused.',
    `The orchestrator's context may cite absolute paths in the original repository (${w.originDir}): ` +
      'the same files are at the same relative paths in your workspace. Use relative paths.',
    'Nothing you do reaches the user\'s repository until a human reviews the diff and merges the branch. ' +
      (review
        ? 'The harness commits your work when the orchestrator accepts your submit_result; do not try to ' +
          'commit yourself.'
        : 'The harness commits your work when you call submit_result; do not try to commit yourself.'),
  ]
  if (w.baseDirty > 0) {
    lines.push(
      `WARNING: the user had ${w.baseDirty} uncommitted change(s) in the original repository. They are NOT ` +
        'in your workspace, which starts from the last commit. If the context describes code you cannot find, ' +
        'this is why: say so in your result rather than guessing.',
    )
  }
  if (w.submodules.length > 0) {
    lines.push(
      `WARNING: these git submodules are EMPTY directories in your workspace: ${w.submodules.join(', ')}. ` +
        'Their code is not available to read, and you cannot write inside them. If the task depends on them, ' +
        'say so in your result rather than guessing.',
    )
  }
  return lines
}
