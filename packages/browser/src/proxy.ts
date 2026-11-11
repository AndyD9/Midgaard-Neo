/**
 * @file Le proxy gardé du navigateur (Slice 7, étape 3) : toute requête de
 * Chromium passe par lui, et il ne joint que l'internet public.
 *
 * ## Pourquoi un proxy, et pas l'interception de Playwright
 *
 * Intercepter les requêtes dans la page (`route`) jugerait un **nom**, que le
 * navigateur résoudrait ensuite lui-même : entre les deux, le DNS peut changer
 * de réponse (*DNS rebinding*) et mener une page publique vers `127.0.0.1` ou
 * le service de métadonnées du cloud. L'interception ne voit pas non plus les
 * WebSocket ouvertes par la page. Un proxy, lui, voit **tout** ce qui sort, et
 * se connecte **à l'adresse qu'il a vérifiée**, jamais au nom : la réponse DNS
 * jugée est celle qui sert.
 *
 * Il applique la règle d'`http_fetch` (`assertPublicHost`, paquet `tools`) :
 * adresses privées, boucle locale et IMDS refusées, sans exception ni liste
 * blanche. La garde est **injectable** pour que les tests servent leur page
 * locale ; le daemon passe toujours la vraie.
 *
 * Chromium contourne d'office un proxy pour la boucle locale. Playwright l'en
 * empêche, sauf variable d'environnement contraire ; la session le lui
 * redemande donc elle-même (`--proxy-bypass-list=<-loopback>`), sans quoi
 * `http://127.0.0.1` passerait à côté de la garde.
 */
import { createServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { connect, type Socket } from 'node:net'

/**
 * Juge un hôte : rend les adresses où se connecter, ou lève avec le motif du
 * refus. La vraie est `assertPublicHost`.
 */
export type HostGuard = (hostname: string) => Promise<string[]>

/** Un refus, tel que le proxy le rapporte. */
export interface ProxyRefusal {
  host: string
  reason: string
}

/** Un proxy gardé démarré. */
export interface GuardedProxy {
  /** Port d'écoute, sur `127.0.0.1`. */
  port: number
  close(): Promise<void>
}

/** En-têtes propres au proxy, qui ne doivent pas atteindre le serveur visé. */
const HOP_BY_HOP = ['proxy-connection', 'proxy-authorization', 'proxy-authenticate', 'connection', 'keep-alive']

/**
 * Sépare `hôte:port` d'une requête `CONNECT`, IPv6 entre crochets compris.
 * @returns `null` si la forme est invalide
 */
export function splitHostPort(target: string): { host: string; port: number } | null {
  const match = /^\[([^\]]+)\]:(\d+)$/.exec(target) ?? /^([^:]+):(\d+)$/.exec(target)
  if (!match) return null
  const port = Number(match[2])
  return Number.isInteger(port) && port > 0 && port < 65536 ? { host: match[1]!, port } : null
}

/**
 * Démarre le proxy sur la boucle locale.
 *
 * @param guard     juge chaque hôte avant toute connexion
 * @param onRefused prévient de chaque refus, pour que la session le dise au modèle
 */
export async function startGuardedProxy(options: {
  guard: HostGuard
  onRefused?: ((refusal: ProxyRefusal) => void) | undefined
}): Promise<GuardedProxy> {
  const sockets = new Set<Socket>()
  /** Juge un hôte ; `null` et le refus signalé s'il est interdit. */
  const judge = async (host: string): Promise<string | null> => {
    try {
      const [address] = await options.guard(host)
      if (address) return address
      throw new Error(`cannot resolve host: ${host}`)
    } catch (e) {
      options.onRefused?.({ host, reason: (e as Error).message })
      return null
    }
  }

  // HTTP en clair : la requête porte l'URL entière, à relayer vers l'adresse jugée.
  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      let target: URL
      try {
        target = new URL(req.url ?? '')
      } catch {
        res.writeHead(400).end('bad proxy request')
        return
      }
      if (target.protocol !== 'http:') {
        res.writeHead(400).end('only http:// is proxied in clear')
        return
      }
      const address = await judge(target.hostname)
      if (!address) {
        res.writeHead(403, { 'content-type': 'text/plain' }).end('refused by Midgaard: private or unresolvable host')
        return
      }
      const headers: Record<string, string | string[] | undefined> = { ...req.headers, host: target.host }
      for (const h of HOP_BY_HOP) delete headers[h]
      const upstream = httpRequest(
        { host: address, port: Number(target.port || 80), method: req.method, path: target.pathname + target.search, headers, setHost: false },
        (up) => {
          res.writeHead(up.statusCode ?? 502, up.headers)
          up.pipe(res)
        },
      )
      upstream.on('error', () => res.headersSent ? res.destroy() : res.writeHead(502).end('upstream error'))
      req.pipe(upstream)
    })()
  })

  // HTTPS et WebSocket : un tunnel `CONNECT`, ouvert vers l'adresse jugée.
  server.on('connect', (req: IncomingMessage, client: Socket, head: Buffer) => {
    sockets.add(client)
    client.on('close', () => sockets.delete(client))
    client.on('error', () => client.destroy())
    void (async () => {
      const target = splitHostPort(req.url ?? '')
      if (!target) {
        client.end('HTTP/1.1 400 Bad Request\r\n\r\n')
        return
      }
      const address = await judge(target.host)
      if (!address) {
        client.end('HTTP/1.1 403 Forbidden\r\n\r\n')
        return
      }
      const upstream = connect(target.port, address, () => {
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n')
        if (head.length) upstream.write(head)
        upstream.pipe(client)
        client.pipe(upstream)
      })
      sockets.add(upstream)
      upstream.on('close', () => sockets.delete(upstream))
      upstream.on('error', () => client.destroy())
    })()
  })

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : 0
  return {
    port,
    close: () =>
      new Promise<void>((resolve) => {
        for (const s of sockets) s.destroy()
        server.close(() => resolve())
        server.closeAllConnections()
      }),
  }
}
