/**
 * @file Table de tarifs : chargement, surcharge utilisateur, et rafraîchissement
 * depuis l'API du fournisseur.
 *
 * Le plan (§4) pose deux règles, et la seconde est la plus utile :
 * **ne jamais coder les prix en dur**, et **afficher la date de dernière mise à
 * jour**. Un tarif périmé qu'on croit courant est pire qu'un tarif absent : il
 * produit un montant plausible, donc personne ne le vérifie.
 *
 * Trois sources, dans cet ordre de priorité :
 *
 *  1. `~/.midgaard/pricing.json` — la table de l'utilisateur, qu'il édite ou que
 *     `harness pricing refresh` reconstruit ;
 *  2. `packages/providers/pricing.json` — la copie livrée, versionnée avec le code ;
 *  3. **rien** — et alors le coût est `unknown`, pas zéro. Afficher zéro pour un
 *     modèle dont on ignore le tarif ferait croire à une tâche gratuite.
 *
 * Pour Venice, la troisième source n'est presque jamais nécessaire :
 * `GET /models` rend `model_spec.pricing.input.usd`, et
 * {@link fetchVenicePricing} en reconstruit la table entière. Un tarif relevé
 * chez le fournisseur ne peut pas avoir dérivé.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { HarnessConfig, ModelPrice, PricingTable } from '@midgaard/contracts'
import { pricingTableSchema, priceKey } from '@midgaard/contracts'
import { getJson } from './http.ts'

/** Emplacement de la table de l'utilisateur. */
export function userPricingPath(config: Pick<HarnessConfig, 'home'>): string {
  return join(config.home, 'pricing.json')
}

/**
 * Emplacement de la copie livrée.
 *
 * Le calcul vaut depuis `src/` comme depuis `dist/` : les deux sont à la même
 * profondeur sous `packages/providers/`.
 */
export function packagedPricingPath(): string {
  return fileURLToPath(new URL('../pricing.json', import.meta.url))
}

/** Table vide, employée quand aucun fichier n'est lisible. */
function emptyTable(reason: string): PricingTable {
  return { updated_at: new Date(0).toISOString(), source: reason, entries: {} }
}

/**
 * Charge la table en vigueur.
 *
 * Un fichier illisible ou invalide **ne fait pas échouer le daemon** : il est
 * signalé et ignoré. Perdre le comptage des coûts est ennuyeux ; refuser de
 * démarrer parce qu'un JSON est mal formé l'est davantage, et le harness dira
 * de toute façon `unknown` plutôt que d'inventer.
 *
 * @param log signalement des fichiers écartés
 */
export function loadPricing(config: Pick<HarnessConfig, 'home'>, log: (m: string) => void = () => {}): PricingTable {
  for (const path of [userPricingPath(config), packagedPricingPath()]) {
    if (!existsSync(path)) continue
    try {
      const parsed = pricingTableSchema.safeParse(JSON.parse(readFileSync(path, 'utf8')))
      if (parsed.success) return parsed.data
      log(`tarifs ignorés (${path}) : ${parsed.error.issues[0]?.message ?? 'format invalide'}`)
    } catch (e) {
      log(`tarifs illisibles (${path}) : ${(e as Error).message}`)
    }
  }
  return emptyTable('aucune table de tarifs lisible')
}

/** Écrit la table de l'utilisateur. @returns le chemin écrit */
export function savePricing(config: Pick<HarnessConfig, 'home'>, table: PricingTable): string {
  const path = userPricingPath(config)
  writeFileSync(path, `${JSON.stringify(table, null, 2)}\n`, 'utf8')
  return path
}

/** Cherche le tarif d'un modèle. @returns `undefined` si inconnu — jamais un tarif par défaut */
export function priceFor(table: PricingTable, preset: string, model: string): ModelPrice | undefined {
  return table.entries[priceKey(preset, model)]
}

// --- Rafraîchissement depuis le fournisseur --------------------------------

interface VeniceModelList {
  data?: {
    id?: string
    model_spec?: {
      pricing?: { input?: { usd?: number }; output?: { usd?: number }; cache_input?: { usd?: number } }
      capabilities?: { supportsFunctionCalling?: boolean; supportsWebSearch?: boolean }
    }
  }[]
}

/** Coût d'une recherche web chez Venice : 10 $ les 1000 requêtes. */
export const VENICE_WEB_SEARCH_USD = 0.01

/**
 * Reconstruit les entrées Venice depuis `GET /models`.
 *
 * C'est la différence entre une table maintenue à la main et une table relevée :
 * le fournisseur publie ses propres tarifs par modèle, et les lire supprime
 * l'écart qu'on cherchait justement à mesurer.
 *
 * **Ne garde que les modèles qui savent appeler des outils** : un modèle sans
 * appel de fonction ne peut pas exécuter de tâche d'agent, et le faire figurer
 * dans la table laisserait croire qu'il est utilisable.
 *
 * @returns la table fusionnée : les entrées Venice sont remplacées, les autres
 *          préréglages conservés tels quels
 */
export async function fetchVenicePricing(
  current: PricingTable,
  options: { baseUrl: string; apiKey: string; redact: (t: string) => string; signal?: AbortSignal },
): Promise<{ table: PricingTable; models: number; skipped: number }> {
  const base = options.baseUrl.replace(/\/+$/, '')
  const list = await getJson<VeniceModelList>({
    url: `${base}/models?type=text`,
    headers: { authorization: `Bearer ${options.apiKey}` },
    signal: options.signal,
    provider: 'venice',
    redact: options.redact,
  })

  // Les entrées des autres préréglages sont préservées : un rafraîchissement
  // Venice ne doit pas effacer un tarif OpenAI saisi à la main.
  const entries: Record<string, ModelPrice> = Object.fromEntries(
    Object.entries(current.entries).filter(([key]) => !key.startsWith('venice:')),
  )

  let models = 0
  let skipped = 0
  for (const model of list.data ?? []) {
    const spec = model.model_spec
    const input = spec?.pricing?.input?.usd
    const output = spec?.pricing?.output?.usd
    if (!model.id || typeof input !== 'number' || typeof output !== 'number') {
      skipped++
      continue
    }
    if (spec?.capabilities?.supportsFunctionCalling === false) {
      skipped++
      continue
    }
    // Le tarif des jetons lus en cache, quand Venice le publie. Le relevé le
    // laissait à `null`, et l'estimation comptait alors tout au plein tarif :
    // 77 % de trop à l'essai de la Slice 4 (étape 8, leçon n° 32), où 60 % des
    // jetons d'entrée venaient du cache. Avec ce tarif, l'estimation retombe
    // sur le montant facturé. `cache_write` (écriture en cache, plus chère
    // que l'entrée chez certains modèles) n'a pas d'équivalent dans le
    // décompte d'usage : il n'est pas relevé.
    const cached = spec?.pricing?.cache_input?.usd
    entries[priceKey('venice', model.id)] = {
      input_usd_per_mtok: input,
      output_usd_per_mtok: output,
      cached_input_usd_per_mtok: typeof cached === 'number' ? cached : null,
      web_search_usd_per_call: spec?.capabilities?.supportsWebSearch ? VENICE_WEB_SEARCH_USD : null,
    }
    models++
  }

  return {
    table: {
      updated_at: new Date().toISOString(),
      source: `${base}/models?type=text (relevé automatique)`,
      entries,
    },
    models,
    skipped,
  }
}
