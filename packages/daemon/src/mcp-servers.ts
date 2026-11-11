/**
 * @file Service des serveurs MCP (Slice 8, étape 2) : déclarer, tester,
 * supprimer, cocher et décocher des outils.
 *
 * Calqué sur le service des fournisseurs (`providers.ts`), pour les mêmes
 * raisons :
 *
 *  - **le coffre d'abord, la base ensuite.** Une variable secrète arrive dans
 *    le corps d'une requête, part au coffre, et la base n'en garde que le nom.
 *    Écrire la base d'abord laisserait une déclaration qui promet un secret
 *    absent, découvert à la première tâche, loin de sa cause ;
 *  - **un test prouve ce qu'il annonce.** « Tester la connexion » lance le
 *    serveur, fait `initialize` puis `tools/list`, et ne se dit réussi que si
 *    le catalogue est revenu. Un binaire qui existe sans parler MCP échoue,
 *    avec la raison (leçon de la clé Venice, Slice 2) ;
 *  - **le programme est vérifié à la déclaration et à chaque lancement** :
 *    absolu, présent, exécutable. Un `.cmd` ou un `.bat` est refusé sous
 *    Windows : il ne se lance pas sans shell, et un shell interpréterait les
 *    arguments.
 *
 * Cocher un outil n'est possible que sur le **catalogue constaté** : on coche
 * ce que le serveur a annoncé et que l'humain a pu lire, avec son empreinte
 * (docs/SLICE8.md, décision 5). Chaque autorisation est journalisée avec son
 * auteur : elle vaut pour toutes les tâches à venir.
 */
import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { access, realpath, stat } from 'node:fs/promises'
import { posix, win32 } from 'node:path'
import {
  createRedactor,
  mcpCatalogStatus,
  mcpToolFingerprint,
  type McpServer,
  type McpServerView,
  type McpTest,
  type McpTool,
  type UpsertMcpServerRequest,
} from '@midgaard/contracts'
import { McpClientError, McpConnection, serverEnv } from '@midgaard/mcp-client'
import type { ProviderRefusal, ProviderServiceDeps } from './providers.ts'

/** Ce dont le service a besoin : le même socle que celui des fournisseurs. */
export type McpServiceDeps = Pick<ProviderServiceDeps, 'config' | 'store' | 'vault' | 'env' | 'log'>

/** Délai de la poignée de main d'un test : un serveur qui ne répond pas en 30 s ne répondra pas. */
export const MCP_TEST_STARTUP_TIMEOUT_MS = 30_000
/** Délai de la lecture du catalogue d'un test. */
export const MCP_TEST_LIST_TIMEOUT_MS = 30_000
/**
 * Ce qu'un test échoué cite de la sortie d'erreur du serveur, expurgée : de
 * quoi comprendre, pas un journal. Le début **et** la fin : la ligne qui dit
 * la cause est souvent la première (« Cannot find module … »), suivie d'une
 * pile d'appels ; n'en garder que la fin l'a perdue au premier essai.
 */
const STDERR_HEAD_CHARS = 400
const STDERR_TAIL_CHARS = 200

/** Un extrait de sortie d'erreur : entière si elle est courte, sinon son début et sa fin. */
export function stderrExcerpt(text: string): string {
  const t = text.trim()
  if (t.length <= STDERR_HEAD_CHARS + STDERR_TAIL_CHARS) return t
  return `${t.slice(0, STDERR_HEAD_CHARS)} … ${t.slice(-STDERR_TAIL_CHARS)}`
}

/**
 * Référence d'une variable secrète dans le coffre, dérivée comme celle d'une
 * clé de fournisseur ({@link secretRefFor}, `providers.ts`) : l'empreinte du
 * dossier runtime sépare deux installations d'une même session, que le coffre
 * système, lui, ne sépare pas.
 *
 * @param home     dossier runtime de cette installation
 * @param serverId identifiant du serveur
 * @param name     nom de la variable ; le coffre la normalise en minuscules,
 *                 d'où le refus de deux noms qui ne diffèrent que par la casse
 * @returns par exemple `mcp.3f9a0c21.rea.api_token`
 */
