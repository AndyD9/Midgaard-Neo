/**
 * @file Consommation et coût : combien a coûté une tâche, et d'où vient le chiffre.
 *
 * **Le point dur de ce module n'est pas le calcul, c'est la provenance.** Le
 * livrable de la Slice 2 exige que « le coût affiché corresponde à la facture ».
 * Un tableau de tarifs maintenu à la main ne peut pas le garantir : il vieillit,
 * et personne ne s'en aperçoit. On garde donc **deux** chiffres côte à côte —
 * celui qu'on calcule et celui que le fournisseur annonce — et on retient le
 * second quand il existe. L'écart entre les deux est visible, donc vérifiable :
 * c'est lui qui dit si `pricing.json` a dérivé.
 *
 * Venice renvoie un objet `cost` (`usd`, `diem`) sur chaque réponse ; OpenAI et
 * Gemini n'annoncent que des jetons, et leur coût reste estimé. {@link CostSource}
 * dit lequel des deux cas on est en train de regarder, et rien n'affiche un
 * montant sans dire d'où il vient.
 */
import { z } from 'zod'

/**
 * D'où vient le montant retenu.
 *
 *  - `provider` : annoncé par le fournisseur lui-même — c'est la facture ;
 *  - `pricing_table` : calculé depuis `pricing.json` — une estimation ;
 *  - `unknown` : aucun tarif connu pour ce modèle. On n'invente **pas** de
 *    chiffre : `cost_usd` reste à zéro et la source le dit.
 */
export const COST_SOURCES = ['provider', 'pricing_table', 'unknown'] as const
export type CostSource = (typeof COST_SOURCES)[number]

/**
 * Consommation cumulée d'une tâche, ou d'un seul appel modèle.
 *
 * Les jetons de raisonnement et de cache sont comptés à part parce qu'ils sont
 * **facturés à part** : un jeton de cache lu coûte une fraction d'un jeton
 * d'entrée, et les jetons de raisonnement sont facturés comme de la sortie alors
 * qu'ils n'apparaissent dans aucun texte rendu. Les confondre fausserait le
 * total dans le sens de la sous-estimation — le pire des deux.
 */
export const usageSchema = z.object({
  /** Appels modèle effectués. Le budget s'exprime en dollars, mais ce compteur-là explique la facture. */
  model_calls: z.number().int().min(0).default(0),
  input_tokens: z.number().int().min(0).default(0),
  output_tokens: z.number().int().min(0).default(0),
  /** Jetons de raisonnement, facturés comme de la sortie mais invisibles dans le texte. */
  reasoning_tokens: z.number().int().min(0).default(0),
  /** Jetons d'entrée servis depuis le cache du fournisseur, facturés moins cher. */
  cached_tokens: z.number().int().min(0).default(0),
  /** Recherches web, facturées à la requête et non au jeton. */
  web_searches: z.number().int().min(0).default(0),
  /** Montant retenu, en dollars. Zéro si {@link CostSource} vaut `unknown`. */
  cost_usd: z.number().min(0).default(0),
  cost_source: z.enum(COST_SOURCES).default('unknown'),
  /** Calculé depuis `pricing.json` ; `null` si aucun tarif n'est connu pour ce modèle. */
  cost_usd_estimated: z.number().min(0).nullable().default(null),
  /** Annoncé par le fournisseur ; `null` s'il n'annonce rien. C'est la facture. */
  cost_usd_reported: z.number().min(0).nullable().default(null),
})
export type Usage = z.infer<typeof usageSchema>

/** Consommation vide, point de départ de tout cumul. */
export function emptyUsage(): Usage {
  return {
    model_calls: 0,
    input_tokens: 0,
    output_tokens: 0,
    reasoning_tokens: 0,
    cached_tokens: 0,
    web_searches: 0,
    cost_usd: 0,
    cost_source: 'unknown',
    cost_usd_estimated: null,
    cost_usd_reported: null,
  }
}

