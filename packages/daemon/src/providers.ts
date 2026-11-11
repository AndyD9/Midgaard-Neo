/**
 * @file Service des fournisseurs : déclarer, tester, supprimer, et tenir la
 * table de tarifs à jour.
 *
 * C'est le seul endroit du daemon où une clé d'API circule, et elle n'y fait que
 * passer : elle arrive dans le corps d'une requête, part au coffre, et ce qui
 * est écrit en base n'est qu'une **référence**. Elle n'est jamais relue, jamais
 * renvoyée, jamais journalisée (§5 du plan).
 *
 * L'ordre des opérations compte : **le coffre d'abord, la base ensuite**. Si la
 * base était écrite en premier et le dépôt échouait, il resterait une
 * configuration qui promet une clé inexistante — et l'erreur ne se verrait qu'à
 * la première tâche, loin de sa cause.
 */
import { createHash } from 'node:crypto'
import { realpathSync } from 'node:fs'
import type {
  ConnectionTest,
  HarnessConfig,
  PricingTable,
  ProviderConfig,
  UpsertProviderRequest,
} from '@midgaard/contracts'
import { PRESETS, createRedactor, resolveBaseUrl } from '@midgaard/contracts'
import { createAdapter, envVarFor, fetchVenicePricing, savePricing } from '@midgaard/providers'
import { resolveApiKey, type SecretVault } from '@midgaard/secrets'
import type { HarnessStore } from '@midgaard/persistence'
import { reconcileAgents } from './agents.ts'

/** Issue d'une opération refusée, à traduire en code HTTP. */
export interface ProviderRefusal {
  error: string
  status: number
  detail?: Record<string, unknown>
}

/** Ce dont le service a besoin. */
export interface ProviderServiceDeps {
  config: HarnessConfig
  store: HarnessStore
  vault: SecretVault
  env: NodeJS.ProcessEnv
  /** Table de tarifs en vigueur ; remplacée par un rafraîchissement. */
  pricing: () => PricingTable
  setPricing: (table: PricingTable) => void
  log: (...a: unknown[]) => void
}

/**
 * Référence d'une clé dans le coffre. Dérivée de l'identifiant et du dossier
 * runtime, jamais fournie de l'extérieur.
 *
 * **Pourquoi le dossier runtime.** Les coffres système sont par utilisateur,
 * pas par installation : sous `provider.<id>` seul, deux `MIDGAARD_HOME` d'une
 * même session voyaient la même entrée — déclarer `venice` dans l'un écrasait
 * la clé de l'autre, et `providers remove` dans l'un **supprimait** celle dont
 * l'autre se servait (Slice 4, étape 8, leçon n° 30). Huit caractères
 * hexadécimaux de l'empreinte du chemin canonique suffisent à séparer les
 * installations d'une machine, et restent dans l'alphabet de `normalizeRef`.
 *
 * Les références déjà en base ne sont pas recalculées : c'est la base qui dit
 * où est une clé, et `upsertProvider` réutilise celle qu'elle connaît.
 *
 * @param home       dossier runtime de cette installation (`config.home`)
 * @param providerId identifiant du fournisseur
 * @returns par exemple `provider.3f9a0c21.venice`
 */
export function secretRefFor(home: string, providerId: string): string {
  let canonical = home
  try {
    // `.native` : sous Windows, seul lui développe les noms courts 8.3 — sans
    // quoi un même dossier aurait deux empreintes (voir CLAUDE.md).
    canonical = realpathSync.native(home)
  } catch {
    // Dossier pas encore créé : le daemon le crée avant d'écrire quoi que ce
    // soit, donc ce cas ne sert qu'aux tests qui appellent la fonction seule.
  }
  const scope = createHash('sha256').update(canonical).digest('hex').slice(0, 8)
  return `provider.${scope}.${providerId}`
}

/** Déclare ou met à jour un fournisseur, et dépose sa clé. */
export async function upsertProvider(
  deps: ProviderServiceDeps,
  input: UpsertProviderRequest,
): Promise<ProviderConfig | ProviderRefusal> {
  const preset = PRESETS[input.preset]
  const existing = deps.store.getProvider(input.id)
  const baseUrl = input.base_url ?? existing?.base_url ?? null

  if (!baseUrl && !preset.baseUrl) {
    return {
      error: 'base_url_required',
      status: 400,
      detail: { reason: `le préréglage « ${input.preset} » ne fournit aucune adresse` },
    }
  }

  // Le coffre d'abord. Un échec ici arrête tout, et la configuration
  // précédente — si elle existait — reste valide.
  let secretRef = existing?.secret_ref ?? null
  if (input.api_key) {
    // Une clé remplacée reprend la référence connue : en changer laisserait
    // l'ancienne entrée orpheline dans le coffre, hors de portée de `remove`.
    secretRef ??= secretRefFor(deps.config.home, input.id)
    try {
      await deps.vault.set(secretRef, input.api_key)
    } catch (e) {
      return { error: 'vault_write_failed', status: 500, detail: { reason: (e as Error).message } }
    }
    deps.log(`clé de « ${input.id} » déposée dans ${deps.vault.id}`)
  }

  const provider = deps.store.upsertProvider({
    id: input.id,
    name: input.name ?? existing?.name ?? preset.label,
    kind: preset.kind,
    preset: input.preset,
    baseUrl,
    defaultModel: input.default_model,
    secretRef,
    // La recherche web native n'est proposée que par les endpoints qui en ont
    // une : l'activer ailleurs annoncerait une capacité inexistante.
    webSearch: input.web_search ?? (preset.nativeWebSearch ? 'native' : 'off'),
  })

  // Un profil sans fournisseur vient peut-être d'en trouver un.
  reconcileAgents(deps.store, deps.log)
  return provider
}

