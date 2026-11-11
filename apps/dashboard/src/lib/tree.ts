/**
 * @file Les tâches en arbre (Slice 5) : un orchestrateur et ses sous-tâches.
 *
 * Fonctions pures, sans rendu : elles sont éprouvées par
 * `tests/unit/dashboard-tree.test.ts`, et c'est là que vivent les deux règles
 * qui pourraient mentir à l'écran — l'ordre de la liste, et le total d'un arbre
 * avec sa provenance.
 */
import type { Task, TaskEvent, Usage } from '@midgaard/contracts'

/** Une ligne de la liste : la tâche, sa profondeur, et combien d'enfants elle a. */
export interface TreeRow {
  task: Task
  depth: 0 | 1
  children: number
}

/**
 * Range les tâches en arbre, pour la liste de gauche.
 *
 * Les tâches de premier niveau gardent l'ordre reçu (de la plus récente à la
 * plus ancienne) ; chaque sous-tâche suit son parent, **dans l'ordre où elle a
 * été déléguée** — c'est l'ordre du plan de l'orchestrateur, celui qu'on relit.
 *
 * Une sous-tâche dont le parent n'est pas dans la liste (liste tronquée par le
 * daemon, parent trop ancien) est montrée au premier niveau plutôt que perdue :
 * cacher une tâche active serait pire qu'un arbre incomplet.
 *
 * @param tasks tâches, de la plus récente à la plus ancienne
 */
export function taskTree(tasks: readonly Task[]): TreeRow[] {
  const ids = new Set(tasks.map((t) => t.id))
  const children = new Map<string, Task[]>()
  for (const task of tasks) {
    if (task.parent_task_id && ids.has(task.parent_task_id)) {
      const list = children.get(task.parent_task_id) ?? []
      list.push(task)
      children.set(task.parent_task_id, list)
    }
  }
  const rows: TreeRow[] = []
  for (const task of tasks) {
    if (task.parent_task_id && ids.has(task.parent_task_id)) continue
    const own = (children.get(task.id) ?? []).slice().sort((a, b) => a.created_at.localeCompare(b.created_at))
    rows.push({ task, depth: 0, children: own.length })
    for (const child of own) rows.push({ task: child, depth: 1, children: 0 })
  }
  return rows
}

/** Sous-tâches d'une tâche, dans l'ordre où elles ont été déléguées. */
export function subtasksOf(tasks: readonly Task[], parentId: string): Task[] {
  return tasks
    .filter((t) => t.parent_task_id === parentId)
    .sort((a, b) => a.created_at.localeCompare(b.created_at))
}

/** Provenances d'un montant, de la plus sûre à la moins sûre. */
const STRENGTH: Record<Usage['cost_source'], number> = { provider: 2, pricing_table: 1, unknown: 0 }

/**
 * Total d'un arbre : le parent et ses sous-tâches.
 *
 * **Le total porte la plus faible des provenances** (Slice 5) : facturé si tous
 * ses termes le sont, estimé dès qu'un seul l'est, inconnu dès qu'un seul l'est.
 * Additionner une facture et une ignorance donnerait sinon un chiffre qui a
 * l'air d'une facture.
 *
 * Une tâche qui n'a appelé **aucun modèle** ne compte pas : elle n'a rien
 * coûté, et sa provenance par défaut (`unknown`) rendrait inconnu le total
 * d'un arbre dont tous les montants sont connus.
 *
 * @returns `null` si aucune tâche de l'arbre n'a appelé de modèle
 */
export function treeTotal(tasks: readonly Task[]): { cost_usd: number; cost_source: Usage['cost_source']; counted: number } | null {
  const measured = tasks.filter((t) => t.usage.model_calls > 0)
  if (measured.length === 0) return null
  const source = measured
    .map((t) => t.usage.cost_source)
    .reduce((weakest, s) => (STRENGTH[s] < STRENGTH[weakest] ? s : weakest))
  return {
    cost_usd: measured.reduce((sum, t) => sum + t.usage.cost_usd, 0),
    cost_source: source,
    counted: measured.length,
  }
}

/**
 * Plafond théorique de sous-tâches d'un orchestrateur : il ne peut pas en
 * lancer plus d'une par appel d'outil, ni plus d'appels que ses étapes n'en
 * permettent. Depuis la Slice 8, ce n'est plus la seule borne : le budget de
 * l'orchestrateur couvre tout l'arbre ({@link treeBudget}), et le nombre de
 * sous-tâches actives en même temps est plafonné par le daemon.
 */
export function subtaskCeiling(task: Pick<Task, 'limits'>): number {
  return task.limits.max_steps * task.limits.max_tool_calls_per_step
}

/**
 * Le budget de l'arbre (Slice 8) : le `max_cost_usd` de l'orchestrateur couvre
 * ses appels et ceux de chaque sous-tâche. Seuls les montants **connus**
 * comptent, comme dans le daemon (`TaskManager.treeBudget`) : un coût inconnu
 * n'est pas zéro, il n'entre pas dans la somme — et le nombre de tâches
 * écartées le dit.
 *
 * @returns le plafond, ce qui est dépensé, et combien de tâches ont un coût inconnu
 */
export function treeBudget(
  parent: Task,
  children: readonly Task[],
): { limit: number; spent: number; unknown: number } {
  const measured = [parent, ...children].filter((t) => t.usage.model_calls > 0)
  return {
    limit: parent.limits.max_cost_usd,
    spent: measured.filter((t) => t.usage.cost_source !== 'unknown').reduce((sum, t) => sum + t.usage.cost_usd, 0),
    unknown: measured.filter((t) => t.usage.cost_source === 'unknown').length,
  }
}

/** Un agent créé par l'orchestrateur, tel que son journal le raconte. */
export interface CreatedAgentView {
  agent_id: string
  name: string
  base: string
  model: string | null
  mcp_servers: string[]
  /** Le rôle écrit par l'orchestrateur, **ajouté** à la consigne du profil. */
  role: string
}

/**
 * Les agents qu'un orchestrateur a créés, lus dans son journal
 * (`agent.created`, Slice 8). Le journal suffit : c'est lui que l'humain doit
 * pouvoir relire, et il porte le rôle tel qu'il a été enregistré.
 */
export function createdAgents(events: readonly TaskEvent[] | undefined): CreatedAgentView[] {
  return (events ?? [])
    .filter((e) => e.type === 'agent.created')
    .map((e) => ({
      agent_id: String(e.payload.agent_id),
      name: String(e.payload.name),
      base: String(e.payload.base_agent_id),
      model: typeof e.payload.model === 'string' ? e.payload.model : null,
      mcp_servers: Array.isArray(e.payload.mcp_servers) ? e.payload.mcp_servers.map(String) : [],
      role: String(e.payload.role ?? ''),
    }))
}

