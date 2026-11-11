/**
 * @file Client HTTP des fournisseurs : un seul endroit pour les délais, les
 * reprises, l'annulation et l'expurgation des erreurs.
 *
 * **Pourquoi pas les SDK officiels.** `openai` et `@google/genai` étaient prévus
 * au plan (§1). La Slice 2 ne les prend pas, pour quatre raisons mesurées :
 *
 *  1. On n'appelle qu'**un seul endpoint par fournisseur**, sans flux. Un SDK
 *     complet pour un `POST` JSON est une dépendance qui coûte plus qu'elle ne
 *     rend.
 *  2. On a besoin de **contrôler le corps au champ près**. Venice refuse en 400
 *     tout champ de premier niveau inconnu, et attend son extension propre
 *     `venice_parameters` ; passer par les échappatoires d'un SDK pour y arriver
 *     donne moins de garanties que d'écrire l'objet.
 *  3. **Une seule discipline HTTP** : le même délai, la même reprise, la même
 *     annulation et la même expurgation pour les deux fournisseurs. Avec deux
 *     SDK, c'est trois comportements à connaître.
 *  4. Les SDK **bougent** : la Slice 0 avait déjà relevé que `@google/genai` ≥ 2
 *     change la forme des appels. L'API REST, elle, est documentée et stable.
 *
 * C'est le même raisonnement qui a fait préférer `node:http` à Fastify et
 * `node:sqlite` à `better-sqlite3` en Slice 1. Le coût est assumé : les erreurs
 * de l'API, c'est nous qui les interprétons.
 */
import { ProviderError } from './adapter.ts'

/** Délai d'un appel modèle. Large : un modèle de raisonnement met parfois une minute. */
export const REQUEST_TIMEOUT_MS = 180_000

/** Nombre de reprises sur erreur transitoire. */
const MAX_RETRIES = 2

/** Attente avant reprise, en millisecondes. Croissante, pour ne pas aggraver une limite de débit. */
const BACKOFF_MS = [800, 2400]

/** Ce dont un appel a besoin pour partir. */
export interface JsonRequest {
  url: string
  headers: Record<string, string>
  body: unknown
  signal?: AbortSignal | undefined
  /** Nom du fournisseur, pour les messages d'erreur. */
  provider: string
  /** Expurgation appliquée aux messages d'erreur avant qu'ils ne sortent d'ici. */
  redact: (text: string) => string
}

/**
 * Envoie un `POST` JSON et rend la réponse désérialisée.
 *
 * **Reprend** sur 408, 409, 429 et 5xx, et sur les coupures réseau : ce sont des
 * incidents transitoires. **Ne reprend pas** sur 401, 403 et 400 — une clé
 * invalide ou un corps malformé ne se répare pas en réessayant, et insister
 * consomme le budget de la tâche tout en retardant un message que l'utilisateur
 * doit lire tout de suite.
 *
 * @throws {ProviderError} avec `retryable` déjà arbitré
 */
export async function postJson<T>(req: JsonRequest): Promise<T> {
  let lastError: ProviderError | null = null

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    // Un délai propre à chaque tentative, combiné à l'annulation de la tâche :
    // `AbortSignal.any` libère l'appel dès que l'un des deux se déclenche.
    const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    const signal = req.signal ? AbortSignal.any([req.signal, timeout]) : timeout

    let res: Response
    try {
      res = await fetch(req.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...req.headers },
        body: JSON.stringify(req.body),
        signal,
      })
    } catch (e) {
      // L'annulation de la tâche n'est pas une panne réseau : elle ne se reprend pas.
      if (req.signal?.aborted) throw new ProviderError(req.provider, 'appel annulé', null, false)
      lastError = new ProviderError(
        req.provider,
        req.redact(`appel injoignable : ${(e as Error).message}`),
        null,
        true,
      )
      if (attempt === MAX_RETRIES) throw lastError
      await delay(BACKOFF_MS[attempt] ?? 2400)
      continue
    }

    if (res.ok) return (await res.json()) as T

    const text = await res.text().catch(() => '')
    const retryable = res.status === 408 || res.status === 409 || res.status === 429 || res.status >= 500
    lastError = new ProviderError(
      req.provider,
      req.redact(`HTTP ${res.status} ${res.statusText} — ${summarizeBody(text)}`),
      res.status,
      retryable,
    )
    if (!retryable || attempt === MAX_RETRIES) throw lastError
    // `Retry-After` est respecté quand il est fourni : c'est le fournisseur qui
    // sait combien de temps sa limite de débit court.
    await delay(retryAfterMs(res) ?? BACKOFF_MS[attempt] ?? 2400)
  }

  throw lastError ?? new ProviderError(req.provider, 'échec inattendu', null, false)
}

/**
 * Envoie un `GET` JSON. Sert au « Test connection » et à la liste des modèles.
 * Ne reprend pas : un test de connexion doit dire tout de suite ce qu'il a vu.
 */
export async function getJson<T>(req: Omit<JsonRequest, 'body'>): Promise<T> {
  const timeout = AbortSignal.timeout(20_000)
  const signal = req.signal ? AbortSignal.any([req.signal, timeout]) : timeout
  let res: Response
  try {
    res = await fetch(req.url, { headers: req.headers, signal })
  } catch (e) {
    throw new ProviderError(req.provider, req.redact(`injoignable : ${(e as Error).message}`), null, true)
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new ProviderError(
      req.provider,
      req.redact(`HTTP ${res.status} ${res.statusText} — ${summarizeBody(text)}`),
      res.status,
      res.status === 429 || res.status >= 500,
    )
  }
  return (await res.json()) as T
}

/**
 * Résume un corps d'erreur.
 *
 * Les fournisseurs répondent parfois une page HTML de plusieurs kilo-octets ; la
 * recopier dans une erreur rend la vraie cause illisible et la fait voyager
 * jusque dans le journal du daemon.
 */
function summarizeBody(text: string): string {
  const trimmed = text.trim()
  if (!trimmed) return '(corps vide)'
  try {
    const parsed = JSON.parse(trimmed) as { error?: { message?: string } | string; message?: string }
    const message =
      typeof parsed.error === 'string' ? parsed.error : (parsed.error?.message ?? parsed.message)
    if (message) return message.slice(0, 500)
  } catch {
    // Pas du JSON : on retombe sur la troncature brute.
  }
  return trimmed.slice(0, 300)
}

/** Délai demandé par un en-tête `Retry-After`, en millisecondes. `null` s'il est absent ou absurde. */
function retryAfterMs(res: Response): number | null {
  const header = res.headers.get('retry-after')
  if (!header) return null
  const seconds = Number(header)
  // Plafonné à trente secondes : au-delà, mieux vaut rendre l'erreur et laisser
  // l'utilisateur décider que de retenir une tâche sans rien lui dire.
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, 30_000)
  return null
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}