export async function mcpSecretRef(home: string, serverId: string, name: string): Promise<string> {
  let canonical = home
  try {
    canonical = await realpath(home)
  } catch {
    // Dossier pas encore créé : voir `secretRefFor`.
  }
  const scope = createHash('sha256').update(canonical).digest('hex').slice(0, 8)
  return `mcp.${scope}.${serverId}.${name.toLowerCase()}`
}

/**
 * Vérifie le programme d'un serveur : absolu, présent, fichier, exécutable.
 *
 * Le chemin est gardé **tel que déclaré**, pas canonicalisé : `node` installé
 * par Homebrew est un lien vers un dossier versionné, et la cible canonique
 * disparaîtrait à la prochaine mise à jour. C'est pourquoi la vérification se
 * refait à chaque lancement.
 *
 * @returns `null` si le programme convient, sinon la raison, en français (elle va à l'humain)
 */
export async function checkMcpCommand(command: string, platform: NodeJS.Platform = process.platform): Promise<string | null> {
  // Les règles de chemin sont celles de la plateforme visée, pas de l'hôte :
  // `C:\outils\rea.cmd` est absolu sous Windows, pas sous POSIX.
  const path = platform === 'win32' ? win32 : posix
  if (!path.isAbsolute(command)) {
    return `le programme doit être un chemin absolu (reçu « ${command} ») : le PATH du daemon n'est pas celui de ton terminal`
  }
  const ext = path.extname(command).toLowerCase()
  if (platform === 'win32' && (ext === '.cmd' || ext === '.bat')) {
    return `un script ${ext} ne se lance pas sans shell : déclare node.exe et le script .js ou .mjs à la place`
  }
  try {
    const s = await stat(command)
    if (!s.isFile()) return `« ${command} » n'est pas un fichier`
    // Sous Windows, X_OK ne vaut que F_OK : l'extension décide.
    await access(command, platform === 'win32' ? constants.F_OK : constants.X_OK)
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code
    return code === 'ENOENT' ? `« ${command} » n'existe pas` : `« ${command} » n'est pas exécutable (${code ?? (e as Error).message})`
  }
  return null
}

/**
 * Un serveur et son catalogue annoté : ce que rendent les routes.
 *
 * @returns `null` si le serveur n'existe pas
 */
export function mcpServerView(deps: Pick<McpServiceDeps, 'store'>, id: string): McpServerView | null {
  const server = deps.store.getMcpServer(id)
  if (!server) return null
  const catalog = deps.store.mcpCatalog(id)
  const { tools, missing } = mcpCatalogStatus(catalog?.tools ?? [], deps.store.mcpToolAllow(id))
  return { ...server, catalog_at: catalog?.at ?? null, tools, missing }
}

/** Tous les serveurs déclarés, avec leur catalogue. */
export function mcpServerViews(deps: Pick<McpServiceDeps, 'store'>): McpServerView[] {
  return deps.store.listMcpServers().map((s) => mcpServerView(deps, s.id)!)
}

