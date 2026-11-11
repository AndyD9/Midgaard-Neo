/**
 * @file Configuration du harness : un objet unique, construit une fois, passé
 * explicitement à tout ce qui en a besoin.
 *
 * **Pourquoi pas des constantes de module.** Le spike lisait l'environnement au
 * niveau module (`const HOME = process.env.MIDGAARD_HOME ?? …`). Les imports ESM
 * statiques étant hissés, la valeur était figée avant qu'un test puisse la
 * changer : il fallait des imports dynamiques pour contourner le problème
 * (découverte n° 7 de la Slice 0). Ici, rien n'est lu au chargement ; chaque point
 * d'entrée appelle {@link loadConfig} et transmet le résultat.
 *
 * Les valeurs par défaut non évidentes sont justifiées sur chaque champ.
 */
import { homedir } from 'node:os'
import { join } from 'node:path'

/** Configuration complète du harness, résolue en chemins et durées absolus. */
export interface HarnessConfig {
  /** Dossier d'état runtime (base, journal, fichier de découverte, verrou). Créé en `0700`. */
  home: string
  /**
   * Dossier personnel de l'utilisateur. Un dossier de projet ne peut pas être
   * celui-ci (Slice 5, décision 9) : un agent y lirait tout.
   */
  userHome: string
  /** Base SQLite : toute la mémoire longue du harness. */
  dbPath: string
  /** Fichier de découverte du daemon (port, jeton, pid). **Secret**, écrit en `0600`. */
  runtimeFile: string
  /** Verrou d'instance unique : contient le pid du daemon qui le détient. */
  lockFile: string
  /** Journal du daemon lancé en arrière-plan. */
  logFile: string
  /** Trace JSONL des attentes du serveur MCP, pour diagnostiquer le vrai client. */
  traceFile: string
  /**
   * Dossier des worktrees des agents écrivants.
   *
   * **Hors de tout dépôt**, décision de la Slice 3 : un worktree rangé dans le
   * dépôt serait parcouru par son outillage — `tsc`, les tests, les watchers,
   * la recherche de l'éditeur — qui verraient chaque fichier en double, et il
   * faudrait l'ignorer dans chaque projet.
   */
  worktreesDir: string
  /**
   * Port d'écoute souhaité. `7777` par défaut pour que l'URL du dashboard soit
   * stable d'une session à l'autre ; si le port est pris, le daemon se rabat sur
   * un port libre choisi par le système — sauf si `MIDGAARD_PORT` a été fixé
   * explicitement, auquel cas un port occupé est une erreur à signaler.
   */
  port: number
  /** Vrai si {@link port} vient de l'environnement : interdit alors le repli sur un port libre. */
  portIsExplicit: boolean
  /**
   * Vrai si {@link home} a été désigné (`MIDGAARD_HOME`, `--home` de la CLI),
   * faux pour `~/.midgaard`. Une commande conseillée doit alors le redire
   * (`harnessCommand`) : sans lui, elle viserait une autre installation.
   */
  homeIsExplicit: boolean
  /**
   * Délai d'inactivité avant arrêt automatique du daemon. `0` désactive l'arrêt.
   *
   * Le daemon de la Slice 0 ne s'arrêtait jamais : il survivait à toutes les
   * sessions et finissait par tourner avec du code périmé. 30 minutes laissent
   * largement le temps d'une approbation humaine, et l'inactivité exige *à la
   * fois* aucune tâche active, aucun client WebSocket et aucune requête récente.
   */
  idleShutdownMs: number
  /**
   * Durée de validité d'une demande d'approbation. Au-delà, elle expire et la
   * tâche s'arrête en `timed_out` plutôt que de rester en pause indéfiniment
   * (§5 du plan). Réglable par `MIDGAARD_APPROVAL_TTL_S`, surtout pour les tests :
   * attendre dix minutes dans une suite n'est pas envisageable.
   */
  approvalTtlMs: number
  /**
   * Durée maximale d'une attente de l'utilisateur dans une conversation
   * (Slice 6). Au-delà, la tâche s'arrête en `timed_out` : une conversation
   * oubliée garderait sinon le daemon en vie, et son orchestrateur ses
   * sous-tâches. Deux heures par défaut, réglable par `MIDGAARD_INPUT_TTL_S`,
   * surtout pour les tests.
   */
  inputTtlMs: number
  /**
   * Durée maximale d'un long-poll côté daemon. Volontairement courte : c'est au
   * serveur MCP d'enchaîner les tranches en notifiant entre chacune, pas au
   * daemon de tenir une connexion ouverte des minutes durant.
   */
  maxWaitMs: number
  /**
   * Durée d'une tranche d'attente du serveur MCP, donc intervalle entre deux
   * notifications de progression. Sous deux limites mesurées en Slice 0 : le
   * client MCP coupe un appel sans progression à 60 s (marge ×4), et `fetch`
   * abandonne une requête sans en-têtes au bout de 300 s.
   */
  waitSliceMs: number
  /** Intervalle de vérification du bail d'instance unique. */
  leaseMs: number
  /** Dossier des fichiers compilés du dashboard ; `null` = emplacement par défaut du paquet. */
  dashboardDir: string | null
  /**
   * Ce que le harness fait d'un hôte absent de la liste blanche, quand un agent
   * appelle `http_fetch` :
   *  - `open` (défaut) : laisser passer tout hôte **public** ;
   *  - `approval` : suspendre la tâche et demander un humain ;
   *  - `allowlist` : refuser.
   *
   * Le plan (§5) prévoyait la liste blanche seule. En pratique, un Researcher
   * qui ne peut lire que des domaines prévus d'avance ne sert à rien : personne
   * ne connaît à l'avance l'URL de la documentation qu'il faudra consulter. Le
   * mécanisme existe donc, réglable, et le défaut est **annoncé** plutôt que
   * présenté comme une liste blanche qui n'en serait pas une. Les adresses
   * privées et l'IMDS restent refusées dans les trois cas.
   */
  httpPolicy: 'open' | 'approval' | 'allowlist'
  /** Hôtes toujours autorisés. Motifs `exemple.org` ou `*.exemple.org`. */
  allowHosts: string[]
  /**
   * Commandes que l'outil `exec` lance **sans approbation** : des argv exacts,
   * lus dans `MIDGAARD_EXEC_ALLOW` (`npm test;npx tsc --noEmit`). **Vide par
   * défaut**, décision de la Slice 3 : un agent qui écrit `package.json` fait
   * de `npm test` en liste blanche l'exécution sans regard de ce qu'il a écrit.
   * Le daemon rappelle cette conséquence dans son journal au démarrage.
   */
  execAllow: string[][]
  /**
   * Sous-tâches actives qu'un orchestrateur peut avoir en même temps (Slice 8,
   * décision 17). Créer des agents à la volée et les lancer en parallèle
   * multiplie la dépense ; ce plafond se vérifie **avant** de créer une
   * sous-tâche. 4 par défaut, réglable par `MIDGAARD_MAX_ACTIVE_SUBTASKS`.
   */
  maxActiveSubtasks: number
}

