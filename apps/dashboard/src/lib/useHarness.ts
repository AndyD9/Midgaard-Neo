/**
 * @file Connexion temps réel au daemon, et état du dashboard.
 *
 * **La reprise après coupure est le point délicat.** Une WebSocket qui se
 * rouvre naïvement laisse un trou invisible dans la timeline : l'affichage
 * paraît cohérent alors qu'il manque des événements. On mémorise donc la
 * dernière séquence globale reçue et on la renvoie dans `?since=` ; le daemon
 * répond par un instantané complet **et** les événements manqués.
 *
 * Si l'écart est trop grand, le daemon le dit (`truncated`) : on l'affiche au
 * lieu de faire semblant. L'état courant reste juste — c'est l'instantané — seul
 * l'historique intermédiaire manque, et il se recharge tâche par tâche.
 *
 * Le jeton passe par le sous-protocole : l'API WebSocket des navigateurs ne
 * permet pas de poser un en-tête `Authorization`.
 *
 * **Une page plus vieille que son daemon se recharge** à la reconnexion
 * (`bundle.ts`) : sans cela, l'ancien code recevait des données qu'il ne
 * connaissait pas, et la fenêtre desktop finissait vide.
 */
import { useCallback, useEffect, useReducer, useRef } from 'react'
import type { Approval, Health, ServerMessage, Task, TaskEvent } from '@midgaard/contracts'
import { bootstrap, currentToken, fetchTaskEvents, forgetToken } from './api'
import { bundleChanged } from './bundle'
import { appendEvent, mergeTimeline, unwatchTimeline, watchTimeline } from './timeline'

/**
 * Dit si le daemon sert maintenant un autre bundle que celui de la page.
 * Une erreur réseau vaut « non » : la tentative de connexion qui suit la
 * verra, et la reprogrammera.
 */
async function servedBundleChanged(): Promise<boolean> {
  const own = document.querySelector('script[type="module"][src]')?.getAttribute('src') ?? null
  try {
    const res = await fetch('/', { cache: 'no-store' })
    return res.ok && bundleChanged(own, await res.text())
  } catch {
    return false
  }
}

/**
 * Sous-protocoles WebSocket, repris de `@midgaard/contracts`
 * (`WS_SUBPROTOCOL`, `WS_TOKEN_PREFIX`).
 *
 * Recopiés et non importés : le point d'entrée de `contracts` charge des modules
 * Node (`node:os`, `node:fs`) qui n'ont pas leur place dans un paquet navigateur.
 * Seuls les **types** en sont importés, et ils disparaissent à la compilation.
 * Toute modification de ces deux valeurs doit être répercutée ici.
 */
const WS_SUBPROTOCOL = 'midgaard.v1'
const WS_TOKEN_PREFIX = 'midgaard-token.'

/** Délais de reconnexion, en millisecondes : rapide d'abord, puis on s'espace. */
const BACKOFF_MS = [300, 700, 1500, 3000, 6000, 10_000]

export type ConnectionStatus = 'connecting' | 'open' | 'closed'

export interface HarnessState {
  status: ConnectionStatus
  /** Dernière séquence globale reçue ; renvoyée au daemon à la reconnexion. */
  seq: number
  tasks: Task[]
  approvals: Approval[]
  health: Health | null
  /** Timeline par tâche, chargée à la demande puis tenue à jour en direct. */
  events: Record<string, TaskEvent[]>
  /** Vrai si une reprise a été tronquée : l'historique intermédiaire manque. */
  gap: boolean
  /** Message d'erreur à afficher ; `null` si tout va bien. */
  error: string | null
}

type Action =
  | { kind: 'status'; status: ConnectionStatus }
  | { kind: 'message'; message: ServerMessage }
  | { kind: 'events'; taskId: string; events: TaskEvent[] }
  | { kind: 'watch'; taskId: string }
  | { kind: 'unwatch'; taskId: string }
  | { kind: 'error'; error: string | null }

const initialState: HarnessState = {
  status: 'connecting',
  seq: 0,
  tasks: [],
  approvals: [],
  health: null,
  events: {},
  gap: false,
  error: null,
}

/** Insère ou remplace une tâche, en gardant l'ordre « plus récente d'abord ». */
function upsertTask(tasks: Task[], task: Task): Task[] {
  const without = tasks.filter((t) => t.id !== task.id)
  return [task, ...without].sort((a, b) => b.created_at.localeCompare(a.created_at))
}

function reduce(state: HarnessState, action: Action): HarnessState {
  switch (action.kind) {
    case 'status':
      return { ...state, status: action.status }
    case 'error':
      return { ...state, error: action.error }
    case 'watch':
      return { ...state, events: watchTimeline(state.events, action.taskId) }
    case 'unwatch':
      return { ...state, events: unwatchTimeline(state.events, action.taskId) }
    case 'events':
      // Fusionnée, jamais remplacée : voir la course décrite dans `timeline.ts`.
      return { ...state, events: mergeTimeline(state.events, action.taskId, action.events) }
    case 'message': {
      const m = action.message
      if (m.type === 'snapshot') {
        // Les événements rejoués sont appliqués après l'instantané : ils ne
        // servent qu'à combler les timelines déjà ouvertes.
        let events = state.events
        for (const e of m.events) events = appendEvent(events, e)
        return {
          ...state,
          seq: m.seq,
          tasks: [...m.tasks].sort((a, b) => b.created_at.localeCompare(a.created_at)),
          approvals: m.approvals,
          health: m.health,
          events,
          gap: state.gap || m.truncated,
          error: null,
        }
      }
      if (m.type === 'event') {
        return {
          ...state,
          seq: Math.max(state.seq, m.event.seq),
          tasks: upsertTask(state.tasks, m.task),
          events: appendEvent(state.events, m.event),
        }
      }
      if (m.type === 'approval') {
        const others = state.approvals.filter((a) => a.id !== m.approval.id)
        return { ...state, approvals: m.approval.status === 'pending' ? [...others, m.approval] : others }
      }
      return { ...state, health: m.health }
    }
  }
}

