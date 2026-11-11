/**
 * @file Une session de navigateur (Slice 7, étape 3) : un Chromium jetable,
 * sans privilège, dont rien ne survit.
 *
 * Ce que la session garantit, et comment :
 *
 *  - **jetable** : un Chromium neuf par session, un contexte vierge — ni
 *    cookie, ni historique, ni session de l'utilisateur. Jamais son navigateur ;
 *  - **réseau gardé** : tout passe par le proxy gardé (`proxy.ts`), boucle
 *    locale comprise (`--proxy-bypass-list=<-loopback>`, qui tient même quand
 *    une variable d'environnement de Playwright le désactiverait) ; seules les
 *    adresses `http:` et `https:` s'ouvrent ;
 *  - **sans privilège** : aucun téléchargement (`acceptDownloads: false`),
 *    aucune permission accordée, aucun service worker, aucune extension ;
 *  - **une seule page** : une fenêtre surgissante est fermée aussitôt. L'agent
 *    et l'humain qui le surveille regardent la même page ;
 *  - **aucun processus survivant** : Chromium est le chef de son groupe de
 *    processus (constaté, 3 processus), confié dès son lancement à la garde
 *    d'`exec` (`guardGroup`, paquet `tools`). Fermée, la session tue le groupe ;
 *    daemon tué net, la garde le fait.
 *
 * La session ne décide rien de ce que l'agent a le droit de faire : les
 * approbations sont l'affaire des outils (étape 4). Elle exécute, et dit ce
 * qu'elle a vu.
 */
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { chromium, type Browser, type BrowserContext, type BrowserServer, type Page } from 'playwright'
import { assertPublicHost, BROWSER_KEYS, guardGroup, type BrowserKey } from '@midgaard/tools'
import { startGuardedProxy, type GuardedProxy, type HostGuard, type ProxyRefusal } from './proxy.ts'

/**
 * Le `document` de la page, pour la seule fonction évaluée dans la page par
 * {@link BrowserSession.focused}. Le paquet tourne sous Node, sans la
 * bibliothèque DOM : ce type minimal décrit ce que cette fonction touche.
 */
interface FocusTarget {
  id: string
  tagName: string
  isContentEditable?: boolean
  getAttribute(name: string): string | null
}
declare const document: { activeElement: FocusTarget | null; body: unknown; documentElement: unknown }

/** Taille de la fenêtre : celle d'un portable courant, lisible dans une capture. */
/**
 * La commande qui installe Chromium, prête à copier, pour **cette**
 * installation : le Node qui tourne et le `cli.js` du Playwright qu'il a
 * chargé, en chemins absolus.
 *
 * Elle disait `npx playwright install chromium`. Depuis un clone, c'est juste ;
 * dans l'application autonome, il n'y a ni `npx` ni dossier où le lancer, et
 * un `npx` tapé ailleurs installerait le Chromium d'une **autre** version de
 * Playwright, que celle-ci ne trouverait pas. La forme absolue vaut dans les
 * deux cas.
 */
export function chromiumInstallCommand(): string {
  const cli = join(dirname(createRequire(import.meta.url).resolve('playwright/package.json')), 'cli.js')
  return `"${process.execPath}" "${cli}" install chromium`
}

export const DEFAULT_VIEWPORT = { width: 1280, height: 800 }
/** Délai d'une navigation, en millisecondes. */
export const NAVIGATION_TIMEOUT_MS = 30_000
/** Attente maximale d'une navigation déclenchée par une action, avant de relire la page. */
const SETTLE_MS = 1_000
/**
 * Touches qu'un agent peut presser : la liste fermée des outils
 * (`BROWSER_KEYS`, paquet `tools`), une seule pour les deux paquets.
 */
export const ALLOWED_KEYS = BROWSER_KEYS
export type AllowedKey = BrowserKey

/** Un refus de la session, à rendre à l'agent tel quel. En anglais : c'est le modèle qui le lit. */
export class BrowserError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'BrowserError'
  }
}

/** Ce que la session a vu après une action. */
export interface PageState {
  url: string
  title: string
}

/** Ce qu'il faut pour ouvrir une session. */
export interface BrowserSessionOptions {
  /** Juge chaque hôte. `assertPublicHost` par défaut ; les tests passent la leur. */
  guard?: HostGuard | undefined
  viewport?: { width: number; height: number } | undefined
  /** Journal du daemon : dit une fois que la garde des processus manque. */
  log?: ((message: string) => void) | undefined
}

/** Une session ouverte. */
export class BrowserSession {
  private readonly server: BrowserServer
  private readonly browser: Browser
  private readonly context: BrowserContext
  private readonly page: Page
  private readonly proxy: GuardedProxy
  private readonly release: () => void
  private readonly refusals: ProxyRefusal[]
  private closed = false
  /** Pid de Chromium, chef de son groupe de processus. */
  readonly pid: number

