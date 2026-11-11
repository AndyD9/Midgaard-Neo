/**
 * @file Configuration des fournisseurs de modèles.
 *
 * ## Deux formes de fil, trois fournisseurs
 *
 * Le plan (§4) prévoyait un adaptateur OpenAI et un adaptateur Gemini, pour
 * éprouver l'interface contre deux protocoles réellement différents. La Slice 2
 * a constaté que **Venice.ai expose une API compatible OpenAI** — même
 * `chat/completions`, mêmes `tools`, mêmes `tool_calls`. Venice n'est donc pas
 * un troisième adaptateur : c'est le même, avec une autre `base_url` et un objet
 * d'extension propre (`venice_parameters`).
 *
 * D'où la distinction entre {@link ProviderKind}, qui dit **comment on parle**
 * (la forme du fil, donc l'adaptateur), et {@link ProviderPreset}, qui dit **à
 * qui on parle** (l'endpoint, donc les tarifs et les extensions disponibles).
 *
 * ## Les clés ne sont pas ici
 *
 * Une configuration ne porte jamais de clé d'API, seulement un `secret_ref` qui
 * la désigne dans le coffre système (§5 du plan). La base contient des
 * identifiants, jamais des secrets : une base copiée ou sauvegardée ne donne
 * accès à rien.
 */
import { z } from 'zod'

/** Forme du fil, donc adaptateur à employer. */
export const PROVIDER_KINDS = ['openai-compatible', 'gemini'] as const
export type ProviderKind = (typeof PROVIDER_KINDS)[number]

/**
 * Endpoint visé. Détermine la `base_url` par défaut, les extensions disponibles
 * et la clé de tarif (`<preset>:<modèle>`).
 */
export const PROVIDER_PRESETS = ['venice', 'openai', 'gemini', 'custom'] as const
export type ProviderPreset = (typeof PROVIDER_PRESETS)[number]

/** Ce que la recherche web fait pour ce fournisseur. */
export const WEB_SEARCH_MODES = ['native', 'off'] as const
export type WebSearchMode = (typeof WEB_SEARCH_MODES)[number]

/** Ce qu'un préréglage fixe d'avance, et que l'utilisateur n'a pas à saisir. */
export interface PresetDefaults {
  kind: ProviderKind
  /** `null` pour Gemini, dont le SDK connaît son propre endpoint. */
  baseUrl: string | null
  /** Variable d'environnement consultée en dernier recours, après le coffre. */
  envVar: string
  /** Vrai si l'endpoint sait chercher sur le web sans outil tiers. */
  nativeWebSearch: boolean
  label: string
}

/**
 * Préréglages connus.
 *
 * Les `base_url` sont celles des documentations officielles. Celle de Venice
 * porte bien `/api/v1` : le domaine `venice.ai` sert l'application web et refuse
 * les appels d'API, ce que sa doc signale explicitement.
 */
export const PRESETS: Readonly<Record<ProviderPreset, PresetDefaults>> = Object.freeze({
  venice: {
    kind: 'openai-compatible',
    baseUrl: 'https://api.venice.ai/api/v1',
    envVar: 'VENICE_API_KEY',
    nativeWebSearch: true,
    label: 'Venice.ai',
  },
  openai: {
    kind: 'openai-compatible',
    baseUrl: 'https://api.openai.com/v1',
    envVar: 'OPENAI_API_KEY',
    nativeWebSearch: false,
    label: 'OpenAI',
  },
  gemini: {
    kind: 'gemini',
    baseUrl: null,
    envVar: 'GEMINI_API_KEY',
    nativeWebSearch: false,
    label: 'Google Gemini',
  },
  custom: {
    kind: 'openai-compatible',
    baseUrl: null,
    envVar: 'MIDGAARD_PROVIDER_API_KEY',
    nativeWebSearch: false,
    label: 'Endpoint compatible OpenAI',
  },
})

/** Résultat d'un « Test connection », tel qu'il est persisté et affiché. */
export const connectionTestSchema = z.object({
  ok: z.boolean(),
  /** Phrase lisible : ce qui a marché, ou pourquoi ça n'a pas marché. */
  detail: z.string(),
  at: z.iso.datetime(),
  /** Durée de l'aller-retour, qui dit aussi quelque chose de la latence de l'endpoint. */
  latency_ms: z.number().int().min(0).nullable().default(null),
  /** Modèles annoncés par l'endpoint, s'il sait les lister. */
  models: z.array(z.string()).default([]),
})
export type ConnectionTest = z.infer<typeof connectionTestSchema>

/** Un fournisseur configuré, tel que le daemon le stocke et l'expose. */
export const providerConfigSchema = z.object({
  /** Identifiant court choisi par l'utilisateur, par exemple `venice`. */
  id: z.string().min(1).max(64).regex(/^[a-z0-9][a-z0-9_-]*$/, 'minuscules, chiffres, tiret ou souligné'),
  name: z.string().min(1).max(200),
  kind: z.enum(PROVIDER_KINDS),
  preset: z.enum(PROVIDER_PRESETS),
  /** `null` = celle du préréglage. Toujours en HTTPS hors boucle locale. */
  base_url: z.url().nullable(),
  /** Modèle employé quand un agent n'en impose pas. */
  default_model: z.string().min(1),
  /**
   * Identifiant de la clé dans le coffre système. **Jamais la clé.**
   * `null` signifie « lue dans l'environnement » — mode de dépannage, annoncé
   * comme tel dans l'interface, jamais le mode recommandé.
   */
  secret_ref: z.string().min(1).nullable(),
  web_search: z.enum(WEB_SEARCH_MODES),
  created_at: z.iso.datetime(),
  updated_at: z.iso.datetime(),
  /** Dernier « Test connection ». `null` tant qu'aucun n'a été lancé — et on ne prétend pas que ça marche. */
  last_test: connectionTestSchema.nullable(),
})
export type ProviderConfig = z.infer<typeof providerConfigSchema>

/** Adresse effective de l'endpoint : celle de la configuration, sinon celle du préréglage. */
export function resolveBaseUrl(config: Pick<ProviderConfig, 'base_url' | 'preset'>): string | null {
  return config.base_url ?? PRESETS[config.preset].baseUrl
}
