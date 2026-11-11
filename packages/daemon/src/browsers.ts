/**
 * @file Les sessions de navigateur des tâches (Slice 7, étape 4) : au plus une
 * par tâche, qui meurt avec elle.
 *
 * Le paquet `browser` sait ouvrir un Chromium jetable ; les outils savent ce
 * qui s'approuve. Ce module fait le lien, et tient ce qui ne regarde ni l'un
 * ni l'autre :
 *
 *  - **la durée approuvée** : un minuteur ferme la session à son échéance, que
 *    l'agent agisse ou non ;
 *  - **la coupure humaine** : `close` est appelé par la route du dashboard
 *    (`POST /api/tasks/:id/browser/close`), et l'agent apprend à son action
 *    suivante pourquoi la session est fermée ;
 *  - **la fin de la tâche** : le moteur ferme la session de toute tâche qui
 *    s'arrête, et le daemon toutes les sessions à son arrêt. Tué net, c'est la
 *    garde des processus qui tue Chromium (étape 3) ;
 *  - **le récit** : `browser.opened` et `browser.closed` au journal, expurgés.
 *    Les actions, elles, y sont déjà comme appels d'outil ;
 *  - **la dernière capture, en mémoire seulement** : l'atelier la montrera
 *    (étape 6). Aucune image n'est écrite en base (décision 1).
 *
 * La garde réseau est celle d'`http_fetch` — adresses publiques seulement —,
 * plus la liste blanche quand la politique HTTP du daemon est `allowlist` :
 * l'utilisateur qui n'a autorisé que certains hôtes ne les voit pas rouverts
 * par le navigateur. Sous `approval`, l'approbation de la session tient lieu
 * d'approbation des hôtes : une page charge des dizaines de ressources, et
 * demander chacune n'apprendrait qu'à cliquer « oui ».
 */
import type { HarnessConfig } from '@midgaard/contracts'
import {
  assertPublicHost, hostAllowed, ToolError,
  type BrowserCapture, type BrowserNoSession, type BrowserPort, type BrowserSessionInfo,
} from '@midgaard/tools'
import type { BrowserSession, BrowserSessionOptions, HostGuard } from '@midgaard/browser'
import type { EventBus } from './bus.ts'

/** La dernière capture d'une session, telle que l'atelier la montrera. */
export interface BrowserFrame {
  jpeg: Buffer
  url: string
  title: string
  /** Heure de la capture, en millisecondes depuis l'époque. */
  at: number
}

/** Ce que le gestionnaire emprunte au daemon. */
export interface BrowserSessionsDeps {
  bus: EventBus
  config: Pick<HarnessConfig, 'httpPolicy' | 'allowHosts'>
  log: (...a: unknown[]) => void
  /**
   * Juge chaque hôte. Par défaut, {@link defaultBrowserGuard} ; les tests
   * passent la leur pour servir une page locale, que la vraie refuse.
   */
  guard?: HostGuard | undefined
  /**
   * Ouvre une session. Par défaut, `BrowserSession.open` du paquet `browser`,
   * chargé à la première session seulement : un daemon qui ne navigue jamais
   * ne charge pas Playwright.
   */
  openSession?: ((options: BrowserSessionOptions) => Promise<BrowserSession>) | undefined
}

/** Une session vivante. */
interface Live {
  session: BrowserSession
  info: BrowserSessionInfo
  timer: NodeJS.Timeout
  redact: (text: string) => string
  frame: BrowserFrame | null
}

/**
 * La garde du navigateur : l'internet public, et la liste blanche sous la
 * politique `allowlist`.
 */
export function defaultBrowserGuard(config: Pick<HarnessConfig, 'httpPolicy' | 'allowHosts'>): HostGuard {
  return async (host) => {
    if (config.httpPolicy === 'allowlist' && !hostAllowed(host, config.allowHosts)) {
      throw new ToolError(`refused: ${host} is not on the allowlist of this harness (MIDGAARD_HTTP_ALLOW)`)
    }
    return assertPublicHost(host)
  }
}