/** Déclare ou met à jour un serveur, et dépose ses variables secrètes au coffre. */
export async function upsertMcpServer(
  deps: McpServiceDeps,
  input: UpsertMcpServerRequest,
): Promise<McpServerView | ProviderRefusal> {
  const existing = deps.store.getMcpServer(input.id)

  const commandProblem = await checkMcpCommand(input.command)
  if (commandProblem) return { error: 'invalid_command', status: 400, detail: { reason: commandProblem } }

  // Les noms : une variable est ordinaire ou secrète, pas les deux ; et deux
  // secrètes ne diffèrent pas que par la casse, le coffre les confondrait.
  const secretNames = [...new Set(input.secret_env)]
  const both = secretNames.filter((n) => n in input.env)
  if (both.length > 0) {
    return { error: 'invalid_env', status: 400, detail: { reason: `déclarée deux fois, ordinaire et secrète : ${both.join(', ')}` } }
  }
  const lowered = new Set<string>()
  for (const n of secretNames) {
    if (lowered.has(n.toLowerCase())) {
      return { error: 'invalid_env', status: 400, detail: { reason: `deux variables secrètes ne diffèrent que par la casse : ${n}` } }
    }
    lowered.add(n.toLowerCase())
  }
  const stray = Object.keys(input.secrets).filter((n) => !secretNames.includes(n))
  if (stray.length > 0) {
    return { error: 'invalid_env', status: 400, detail: { reason: `valeur fournie pour une variable non déclarée secrète : ${stray.join(', ')}` } }
  }
  // Une secrète sans valeur doit déjà être au coffre, c'est-à-dire déjà
  // déclarée secrète pour ce serveur.
  const missing = secretNames.filter((n) => !(n in input.secrets) && !existing?.secret_env.includes(n))
  if (missing.length > 0) {
    return { error: 'secret_value_required', status: 400, detail: { reason: `valeur attendue pour : ${missing.join(', ')}` } }
  }

  // Le coffre d'abord. Un échec ici arrête tout ; la déclaration précédente,
  // si elle existait, reste valide.
  try {
    for (const [name, value] of Object.entries(input.secrets)) {
      await deps.vault.set(await mcpSecretRef(deps.config.home, input.id, name), value)
    }
  } catch (e) {
    return { error: 'vault_write_failed', status: 500, detail: { reason: (e as Error).message } }
  }
  const removed = (existing?.secret_env ?? []).filter((n) => !secretNames.includes(n))
  for (const name of removed) {
    await deps.vault.delete(await mcpSecretRef(deps.config.home, input.id, name)).catch((e: Error) => {
      deps.log(`serveur MCP « ${input.id} » : ${name} non effacée du coffre : ${e.message}`)
    })
  }

  deps.store.upsertMcpServer({
    id: input.id,
    name: input.name ?? existing?.name ?? input.id,
    command: input.command,
    args: input.args,
    env: input.env,
    secretEnv: secretNames,
  })
  deps.log(`serveur MCP « ${input.id} » ${existing ? 'mis à jour' : 'déclaré'} : ${input.command}`)
  return mcpServerView(deps, input.id)!
}

/** Supprime un serveur, ses outils cochés et ses variables secrètes. */
export async function deleteMcpServer(
  deps: McpServiceDeps,
  id: string,
): Promise<{ ok: true; detached: string[] } | ProviderRefusal> {
  const server = deps.store.getMcpServer(id)
  if (!server) return { error: 'mcp_server_not_found', status: 404 }
  for (const name of server.secret_env) {
    await deps.vault.delete(await mcpSecretRef(deps.config.home, id, name)).catch((e: Error) => {
      // Un secret qu'on n'arrive pas à effacer n'empêche pas de retirer le
      // serveur : mieux vaut le signaler que bloquer l'humain.
      deps.log(`serveur MCP « ${id} » : ${name} non effacée du coffre : ${e.message}`)
    })
  }
  // Retiré des profils qui l'avaient, et dit : un profil qui garderait un
  // serveur disparu ferait échouer sa tâche suivante loin de la cause.
  const detached: string[] = []
  for (const agent of deps.store.agentsUsingMcpServer(id)) {
    deps.store.setAgentMcpServers(agent.id, agent.mcp_servers.filter((s) => s !== id))
    detached.push(agent.id)
  }
  deps.store.deleteMcpServer(id)
  deps.log(`serveur MCP « ${id} » retiré, avec ses outils cochés${detached.length ? ` ; retiré des profils ${detached.join(', ')}` : ''}`)
  return { ok: true, detached }
}

/**
 * Lit les valeurs secrètes d'un serveur au coffre.
 *
 * @returns les valeurs par nom, ou le nom de la première absente
 */
export async function mcpSecrets(
  deps: Pick<McpServiceDeps, 'config' | 'vault'>,
  id: string,
  names: readonly string[],
): Promise<{ values: Record<string, string> } | { absent: string }> {
  const values: Record<string, string> = {}
  for (const name of names) {
    const value = await deps.vault.get(await mcpSecretRef(deps.config.home, id, name))
    if (!value) return { absent: name }
    values[name] = value
  }
  return { values }
}

