/**
 * @file Assemblage du daemon : verrou, base, bus, moteur de tâches, HTTP,
 * WebSocket, bail et arrêt pour inactivité.
 *
 * Un seul daemon tourne par dossier runtime, quel que soit le nombre de sessions
 * Claude Code ouvertes. Chaque session lance son propre serveur MCP en stdio, et
 * tous relaient vers ce daemon en HTTP sur la boucle locale.
 *
 * ```text
 *   session A ─ serveur MCP ─┐
 *   session B ─ serveur MCP ─┼─ HTTP 127.0.0.1 + jeton ─► daemon ─► SQLite
 *   CLI harness ─────────────┤                              │
 *   dashboard ───────────────┘                              └─ WebSocket ─► dashboard
 * ```
 *
 * Trois différences avec la Slice 0, chacune corrigeant une limite constatée :
 *  - **l'état est persisté** : une tâche survit au redémarrage, et celles qui
 *    étaient en cours sont marquées `interrupted` plutôt que perdues ;
 *  - **le daemon s'arrête tout seul** après `idleShutdownMs` sans tâche active,
 *    sans dashboard connecté et sans requête. Celui de la Slice 0 survivait à
 *    toutes les sessions et finissait par tourner avec du code périmé ;
 *  - **la configuration est injectée**, jamais lue au chargement du module.
 */
import { randomBytes } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { fileURLToPath } from 'node:url'
import {
  PROTOCOL_VERSION,
  harnessCommand,
  readRuntime,
  removeRuntime,
  writeRuntime,
  type HarnessConfig,
  type Health,
} from '@midgaard/contracts'
import { HarnessStore } from '@midgaard/persistence'
import { loadPricing } from '@midgaard/providers'
import { openVault } from '@midgaard/secrets'
import type { PricingTable } from '@midgaard/contracts'
import { ensureBuiltinAgents } from './agents.ts'
import { EventBus } from './bus.ts'
import { installation } from './installation.ts'
import { AgentEngine } from './engines/agent.ts'
import { BrowserSessions } from './browsers.ts'
import { WebReaders } from './web.ts'
import type { SearchEngine } from '@midgaard/browser/search'
import { McpSessions } from './mcp-sessions.ts'
import type { HostGuard } from '@midgaard/browser'
import type { ProviderServiceDeps } from './providers.ts'
import { createRequestHandler } from './http.ts'
import { systemDirectoryPicker, type DirectoryPicker } from './pick-directory.ts'
import { acquireLock, readLockPid, releaseLock, tryCreateLock } from './lock.ts'
import { securityContext, type SecurityContext } from './security.ts'
import { StaticFiles } from './static-files.ts'
import { TaskManager } from './task-manager.ts'
import { EventStream } from './ws.ts'

/** Intervalle de vérification de l'inactivité. */
const IDLE_CHECK_MS = 30_000

/**
 * Intervalle de diffusion de l'état de santé aux dashboards connectés.
 *
 * Les compteurs et le compte à rebours d'inactivité de l'en-tête ne changent pas
 * avec les événements de tâche : sans cette diffusion, ils se figeraient à la
 * valeur de l'instantané initial, en paraissant à jour.
 */
const HEALTH_BROADCAST_MS = 10_000

/**
 * Emplacement par défaut des fichiers compilés du dashboard, relatif à ce paquet :
 * `apps/dashboard/dist/` du dépôt, à trois niveaux. Le calcul vaut aussi bien
 * depuis `src/` que depuis `dist/`, à la même profondeur. (Le paquet npm, qui
 * le rangeait ailleurs, a été abandonné : docs/SLICE4.md.)
 *
 * Exporté pour que `doctor` puisse constater la présence du dashboard
 * **sans démarrer le daemon**.
 */
export function defaultDashboardDir(): string {
  return fileURLToPath(new URL('../../../apps/dashboard/dist/', import.meta.url))
}

/** Daemon en marche. */
export interface Daemon {
  port: number
  /** URL du dashboard, ou `null` si le dashboard n'a pas été compilé. */
  dashboardUrl: string | null
  store: HarnessStore
  tasks: TaskManager
  /**
   * S'abonne à ce que diffuse le bus, **dans ce processus** : chaque écriture,
   * au moment même où elle est faite. Lecture seule — toute écriture passe par
   * le gérant. Sert aux tests qui doivent constater un état à un instant précis
   * (la branche d'un Developer pendant qu'il attend son verdict, Slice 6).
   */
  subscribe: EventBus['subscribe']
  /** Arrêt propre et idempotent. */
  close: (reason?: string) => void
  /** Promesse résolue quand le daemon s'est arrêté, quelle qu'en soit la cause. */
  stopped: Promise<string>
}