/**
 * Additionne deux consommations.
 *
 * Les montants s'additionnent terme à terme, mais **la source ne s'additionne
 * pas** : elle se dégrade. Un total qui mélange un appel facturé par le
 * fournisseur et un appel seulement estimé n'est pas « annoncé par le
 * fournisseur » ; il est au mieux une estimation. Et si un seul appel a un
 * modèle de tarif inconnu, le total est inconnu — annoncer la somme partielle
 * donnerait un chiffre trop bas, présenté comme complet.
 *
 * @example
 * let total = emptyUsage()
 * for (const call of calls) total = addUsage(total, call.usage)
 */
export function addUsage(a: Usage, b: Usage): Usage {
  const estimated = sumNullable(a.cost_usd_estimated, b.cost_usd_estimated)
  const reported = sumNullable(a.cost_usd_reported, b.cost_usd_reported)
  const source = worstSource(a, b)
  return {
    model_calls: a.model_calls + b.model_calls,
    input_tokens: a.input_tokens + b.input_tokens,
    output_tokens: a.output_tokens + b.output_tokens,
    reasoning_tokens: a.reasoning_tokens + b.reasoning_tokens,
    cached_tokens: a.cached_tokens + b.cached_tokens,
    web_searches: a.web_searches + b.web_searches,
    cost_usd: a.cost_usd + b.cost_usd,
    cost_source: source,
    cost_usd_estimated: estimated,
    cost_usd_reported: reported,
  }
}

/** Somme de deux montants dont l'un peut manquer. `null + x` vaut `x` : on ne perd pas ce qu'on sait. */
function sumNullable(a: number | null, b: number | null): number | null {
  if (a === null) return b
  if (b === null) return a
  return a + b
}

/**
 * Source résultante d'un cumul, du plus fiable au moins fiable.
 *
 * Un cumul vide (`model_calls` à zéro des deux côtés) garde `unknown` sans que
 * ce soit un aveu d'ignorance : il n'y a simplement rien à facturer encore.
 */
function worstSource(a: Usage, b: Usage): CostSource {
  if (a.model_calls === 0) return b.cost_source
  if (b.model_calls === 0) return a.cost_source
  if (a.cost_source === 'unknown' || b.cost_source === 'unknown') return 'unknown'
  if (a.cost_source === 'pricing_table' || b.cost_source === 'pricing_table') return 'pricing_table'
  return 'provider'
}

// --- Tarifs ----------------------------------------------------------------

/**
 * Tarif d'un modèle, en dollars par **million** de jetons.
 *
 * C'est l'unité dans laquelle les fournisseurs publient leurs prix. Convertir à
 * la saisie inviterait l'erreur de facteur mille : on garde leur unité, et on
 * divise une seule fois, dans {@link costFromTable}.
 */
export const modelPriceSchema = z.object({
  input_usd_per_mtok: z.number().min(0),
  output_usd_per_mtok: z.number().min(0),
  /** Tarif des jetons d'entrée servis depuis le cache ; à défaut, le tarif d'entrée plein s'applique. */
  cached_input_usd_per_mtok: z.number().min(0).nullable().default(null),
  /** Coût d'une recherche web, à la requête. Venice : 0,01 $. */
  web_search_usd_per_call: z.number().min(0).nullable().default(null),
})
export type ModelPrice = z.infer<typeof modelPriceSchema>

/**
 * Table de tarifs versionnée, telle que `pricing.json` la porte.
 *
 * Le plan (§4) interdit d'écrire les prix en dur dans le code et exige
 * d'afficher la date de dernière mise à jour : un tarif périmé qu'on croit
 * courant est pire qu'un tarif absent. Les clés sont `<preset>:<modèle>`, par
 * exemple `venice:deepseek-v4-flash-0731` — le tarif suit l'endpoint, pas
 * l'instance de configuration, car deux configurations vers Venice facturent
 * pareil.
 */
export const pricingTableSchema = z.object({
  /** Date de relevé des tarifs, affichée dans l'interface. */
  updated_at: z.iso.datetime(),
  /** D'où viennent ces tarifs : URL de doc, ou `GET /models` du fournisseur. */
  source: z.string(),
  entries: z.record(z.string(), modelPriceSchema),
})
export type PricingTable = z.infer<typeof pricingTableSchema>