/** Les sessions de navigateur de toutes les tâches du daemon. */
export class BrowserSessions {
  private readonly deps: BrowserSessionsDeps
  private readonly live = new Map<string, Live>()
  /** Ouvertures en cours : une tâche n'en a qu'une à la fois, même pendant le lancement de Chromium. */
  private readonly opening = new Set<string>()
  /** Pourquoi la dernière session d'une tâche s'est fermée : c'est ce que l'agent lit ensuite. */
  private readonly closedReasons = new Map<string, string>()
  /**
   * Tâches terminées : aucune session ne s'y ouvre plus. Sans cela, une
   * ouverture lancée juste avant la fin de la tâche finirait après elle, et
   * laisserait un Chromium que personne ne fermerait avant l'arrêt du daemon.
   */
  private readonly ended = new Set<string>()
  private stopped = false

  constructor(deps: BrowserSessionsDeps) {
    this.deps = deps
  }

  /**
   * Le port d'une tâche : ce que ses outils peuvent faire de son navigateur.
   *
   * @param redact l'expurgation de la tâche : l'objectif et les adresses
   *               écrits au journal passent par elle
   */
  portFor(taskId: string, redact: (text: string) => string): BrowserPort {
    const live = () => {
      const l = this.live.get(taskId)
      if (!l) throw new ToolError(this.noSessionMessage(taskId))
      return l
    }
    /** Relève une capture, la garde en mémoire pour l'atelier, et la rend à l'outil. */
    const capture = async (l: Live): Promise<BrowserCapture> => {
      const shot = await l.session.screenshot()
      l.frame = { jpeg: shot.jpeg, url: shot.url, title: shot.title, at: Date.now() }
      return { ...shot, focused: await l.session.focused(), viewport: l.session.viewport() }
    }
    /** Exécute une action, puis capture ; une erreur de la session devient un refus lisible. */
    const act = async (run: (s: BrowserSession) => Promise<unknown>): Promise<BrowserCapture> => {
      const l = live()
      try {
        await run(l.session)
        return await capture(l)
      } catch (e) {
        // La session a pu être fermée pendant l'action (échéance, coupure) :
        // le motif de la fermeture explique mieux que l'erreur de Playwright.
        if (!this.live.has(taskId)) throw new ToolError(this.noSessionMessage(taskId))
        throw e instanceof ToolError ? e : new ToolError((e as Error).message)
      }
    }

    return {
      session: (): BrowserSessionInfo | BrowserNoSession => {
        const l = this.live.get(taskId)
        return l ? l.info : { closed_reason: this.closedReasons.get(taskId) ?? null }
      },
      open: async (request) => {
        if (this.stopped || this.ended.has(taskId)) throw new ToolError('this task is ending: no browser can be opened')
        if (this.live.has(taskId) || this.opening.has(taskId)) {
          throw new ToolError('a browser session is already open: use it, or call browser_close first')
        }
        this.opening.add(taskId)
        let session: BrowserSession
        try {
          session = await this.openSession()
        } catch (e) {
          throw new ToolError((e as Error).message)
        } finally {
          this.opening.delete(taskId)
        }
        if (this.stopped || this.ended.has(taskId)) {
          await session.close()
          throw new ToolError('this task ended while the browser was starting: it was closed')
        }
        const expiresAt = Date.now() + request.max_duration_s * 1000
        // Une copie : la liste des textes prévus se vide au fil des saisies.
        const info: BrowserSessionInfo = {
          objective: request.objective,
          start_url: request.url,
          expires_at: expiresAt,
          planned_inputs: request.planned_inputs.map((p) => ({ ...p })),
        }
        const timer = setTimeout(() => {
          void this.close(taskId, 'its approved duration is over')
        }, request.max_duration_s * 1000)
        // Une session ne retient pas le daemon : à son arrêt, `closeAll` la ferme.
        timer.unref()
        const l: Live = { session, info, timer, redact, frame: null }
        this.live.set(taskId, l)
        this.closedReasons.delete(taskId)
        this.deps.bus.record(taskId, null, {
          type: 'browser.opened',
          payload: {
            objective: redact(request.objective),
            start_url: redact(request.url),
            max_duration_s: request.max_duration_s,
            expires_at: new Date(expiresAt).toISOString(),
            // Approuvés avec la session : l'atelier les montre, expurgés comme
            // tout ce qui s'écrit. La version en mémoire, elle, reste exacte.
            planned_inputs: request.planned_inputs.map((p) => ({ text: redact(p.text), press_enter: p.press_enter })),
          },
        })
        return act((s) => s.goto(request.url))
      },
      view: async () => {
        const l = live()
        const state = await l.session.state()
        return { ...state, focused: await l.session.focused() }
      },
      claimPlanned: (input) => {
        const l = this.live.get(taskId)
        if (!l) return false
        const at = l.info.planned_inputs.findIndex((p) => p.text === input.text && p.press_enter === input.press_enter)
        if (at < 0) return false
        l.info.planned_inputs.splice(at, 1)
        return true
      },
      screenshot: () => act(async () => {}),
      goto: (url) => act((s) => s.goto(url)),
      click: (x, y) => act((s) => s.click(x, y)),
      scroll: (dy) => act((s) => s.scroll(dy)),
      type: (text) => act((s) => s.type(text)),
      press: (key) => act((s) => s.press(key)),
      close: async (reason) => {
        await this.close(taskId, reason)
      },
    }
  }