/** Un serveur lancé, prêt à servir : sa connexion, son catalogue et ses valeurs secrètes. */
export interface ConnectedMcpServer {
  connection: McpConnection
  /** Le catalogue annoncé **maintenant**, avec les empreintes. */
  catalog: McpTool[]
  /** Valeurs des variables secrètes : à ajouter à l'expurgation de qui s'en sert. */
  secretValues: string[]
  latencyMs: number
}

/**
 * Lance un serveur déclaré et lit son catalogue : le chemin commun au « Tester
 * la connexion » et au départ d'une tâche (étape 3), pour qu'un serveur qui
 * passe le test démarre de la même façon pour un agent.
 *
 * Le programme est **revérifié** (il a pu disparaître ou changer de droits
 * depuis la déclaration), les secrets lus au coffre, le serveur lancé sous la
 * garde, `initialize` puis `tools/list`.
 *
 * @param cwd dossier où le serveur tourne : le dossier runtime pour un test,
 *            le projet de la tâche pour un agent
 * @returns le serveur prêt — **à fermer** par l'appelant —, ou ce qui a
 *          échoué, en français, **expurgé** des valeurs secrètes
 */
export async function connectMcpServer(
  deps: Pick<McpServiceDeps, 'config' | 'vault' | 'env' | 'log'>,
  server: McpServer,
  cwd: string,
  signal?: AbortSignal,
): Promise<ConnectedMcpServer | { error: string; latencyMs: number | null }> {
  const commandProblem = await checkMcpCommand(server.command)
  if (commandProblem) return { error: commandProblem, latencyMs: null }
  const secrets = await mcpSecrets(deps, server.id, server.secret_env)
  if ('absent' in secrets) {
    return { error: `la variable secrète ${secrets.absent} est absente du coffre : redéclare-la`, latencyMs: null }
  }
  const secretValues = Object.values(secrets.values)
  const redact = createRedactor(secretValues)

  const started = Date.now()
  let connection: McpConnection | null = null
  try {
    connection = await McpConnection.open(
      { command: server.command, args: server.args, env: serverEnv(deps.env, { ...server.env, ...secrets.values }), cwd },
      { startupTimeoutMs: MCP_TEST_STARTUP_TIMEOUT_MS, signal, log: (m) => deps.log(redact(m)) },
    )
    const announced = await connection.listTools({ timeoutMs: MCP_TEST_LIST_TIMEOUT_MS, signal })
    const catalog: McpTool[] = announced.map((t) => {
      const tool = {
        name: t.name,
        title: t.title ?? t.annotations?.title ?? null,
        description: t.description ?? '',
        input_schema: t.inputSchema as Record<string, unknown>,
        annotations: (t.annotations as Record<string, unknown> | undefined) ?? null,
      }
      return { ...tool, fingerprint: mcpToolFingerprint(tool) }
    })
    return { connection, catalog, secretValues, latencyMs: Date.now() - started }
  } catch (e) {
    // La sortie d'erreur dit souvent pourquoi un serveur n'a pas démarré
    // (Java absent pour Ghidra, module introuvable) : on en cite le début et
    // la fin, expurgés — elle peut répéter une variable secrète. Un démarrage
    // raté n'a pas de connexion : l'erreur porte la sortie.
    const tail = connection?.stderrTail() ?? (e instanceof McpClientError ? e.stderrTail : '')
    const excerpt = tail.trim() ? ` — sortie d'erreur : ${stderrExcerpt(tail)}` : ''
    await connection?.close()
    return { error: redact(`${(e as Error).message}${excerpt}`), latencyMs: Date.now() - started }
  }
}

/**
 * « Tester la connexion » : lance réellement le serveur, fait `initialize`,
 * lit tout le catalogue, l'arrête — son groupe compris — et dit ce qu'il a vu.
 * Un test réussi remplace le catalogue en base.
 *
 * Le serveur tourne dans le dossier runtime : il n'y a pas de projet au
 * moment d'un test, et ce dossier n'appartient qu'à Midgaard.
 */