/** Clé d'un tarif : `<preset>:<modèle>`. Normalisée en minuscules, les identifiants de modèle l'étant. */
export function priceKey(preset: string, model: string): string {
  return `${preset}:${model}`.toLowerCase()
}

/**
 * Coût estimé d'une consommation, depuis une table de tarifs.
 *
 * @returns le montant en dollars, ou `null` si le modèle n'a pas de tarif connu.
 *          `null` et non `0` : zéro est un coût, pas une ignorance, et l'afficher
 *          comme tel ferait croire qu'une tâche a été gratuite.
 */
export function costFromTable(usage: Usage, price: ModelPrice | undefined): number | null {
  if (!price) return null
  // Les jetons de cache sont comptés dans `input_tokens` par les fournisseurs :
  // on retire leur part du tarif plein avant de la facturer au tarif réduit.
  const cached = Math.min(usage.cached_tokens, usage.input_tokens)
  const fullInput = usage.input_tokens - cached
  const cachedRate = price.cached_input_usd_per_mtok ?? price.input_usd_per_mtok
  // Les jetons de raisonnement sont facturés comme de la sortie, et les
  // fournisseurs les comptent déjà dans `completion_tokens` : les ajouter une
  // seconde fois doublerait leur part.
  const million = 1_000_000
  return (
    (fullInput * price.input_usd_per_mtok) / million +
    (cached * cachedRate) / million +
    (usage.output_tokens * price.output_usd_per_mtok) / million +
    usage.web_searches * (price.web_search_usd_per_call ?? 0)
  )
}

/**
 * Arrête le montant retenu et sa provenance, à partir de ce qu'on a calculé et
 * de ce que le fournisseur a annoncé.
 *
 * La règle tient en une phrase : **le fournisseur a toujours raison sur sa
 * propre facture.** On ne garde l'estimation que faute de mieux.
 *
 * @param estimated calculé depuis `pricing.json` ; `null` si tarif inconnu
 * @param reported  annoncé par le fournisseur ; `null` s'il n'annonce rien
 */
export function settleCost(
  estimated: number | null,
  reported: number | null,
): { cost_usd: number; cost_source: CostSource } {
  if (reported !== null) return { cost_usd: reported, cost_source: 'provider' }
  if (estimated !== null) return { cost_usd: estimated, cost_source: 'pricing_table' }
  return { cost_usd: 0, cost_source: 'unknown' }
}

/**
 * Résume une consommation en un objet compact, destiné à Claude et au dashboard.
 *
 * **La provenance du montant y figure toujours.** Un coût affiché sans dire s'il
 * vient de la facture ou d'une estimation invite à le prendre pour argent
 * comptant ; `cost_source` est donc rendu avec le chiffre, et jamais après.
 *
 * Quand la source est inconnue, le champ `cost_usd` est **absent** plutôt qu'à
 * zéro : un zéro se lit « gratuit », et c'est faux.
 */
export function formatUsage(usage: Usage): Record<string, unknown> {
  const tokens = {
    input: usage.input_tokens,
    output: usage.output_tokens,
    ...(usage.reasoning_tokens > 0 ? { reasoning: usage.reasoning_tokens } : {}),
    ...(usage.cached_tokens > 0 ? { cached_input: usage.cached_tokens } : {}),
  }
  return {
    model_calls: usage.model_calls,
    tokens,
    ...(usage.web_searches > 0 ? { web_searches: usage.web_searches } : {}),
    ...(usage.cost_source === 'unknown'
      ? { cost: 'unknown: no price on record for this model' }
      : {
          cost_usd: Number(usage.cost_usd.toFixed(6)),
          cost_source:
            usage.cost_source === 'provider'
              ? 'billed by the provider'
              : 'estimated from the local price table',
        }),
    ...(usage.cost_usd_reported !== null && usage.cost_usd_estimated !== null
      ? { cost_usd_estimated: Number(usage.cost_usd_estimated.toFixed(6)) }
      : {}),
  }
}
