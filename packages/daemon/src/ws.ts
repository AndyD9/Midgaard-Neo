/**
 * @file Diffusion temps réel vers le dashboard, en WebSocket.
 *
 * **La reprise est le point délicat.** Une coupure de quelques secondes suffit à
 * faire manquer des événements ; si le client se contentait de se reconnecter, sa
 * timeline aurait un trou invisible — l'affichage paraîtrait cohérent tout en
 * étant faux. Le client mémorise donc la dernière séquence globale reçue et la
 * renvoie dans `?since=` ; le serveur répond par un instantané complet **et** les
 * événements manqués, dans l'ordre.
 *
 * Si l'écart est trop grand (`MAX_REPLAY_EVENTS`), le serveur le dit
 * (`truncated: true`) au lieu de déverser tout le journal : l'instantané décrit
 * de toute façon l'état courant, seul l'historique intermédiaire est perdu, et le
 * client peut le recharger tâche par tâche.
 *
 * Authentification : le jeton passe par le sous-protocole, seul champ que l'API
 * WebSocket des navigateurs laisse remplir (voir `security.ts`).
 */
import type { IncomingMessage, Server } from 'node:http'
import type { Duplex } from 'node:stream'
import { WebSocketServer, type WebSocket } from 'ws'
import {
  MAX_REPLAY_EVENTS,
  WS_SUBPROTOCOL,
  WS_TOKEN_PREFIX,
  type Health,
  type ServerMessage,
} from '@midgaard/contracts'
import type { HarnessStore } from '@midgaard/persistence'
import type { EventBus } from './bus.ts'
import { checkEnvelope, checkWebSocketToken, type SecurityContext } from './security.ts'

/** Chemin de la WebSocket. */
export const WS_PATH = '/events'

/** Ce dont le diffuseur a besoin du daemon pour composer ses messages. */
export interface EventStreamDeps {
  store: HarnessStore
  bus: EventBus
  security: () => SecurityContext
  /** État de santé courant, recalculé à chaque instantané. */
  health: () => Health
  log: (...a: unknown[]) => void
  /** Prévient le daemon d'une activité : repousse l'arrêt pour inactivité. */
  touch: () => void
}

/** Serveur WebSocket du dashboard : instantané, reprise, diffusion. */
export class EventStream {
  private readonly deps: EventStreamDeps
  private readonly wss: WebSocketServer
  private readonly sockets = new Set<WebSocket>()
  private unsubscribe: (() => void)[] = []

  constructor(deps: EventStreamDeps) {
    this.deps = deps
    // `noServer` : on gère l'upgrade nous-mêmes, pour appliquer les mêmes
    // contrôles d'enveloppe qu'aux requêtes HTTP avant d'accepter la connexion.
    this.wss = new WebSocketServer({ noServer: true })
    this.unsubscribe.push(
      deps.bus.subscribe(({ event, task }) => this.broadcast({ type: 'event', event, task })),
      deps.bus.subscribeApprovals((approval) => this.broadcast({ type: 'approval', approval })),
    )
  }

  /** Nombre de dashboards connectés. Un client connecté empêche l'arrêt pour inactivité. */
  get clientCount(): number {
    return this.sockets.size
  }

  /** Branche la gestion des upgrades sur le serveur HTTP. */
  attach(server: Server): void {
    server.on('upgrade', (req, socket, head) => this.handleUpgrade(req, socket, head))
  }

  private reject(socket: Duplex, status: number, error: string): void {
    socket.write(`HTTP/1.1 ${status} ${error}\r\nconnection: close\r\n\r\n`)
    socket.destroy()
  }

  private handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    const ctx = this.deps.security()
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${ctx.port}`)
    if (url.pathname !== WS_PATH) return this.reject(socket, 404, 'not_found')

    const denial =
      checkEnvelope(req, ctx) ??
      checkWebSocketToken(req.headers['sec-websocket-protocol'], WS_TOKEN_PREFIX, ctx)
    if (denial) {
      this.deps.log(`upgrade WebSocket refusé : ${denial.error}`)
      return this.reject(socket, denial.status, denial.error)
    }

    // On n'accepte que le sous-protocole d'application : renvoyer celui qui porte
    // le jeton l'exposerait dans l'en-tête de réponse, et donc dans les journaux
    // de n'importe quel intermédiaire.
    this.wss.handleUpgrade(req, socket, head, (ws) => {
      const since = Number(url.searchParams.get('since') ?? 0)
      this.welcome(ws, Number.isFinite(since) && since > 0 ? since : 0)
    })
  }

  /** Enregistre la connexion et lui envoie son instantané. */
  private welcome(ws: WebSocket, since: number): void {
    this.sockets.add(ws)
    this.deps.touch()
    this.deps.log(`dashboard connecté (reprise depuis la séquence ${since}, ${this.sockets.size} client(s))`)

    const last = this.deps.store.lastSeq()
    const missed = since > 0 && since < last ? this.deps.store.eventsSince(since, MAX_REPLAY_EVENTS + 1) : []
    const truncated = missed.length > MAX_REPLAY_EVENTS
    this.send(ws, {
      type: 'snapshot',
      seq: last,
      tasks: this.deps.store.listTasks({ limit: 200 }),
      approvals: this.deps.store.pendingApprovals(),
      events: truncated ? [] : missed,
      truncated,
      health: this.deps.health(),
    })

    ws.on('message', () => this.deps.touch())
    ws.on('close', () => {
      this.sockets.delete(ws)
      this.deps.log(`dashboard déconnecté (${this.sockets.size} restant(s))`)
    })
    ws.on('error', () => ws.terminate())
  }

  /** Envoie un message à tous les dashboards connectés. */
  broadcast(message: ServerMessage): void {
    for (const ws of this.sockets) this.send(ws, message)
  }

  /** Sérialise et envoie, en ignorant une socket déjà morte. */
  private send(ws: WebSocket, message: ServerMessage): void {
    if (ws.readyState !== ws.OPEN) return
    try {
      ws.send(JSON.stringify(message))
    } catch {}
  }

  /** Ferme toutes les connexions et se désabonne du bus. */
  close(): void {
    for (const off of this.unsubscribe) off()
    this.unsubscribe = []
    for (const ws of this.sockets) ws.close(1001, 'daemon shutting down')
    this.sockets.clear()
    this.wss.close()
  }
}

/** Sous-protocole annoncé au client, exporté pour le dashboard et les tests. */
export { WS_SUBPROTOCOL, WS_TOKEN_PREFIX }