/**
 * Se connecte au daemon et tient l'état du dashboard à jour.
 *
 * @returns l'état, et `loadEvents` pour charger la timeline complète d'une tâche
 */
export function useHarness() {
  const [state, dispatch] = useReducer(reduce, initialState)
  // La séquence vit aussi dans une ref : la fonction de connexion est créée une
  // seule fois et ne doit pas capturer une valeur figée.
  const seqRef = useRef(0)
  const socketRef = useRef<WebSocket | null>(null)
  const attemptRef = useRef(0)
  const closedRef = useRef(false)
  // Vrai dès une première connexion réussie : seule une page qui a déjà parlé
  // à un daemon peut lui avoir survécu.
  const everOpenRef = useRef(false)

  useEffect(() => {
    seqRef.current = state.seq
  }, [state.seq])

  useEffect(() => {
    closedRef.current = false
    let retry: ReturnType<typeof setTimeout> | undefined

    /** Ouvre la WebSocket, après avoir obtenu un jeton si besoin. */
    async function connect(): Promise<void> {
      if (closedRef.current) return
      dispatch({ kind: 'status', status: 'connecting' })
      try {
        if (!currentToken()) {
          // Sans jeton après une première connexion : la WebSocket s'est
          // fermée, peut-être parce que le daemon a été remplacé. Si celui
          // qui répond sert un autre bundle, on recharge plutôt que de faire
          // tourner l'ancien code contre lui. Le fragment de l'URL garde la
          // tâche ouverte.
          if (everOpenRef.current && (await servedBundleChanged())) {
            location.reload()
            return
          }
          await bootstrap()
        }
      } catch (e) {
        // Retour à `closed` : sans lui, une tentative qui échouait ici laissait
        // le bandeau sur « connexion… » pour toujours, daemon mort compris —
        // la page ne disait plus jamais « déconnecté ». Vu par D7 dès qu'un
        // rechargement le précédait (Slice 7, étape 6).
        dispatch({ kind: 'status', status: 'closed' })
        dispatch({ kind: 'error', error: `daemon injoignable : ${(e as Error).message}` })
        return scheduleRetry()
      }

      const protocol = location.protocol === 'https:' ? 'wss' : 'ws'
      const url = `${protocol}://${location.host}/events?since=${seqRef.current}`
      const ws = new WebSocket(url, [WS_SUBPROTOCOL, WS_TOKEN_PREFIX + currentToken()])
      socketRef.current = ws

      ws.onopen = () => {
        attemptRef.current = 0
        everOpenRef.current = true
        dispatch({ kind: 'status', status: 'open' })
        dispatch({ kind: 'error', error: null })
      }
      ws.onmessage = (e) => dispatch({ kind: 'message', message: JSON.parse(e.data as string) as ServerMessage })
      ws.onclose = () => {
        socketRef.current = null
        // Le jeton change à chaque démarrage du daemon : une fermeture peut
        // vouloir dire « daemon redémarré », auquel cas le jeton en mémoire ne
        // vaut plus rien. On l'oublie pour que la tentative suivante en
        // redemande un — une requête de plus, contre une reconnexion qui
        // sinon ne réussirait jamais.
        forgetToken()
        dispatch({ kind: 'status', status: 'closed' })
        scheduleRetry()
      }
      // Une erreur est toujours suivie d'un `close` : on laisse celui-ci reprogrammer.
      ws.onerror = () => ws.close()
    }

    function scheduleRetry(): void {
      if (closedRef.current) return
      const delay = BACKOFF_MS[Math.min(attemptRef.current, BACKOFF_MS.length - 1)]!
      attemptRef.current += 1
      retry = setTimeout(connect, delay)
    }

    void connect()
    return () => {
      closedRef.current = true
      clearTimeout(retry)
      socketRef.current?.close()
    }
  }, [])

  /**
   * Charge la timeline complète d'une tâche. Elle est ouverte **avant** la
   * requête, pour que le direct s'y accumule pendant qu'elle part (`timeline.ts`).
   */
  const loadEvents = useCallback(async (taskId: string) => {
    dispatch({ kind: 'watch', taskId })
    try {
      const { events } = await fetchTaskEvents(taskId)
      dispatch({ kind: 'events', taskId, events })
    } catch (e) {
      dispatch({ kind: 'unwatch', taskId })
      dispatch({ kind: 'error', error: `timeline indisponible : ${(e as Error).message}` })
    }
  }, [])

  /** Remonte une erreur d'action (approbation, annulation) dans le bandeau. */
  const reportError = useCallback((error: string | null) => dispatch({ kind: 'error', error }), [])

  return { state, loadEvents, reportError }
}