export async function testMcpServer(
  deps: McpServiceDeps,
  id: string,
  signal?: AbortSignal,
): Promise<McpServerView | ProviderRefusal> {
  const server = deps.store.getMcpServer(id)
  if (!server) return { error: 'mcp_server_not_found', status: 404 }
  const at = new Date().toISOString()
  const connected = await connectMcpServer(deps, server, deps.config.home, signal)
  if ('error' in connected) {
    const test: McpTest = { ok: false, detail: connected.error, at, latency_ms: connected.latencyMs, server: null, tools: 0 }
    deps.store.recordMcpTest(id, test, null)
    deps.log(`test du serveur MCP « ${id} » : échoué — ${connected.error}`)
    return mcpServerView(deps, id)!
  }
  try {
    const info = connected.connection.serverInfo
    const redact = createRedactor(connected.secretValues)
    const test: McpTest = {
      ok: true,
      detail: redact(`${info ? `${info.name} ${info.version}` : 'serveur sans nom'} : ${connected.catalog.length} outil(s) annoncé(s)`),
      at,
      latency_ms: connected.latencyMs,
      server: info ? { name: info.name, version: info.version } : null,
      tools: connected.catalog.length,
    }
    deps.store.recordMcpTest(id, test, connected.catalog)
    deps.log(`test du serveur MCP « ${id} » : réussi — ${test.detail}`)
    return mcpServerView(deps, id)!
  } finally {
    await connected.connection.close()
  }
}

/**
 * Coche des outils, chacun avec l'empreinte du catalogue constaté.
 *
 * Refusé sans catalogue — il n'y a rien que l'humain ait pu lire —, et pour
 * tout nom absent du catalogue : on ne coche pas un outil qu'on n'a pas vu.
 */
export function allowMcpTools(
  deps: Pick<McpServiceDeps, 'store' | 'log'>,
  id: string,
  names: readonly string[],
  by: string,
): McpServerView | ProviderRefusal {
  if (!deps.store.getMcpServer(id)) return { error: 'mcp_server_not_found', status: 404 }
  const catalog = deps.store.mcpCatalog(id)
  if (!catalog) {
    return { error: 'no_catalog', status: 409, detail: { reason: 'aucun catalogue : teste d\'abord la connexion, pour cocher ce que le serveur annonce' } }
  }
  const byName = new Map(catalog.tools.map((t) => [t.name, t]))
  const unknown = names.filter((n) => !byName.has(n))
  if (unknown.length > 0) {
    return { error: 'unknown_tools', status: 404, detail: { reason: `absents du catalogue : ${unknown.join(', ')}`, tools: unknown } }
  }
  const tools = [...new Set(names)].map((n) => ({ name: n, fingerprint: byName.get(n)!.fingerprint }))
  deps.store.allowMcpTools(id, tools, by)
  // Journalisé à chaque fois : c'est une autorisation durable, donnée une
  // fois et appliquée à toutes les tâches à venir.
  deps.log(`serveur MCP « ${id} » : ${tools.map((t) => t.name).join(', ')} libre(s) sans approbation, par ${by}`)
  return mcpServerView(deps, id)!
}

/** Décoche des outils. Refusé pour un nom qui n'était pas coché : l'humain doit savoir que rien n'a changé. */
export function revokeMcpTools(
  deps: Pick<McpServiceDeps, 'store' | 'log'>,
  id: string,
  names: readonly string[],
  by: string,
): McpServerView | ProviderRefusal {
  if (!deps.store.getMcpServer(id)) return { error: 'mcp_server_not_found', status: 404 }
  const allowed = new Set(deps.store.mcpToolAllow(id).map((a) => a.tool_name))
  const notAllowed = names.filter((n) => !allowed.has(n))
  if (notAllowed.length > 0) {
    return { error: 'not_allowed', status: 404, detail: { reason: `pas cochés : ${notAllowed.join(', ')}`, tools: notAllowed } }
  }
  const revoked = deps.store.revokeMcpTools(id, names)
  deps.log(`serveur MCP « ${id} » : ${revoked.join(', ')} approuvé(s) de nouveau à chaque appel, par ${by}`)
  return mcpServerView(deps, id)!
}