/** Valeurs lisibles depuis l'environnement. Tout le reste est dérivé. */
export interface ConfigEnv {
  MIDGAARD_HOME?: string | undefined
  MIDGAARD_PORT?: string | undefined
  MIDGAARD_IDLE_SHUTDOWN_S?: string | undefined
  MIDGAARD_APPROVAL_TTL_S?: string | undefined
  MIDGAARD_INPUT_TTL_S?: string | undefined
  MIDGAARD_DASHBOARD_DIR?: string | undefined
  MIDGAARD_HTTP_POLICY?: string | undefined
  MIDGAARD_HTTP_ALLOW?: string | undefined
  MIDGAARD_EXEC_ALLOW?: string | undefined
  MIDGAARD_MAX_ACTIVE_SUBTASKS?: string | undefined
}

/** Port par défaut, repris du plan (`http://127.0.0.1:7777`). */
export const DEFAULT_PORT = 7777

/**
 * Lit `MIDGAARD_HTTP_POLICY`. Une valeur inconnue retombe sur `open` plutôt que
 * de faire échouer le démarrage : une faute de frappe ne doit pas empêcher le
 * harness de tourner, et les adresses privées restent refusées de toute façon.
 */
function parsePolicy(raw: string | undefined): 'open' | 'approval' | 'allowlist' {
  const value = raw?.trim()
  return value === 'approval' || value === 'allowlist' ? value : 'open'
}