/** Options d'assemblage, surtout utiles aux tests. */
export interface StartOptions {
  /** Journalisation ; par défaut sur stderr. **Jamais stdout** dans un contexte MCP. */
  log?: (...a: unknown[]) => void
  /**
   * Environnement consulté en dernier recours pour une clé de fournisseur.
   *
   * Injecté plutôt que lu ici : seuls les `main.ts` lisent `process.env`, et
   * les tests doivent pouvoir faire tourner un daemon sans qu'une clé traîne
   * dans leur propre environnement.
   */
  env?: NodeJS.ProcessEnv
  /**
   * Garde réseau du navigateur des agents (Slice 7). Pour les tests seulement,
   * qui servent leur page sur la boucle locale que la vraie garde refuse ;
   * `main.ts` ne la pose jamais, et le daemon prend alors la vraie.
   */
  browserGuard?: HostGuard | undefined
  /**
   * Moteurs de recherche de `search_web`. Pour les tests seulement, qui
   * servent une fausse page de résultats ; `main.ts` ne les pose jamais.
   */
  searchEngines?: readonly SearchEngine[] | undefined
  /**
   * Sélecteur de dossier (`POST /api/dialogs/directory`). Par défaut, celui du
   * système. Les tests passent le leur : un daemon de test ne doit jamais
   * ouvrir une fenêtre sur l'écran de qui lance la suite.
   */
  pickDirectory?: DirectoryPicker | undefined
}

/**
 * Démarre le daemon.
 *
 * @param config configuration injectée (voir `loadConfig`)
 * @returns le daemon, ou `null` si un autre daemon détient déjà le verrou —
 *          ce n'est pas une erreur, c'est le cas nominal quand deux sessions
 *          démarrent en même temps
 * @throws si le port demandé explicitement est occupé, ou si la base est
 *         inutilisable
 */
