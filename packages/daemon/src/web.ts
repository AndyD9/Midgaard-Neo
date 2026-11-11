/**
 * @file Le web des tâches, lu par un navigateur (`search_web`,
 * `read_web_page`) : au plus un Chromium par tâche, ouvert à son premier appel
 * et fermé avec elle.
 *
 * À côté des sessions du Navigator (`browsers.ts`), et volontairement à part :
 * celles-là s'approuvent, se montrent en captures et se pilotent ; ici l'agent
 * ne fait que **charger une adresse publique et lire son texte**, sous la
 * politique d'`http_fetch`. Rien n'est cliqué ni saisi, donc rien n'est à
 * approuver au-delà de ce que cette politique demande.
 *
 * Ce que ce module tient :
 *
 *  - **un navigateur par tâche, ouvert à la demande** : une tâche qui ne
 *    cherche rien ne lance pas Chromium, et un daemon qui ne cherche jamais ne
 *    charge pas Playwright ;
 *  - **un appel à la fois par tâche** : le navigateur n'a qu'une page, et deux
 *    lectures simultanées se marcheraient dessus ;
 *  - **fermé au repos** (`idleMs`) : avec `webBrowser: 'window'`, c'est une
 *    fenêtre sur l'écran de l'utilisateur, qui ne doit pas y rester le temps
 *    d'une longue conversation. L'appel suivant en rouvre un ;
 *  - **fermé à la fin de la tâche et à l'arrêt du daemon** ; tué net, c'est la
 *    garde des processus qui tue Chromium (paquet `browser`) ;
 *  - **le repli sans fenêtre** : si la fenêtre ne peut pas s'ouvrir (poste
 *    sans écran), le navigateur s'ouvre sans, et le journal le dit une fois.
 *
 * La garde réseau est celle du Navigator ({@link defaultBrowserGuard}) :
 * adresses publiques seulement, plus la liste blanche sous `allowlist`.
 */
import type { HarnessConfig } from '@midgaard/contracts'
import { ToolError, type WebPort } from '@midgaard/tools'
import type { BrowserSession, BrowserSessionOptions, HostGuard } from '@midgaard/browser'
import { SEARCH_ENGINES, searchEngineHost, searchWeb, type SearchEngine } from '@midgaard/browser/search'
import { defaultBrowserGuard } from './browsers.ts'

/** Délai de repos après lequel le navigateur d'une tâche se ferme, en millisecondes. */
export const WEB_IDLE_MS = 120_000

/** Ce que le gestionnaire emprunte au daemon. */
export interface WebReadersDeps {
  config: Pick<HarnessConfig, 'httpPolicy' | 'allowHosts' | 'webBrowser'>
  log: (...a: unknown[]) => void
  /** Juge chaque hôte ; {@link defaultBrowserGuard} par défaut. Les tests passent la leur. */
  guard?: HostGuard | undefined
  /** Ouvre une session ; `BrowserSession.open` par défaut, chargé au premier appel. */
  openSession?: ((options: BrowserSessionOptions) => Promise<BrowserSession>) | undefined
  /** Moteurs de recherche ; ceux du paquet `browser` par défaut. Les tests passent le leur. */
  engines?: readonly SearchEngine[] | undefined
  /** Délai de repos ; {@link WEB_IDLE_MS} par défaut. */
  idleMs?: number | undefined
}

/** Le navigateur d'une tâche. */
interface Live {
  /** La session, ou son ouverture en cours ; `null` quand elle est fermée au repos. */
  session: Promise<BrowserSession> | null
  /** File des appels : chacun attend le précédent. */
  queue: Promise<unknown>
  timer: NodeJS.Timeout | null
}

/** Les navigateurs de lecture de toutes les tâches du daemon. */
export class WebReaders {
  private readonly deps: WebReadersDeps
  private readonly engines: readonly SearchEngine[]
  private readonly live = new Map<string, Live>()
  /** Tâches terminées : aucun navigateur ne s'y rouvre, même pour un appel en vol. */
  private readonly ended = new Set<string>()
  private stopped = false
  /** Vrai une fois la fenêtre refusée par le poste : on ne la retente pas à chaque appel. */
  private windowUnavailable = false

  constructor(deps: WebReadersDeps) {
    this.deps = deps
    this.engines = deps.engines ?? SEARCH_ENGINES
  }

