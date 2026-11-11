/**
 * @file Petites fonctions partagées par les composants.
 */
import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'

/**
 * Combine des classes Tailwind en laissant la dernière gagner.
 *
 * `clsx` gère les conditions, `tailwind-merge` résout les conflits : sans lui,
 * `cn('p-2', 'p-4')` produirait les deux classes et le résultat dépendrait de
 * l'ordre dans la feuille de style.
 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs))
}

/** Horodatage court `14:32:07`, pour la timeline. */
export function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString(undefined, { hour12: false })
}

/** Horodatage complet, pour les infobulles. */
export function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString()
}

/** Durée lisible entre deux instants ISO ; `null` si la fin manque encore. */
export function duration(from: string, to: string | null): string | null {
  if (!to) return null
  const ms = new Date(to).getTime() - new Date(from).getTime()
  if (ms < 1000) return `${ms} ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`
  return `${Math.floor(ms / 60_000)} min ${Math.round((ms % 60_000) / 1000)} s`
}

/** Temps restant avant un instant ISO, en texte court. `null` si déjà passé. */
export function timeUntil(iso: string, now: number): string | null {
  const ms = new Date(iso).getTime() - now
  if (ms <= 0) return null
  if (ms < 60_000) return `${Math.ceil(ms / 1000)} s`
  return `${Math.ceil(ms / 60_000)} min`
}

/**
 * Retire les zéros inutiles d'un montant déjà formaté, **sans** descendre sous
 * deux décimales : un budget reste « 0,50 $ » et non « 0,5 $ », qui ne se lit
 * plus comme de l'argent.
 */
function trimDecimals(fixed: string): string {
  const trimmed = fixed.replace(/0+$/, '')
  const [whole, decimals = ''] = trimmed.split('.')
  return decimals.length >= 2 ? trimmed : `${whole}.${decimals.padEnd(2, '0')}`
}

/**
 * Montant en dollars, lisible — et **comparable**.
 *
 * Le nombre de décimales suit l'ordre de grandeur, parce qu'un montant arrondi
 * trop tôt cesse de dire ce qu'il vaut :
 *
 * - au-dessus du dollar, deux décimales : l'écart entre deux montants s'y voit ;
 * - en dessous, **quatre**, l'échelle d'une tâche d'agent ;
 * - en dessous du dixième de millième, jusqu'à huit, pour qu'un montant non nul
 *   ne s'affiche jamais « 0,0000 $ » — ce qui ressemblerait à un bogue.
 *
 * Les quatre décimales sous le dollar ne sont pas un confort. La facture et
 * notre estimation ne valent **que côte à côte** : leur écart est la seule façon
 * de voir vieillir `pricing.json`. Deux décimales affichaient « 0,01 $ » des
 * deux côtés pour 0,011632 $ facturés et 0,011763 $ estimés — les deux chiffres
 * dont tout l'intérêt est de différer devenaient identiques, pile dans la
 * tranche où vit une vraie tâche. C'est le défaut « budget de 0,0000 $ » à
 * l'autre bout de l'échelle : un arrondi qui efface ce qu'il doit montrer.
 */
export function formatCost(usd: number): string {
  if (usd === 0) return '0 $'
  if (usd >= 1) return `${usd.toFixed(2)} $`
  if (usd >= 0.0001) return `${trimDecimals(usd.toFixed(4))} $`
  return `${trimDecimals(usd.toFixed(8))} $`
}

/** Nombre de jetons, abrégé au-delà du millier : `12 400` devient `12,4 k`. */
export function formatTokens(count: number): string {
  if (count < 1000) return String(count)
  return `${(count / 1000).toFixed(1).replace('.', ',')} k`
}
