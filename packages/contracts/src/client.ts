/**
 * @file Client HTTP authentifié vers le daemon, partagé par le serveur MCP, la
 * CLI et les tests.
 */
import type { RuntimeInfo } from './protocol.ts'

/**
 * Appelle l'API du daemon avec le jeton d'accès.
 *
 * Passe toujours par `127.0.0.1` et jamais par `localhost`, qui peut résoudre en
 * IPv6 (`::1`) alors que le daemon n'écoute qu'en IPv4.
 *
 * @param rt   informations lues par `readRuntime`
 * @param path chemin de l'API, par exemple `/api/tasks/<id>/wait?timeout_ms=15000`
 * @param init options `fetch` ; `signal` permet d'interrompre un long-poll
 * @throws si le daemon est injoignable (erreur réseau de `fetch`)
 */
export async function daemonFetch(rt: RuntimeInfo, path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`http://127.0.0.1:${rt.port}${path}`, {
    ...init,
    headers: { ...init.headers, authorization: `Bearer ${rt.token}`, 'content-type': 'application/json' },
  })
}

/**
 * Appelle le daemon et parse sa réponse JSON.
 * @returns le code HTTP et le corps parsé, à interpréter par l'appelant : une
 *          réponse d'erreur du daemon est une information, pas une exception
 */
export async function daemonJson<T>(
  rt: RuntimeInfo,
  path: string,
  init: RequestInit = {},
): Promise<{ status: number; body: T }> {
  const res = await daemonFetch(rt, path, init)
  return { status: res.status, body: (await res.json()) as T }
}