  /** Le port d'une tâche : ce que ses outils peuvent faire du web. */
  portFor(taskId: string): WebPort {
    return {
      searchHosts: () => this.engines.map(searchEngineHost),
      search: (query) => this.run(taskId, (session) => searchWeb(session, query, this.engines)),
      read: (url) =>
        this.run(taskId, async (session) => {
          await session.goto(url)
          return session.readPage()
        }),
    }
  }

  /** Nombre de navigateurs ouverts, pour les tests et le diagnostic. */
  get openCount(): number {
    return [...this.live.values()].filter((l) => l.session !== null).length
  }

  /** La tâche s'arrête : son navigateur se ferme, et aucun autre ne s'ouvrira. */
  async endTask(taskId: string): Promise<void> {
    this.ended.add(taskId)
    const l = this.live.get(taskId)
    this.live.delete(taskId)
    if (l) await this.closeLive(l)
  }

  /** Ferme tous les navigateurs : à l'arrêt du daemon. */
  async closeAll(): Promise<void> {
    this.stopped = true
    const all = [...this.live.values()]
    this.live.clear()
    await Promise.all(all.map((l) => this.closeLive(l)))
  }

  /**
   * Exécute un appel dans le navigateur de la tâche, après les précédents.
   * Une erreur du navigateur devient un refus lisible par le modèle.
   */
  private run<T>(taskId: string, action: (session: BrowserSession) => Promise<T>): Promise<T> {
    let l = this.live.get(taskId)
    if (!l) {
      l = { session: null, queue: Promise.resolve(), timer: null }
      this.live.set(taskId, l)
    }
    const state = l
    const result = state.queue.then(async () => {
      if (this.stopped || this.ended.has(taskId)) throw new ToolError('this task is ending: the web browser is closed')
      if (state.timer) clearTimeout(state.timer)
      state.timer = null
      state.session ??= this.openSession()
      let session: BrowserSession
      try {
        session = await state.session
      } catch (e) {
        state.session = null
        throw new ToolError((e as Error).message)
      }
      // La tâche a pu finir pendant le lancement de Chromium : `endTask` n'a
      // alors vu qu'une ouverture en cours, qu'il a attendue et fermée.
      if (session.isClosed) throw new ToolError('this task is ending: the web browser is closed')
      try {
        return await action(session)
      } catch (e) {
        throw e instanceof ToolError ? e : new ToolError((e as Error).message.split('\n')[0] ?? 'the web browser failed')
      } finally {
        if (this.live.get(taskId) === state) {
          state.timer = setTimeout(() => void this.closeIdle(state), this.deps.idleMs ?? WEB_IDLE_MS)
          // Un navigateur au repos ne retient pas le daemon.
          state.timer.unref()
        }
      }
    })
    // La file continue après un échec : l'appel suivant n'hérite pas de l'erreur.
    state.queue = result.catch(() => {})
    return result
  }

  /** Ferme le navigateur d'une tâche au repos ; la tâche garde sa place, et le rouvrira. */
  private async closeIdle(l: Live): Promise<void> {
    // Passe par la file : jamais sous un appel en cours.
    l.queue = l.queue.then(async () => {
      const session = l.session
      l.session = null
      l.timer = null
      await session?.then((s) => s.close()).catch(() => {})
    })
    await l.queue
  }

  private async closeLive(l: Live): Promise<void> {
    if (l.timer) clearTimeout(l.timer)
    l.timer = null
    const session = l.session
    l.session = null
    // Une ouverture en cours est attendue puis fermée : sans cela, un Chromium
    // lancé juste avant la fin de la tâche lui survivrait.
    await session?.then((s) => s.close()).catch(() => {})
  }

  private async openSession(): Promise<BrowserSession> {
    const open = async (options: BrowserSessionOptions): Promise<BrowserSession> => {
      if (this.deps.openSession) return this.deps.openSession(options)
      const { BrowserSession } = await import('@midgaard/browser')
      return BrowserSession.open(options)
    }
    const options: BrowserSessionOptions = {
      guard: this.deps.guard ?? defaultBrowserGuard(this.deps.config),
      log: (m) => this.deps.log(m),
    }
    if (this.deps.config.webBrowser === 'window' && !this.windowUnavailable) {
      try {
        return await open({ ...options, headless: false })
      } catch (e) {
        this.windowUnavailable = true
        this.deps.log(
          `navigateur web : la fenêtre n'a pas pu s'ouvrir (${(e as Error).message.split('\n')[0]}) — ` +
            'repli sans fenêtre, où les moteurs de recherche refusent souvent de répondre',
        )
      }
    }
    return open({ ...options, headless: true })
  }
}
