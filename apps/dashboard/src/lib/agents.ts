/**
 * @file Ce que le dashboard dit d'un profil d'agent : peut-il recevoir une
 * tâche, et sinon pourquoi.
 *
 * Fonction pure, éprouvée par `tests/unit/dashboard-tree.test.ts`. Depuis la
 * Slice 7, le daemon rend le motif (`disabled_reason`) : un Navigator peut être
 * refusé pour un modèle qui ne lit pas les images, ce que le dashboard ne sait
 * pas constater. Sans ce champ — un daemon plus ancien —, le motif se déduit
 * des profils et des fournisseurs, comme avant.
 */
import type { Agent, ProviderConfig } from '@midgaard/contracts'

/**
 * Pourquoi un profil ne peut pas recevoir de tâche ; `null` s'il le peut.
 *
 * Un profil désactivé est **montré avec son motif**, jamais caché : c'est la
 * leçon de la Slice 0, ne rien présenter comme disponible qui ne l'est pas.
 */
export function disabledReason(agent: Agent, providers: readonly ProviderConfig[]): string | null {
  if (agent.enabled) return null
  if (agent.disabled_reason) return agent.disabled_reason
  if (agent.provider_id === null) return 'aucun fournisseur de modèle configuré'
  if (!providers.some((p) => p.id === agent.provider_id)) return `le fournisseur « ${agent.provider_id} » n'existe plus`
  return 'profil désactivé'
}
