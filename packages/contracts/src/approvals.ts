/**
 * @file Demandes d'approbation humaine.
 *
 * Une approbation est liée à **une opération précise** et à **une seule
 * utilisation** : jamais « autoriser toutes les commandes `npm` » (§5 du plan).
 * Elle expire au bout de `approvalTtlMs`, sinon une tâche oubliée resterait en
 * pause indéfiniment en retenant un worktree et un emplacement d'exécution.
 *
 * Depuis la Slice 3, une demande porte deux formes de la même opération :
 *
 *  - `operation`, le texte que l'humain lit — exact, sans abréviation : le
 *    binaire **résolu**, chaque argument, le dossier absolu ;
 *  - `operation_detail`, la forme **structurée**, d'où l'empreinte est tirée.
 *
 * L'empreinte ne porte plus sur le texte, mais sur le détail mis en forme
 * canonique (clés triées) : deux opérations qui s'affichent pareil mais
 * diffèrent — `["a;b"]` contre `["a", ";", "b"]` — n'ont pas la même empreinte,
 * et deux écritures du même objet dans un ordre de clés différent ont la même.
 */
import { createHash } from 'node:crypto'
import { z } from 'zod'

/** Cycle de vie d'une demande : `pending` puis exactement un état final. */
export const APPROVAL_STATUSES = ['pending', 'approved', 'rejected', 'expired'] as const
export type ApprovalStatus = (typeof APPROVAL_STATUSES)[number]

export const approvalSchema = z.object({
  id: z.uuid(),
  task_id: z.uuid(),
  /** Numéro de la pause sur cette tâche : correspond à `task.approval_seq`. */
  seq: z.number().int().positive(),
  /** Description lisible par un humain de ce qu'il autorise. */
  operation: z.string(),
  /**
   * L'opération exacte, sous forme structurée — pour `exec` : programme
   * résolu, arguments, dossier absolu, empreinte du binaire. `null` pour les
   * demandes antérieures à la Slice 3, qui n'avaient que le texte.
   */
  operation_detail: z.record(z.string(), z.unknown()).nullable(),
  /**
   * Empreinte de l'opération exacte. Une décision ne vaut que pour elle :
   * si l'opération change, l'empreinte change et l'approbation ne s'applique plus.
   */
  operation_hash: z.string(),
  status: z.enum(APPROVAL_STATUSES),
  requested_at: z.iso.datetime(),
  expires_at: z.iso.datetime(),
  resolved_at: z.iso.datetime().nullable(),
  /** Qui a décidé : `cli` ou `dashboard`. Jamais le modèle. */
  resolved_by: z.string().nullable(),
  /** Motif facultatif d'un refus, transmis à la tâche. */
  reason: z.string().nullable(),
})
export type Approval = z.infer<typeof approvalSchema>

/**
 * Sérialise une valeur JSON avec des clés **triées** à tous les niveaux.
 *
 * `JSON.stringify` garde l'ordre d'insertion : deux objets égaux construits
 * différemment donneraient deux empreintes, et une vérification échouerait sur
 * une opération pourtant identique.
 */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`
  }
  return JSON.stringify(value ?? null)
}

/**
 * Empreinte d'une opération soumise à approbation : SHA-256 de la tâche, du
 * numéro de pause et du détail canonique.
 *
 * La tâche et le numéro y sont pour qu'une décision ne vaille que pour **cette**
 * pause : la même commande demandée deux fois donne deux empreintes.
 */
export function operationHash(taskId: string, seq: number, detail: Record<string, unknown>): string {
  return createHash('sha256').update(canonicalJson({ task_id: taskId, seq, operation: detail })).digest('hex')
}