/**
 * Supprime un fournisseur et sa clé.
 *
 * Les profils qui s'y référaient sont **désactivés, pas supprimés** : quelqu'un
 * qui change de clé ne doit pas perdre ses limites et ses réglages au passage.
 */
export async function deleteProvider(
  deps: ProviderServiceDeps,
  id: string,
): Promise<{ ok: true } | ProviderRefusal> {
  const provider = deps.store.getProvider(id)
  if (!provider) return { error: 'provider_not_found', status: 404 }
  if (provider.secret_ref) {
    await deps.vault.delete(provider.secret_ref).catch((e: Error) => {
      // Une clé qu'on n'arrive pas à effacer n'empêche pas de retirer la
      // configuration : mieux vaut le signaler que bloquer l'utilisateur.
      deps.log(`clé de « ${id} » non supprimée du coffre : ${e.message}`)
    })
  }
  deps.store.deleteProvider(id)
  reconcileAgents(deps.store, deps.log)
  return { ok: true }
}

/**
 * « Test connection » : joint réellement l'endpoint et dit ce qu'il a vu.
 *
 * Passe par `GET /models` plutôt que par une complétion : cela prouve d'un coup
 * que l'adresse répond, que la clé est acceptée et que le modèle configuré
 * existe là-bas — sans facturer un seul jeton pour un test.
 */
export async function testProvider(
  deps: ProviderServiceDeps,
  id: string,
  signal?: AbortSignal,
): Promise<{ provider: ProviderConfig; test: ConnectionTest } | ProviderRefusal> {
  const provider = deps.store.getProvider(id)
  if (!provider) return { error: 'provider_not_found', status: 404 }

  const envVar = envVarFor(provider)
  const found = await resolveApiKey(deps.vault, provider.secret_ref, envVar, deps.env)
  if (!found) {
    const test: ConnectionTest = {
      ok: false,
      detail: `aucune clé : dépose-la, ou définis ${envVar} dans l'environnement du daemon`,
      at: new Date().toISOString(),
      latency_ms: null,
      models: [],
    }
    return { provider: deps.store.recordProviderTest(id, test) ?? provider, test }
  }

  const adapter = createAdapter({
    config: provider,
    apiKey: found.key,
    pricing: deps.pricing(),
    redact: createRedactor([found.key]),
  })
  const test = await adapter.testConnection(signal)
  const updated = deps.store.recordProviderTest(id, test) ?? provider
  deps.log(`test de « ${id} » : ${test.ok ? 'réussi' : 'échoué'} — ${test.detail}`)
  return { provider: updated, test }
}

/**
 * Reconstruit les tarifs Venice depuis son API.
 *
 * Venice publie `model_spec.pricing` sur `GET /models` : un tarif relevé chez le
 * fournisseur ne peut pas avoir dérivé, contrairement à une table maintenue à la
 * main. Les entrées des autres préréglages sont conservées.
 */
export async function refreshPricing(
  deps: ProviderServiceDeps,
  id: string,
  signal?: AbortSignal,
): Promise<{ pricing: PricingTable; models: number; path: string } | ProviderRefusal> {
  const provider = deps.store.getProvider(id)
  if (!provider) return { error: 'provider_not_found', status: 404 }
  if (provider.preset !== 'venice') {
    return {
      error: 'refresh_unsupported',
      status: 400,
      detail: { reason: `seul Venice publie ses tarifs par modèle ; « ${provider.preset} » ne le fait pas` },
    }
  }
  const baseUrl = resolveBaseUrl(provider)
  if (!baseUrl) return { error: 'base_url_required', status: 400 }

  const found = await resolveApiKey(deps.vault, provider.secret_ref, envVarFor(provider), deps.env)
  if (!found) return { error: 'missing_api_key', status: 400 }

  try {
    const { table, models } = await fetchVenicePricing(deps.pricing(), {
      baseUrl,
      apiKey: found.key,
      redact: createRedactor([found.key]),
      ...(signal ? { signal } : {}),
    })
    deps.setPricing(table)
    const path = savePricing(deps.config, table)
    deps.log(`tarifs rafraîchis depuis ${provider.id} : ${models} modèle(s) → ${path}`)
    return { pricing: table, models, path }
  } catch (e) {
    return { error: 'refresh_failed', status: 502, detail: { reason: (e as Error).message } }
  }
}
