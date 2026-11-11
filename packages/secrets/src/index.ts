/**
 * @file Point d'entrée de `@midgaard/secrets` : choisir un coffre, et y lire une
 * clé de fournisseur.
 *
 * Le harness ne stocke jamais de clé en base (§5 du plan) : la configuration
 * d'un fournisseur ne porte qu'un `secret_ref`, et c'est ici qu'on le résout.
 */
import { join } from 'node:path'
import type { HarnessConfig } from '@midgaard/contracts'
import { fileVault, libsecret, macosKeychain, windowsDpapi } from './vaults.ts'
import { VAULT_IDS, type SecretVault, type VaultId } from './types.ts'

export { normalizeRef, VaultError, VAULT_IDS } from './types.ts'
export { EXEC_TIMEOUT_MS, POWERSHELL_TIMEOUT_MS, minimalEnv, run } from './exec.ts'
export type { SecretVault, VaultId } from './types.ts'
export { dpapiDir, fileVault, powershellError, libsecret, macosKeychain, windowsDpapi } from './vaults.ts'

/** Variable qui force un coffre, surtout utile aux tests et au dépannage. */
export const VAULT_ENV = 'MIDGAARD_VAULT'

/** Dossier des secrets du repli fichier, sous le dossier runtime. */
export function secretsDir(config: Pick<HarnessConfig, 'home'>): string {
  return join(config.home, 'secrets')
}

/**
 * Choisit le coffre à employer sur cette machine.
 *
 * L'ordre est : coffre forcé par l'environnement, puis coffre système de la
 * plateforme, puis repli fichier. La disponibilité est **mesurée**, pas déduite
 * de `process.platform` : un Linux sans session graphique n'a pas de
 * `secret-tool`, et un macOS en mode restreint peut refuser `security`.
 *
 * @param config configuration injectée ; seul `home` sert
 * @param env    environnement, pour la variable {@link VAULT_ENV}
 * @returns le coffre retenu — jamais `null` : le repli fichier marche toujours
 *
 * @example
 * const vault = await openVault(config, process.env)
 * if (!vault.osBacked) log('attention : secrets en clair sur le disque')
 */
export async function openVault(
  config: Pick<HarnessConfig, 'home'>,
  env: NodeJS.ProcessEnv = {},
): Promise<SecretVault> {
  const file = fileVault(secretsDir(config))
  const forced = env[VAULT_ENV]?.trim() as VaultId | undefined
  const candidates: SecretVault[] = [macosKeychain, windowsDpapi, libsecret, file]

  if (forced) {
    if (!(VAULT_IDS as readonly string[]).includes(forced)) {
      throw new Error(`${VAULT_ENV}=${forced} inconnu ; valeurs possibles : ${VAULT_IDS.join(', ')}`)
    }
    const picked = candidates.find((v) => v.id === forced)!
    // Un coffre forcé n'est pas contourné en silence : si l'utilisateur l'a
    // demandé et qu'il ne répond pas, il doit le savoir plutôt que voir ses
    // secrets atterrir ailleurs.
    if (!(await picked.available())) throw new Error(`${VAULT_ENV}=${forced} indisponible sur cette machine`)
    return picked
  }

  for (const vault of candidates) {
    if (await vault.available()) return vault
  }
  return file
}

/**
 * Résout la clé d'API d'un fournisseur.
 *
 * Deux sources, dans cet ordre : le coffre, puis la variable d'environnement du
 * préréglage. L'environnement vient en **dernier** et n'est qu'un mode de
 * dépannage : une clé qui vit dans l'environnement du daemon se retrouve dans
 * tout processus fils, et dans les traces d'erreur de n'importe quelle
 * bibliothèque. L'interface doit le signaler.
 *
 * @param vault     coffre retenu par {@link openVault}
 * @param secretRef référence en coffre, ou `null` pour n'employer que l'environnement
 * @param envVar    variable consultée en dernier recours
 * @returns la clé et sa provenance, ou `null` si aucune source n'en a
 */
export async function resolveApiKey(
  vault: SecretVault,
  secretRef: string | null,
  envVar: string,
  env: NodeJS.ProcessEnv = {},
): Promise<{ key: string; source: 'vault' | 'env' } | null> {
  if (secretRef) {
    const stored = await vault.get(secretRef)
    if (stored) return { key: stored, source: 'vault' }
  }
  const fromEnv = env[envVar]?.trim()
  if (fromEnv) return { key: fromEnv, source: 'env' }
  return null
}
