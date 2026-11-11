/**
 * @file Budgets et limites : s'arrêter **avant** l'appel qui dépasse.
 *
 * Le plan (§4) est précis sur l'ordre : « vérifier budget, étapes, délai,
 * annulation. Tout dépassement = arrêt propre avec statut explicite, **avant**
 * l'appel modèle. » L'ordre compte : une limite constatée après l'appel a déjà
 * été payée, et un budget qui se contente de constater n'est pas un budget.
 *
 * Et le statut compte autant que l'arrêt. `budget_exceeded` n'est pas `failed` :
 * rien n'a échoué, une limite a été atteinte. Les confondre enverrait
 * l'utilisateur chercher un bogue là où il n'y a qu'un plafond à relever.
 */
import type { AgentLimits, Usage } from '@midgaard/contracts'

/** Pourquoi la boucle s'arrête, et sous quel statut. */
export type StopReason =
  | { kind: 'budget'; detail: string }
  | { kind: 'steps'; detail: string }
  | { kind: 'timeout'; detail: string }
  | { kind: 'cancelled'; detail: string }

/** Ce que la boucle sait d'elle-même au moment de décider si elle continue. */
export interface BudgetState {
  usage: Usage
  step: number
  limits: AgentLimits
  /** Date limite absolue, en millisecondes epoch. */
  deadline: number
  /** Vrai si une annulation a été demandée. */
  cancelled: boolean
  now?: number
  /**
   * Le budget de l'arbre de la tâche (Slice 8) : le plafond de l'orchestrateur,
   * et ce qu'ont dépensé les **autres** tâches de l'arbre. Absent hors arbre.
   */
  tree?: { limit: number; others: number } | null | undefined
}

/**
 * Décide si l'itération suivante peut partir.
 *
 * @returns `null` pour continuer, sinon la raison de l'arrêt
 *
 * @example
 * const stop = checkLimits({ usage, step, limits, deadline, cancelled })
 * if (stop) return finish(stop)
 */
export function checkLimits(state: BudgetState): StopReason | null {
  const now = state.now ?? Date.now()

  // L'annulation passe en premier : inutile de signaler un budget dépassé à
  // quelqu'un qui vient de dire qu'il ne veut plus du résultat.
  if (state.cancelled) {
    return { kind: 'cancelled', detail: 'annulation demandée' }
  }

  if (now >= state.deadline) {
    return {
      kind: 'timeout',
      detail: `délai de ${state.limits.timeout_s} s écoulé`,
    }
  }

  if (state.step >= state.limits.max_steps) {
    return {
      kind: 'steps',
      // Les deux sorties sont atteignables depuis une délégation : `max_steps`
      // peut remonter jusqu'au plafond du profil, et l'objectif se réécrit.
      detail:
        `limite de ${state.limits.max_steps} étapes atteinte sans résultat soumis ; ` +
        `relève max_steps jusqu'au plafond du profil, ou simplifie l'objectif`,
    }
  }

  // Le budget ne s'applique que si on sait ce que ça coûte. Un modèle sans tarif
  // connu ne peut pas être facturé, donc pas plafonné en dollars : c'est le
  // nombre d'étapes qui le borne, et la boucle le dit à l'utilisateur plutôt que
  // de laisser croire à une protection qui n'opère pas.
  if (state.usage.cost_source !== 'unknown' && state.usage.cost_usd >= state.limits.max_cost_usd) {
    // Le détail ne répète pas le montant dépensé : l'appelant l'ajoute pour
    // les quatre raisons d'arrêt, et le dire deux fois rend le message illisible.
    return { kind: 'budget', detail: `budget de ${formatUsd(state.limits.max_cost_usd)} atteint` }
  }
  // Le budget de l'arbre : ce que cette tâche a dépensé plus ce qu'ont dépensé
  // les autres. Même statut d'arrêt — un plafond est atteint, rien n'a échoué —
  // et le motif dit que c'est l'arbre, pas la tâche, qui l'a atteint. Le coût
  // propre encore inconnu (avant le premier appel) compte pour zéro, mais **ne
  // dispense pas** du contrôle : une sous-tâche qui démarre dans un arbre déjà
  // à court ne doit pas faire un seul appel payant.
  const own = state.usage.cost_source !== 'unknown' ? state.usage.cost_usd : 0
  if (state.tree && own + state.tree.others >= state.tree.limit) {
    return { kind: 'budget', detail: `budget de l'arbre de tâches, ${formatUsd(state.tree.limit)}, atteint` }
  }

  return null
}

/**
 * Indique si le budget est applicable.
 *
 * Sert à prévenir **une seule fois** au début d'une tâche, plutôt qu'à chaque
 * itération : un avertissement répété devient du bruit, et le bruit se filtre.
 */
export function budgetIsEnforceable(usage: Usage): boolean {
  return usage.cost_source !== 'unknown'
}

/**
 * Montant lisible. Quatre décimales : les appels d'agent coûtent couramment des
 * fractions de centime, et « 0,00 $ » pour trois centièmes de centime ferait
 * croire que le comptage ne marche pas.
 */
export function formatUsd(amount: number): string {
  if (amount === 0) return '0 $'
  if (amount >= 0.01) return `${amount.toFixed(2)} $`
  if (amount >= 0.0001) return `${amount.toFixed(4)} $`
  // En dessous, quatre décimales afficheraient « 0,0000 $ » pour un montant non
  // nul — un budget de 0,000001 $ se lisait « budget de 0,0000 $ atteint », ce
  // qui ressemble à un bogue. On montre assez de décimales pour rester vrai.
  return `${amount.toFixed(8).replace(/0+$/, '')} $`
}