export async function startDaemon(config: HarnessConfig, options: StartOptions = {}): Promise<Daemon | null> {
  const log =
    options.log ?? ((...a: unknown[]) => console.error(new Date().toISOString(), '[daemon]', ...a))

  mkdirSync(config.home, { recursive: true, mode: 0o700 })
  if (!acquireLock(config.lockFile, log)) {
    log('un autre daemon détient le verrou, sortie')
    return null
  }

  const store = HarnessStore.open(config, log)
  const bus = new EventBus(store)
  const tasks = new TaskManager(config, store, bus, log)

  // Coffre et tarifs : résolus une fois au démarrage, puis injectés partout.
  // Le coffre est **mesuré**, pas déduit de la plateforme — un Linux sans
  // session graphique n'a pas de trousseau, et un macOS restreint peut refuser.
  const vault = await openVault(config, options.env ?? {})
  if (!vault.osBacked) {
    log(`coffre : ${vault.label} — les clés ne sont PAS protégées par le système`)
  } else {
    log(`coffre : ${vault.label}`)
  }
  if (config.execAllow.length) {
    // Rappelé à chaque démarrage, parce que la conséquence ne se voit pas dans
    // la variable : une commande qui exécute le code du projet exécute ce que
    // l'agent a écrit dans son worktree.
    log(
      `exec : ${config.execAllow.length} commande(s) sans approbation (${config.execAllow
        .map((a) => a.join(' '))
        .join(' ; ')}) — si l'une exécute le code du projet, elle exécute ce que l'agent a écrit`,
    )
  }
  let pricing: PricingTable = loadPricing(config, (m) => log(m))
  log(`tarifs : ${Object.keys(pricing.entries).length} modèle(s), relevés le ${pricing.updated_at.slice(0, 10)}`)

  // Le gérant refuse à un agent créé un modèle sans tarif connu (Slice 8) :
  // il lit les tarifs en vigueur, rafraîchissement compris.
  tasks.usePricing(() => pricing)

  const providers: ProviderServiceDeps = {
    config,
    store,
    vault,
    env: options.env ?? {},
    pricing: () => pricing,
    setPricing: (table) => {
      pricing = table
    },
    log,
  }

  // Les navigateurs isolés des tâches (Slice 7) : un par tâche au plus, fermés
  // avec elle, et tous à l'arrêt du daemon.
  const browsers = new BrowserSessions({ bus, config, log, guard: options.browserGuard })
  // Le web lu par navigateur (`search_web`, `read_web_page`) : un Chromium par
  // tâche, ouvert à son premier appel, fermé avec elle.
  const web = new WebReaders({ config, log, guard: options.browserGuard, engines: options.searchEngines })
  // Les serveurs MCP des tâches (Slice 8) : lancés au départ d'une tâche dont
  // le profil en a, fermés à sa fin, et tous à l'arrêt du daemon.
  const mcp = new McpSessions({ store, config, vault, env: options.env ?? {}, log })

  // Researcher, Developer, Orchestrator et Navigator partagent la boucle : une
  // instance du même moteur par type de profil. Seul le Developer crée un
  // worktree ; seul l'Orchestrator reçoit le port de délégation ; le navigateur
  // va au profil qui en a les outils, le Navigator.
  for (const kind of ['researcher', 'developer', 'orchestrator', 'navigator'] as const) {
    tasks.register(
      new AgentEngine({
        kind,
        ctx: tasks.engineContextFor(),
        vault,
        pricing: () => pricing,
        env: options.env ?? {},
        browsers,
        web,
        mcp,
      }),
    )
  }
  const files = new StaticFiles(config.dashboardDir ?? defaultDashboardDir())
  if (!files.available) log('dashboard non compilé : les URL de dashboard ne seront pas annoncées')

  // Jeton de 256 bits, régénéré à chaque démarrage : un jeton fuité ne survit
  // pas au redémarrage du daemon.
  const token = randomBytes(32).toString('hex')
  const startedAt = Date.now()
  let port = 0
  let security: SecurityContext = securityContext(0, token)
  let lastActivity = Date.now()
  const touch = () => {
    lastActivity = Date.now()
  }

  // Le sélecteur de dossier du système. Sa disponibilité est mesurée une fois :
  // la plateforme et les programmes installés ne changent pas sous un daemon.
  const pickDirectory =
    options.pickDirectory ??
    systemDirectoryPicker({ platform: process.platform, env: options.env ?? {}, log: (m) => log(m) })
  const pickerUnavailable = pickDirectory.available()
  if (pickerUnavailable !== null) log(`sélecteur de dossier indisponible : ${pickerUnavailable}`)

  const dashboardUrl = () => (files.available ? `http://127.0.0.1:${port}/` : null)

  // Calculée une fois : le dossier et la version ne changent pas pendant la vie
  // du processus, même si un `git pull` remplace les fichiers sous lui.
  const install = installation()
  const health = (): Health => ({
    ok: true,
    pid: process.pid,
    protocol: PROTOCOL_VERSION,
    uptime_s: Math.round((Date.now() - startedAt) / 1000),
    port,
    // L'URL reste valide même sans dashboard compilé : la page servie explique
    // alors comment le compiler. C'est `dashboard_available` qui dit si on peut
    // y envoyer quelqu'un.
    dashboard_url: `http://127.0.0.1:${port}/`,
    dashboard_available: files.available,
    tasks: store.countTasks(),
    idle_shutdown_in_ms:
      config.idleShutdownMs === 0 ? null : Math.max(0, lastActivity + config.idleShutdownMs - Date.now()),
    db_path: config.dbPath,
    install,
    // Lue au dashboard, donc hors d'un terminal ouvert dans le clone : le
    // dossier runtime désigné et le lanceur de l'application autonome y sont.
    harness_command: harnessCommand('', {
      home: config.homeIsExplicit ? config.home : null,
      launcher: config.launcher,
    }).trimEnd(),
    directory_picker: pickerUnavailable === null,
  })

  const stream = new EventStream({ store, bus, security: () => security, health, log, touch })

  const server: Server = createServer(
    createRequestHandler({
      store,
      tasks,
      files,
      security: () => security,
      health,
      token: () => token,
      maxWaitMs: config.maxWaitMs,
      log,
      touch,
      shutdown: (reason) => close(reason),
      providers,
      bus,
      config,
      browsers,
      pickDirectory,
    }),
  )
  stream.attach(server)

  // --- Arrêt -------------------------------------------------------------
  let stopping = false
  let resolveStopped: (reason: string) => void
  const stopped = new Promise<string>((r) => {
    resolveStopped = r
  })

  /**
   * Arrêt propre et idempotent.
   *
   * Les connexions sont coupées explicitement : `server.close()` attend sinon la
   * fin des long-polls en cours, qui peuvent durer une minute. Le verrou et le
   * fichier de découverte ne sont supprimés que s'ils sont les nôtres — un
   * daemon qui s'arrête après avoir perdu une course ne doit pas effacer ceux du
   * gagnant.
   */
  function close(reason = 'demande'): void {
    if (stopping) return
    stopping = true
    log(`arrêt (${reason})`)
    clearInterval(lease)
    clearInterval(idle)
    clearInterval(heartbeat)
    tasks.stop()
    // Sans attendre : l'arrêt reste synchrone. Chaque fermeture tue le groupe
    // de Chromium d'abord ; un processus qui sortirait avant serait rattrapé
    // par la garde des processus, comme après un `SIGKILL`.
    void browsers.closeAll('the harness stopped')
    void web.closeAll()
    void mcp.closeAll()
    stream.close()
    server.closeAllConnections()
    server.close()
    if (readRuntime(config.runtimeFile)?.pid === process.pid) removeRuntime(config.runtimeFile)
    releaseLock(config.lockFile)
    store.close()
    resolveStopped(reason)
  }

  /**
   * Vérifie le bail, toutes les `leaseMs`.
   *
   * - verrou détenu par un autre : on a perdu une course, on s'arrête ;
   * - verrou disparu (supprimé à la main) : on le recrée, plutôt que de s'arrêter
   *   et de perdre les tâches en cours ;
   * - verrou à nous mais fichier de découverte désignant quelqu'un d'autre
   *   (un perdant l'a écrit en dernier puis l'a effacé) : on le republie, sinon
   *   les serveurs MCP ne nous trouveraient plus.
   */
  function checkLease(): void {
    let holder = readLockPid(config.lockFile)
    if (holder === null && tryCreateLock(config.lockFile)) {
      log('verrou disparu, recréé')
      holder = process.pid
    }
    holder ??= readLockPid(config.lockFile)
    if (holder !== process.pid) return close(`verrou détenu par le pid ${holder ?? 'inconnu'}`)
    if (readRuntime(config.runtimeFile)?.pid !== process.pid) {
      publishRuntime()
      log('fichier de découverte republié')
    }
  }

  /**
   * Arrête le daemon après une période d'inactivité complète.
   *
   * Les trois conditions sont nécessaires : une tâche active doit continuer même
   * sans personne pour la regarder, et un dashboard ouvert doit rester alimenté
   * même si rien ne se passe.
   */
  function checkIdle(): void {
    if (config.idleShutdownMs === 0) return
    if (Date.now() - lastActivity < config.idleShutdownMs) return
    if (store.countTasks().active > 0 || stream.clientCount > 0) return touch()
    close(`inactif depuis ${Math.round(config.idleShutdownMs / 60000)} min`)
  }

  function publishRuntime(): void {
    writeRuntime(config.runtimeFile, {
      pid: process.pid,
      port,
      token,
      started_at: new Date(startedAt).toISOString(),
      protocol: PROTOCOL_VERSION,
      dashboard_url: `http://127.0.0.1:${port}/`,
    })
  }

  // --- Écoute --------------------------------------------------------------
  port = await listen(server, config, log)
  security = securityContext(port, token)

  // L'état d'avant le redémarrage est réconcilié avant la publication du fichier
  // de découverte : aucun client ne peut voir une tâche encore marquée `running`
  // alors que le processus qui la faisait avancer est mort.
  tasks.recoverFromRestart()
  // Les profils livrés d'office sont (re)posés à chaque démarrage, pour qu'une
  // montée de version livre ses consignes système corrigées sans que
  // l'utilisateur ait à supprimer sa base.
  ensureBuiltinAgents(store, log)
  publishRuntime()
  // La vue des Navigator se constate au catalogue, sans bloquer le démarrage :
  // un profil aveugle sera montré refusé dès que la réponse arrive (Slice 7).
  void tasks.probeVision()

  const lease = setInterval(checkLease, config.leaseMs)
  lease.unref()
  // Diffusion seulement s'il y a quelqu'un pour la recevoir : un daemon sans
  // dashboard ouvert ne doit pas se réveiller pour rien.
  const heartbeat = setInterval(() => {
    if (stream.clientCount > 0) stream.broadcast({ type: 'health', health: health() })
  }, HEALTH_BROADCAST_MS)
  heartbeat.unref()
  const idle = setInterval(checkIdle, Math.min(IDLE_CHECK_MS, Math.max(1_000, config.idleShutdownMs || IDLE_CHECK_MS)))
  idle.unref()

  log(`à l'écoute sur http://127.0.0.1:${port} (pid ${process.pid}, protocole ${PROTOCOL_VERSION})`)
  if (files.available) log(`dashboard : http://127.0.0.1:${port}/`)

  return { port, dashboardUrl: dashboardUrl(), store, tasks, subscribe: (listener) => bus.subscribe(listener), close, stopped }
}

/**
 * Met le serveur à l'écoute, avec repli sur un port libre.
 *
 * Le port par défaut est fixe pour que l'URL du dashboard soit stable d'une
 * session à l'autre. S'il est occupé par autre chose, se rabattre sur un port
 * libre vaut mieux que refuser de démarrer — sauf si l'utilisateur a demandé ce
 * port explicitement, auquel cas le silence serait trompeur.
 */
function listen(server: Server, config: HarnessConfig, log: (...a: unknown[]) => void): Promise<number> {
  return new Promise((resolve, reject) => {
    const onError = (e: NodeJS.ErrnoException) => {
      if (e.code !== 'EADDRINUSE' || config.portIsExplicit) return reject(e)
      log(`port ${config.port} occupé, repli sur un port libre`)
      server.listen(0, '127.0.0.1')
    }
    server.on('error', onError)
    server.once('listening', () => {
      server.removeListener('error', onError)
      const address = server.address()
      resolve(typeof address === 'object' && address ? address.port : 0)
    })
    server.listen(config.port, '127.0.0.1')
  })
}
