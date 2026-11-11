/**
 * @file Contrôles d'accès de l'API locale.
 *
 * Le daemon n'écoute que sur `127.0.0.1`, mais « local » ne veut pas dire
 * « sûr » : le navigateur de l'utilisateur est local, et une page web
 * malveillante peut lui faire émettre des requêtes vers le harness. C'est **le**
 * modèle de menace de cette API. Un autre processus du même utilisateur, lui, peut
 * de toute façon lire le fichier de découverte : on ne prétend pas s'en protéger.
 *
 * Trois défenses, complémentaires :
 *
 *  1. **`Host` exact.** Une page peut faire pointer son propre nom de domaine
 *     vers `127.0.0.1` (DNS rebinding) ; le navigateur enverra alors ce nom dans
 *     `Host`, et on refuse tout ce qui n'est pas `127.0.0.1:<port>` ou
 *     `localhost:<port>`.
 *  2. **`Origin` en liste blanche.** Absente (serveur MCP, CLI, `curl`) ou
 *     exactement celle du dashboard. Toute autre origine est refusée, y compris
 *     sur les requêtes simples que le navigateur enverrait sans préflight.
 *  3. **Jeton porteur.** Comparé à temps constant, obligatoire sur `/api` et sur
 *     la WebSocket.
 *
 * S'y ajoute `Sec-Fetch-Site` quand le navigateur le fournit : il dit directement
 * si la requête vient de la même origine, sans qu'on ait à le déduire.
 */
import { timingSafeEqual } from 'node:crypto'
import type { IncomingMessage } from 'node:http'

/** Ce dont les contrôles ont besoin : le port réellement écouté et le jeton attendu. */
export interface SecurityContext {
  port: number
  /** `Bearer <jeton>` précalculé, pour une comparaison à temps constant. */
  expectedAuthorization: Buffer
}

/** Refus, à traduire en réponse HTTP. */
export interface Denial {
  status: number
  error: string
}

/** Construit le contexte de sécurité à partir du port et du jeton du daemon. */
export function securityContext(port: number, token: string): SecurityContext {
  return { port, expectedAuthorization: Buffer.from(`Bearer ${token}`) }
}

/** Origines acceptées pour le dashboard : les deux écritures de la boucle locale. */
function allowedOrigins(port: number): string[] {
  return [`http://127.0.0.1:${port}`, `http://localhost:${port}`]
}

/**
 * Vérifie l'enveloppe de la requête : `Host`, `Origin`, `Sec-Fetch-Site`.
 * S'applique à **tout**, y compris aux fichiers du dashboard.
 * @returns `null` si la requête est acceptable, sinon le refus
 */
export function checkEnvelope(req: IncomingMessage, ctx: SecurityContext): Denial | null {
  const host = req.headers.host
  if (host !== `127.0.0.1:${ctx.port}` && host !== `localhost:${ctx.port}`) {
    return { status: 403, error: 'forbidden_host' }
  }
  const origin = req.headers.origin
  if (origin !== undefined && !allowedOrigins(ctx.port).includes(origin)) {
    return { status: 403, error: 'forbidden_origin' }
  }
  // `none` = saisie directe dans la barre d'adresse ou signet ; `same-origin` =
  // requête du dashboard lui-même. `cross-site` et `same-site` sont refusés.
  const site = req.headers['sec-fetch-site']
  if (typeof site === 'string' && site !== 'same-origin' && site !== 'none') {
    return { status: 403, error: 'forbidden_fetch_site' }
  }
  return null
}

/**
 * Vérifie le jeton porteur.
 *
 * `timingSafeEqual` évite qu'on puisse deviner le jeton octet par octet en
 * mesurant le temps de réponse ; il exige des tailles égales, d'où la
 * vérification de longueur préalable — qui ne fuite que la longueur du jeton,
 * laquelle est fixe et publique.
 */
export function checkToken(req: IncomingMessage, ctx: SecurityContext): Denial | null {
  const got = Buffer.from(req.headers.authorization ?? '')
  const ok = got.length === ctx.expectedAuthorization.length && timingSafeEqual(got, ctx.expectedAuthorization)
  return ok ? null : { status: 401, error: 'unauthorized' }
}

/**
 * Vérifie le jeton d'une connexion WebSocket, transmis par le sous-protocole.
 *
 * L'API WebSocket des navigateurs ne permet pas de poser un en-tête
 * `Authorization` : le sous-protocole est le seul champ que le code de la page
 * peut remplir. La comparaison reste à temps constant.
 *
 * @param protocols valeur de `Sec-WebSocket-Protocol`, telle qu'envoyée
 * @param prefix    préfixe du sous-protocole porteur du jeton
 */
export function checkWebSocketToken(
  protocols: string | undefined,
  prefix: string,
  ctx: SecurityContext,
): Denial | null {
  const offered = (protocols ?? '').split(',').map((p) => p.trim())
  const carried = offered.find((p) => p.startsWith(prefix))
  if (!carried) return { status: 401, error: 'unauthorized' }
  const got = Buffer.from(`Bearer ${carried.slice(prefix.length)}`)
  const ok = got.length === ctx.expectedAuthorization.length && timingSafeEqual(got, ctx.expectedAuthorization)
  return ok ? null : { status: 401, error: 'unauthorized' }
}