  private constructor(parts: {
    server: BrowserServer
    browser: Browser
    context: BrowserContext
    page: Page
    proxy: GuardedProxy
    release: () => void
    refusals: ProxyRefusal[]
    pid: number
  }) {
    this.server = parts.server
    this.browser = parts.browser
    this.context = parts.context
    this.page = parts.page
    this.proxy = parts.proxy
    this.release = parts.release
    this.refusals = parts.refusals
    this.pid = parts.pid
  }

  /**
   * Ouvre une session : proxy gardé, Chromium, contexte vierge, une page.
   *
   * @throws {BrowserError} si Chromium n'est pas installé, avec la commande qui l'installe
   */
  static async open(options: BrowserSessionOptions = {}): Promise<BrowserSession> {
    const refusals: ProxyRefusal[] = []
    const proxy = await startGuardedProxy({ guard: options.guard ?? assertPublicHost, onRefused: (r) => refusals.push(r) })
    let server: BrowserServer
    try {
      server = await chromium.launchServer({
        headless: true,
        proxy: { server: `http://127.0.0.1:${proxy.port}` },
        args: [
          // Chromium contourne d'office un proxy pour la boucle locale.
          // Playwright l'en empêche déjà, **sauf** si la variable
          // PLAYWRIGHT_DISABLE_FORCED_CHROMIUM_PROXIED_LOOPBACK est posée —
          // et le daemon hérite de l'environnement de qui le lance. Ce
          // drapeau tient dans ce cas-là : constaté, sans lui la page locale
          // se chargeait.
          '--proxy-bypass-list=<-loopback>',
          '--disable-extensions',
          '--no-first-run',
          '--no-default-browser-check',
        ],
      })
    } catch (e) {
      await proxy.close()
      throw new BrowserError(
        `Chromium could not start (${(e as Error).message.split('\n')[0]}). Install it once with: ${chromiumInstallCommand()}`,
      )
    }
    const pid = server.process().pid
    // Confié à la garde dès le lancement : si le daemon meurt net pendant la
    // session, c'est elle qui tuera le groupe.
    const release = pid !== undefined ? guardGroup(pid, options.log) : () => {}
    try {
      const browser = await chromium.connect(server.wsEndpoint())
      const context = await browser.newContext({
        viewport: options.viewport ?? DEFAULT_VIEWPORT,
        acceptDownloads: false,
        serviceWorkers: 'block',
        permissions: [],
      })
      context.setDefaultNavigationTimeout(NAVIGATION_TIMEOUT_MS)
      const page = await context.newPage()
      // Une seule page : une fenêtre surgissante se ferme, et la page reste
      // celle que l'humain voit.
      context.on('page', (opened) => {
        if (opened !== page) void opened.close().catch(() => {})
      })
      return new BrowserSession({ server, browser, context, page, proxy, release, refusals, pid: pid ?? 0 })
    } catch (e) {
      await server.close().catch(() => {})
      release()
      await proxy.close()
      throw e
    }
  }

  /** L'adresse et le titre de la page. */
  async state(): Promise<PageState> {
    return { url: this.page.url(), title: await this.page.title().catch(() => '') }
  }

  /**
   * Ouvre une adresse. Seules `http:` et `https:` sont admises : `file:`
   * lirait le disque de l'utilisateur, `chrome:` et `javascript:` n'ont rien à
   * faire dans une tâche.
   *
   * @throws {BrowserError} si l'adresse est refusée, par le schéma ou par la garde
   */
  async goto(url: string): Promise<PageState> {
    this.ensureOpen()
    let parsed: URL
    try {
      parsed = new URL(url)
    } catch {
      throw new BrowserError(`not a valid URL: ${url}`)
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new BrowserError(`only http:// and https:// addresses can be opened, not ${parsed.protocol}`)
    }
    const before = this.refusals.length
    try {
      await this.page.goto(parsed.href, { waitUntil: 'domcontentloaded' })
    } catch (e) {
      throw this.explain(e, before, parsed.hostname)
    }
    const refused = this.refusals.slice(before).find((r) => r.host === parsed.hostname)
    if (refused) throw new BrowserError(refused.reason)
    return this.state()
  }

  /**
   * Décrit l'élément qui a le focus, en une ligne : `input[type=search][name=q]`,
   * `textarea#message`, `[contenteditable]`. `null` si aucun champ ne l'a.
   *
   * C'est ce que l'humain lit pour approuver une saisie, et ce qui est
   * revérifié avant de taper. La description est lue **dans la page** : une
   * page hostile peut mentir sur son propre champ, pas déplacer le clavier —
   * la saisie va au vrai focus. Elle est bornée, pour qu'un attribut géant
   * n'envahisse pas la demande d'approbation.
   */
  async focused(): Promise<string | null> {
    this.ensureOpen()
    const described = await this.page
      .evaluate(() => {
        const el = document.activeElement
        if (!el || el === document.body || el === document.documentElement) return null
        const attr = (name: string) => {
          const v = el.getAttribute(name)
          return v ? `[${name}=${JSON.stringify(v.slice(0, 40))}]` : ''
        }
        const id = el.id ? `#${el.id.slice(0, 40)}` : ''
        const editable = el.isContentEditable ? '[contenteditable]' : ''
        return `${el.tagName.toLowerCase()}${id}${attr('type')}${attr('name')}${attr('aria-label')}${attr('placeholder')}${editable}`
      })
      .catch(() => null)
    return described ? described.slice(0, 200) : null
  }

