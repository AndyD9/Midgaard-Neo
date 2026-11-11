/**
 * @file Classification des adresses IP, et ce que `http_fetch` refuse de joindre.
 *
 * Le plan (§5) demande de bloquer « les IP privées et l'IMDS
 * (`169.254.169.254`) », et d'interdire « la redirection vers une IP privée ».
 * La raison tient en une phrase : **le daemon tourne là où personne d'autre ne
 * peut aller**. Une page web qui obtient d'un agent qu'il appelle
 * `http://169.254.169.254/latest/meta-data/iam/security-credentials/` obtient
 * des identifiants de machine ; `http://127.0.0.1:7777/api/health` lui donne le
 * harness lui-même. C'est le *SSRF*, et l'agent en est le véhicule parfait,
 * puisqu'il lit des contenus que personne n'a écrits pour lui.
 *
 * ## Limite connue, et assumée
 *
 * On résout le nom, on vérifie **toutes** les adresses rendues, puis on laisse
 * `fetch` se connecter — qui résout une seconde fois. Un attaquant maîtrisant un
 * DNS à très faible TTL peut théoriquement rendre une adresse publique à la
 * vérification et une adresse privée à la connexion (*DNS rebinding*). Fermer
 * complètement cette fenêtre demanderait de se connecter à l'adresse vérifiée en
 * portant le nom pour TLS, ce que `fetch` ne permet pas sans réimplémenter la
 * couche de transport. C'est dit ici plutôt que sous-entendu.
 */
import { isIP } from 'node:net'
import { lookup } from 'node:dns/promises'
import { ToolError } from './types.ts'

/** Adresse du service de métadonnées des nuages publics (AWS, GCP, Azure). */
export const IMDS_ADDRESS = '169.254.169.254'

/**
 * Indique si une adresse IP est hors du réseau public.
 *
 * Couvre la boucle locale, les plages privées, le lien-local (donc l'IMDS), le
 * NAT d'opérateur, le multicast et les plages réservées — en v4 comme en v6.
 */
export function isPrivateAddress(address: string): boolean {
  const family = isIP(address)
  if (family === 4) return isPrivateV4(address)
  if (family === 6) return isPrivateV6(address)
  // Ni l'un ni l'autre : on refuse plutôt que de supposer.
  return true
}

function isPrivateV4(address: string): boolean {
  const parts = address.split('.').map(Number)
  if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) return true
  const [a = 0, b = 0] = parts
  if (a === 0) return true // « cet hôte »
  if (a === 10) return true // privé
  if (a === 127) return true // boucle locale
  if (a === 169 && b === 254) return true // lien-local, IMDS comprise
  if (a === 172 && b >= 16 && b <= 31) return true // privé
  if (a === 192 && b === 168) return true // privé
  if (a === 100 && b >= 64 && b <= 127) return true // NAT d'opérateur
  if (a === 192 && b === 0) return true // IETF, TEST-NET-1
  if (a === 198 && (b === 18 || b === 19)) return true // bancs d'essai
  if (a >= 224) return true // multicast et réservé
  return false
}

function isPrivateV6(address: string): boolean {
  const lower = address.toLowerCase().split('%')[0] ?? ''
  if (lower === '::' || lower === '::1') return true
  // Une adresse v4 enveloppée en v6 doit être jugée sur sa partie v4, sinon
  // `::ffff:127.0.0.1` passerait pour une adresse v6 publique.
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower)
  if (mapped?.[1]) return isPrivateV4(mapped[1])
  if (/^f[cd]/.test(lower)) return true // unique-local, fc00::/7
  if (/^fe[89ab]/.test(lower)) return true // lien-local, fe80::/10
  if (lower.startsWith('ff')) return true // multicast
  if (lower.startsWith('2001:db8')) return true // documentation
  return false
}

/**
 * Vérifie qu'un nom d'hôte ne mène que vers le réseau public.
 *
 * Résout **toutes** les adresses, pas seulement la première : un nom qui rend
 * une adresse publique et une adresse privée doit être refusé, car rien ne
 * garantit laquelle sera employée à la connexion.
 *
 * @throws {ToolError} si le nom ne résout pas, ou mène à une adresse non publique
 */
export async function assertPublicHost(hostname: string): Promise<string[]> {
  // `URL.hostname` garde les crochets d'un littéral IPv6 (`[::1]`), que
  // `isIP` ne reconnaît pas : sans les ôter, `[::1]` partait en résolution
  // DNS et n'était refusé que comme « introuvable » — sûr, mais pour une
  // fausse raison, et une adresse IPv6 publique l'était tout autant (Slice 7,
  // étape 7, X8).
  const bare = hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname
  // Un littéral IP ne se résout pas : il se juge directement.
  if (isIP(bare)) {
    if (isPrivateAddress(bare)) throw new ToolError(refusal(hostname, bare))
    return [bare]
  }

  let addresses: { address: string }[]
  try {
    addresses = await lookup(hostname, { all: true })
  } catch {
    throw new ToolError(`cannot resolve host: ${hostname}`)
  }
  if (addresses.length === 0) throw new ToolError(`cannot resolve host: ${hostname}`)

  for (const { address } of addresses) {
    if (isPrivateAddress(address)) throw new ToolError(refusal(hostname, address))
  }
  return addresses.map((a) => a.address)
}

/** Message de refus, explicite sur la raison : le modèle doit pouvoir changer d'approche. */
function refusal(hostname: string, address: string): string {
  const what = address === IMDS_ADDRESS ? 'the cloud metadata service' : 'a private or loopback address'
  return `refused: ${hostname} resolves to ${what} (${address}). Agents may only reach the public internet.`
}

/**
 * Indique si un hôte figure dans une liste blanche.
 *
 * Un motif `example.com` n'autorise **que** cet hôte ; `*.example.com`
 * autorise ses sous-domaines **et** lui-même. Le second point évite le piège
 * classique où `*.example.com` laisse passer `evil-example.com` : la
 * comparaison porte sur un suffixe précédé d'un point, jamais sur une sous-chaîne.
 */
export function hostAllowed(hostname: string, patterns: readonly string[]): boolean {
  const host = hostname.toLowerCase()
  return patterns.some((raw) => {
    const pattern = raw.trim().toLowerCase()
    if (!pattern) return false
    if (pattern === '*') return true
    if (pattern.startsWith('*.')) {
      const suffix = pattern.slice(1) // « .example.com »
      return host === pattern.slice(2) || host.endsWith(suffix)
    }
    return host === pattern
  })
}
