/**
 * @file Point d'entrée de `@midgaard/providers` : d'une configuration et d'une
 * clé, on obtient un adaptateur prêt à appeler.
 *
 * Ce paquet ne connaît **ni le coffre, ni la base, ni le daemon**. Il reçoit une
 * clé déjà résolue et une table de tarifs déjà chargée. C'est ce qui permet de
 * le tester sur réponses enregistrées sans monter quoi que ce soit d'autre.
 */
import type { HarnessConfig, PricingTable, ProviderConfig } from '@midgaard/contracts'
import { PRESETS, resolveBaseUrl } from '@midgaard/contracts'
import type { ProviderAdapter } from './adapter.ts'
import { createGeminiAdapter, GEMINI_BASE_URL } from './gemini.ts'
import { createOpenAiAdapter } from './openai.ts'
import { priceFor } from './pricing.ts'

export type {
  CompletionRequest,
  CompletionResponse,
  FinishReason,
  ImageInput,
  ImageMediaType,
  Message,
  ModelCapabilities,
  ProviderAdapter,
  ToolCallRequest,
  ToolSpec,
} from './adapter.ts'
export { IMAGE_MEDIA_TYPES, ProviderError } from './adapter.ts'
export { CATALOG_TTL_MS, clearCatalogCache, createOpenAiAdapter } from './openai.ts'
export { createGeminiAdapter, GEMINI_BASE_URL } from './gemini.ts'
export {
  fetchVenicePricing,
  loadPricing,
  packagedPricingPath,
  priceFor,
  savePricing,
  userPricingPath,
  VENICE_WEB_SEARCH_USD,
} from './pricing.ts'
export { REQUEST_TIMEOUT_MS } from './http.ts'

/** Ce qu'il faut pour instancier un adaptateur. */
export interface AdapterInput {
  config: ProviderConfig
  /** Clé déjà résolue depuis le coffre ou l'environnement. */
  apiKey: string
  /** Modèle à employer ; par défaut celui du fournisseur. */
  model?: string | null
  pricing: PricingTable
  redact: (text: string) => string
}

/**
 * Construit l'adaptateur d'une configuration.
 *
 * Le choix se fait sur `kind` — la **forme du fil** — et non sur `preset`, qui
 * ne dit que l'endroit où l'on parle. C'est toute la différence qui permet à
 * Venice et OpenAI de partager un adaptateur.
 *
 * @throws si la configuration ne désigne aucune adresse joignable
 *
 * @example
 * const adapter = createAdapter({ config, apiKey, pricing, redact })
 * const res = await adapter.complete({ messages, tools, maxOutputTokens: 2048, webSearch: true })
 */
export function createAdapter(input: AdapterInput): ProviderAdapter {
  const { config } = input
  const model = input.model ?? config.default_model
  const price = priceFor(input.pricing, config.preset, model)

  if (config.kind === 'gemini') {
    return createGeminiAdapter({
      id: config.id,
      model,
      apiKey: input.apiKey,
      baseUrl: resolveBaseUrl(config) ?? GEMINI_BASE_URL,
      webSearch: config.web_search === 'native',
      redact: input.redact,
      price,
    })
  }

  const baseUrl = resolveBaseUrl(config)
  if (!baseUrl) {
    throw new Error(
      `le fournisseur « ${config.id} » n'a pas d'adresse : le préréglage « ${config.preset} » ` +
        'n\'en fournit aucune, renseigne base_url',
    )
  }
  return createOpenAiAdapter({
    id: config.id,
    preset: config.preset,
    model,
    baseUrl,
    apiKey: input.apiKey,
    webSearch: config.web_search === 'native',
    redact: input.redact,
    price,
  })
}

/**
 * Variable d'environnement consultée en dernier recours pour un préréglage.
 * Réexportée ici pour que le daemon n'ait pas à connaître la table des préréglages.
 */
export function envVarFor(config: Pick<ProviderConfig, 'preset'>): string {
  return PRESETS[config.preset].envVar
}

/** Chemin de la table de tarifs de l'utilisateur, pour `harness doctor`. */
export function pricingPathFor(config: Pick<HarnessConfig, 'home'>): string {
  return `${config.home}/pricing.json`
}