  /** Taille de la fenêtre, en pixels : le repère des clics. */
  viewport(): { width: number; height: number } {
    return this.page.viewportSize() ?? DEFAULT_VIEWPORT
  }

  /** Une capture de la page visible, en JPEG : quatre fois plus léger qu'un PNG, donc moins de jetons. */
  async screenshot(): Promise<{ jpeg: Buffer } & PageState> {
    this.ensureOpen()
    const jpeg = await this.page.screenshot({ type: 'jpeg', quality: 70 })
    return { jpeg, ...(await this.state()) }
  }

  /** Un clic aux coordonnées données, en pixels de la fenêtre. */
  async click(x: number, y: number): Promise<PageState> {
    this.ensureOpen()
    const { width, height } = this.page.viewportSize() ?? DEFAULT_VIEWPORT
    if (!(x >= 0 && y >= 0 && x < width && y < height)) {
      throw new BrowserError(`click outside the page: (${x}, ${y}) is not within ${width}×${height}`)
    }
    await this.page.mouse.click(x, y)
    await this.settle()
    return this.state()
  }

  /** Fait défiler la page, de `dy` pixels (négatif vers le haut). */
  async scroll(dy: number): Promise<PageState> {
    this.ensureOpen()
    await this.page.mouse.wheel(0, dy)
    await this.settle()
    return this.state()
  }

  /** Saisit un texte dans l'élément qui a le focus. */
  async type(text: string): Promise<PageState> {
    this.ensureOpen()
    await this.page.keyboard.type(text)
    return this.state()
  }

  /** Presse une touche de la liste fermée {@link ALLOWED_KEYS}. */
  async press(key: string): Promise<PageState> {
    this.ensureOpen()
    if (!(ALLOWED_KEYS as readonly string[]).includes(key)) {
      throw new BrowserError(`key not allowed: ${key}. Allowed: ${ALLOWED_KEYS.join(', ')}`)
    }
    await this.page.keyboard.press(key)
    await this.settle()
    return this.state()
  }

  /** Nombre de pages ouvertes : une seule, les fenêtres surgissantes fermées. Pour les tests et le diagnostic. */
  pageCount(): number {
    return this.context.pages().length
  }

  /** Les refus de la garde depuis l'ouverture : ce que la page a tenté de joindre en vain. */
  refused(): readonly ProxyRefusal[] {
    return this.refusals
  }

  /**
   * Ferme tout : le navigateur, son groupe de processus, le proxy.
   * Idempotente, et ne lève pas : une fermeture qui échoue ne doit pas masquer
   * la raison pour laquelle on fermait.
   */
  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    await this.context.close().catch(() => {})
    await this.browser.close().catch(() => {})
    await this.server.close().catch(() => {})
    // `close` de Playwright attend la fin du processus principal. Ce qui
    // resterait de son groupe — un processus de rendu détaché — est tué ici,
    // **avant** de libérer la garde : libérer retire le groupe de sa liste,
    // cela ne le tue pas.
    killGroup(this.pid)
    this.release()
    await this.proxy.close()
  }

  /** Vrai une fois fermée. */
  get isClosed(): boolean {
    return this.closed
  }

  private ensureOpen(): void {
    if (this.closed) throw new BrowserError('the browser session is closed')
  }

  /**
   * Laisse une navigation déclenchée par une action se poser, sans l'attendre
   * indéfiniment.
   *
   * Attendre « page chargée » seul ne suffit pas : la page **courante** l'est
   * déjà, et l'état relu serait celui d'avant le clic ou l'Entrée qui envoie un
   * formulaire — constaté au premier jet du test. On attend donc qu'une
   * navigation de la page principale commence, une seconde au plus, puis
   * qu'elle se charge.
   */
  private async settle(): Promise<void> {
    await this.page
      .waitForEvent('framenavigated', { predicate: (frame) => frame === this.page.mainFrame(), timeout: SETTLE_MS })
      .catch(() => {})
    await this.page.waitForLoadState('domcontentloaded', { timeout: 5_000 }).catch(() => {})
  }

  /** Traduit un échec de navigation en refus lisible, la garde en premier. */
  private explain(e: unknown, before: number, host: string): BrowserError {
    const refused = this.refusals.slice(before).find((r) => r.host === host) ?? this.refusals[before]
    if (refused) return new BrowserError(refused.reason)
    return new BrowserError(`navigation failed: ${(e as Error).message.split('\n')[0]}`)
  }
}

/**
 * Tue un groupe de processus, silencieusement s'il n'existe plus : tuer ce qui
 * est déjà mort n'est pas une erreur. Sous Windows, l'arbre par `taskkill /T`.
 */
function killGroup(pid: number): void {
  if (!pid) return
  try {
    if (process.platform === 'win32') {
      execFileSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
    } else {
      process.kill(-pid, 'SIGKILL')
    }
  } catch {
    // Déjà mort.
  }
}