/**
 * Lit `MIDGAARD_EXEC_ALLOW` : des commandes exactes séparées par `;`, chacune
 * découpée sur les espaces. Pas de guillemets, délibérément : un analyseur de
 * guillemets est un endroit de plus où une commande approuvée d'office pourrait
 * ne pas être celle qu'on croit. Un argument contenant une espace ne peut donc
 * pas être mis en liste blanche.
 */
export function parseExecAllow(raw: string | undefined): string[][] {
  return (raw ?? '')
    .split(';')
    .map((entry) => entry.trim().split(/\s+/).filter(Boolean))
    .filter((argv) => argv.length > 0)
}

/**
 * Construit la configuration à partir de l'environnement, puis des surcharges.
 *
 * @param env       variables d'environnement (passer `process.env` au point d'entrée)
 * @param overrides surcharges appliquées après coup, utilisées par les tests
 * @returns une configuration complète ; aucun fichier n'est créé ici
 *
 * @example
 * const config = loadConfig(process.env)
 * const daemon = await startDaemon(config)
 */
export function loadConfig(env: ConfigEnv = {}, overrides: Partial<HarnessConfig> = {}): HarnessConfig {
  // Dossier utilisateur et non dossier de projet : le daemon est partagé par
  // toutes les sessions Claude Code, quel que soit le dépôt ouvert.
  const home = overrides.home ?? env.MIDGAARD_HOME ?? join(homedir(), '.midgaard')
  const homeIsExplicit = overrides.home !== undefined || env.MIDGAARD_HOME !== undefined
  const rawPort = env.MIDGAARD_PORT?.trim()
  const portIsExplicit = rawPort !== undefined && rawPort !== ''
  const idleS = Number(env.MIDGAARD_IDLE_SHUTDOWN_S ?? 1800)
  const ttlS = Number(env.MIDGAARD_APPROVAL_TTL_S ?? 600)
  const inputTtlS = Number(env.MIDGAARD_INPUT_TTL_S ?? 7200)
  const maxActive = Number(env.MIDGAARD_MAX_ACTIVE_SUBTASKS ?? 4)

  const base: HarnessConfig = {
    home,
    userHome: homedir(),
    dbPath: join(home, 'harness.db'),
    runtimeFile: join(home, 'daemon.json'),
    lockFile: join(home, 'daemon.lock'),
    logFile: join(home, 'daemon.log'),
    traceFile: join(home, 'mcp-trace.jsonl'),
    worktreesDir: join(home, 'worktrees'),
    port: portIsExplicit ? Number(rawPort) : DEFAULT_PORT,
    portIsExplicit,
    homeIsExplicit,
    idleShutdownMs: Number.isFinite(idleS) && idleS >= 0 ? idleS * 1000 : 1_800_000,
    approvalTtlMs: Number.isFinite(ttlS) && ttlS > 0 ? ttlS * 1000 : 600_000,
    inputTtlMs: Number.isFinite(inputTtlS) && inputTtlS > 0 ? inputTtlS * 1000 : 7_200_000,
    maxWaitMs: 60_000,
    waitSliceMs: 15_000,
    leaseMs: 1_000,
    dashboardDir: env.MIDGAARD_DASHBOARD_DIR ?? null,
    httpPolicy: parsePolicy(env.MIDGAARD_HTTP_POLICY),
    allowHosts: (env.MIDGAARD_HTTP_ALLOW ?? '')
      .split(',')
      .map((h) => h.trim())
      .filter(Boolean),
    execAllow: parseExecAllow(env.MIDGAARD_EXEC_ALLOW),
    // Un entier d'au moins 1 : zéro interdirait toute délégation sans le dire.
    maxActiveSubtasks: Number.isInteger(maxActive) && maxActive >= 1 ? maxActive : 4,
  }
  // Les surcharges s'appliquent en dernier, mais les chemins dérivés de `home`
  // ont déjà été calculés : une surcharge de `home` seule doit donc les recalculer.
  const merged = { ...base, ...overrides }
  if (overrides.home && !overrides.dbPath) {
    merged.dbPath = join(overrides.home, 'harness.db')
    merged.runtimeFile = join(overrides.home, 'daemon.json')
    merged.lockFile = join(overrides.home, 'daemon.lock')
    merged.logFile = join(overrides.home, 'daemon.log')
    merged.traceFile = join(overrides.home, 'mcp-trace.jsonl')
    if (!overrides.worktreesDir) merged.worktreesDir = join(overrides.home, 'worktrees')
  }
  return merged
}