  /** La dernière capture d'une tâche, en mémoire ; `null` sans session ou avant la première. */
  frame(taskId: string): BrowserFrame | null {
    return this.live.get(taskId)?.frame ?? null
  }

  /** La session ouverte d'une tâche, ou `null`. */
  info(taskId: string): BrowserSessionInfo | null {
    return this.live.get(taskId)?.info ?? null
  }

  /** Nombre de sessions ouvertes, pour les tests et le diagnostic. */
  get openCount(): number {
    return this.live.size
  }

  /**
   * Ferme la session d'une tâche, et l'écrit au journal.
   *
   * @param reason ce que l'agent lira à sa prochaine action, en anglais
   * @returns `false` s'il n'y avait pas de session ouverte
   */
  async close(taskId: string, reason: string): Promise<boolean> {
    const l = this.live.get(taskId)
    if (!l) return false
    // Retirée avant d'attendre : une action en vol voit aussitôt la session
    // fermée, et un second appel n'essaie pas de la refermer.
    this.live.delete(taskId)
    this.closedReasons.set(taskId, reason)
    clearTimeout(l.timer)
    // Écrit avant d'attendre la fermeture : à l'arrêt du daemon, la base se
    // ferme juste après `closeAll`, sans l'attendre.
    this.deps.bus.record(taskId, null, { type: 'browser.closed', payload: { reason: l.redact(reason) } })
    await l.session.close()
    return true
  }

  /** Ferme toutes les sessions : à l'arrêt du daemon. */
  async closeAll(reason: string): Promise<void> {
    this.stopped = true
    await Promise.all([...this.live.keys()].map((id) => this.close(id, reason)))
  }

  /**
   * La tâche s'arrête : sa session se ferme, et aucune autre ne s'ouvrira.
   * Appelé par le moteur à la fin de toute tâche qui avait un navigateur.
   */
  async endTask(taskId: string, reason: string): Promise<void> {
    this.ended.add(taskId)
    await this.close(taskId, reason)
    this.closedReasons.delete(taskId)
  }

  private noSessionMessage(taskId: string): string {
    const reason = this.closedReasons.get(taskId)
    return reason
      ? `the browser session is closed (${reason}); call browser_open to ask the human for a new one`
      : 'no browser session is open: call browser_open first'
  }

  private async openSession(): Promise<BrowserSession> {
    const options: BrowserSessionOptions = {
      guard: this.deps.guard ?? defaultBrowserGuard(this.deps.config),
      log: (m) => this.deps.log(m),
    }
    if (this.deps.openSession) return this.deps.openSession(options)
    const { BrowserSession } = await import('@midgaard/browser')
    return BrowserSession.open(options)
  }
}
