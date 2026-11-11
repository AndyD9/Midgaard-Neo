/**
 * @file Interface commune des coffres, et ce qu'ils promettent réellement.
 *
 * Le plan (§5) exige que les secrets vivent dans un « coffre système », la base
 * ne gardant que des identifiants. Le point délicat n'est pas d'y arriver sur
 * une plateforme, c'est d'être **honnête sur les trois** : macOS, Windows et
 * Linux n'offrent pas le même service, et sur une machine donnée le mécanisme
 * attendu peut tout simplement manquer.
 *
 * D'où {@link SecretVault.osBacked}, qui n'existe que pour pouvoir le dire. Un
 * repli fichier reste un repli fichier, et l'interface l'annonce au lieu de
 * laisser croire à une protection qui n'est pas là — c'est la leçon du défaut
 * n° 1 de la Slice 0, appliquée à la sécurité.
 */

/** Identifiants des implémentations livrées. */
export const VAULT_IDS = ['macos-keychain', 'windows-dpapi', 'libsecret', 'file'] as const
export type VaultId = (typeof VAULT_IDS)[number]

/**
 * Un coffre : il range des chaînes sous des références, et les rend.
 *
 * Les références sont des identifiants choisis par le harness (par exemple
 * `provider.venice`), jamais des noms fournis par un modèle.
 */
export interface SecretVault {
  readonly id: VaultId
  /** Libellé affichable, par exemple « trousseau macOS ». */
  readonly label: string
  /**
   * Vrai si le système d'exploitation protège réellement le secret au repos.
   * Faux pour le repli fichier, qui ne fait que des permissions `0600`.
   */
  readonly osBacked: boolean
  /** Vrai si le mécanisme est utilisable sur cette machine (binaire présent, service joignable). */
  available(): Promise<boolean>
  /** @returns le secret, ou `null` s'il n'existe pas. Ne lève pas sur une référence inconnue. */
  get(ref: string): Promise<string | null>
  /** Range un secret, en écrasant celui qui portait la même référence. */
  set(ref: string, value: string): Promise<void>
  /** Supprime un secret. L'absence n'est pas une erreur. */
  delete(ref: string): Promise<void>
}

/**
 * Normalise une référence de secret.
 *
 * Les références finissent en argument de ligne de commande (`security`,
 * `secret-tool`) ou en nom de fichier (DPAPI, repli) : on les contraint à un
 * alphabet sans surprise plutôt que d'échapper au cas par cas. Interdire vaut
 * mieux qu'échapper — un échappement oublié est une injection.
 *
 * @throws si la référence ne contient aucun caractère utilisable
 */
export function normalizeRef(ref: string): string {
  const clean = ref
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]/g, '-')
    .replace(/^[.-]+/, '')
    .slice(0, 120)
  if (!clean) throw new Error(`référence de secret inutilisable : ${JSON.stringify(ref)}`)
  return clean
}

/** Erreur d'un coffre, avec le mécanisme en cause pour que le message soit actionnable. */
export class VaultError extends Error {
  readonly vault: VaultId
  constructor(vault: VaultId, message: string) {
    super(`${vault} : ${message}`)
    this.name = 'VaultError'
    this.vault = vault
  }
}
