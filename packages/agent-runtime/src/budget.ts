/**
 * @file Mise en forme d'un montant en dollars.
 *
 * Ce module portait les limites d'une tâche (étapes, budget, délai) ; elles
 * ont été retirées (décision de l'auteur, 2026-11-11) : une tâche ne s'arrête
 * plus que sur son résultat, une annulation ou un refus du fournisseur. Il
 * reste ce qui sert à **dire** un coût, qui est toujours mesuré.
 */

/**
 * Un montant lisible, sans faux zéro.
 *
 * @param amount montant en dollars
 * @returns par exemple `0.42 $`, `0.0031 $`, `0.000001 $`
 */
export function formatUsd(amount: number): string {
  if (amount === 0) return '0 $'
  if (amount >= 0.01) return `${amount.toFixed(2)} $`
  if (amount >= 0.0001) return `${amount.toFixed(4)} $`
  // En dessous, quatre décimales afficheraient « 0,0000 $ » pour un montant non
  // nul, ce qui ressemble à un bogue. On montre assez de décimales pour rester vrai.
  return `${amount.toFixed(8).replace(/0+$/, '')} $`
}
