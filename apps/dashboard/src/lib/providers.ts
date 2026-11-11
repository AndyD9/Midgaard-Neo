/**
 * @file Les fournisseurs vus du dashboard : fonctions pures, sans rendu,
 * éprouvées par `tests/unit/dashboard-providers.test.ts`.
 *
 * La carte « Fournisseurs » (`components/ProvidersCard.tsx`) déclare un
 * fournisseur et dépose sa clé sans passer par un terminal. Ce module porte ce
 * qui se décide **avant** l'appel : la liste des préréglages, la validation
 * d'une saisie et la requête qui en sort.
 *
 * Le dashboard n'importe de `@midgaard/contracts` que des types (son point
 * d'entrée charge `node:os`) : les préréglages sont donc recopiés ici. Le
 * `Record<ProviderPreset, …>` fait échouer la vérification des types si un
 * préréglage est ajouté là-bas sans l'être ici, et le test compare les
 * libellés et les adresses à ceux de `PRESETS`.
 */
import type { ProviderConfig, ProviderPreset, UpsertProviderRequest } from '@midgaard/contracts'

/** Ce que la carte sait d'un préréglage. */
export interface PresetOption {
  /** Libellé montré dans la liste, celui de `PRESETS`. */
  label: string
  /** Vrai si le préréglage ne fournit aucune adresse : il faut la saisir. */
  needsBaseUrl: boolean
  /** Modèle proposé dans le champ, modifiable ; vide quand rien ne s'impose. */
  suggestedModel: string
}

/** Les préréglages, dans l'ordre de la liste. Recopie de `PRESETS` (contracts). */
export const PRESET_OPTIONS: Readonly<Record<ProviderPreset, PresetOption>> = {
  venice: { label: 'Venice.ai', needsBaseUrl: false, suggestedModel: 'deepseek-v4-flash-0731' },
  openai: { label: 'OpenAI', needsBaseUrl: false, suggestedModel: '' },
  gemini: { label: 'Google Gemini', needsBaseUrl: false, suggestedModel: '' },
  custom: { label: 'Endpoint compatible OpenAI', needsBaseUrl: true, suggestedModel: '' },
}

/** Ce que l'humain a saisi dans le formulaire, tel quel. */
export interface ProviderDraft {
  id: string
  preset: ProviderPreset
  model: string
  baseUrl: string
  /** La clé saisie ; vide = garder celle du coffre (fournisseur existant seulement). */
  apiKey: string
}

/** Un formulaire vide, sur Venice : le cas courant n'a que la clé à saisir. */
export function emptyDraft(): ProviderDraft {
  return { id: 'venice', preset: 'venice', model: PRESET_OPTIONS.venice.suggestedModel, baseUrl: '', apiKey: '' }
}

/** Le formulaire pré-rempli d'un fournisseur existant — sans clé : le dashboard n'en voit jamais une. */
export function draftOf(provider: ProviderConfig): ProviderDraft {
  return { id: provider.id, preset: provider.preset, model: provider.default_model, baseUrl: provider.base_url ?? '', apiKey: '' }
}

/** Même règle que `providerConfigSchema.id` : le daemon refuserait le reste. */
const ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/

/**
 * Pourquoi une saisie ne peut pas partir, ou `null` si elle le peut.
 *
 * Deux règles de plus que le daemon, propres au formulaire :
 *  - un fournisseur **nouveau** exige une clé — sans elle, il serait déclaré
 *    « lu dans l'environnement », mode de dépannage que la CLI ne propose pas
 *    non plus ;
 *  - changer l'**adresse** ou le **préréglage** d'un fournisseur existant
 *    exige de ressaisir la clé : sinon la clé déjà au coffre partirait vers
 *    une adresse que l'humain n'avait pas en tête quand il l'a déposée.
 *
 * @param draft    la saisie
 * @param existing le fournisseur du même identifiant, s'il est déjà déclaré
 */
export function draftError(draft: ProviderDraft, existing: ProviderConfig | undefined): string | null {
  const id = draft.id.trim()
  if (!ID_PATTERN.test(id)) return 'Identifiant : minuscules, chiffres, tiret ou souligné (par exemple « venice »).'
  if (draft.model.trim() === '') return 'Il faut un modèle par défaut.'
  const baseUrl = draft.baseUrl.trim()
  if (PRESET_OPTIONS[draft.preset].needsBaseUrl && baseUrl === '') return 'Ce préréglage ne fournit aucune adresse : saisis celle de l’endpoint.'
  if (baseUrl !== '' && !/^https?:\/\/\S+$/.test(baseUrl)) return 'L’adresse doit commencer par https:// (ou http:// sur la boucle locale).'
  const key = draft.apiKey.trim()
  if (!existing && key === '') return 'Il faut une clé d’API.'
  if (existing && key === '' && existing.secret_ref === null) return 'Ce fournisseur n’a pas de clé au coffre : saisis-la.'
  if (existing && key === '' && (existing.preset !== draft.preset || (existing.base_url ?? '') !== baseUrl)) {
    return 'L’adresse ou le préréglage change : ressaisis la clé, pour qu’elle ne parte pas ailleurs à ton insu.'
  }
  return null
}

/**
 * La requête `POST /api/providers` d'une saisie valide.
 *
 * La clé est **rognée** : collée depuis un gestionnaire de mots de passe, elle
 * traîne souvent un saut de ligne, et le fournisseur la refuserait sans dire
 * pourquoi. Absente de la requête quand elle est vide : le daemon garde alors
 * celle du coffre.
 */
export function requestOf(draft: ProviderDraft): Omit<UpsertProviderRequest, 'preset'> & { preset: ProviderPreset } {
  const baseUrl = draft.baseUrl.trim()
  const key = draft.apiKey.trim()
  return {
    id: draft.id.trim(),
    preset: draft.preset,
    default_model: draft.model.trim(),
    ...(baseUrl !== '' ? { base_url: baseUrl } : {}),
    ...(key !== '' ? { api_key: key } : {}),
  }
}

/** D'où vient la clé d'un fournisseur, en clair pour l'humain. */
export function keyStatus(provider: Pick<ProviderConfig, 'secret_ref'>): { inVault: boolean; text: string } {
  return provider.secret_ref !== null
    ? { inVault: true, text: 'clé au coffre' }
    : { inVault: false, text: 'clé lue dans l’environnement du daemon' }
}
