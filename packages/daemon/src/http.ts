/**
 * @file Routeur HTTP du daemon.
 *
 * Deux familles de routes, avec deux régimes d'authentification :
 *
 *  - **`/api/…`** : jeton porteur obligatoire. Utilisées par le serveur MCP, la
 *    CLI, les tests et le dashboard une fois chargé.
 *  - **`/ui/bootstrap` et les fichiers du dashboard** : pas de jeton, car le
 *    navigateur n'en a aucun avant d'avoir chargé la page. Ces routes restent
 *    protégées par les contrôles d'enveloppe (`Host` exact, `Origin` en liste
 *    blanche, `Sec-Fetch-Site`), qui sont précisément ce qui arrête une page web
 *    malveillante. `/ui/bootstrap` remet le jeton d'API à la page ainsi servie.
 *
 * Les contrôles de sécurité passent **avant** le routage, y compris avant de
 * savoir si la route existe : un client refusé ne doit rien apprendre de l'API.
 *
 * | Méthode | Chemin | Rôle | Codes |
 * |---|---|---|---|
 * | GET  | `/api/health` | Vivacité, version de protocole, compteurs | 200 |
 * | POST | `/api/tasks` | Crée une tâche ; `project_dir` vérifié (`checkProjectDir`) | 201, 400 |
 * | GET  | `/api/tasks?status=&limit=` | Liste les tâches | 200 |
 * | POST | `/api/dialogs/directory` | Ouvre le sélecteur de dossier du système ; rend le dossier choisi, vérifié (`checkProjectDir`), ou `cancelled` | 200, 400, 409, 501 |
 * | GET  | `/api/tasks/:id` | État et consigne | 200, 404 |
 * | GET  | `/api/tasks/:id/wait?timeout_ms=&known_approval=` | Long-poll | 200, 404 |
 * | GET  | `/api/tasks/:id/events` | Timeline complète | 200, 404 |
 * | POST | `/api/tasks/:id/cancel` | Annulation | 200, 404, 409 |
 * | POST | `/api/tasks/:id/messages` | Message de l'utilisateur à une conversation qui l'attend | 200, 400, 404, 409 |
 * | POST | `/api/tasks/:id/continue` | Rebondit sur une tâche terminée d'un orchestrateur : crée la tâche qui la prolonge | 201, 400, 404, 409 |
 * | GET  | `/api/tasks/:id/tools` | Appels d'outils d'une tâche | 200, 404 |
 * | GET  | `/api/tasks/:id/workspace` | Worktree et diff, calculé à la demande | 200, 404 |
 * | GET  | `/api/tasks/:id/files/image?path=` | Une image de la tâche, en octets, type lu dans les octets | 200, 400, 404, 409, 413, 415 |
 * | GET  | `/api/tasks/:id/browser` | Session de navigateur ouverte de la tâche, et ce que montre sa dernière capture | 200, 404 |
 * | GET  | `/api/tasks/:id/browser/frame` | La dernière capture, en JPEG, depuis la mémoire du daemon | 200, 404 |
 * | POST | `/api/tasks/:id/browser/close` | L'humain coupe la session de navigateur | 200, 404, 409 |
 * | GET  | `/api/workspaces` | Tous les worktrees, état sur le disque, orphelins | 200 |
 * | POST | `/api/workspaces/:id/remove` | Retire un worktree (la branche reste) | 200, 404, 409 |
 * | GET  | `/api/exec-allow?project_dir=` | Liste blanche `exec` du dépôt, et la globale | 200, 400 |
 * | POST | `/api/exec-allow` | Ajoute un argv exact, ou un préfixe jugé (`prefix`, Slice 9), à la liste du dépôt | 200, 400 |
 * | POST | `/api/exec-allow/remove` | Retire un argv de la liste du dépôt | 200, 400, 404 |
 * | GET  | `/api/agents` | Profils d'agents, en vue : `enabled` et `disabled_reason` disent s'ils peuvent recevoir une tâche maintenant | 200 |
 * | GET  | `/api/agents/:id` | Un profil, en vue | 200, 404 |
 * | PATCH | `/api/agents/:id` | Fournisseur et modèle d'un profil | 200, 400, 404, 409 |
 * | PUT  | `/api/agents/:id/mcp` | Serveurs MCP d'un profil, liste complète (Slice 8) | 200, 400, 404, 409 |
 * | GET  | `/api/providers` | Fournisseurs **sans aucune clé** | 200 |
 * | POST | `/api/providers` | Déclare un fournisseur, dépose sa clé au coffre | 200, 400, 500 |
 * | DELETE | `/api/providers/:id` | Retire un fournisseur et sa clé | 200, 404 |
 * | POST | `/api/providers/:id/test` | « Test connection » | 200, 404 |
 * | POST | `/api/providers/:id/pricing` | Relève les tarifs chez le fournisseur | 200, 400, 404, 502 |
 * | GET  | `/api/mcp` | Serveurs MCP déclarés, catalogue annoté, **sans aucun secret** | 200 |
 * | POST | `/api/mcp` | Déclare un serveur MCP, dépose ses variables secrètes au coffre | 200, 400, 500 |
 * | GET  | `/api/mcp/:id` | Un serveur MCP et son catalogue | 200, 404 |
 * | DELETE | `/api/mcp/:id` | Retire un serveur, ses outils cochés et ses secrets | 200, 404 |
 * | POST | `/api/mcp/:id/test` | « Tester la connexion » : lance le serveur, lit son catalogue | 200, 404 |
 * | POST | `/api/mcp/:id/allow` | Coche des outils du catalogue, avec leur empreinte | 200, 400, 404, 409 |
 * | POST | `/api/mcp/:id/revoke` | Décoche des outils | 200, 400, 404 |
 * | GET  | `/api/approvals` | Demandes en attente | 200 |
 * | POST | `/api/approvals/:id/approve` | Décision humaine | 200, 404, 409 |
 * | POST | `/api/approvals/:id/reject` | Décision humaine | 200, 404, 409 |
 * | POST | `/api/shutdown` | Arrêt propre ; `{ if_idle: true }` le refuse tant qu'une tâche est active | 200, 409 |
 * | GET  | `/ui/bootstrap` | Jeton d'API pour le dashboard | 200 |
 * | GET  | `/*` | Fichiers du dashboard | 200, 404 |
 *
 * Erreurs communes : 401 sans jeton valide, 403 sur enveloppe refusée, 400 sur
 * corps invalide ou trop gros, 405 sur méthode inconnue.
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import {
  createTaskRequestSchema,
  execAllowRequestSchema,
  execPrefixRefusal,
  formatExecRule,
  mcpAllowRequestSchema,
  continueTaskRequestSchema,
  postMessageRequestSchema,
  removeWorkspaceRequestSchema,
  setAgentMcpRequestSchema,
  updateAgentRequestSchema,
  upsertMcpServerRequestSchema,
  upsertProviderRequestSchema,
  type HarnessConfig,
  type Health,
} from '@midgaard/contracts'
import type { EventBus } from './bus.ts'
import type { BrowserSessions } from './browsers.ts'
import type { HarnessStore } from '@midgaard/persistence'
import type { TaskManager } from './task-manager.ts'
import type { StaticFiles } from './static-files.ts'
import {
  deleteProvider,
  refreshPricing,
  testProvider,
  upsertProvider,
  type ProviderRefusal,
  type ProviderServiceDeps,
} from './providers.ts'
import {
  allowMcpTools,
  deleteMcpServer,
  mcpServerView,
  mcpServerViews,
  revokeMcpTools,
  testMcpServer,
  upsertMcpServer,
} from './mcp-servers.ts'
import { checkEnvelope, checkToken, type SecurityContext } from './security.ts'
import { execAllowFor, listWorkspaces, removeWorkspace, workspaceView } from './workspaces.ts'
import { FileAccessError, taskImage } from './files.ts'
import { setAgentMcpServers, updateAgentModel } from './agents.ts'
import { checkProjectDir } from './project-dir.ts'
import type { DirectoryPicker } from './pick-directory.ts'

/** Taille maximale d'un corps de requête, contre l'épuisement mémoire. */
const MAX_BODY_BYTES = 64 * 1024

/** Ce que le routeur emprunte au daemon. */
export interface HttpDeps {
  store: HarnessStore
  tasks: TaskManager
  files: StaticFiles
  security: () => SecurityContext
  health: () => Health
  /** Jeton d'API, remis au dashboard par `/ui/bootstrap`. */
  token: () => string
  /** Délai maximal d'un long-poll, borne supérieure imposée au client. */
  maxWaitMs: number
  log: (...a: unknown[]) => void
  /** Repousse l'arrêt pour inactivité. */
  touch: () => void
  /** Demande l'arrêt du daemon (route `/api/shutdown`). */
  shutdown: (reason: string) => void
  /** Service des fournisseurs : coffre, tests de connexion, tarifs. */
  providers: ProviderServiceDeps
  /** Bus d'écriture : le retrait d'un worktree s'écrit avec son événement. */
  bus: EventBus
  config: HarnessConfig
  /** Sessions de navigateur des tâches (Slice 7) : l'humain peut en couper une. */
  browsers?: BrowserSessions | undefined
  /**
   * Sélecteur de dossier du système (`POST /api/dialogs/directory`). Absent,
   * la route répond 501 : fermé par défaut, un routeur assemblé sans y penser
   * n'ouvre aucune fenêtre.
   */
  pickDirectory?: DirectoryPicker | undefined
}

/**
 * Vrai pendant qu'un dialogue de dossier est ouvert, par sélecteur. Un seul à
 * la fois : deux fenêtres modales empilées, dont l'une cachée, laisseraient
 * une requête attendre un humain qui ne la voit pas.
 */
const openDialogs = new WeakSet<DirectoryPicker>()

/**
 * Envoie des octets — une image —, sans qu'ils puissent devenir une page.
 *
 * `nosniff` interdit au navigateur de deviner un autre type que celui annoncé,
 * et la politique de contenu vide fait qu'un document servi ici n'exécuterait
 * rien : l'image vient d'un worktree écrit par l'agent, ou d'une page web.
 */
function sendBytes(res: ServerResponse, type: string, bytes: Buffer, headers: Record<string, string> = {}): void {
  if (res.writableEnded || res.destroyed) return
  res.writeHead(200, {
    'content-type': type,
    'content-length': String(bytes.length),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'content-security-policy': "default-src 'none'",
    ...headers,
  })
  res.end(bytes)
}

/** Envoie une réponse JSON, sauf si la connexion est déjà close — cas normal
 * d'un long-poll dont le client est parti. */
function send(res: ServerResponse, status: number, body: unknown): void {
  if (res.writableEnded || res.destroyed) return
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(body))
}

/**
 * Lit et parse un corps JSON, en coupant au-delà de `MAX_BODY_BYTES`.
 * @returns l'objet parsé, ou `{}` pour un corps vide
 * @throws sur corps trop gros ou JSON invalide (transformé en 400 par le routeur)
 */
async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  let size = 0
  const chunks: Buffer[] = []
  for await (const c of req) {
    size += (c as Buffer).length
    if (size > MAX_BODY_BYTES) throw new Error('corps de requête trop volumineux')
    chunks.push(c as Buffer)
  }
  return chunks.length ? (JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>) : {}
}

/** Construit le gestionnaire de requêtes du daemon. */
export function createRequestHandler(deps: HttpDeps) {
  return async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const ctx = deps.security()
    try {
      const denial = checkEnvelope(req, ctx)
      if (denial) return send(res, denial.status, { error: denial.error })

      const url = new URL(req.url ?? '/', `http://127.0.0.1:${ctx.port}`)
      const method = req.method ?? 'GET'

      // --- Dashboard : pas de jeton, l'enveloppe fait la sécurité -----------
      if (url.pathname === '/ui/bootstrap') {
        if (method !== 'GET') return send(res, 405, { error: 'method_not_allowed' })
        deps.touch()
        return send(res, 200, { token: deps.token(), health: deps.health() })
      }
      if (!url.pathname.startsWith('/api/')) {
        if (method !== 'GET' && method !== 'HEAD') return send(res, 405, { error: 'method_not_allowed' })
        return deps.files.serve(url.pathname, res)
      }

      // --- API : jeton obligatoire -----------------------------------------
      const unauthorized = checkToken(req, ctx)
      if (unauthorized) return send(res, unauthorized.status, { error: unauthorized.error })
      deps.touch()

      const parts = url.pathname.split('/').filter(Boolean) // ['api', …]
      const section = parts[1]
      const id = parts[2]
      const action = parts[3]

      if (section === 'health' && method === 'GET') return send(res, 200, deps.health())

      if (section === 'shutdown' && method === 'POST') {
        // `if_idle` : la décision « oisif ou non » se prend ICI, entre la
        // lecture du compteur et l'arrêt, sans `await` entre les deux. Faite par
        // le serveur MCP sur un `/api/health` lu avant, elle laisserait une tâche
        // déléguée entre-temps par une autre session se faire interrompre.
        const body = await readJson(req).catch(() => ({}) as Record<string, unknown>)
        if (body.if_idle === true) {
          const active = deps.health().tasks.active
          if (active > 0) return send(res, 409, { error: 'busy', active })
        }
        send(res, 200, { ok: true })
        return deps.shutdown('requête /api/shutdown')
      }

      if (section === 'approvals') return handleApprovals(deps, res, method, id, action, req)
      if (section === 'tasks') return handleTasks(deps, res, method, url, id, action, req)
      if (section === 'agents') return handleAgents(deps, res, method, id, action, req)
      if (section === 'providers') return handleProviders(deps, res, method, id, action, req)
      if (section === 'mcp') return handleMcp(deps, res, method, id, action, req)
      if (section === 'workspaces') return handleWorkspaces(deps, res, method, id, action, req)
      if (section === 'exec-allow') return handleExecAllow(deps, res, method, url, id, req)
      if (section === 'dialogs' && id === 'directory' && !action) {
        if (method !== 'POST') return send(res, 405, { error: 'method_not_allowed' })
        return handlePickDirectory(deps, res, req)
      }
      if (section === 'pricing' && method === 'GET') {
        return send(res, 200, { pricing: deps.providers.pricing() })
      }

      return send(res, 404, { error: 'not_found' })
    } catch (e) {
      deps.log('erreur de requête', e)
      return send(res, 400, { error: 'bad_request', detail: (e as Error).message })
    }
  }
}

/**
 * Routes `/api/mcp…` (Slice 8) : serveurs MCP déclarés par l'humain.
 *
 * ⚠️ Comme pour les fournisseurs, ce que ces routes **rendent** ne contient
 * aucun secret : une déclaration ne porte que les **noms** des variables
 * secrètes. Les valeurs n'arrivent que dans le corps d'un `POST /api/mcp`, et
 * partent au coffre.
 */
async function handleMcp(
  deps: HttpDeps,
  res: ServerResponse,
  method: string,
  id: string | undefined,
  action: string | undefined,
  req: IncomingMessage,
): Promise<void> {
  const refuse = (r: ProviderRefusal) => send(res, r.status, { error: r.error, ...r.detail })

  if (!id) {
    if (method === 'GET') return send(res, 200, { servers: mcpServerViews(deps.providers) })
    if (method === 'POST') {
      const parsed = upsertMcpServerRequestSchema.safeParse(await readJson(req))
      if (!parsed.success) return send(res, 400, { error: 'invalid_request', detail: parsed.error.issues })
      const outcome = await upsertMcpServer(deps.providers, parsed.data)
      return 'error' in outcome ? refuse(outcome) : send(res, 200, { server: outcome })
    }
    return send(res, 405, { error: 'method_not_allowed' })
  }

  if (!action) {
    if (method === 'GET') {
      const view = mcpServerView(deps.providers, id)
      return view ? send(res, 200, { server: view }) : send(res, 404, { error: 'mcp_server_not_found' })
    }
    if (method === 'DELETE') {
      const outcome = await deleteMcpServer(deps.providers, id)
      return 'error' in outcome ? refuse(outcome) : send(res, 200, outcome)
    }
    return send(res, 405, { error: 'method_not_allowed' })
  }

  if (method === 'POST' && action === 'test') {
    // Un test lance un programme et peut durer jusqu'au délai de la poignée
    // de main : l'abandon du client l'arrête, groupe de processus compris.
    const aborter = new AbortController()
    res.on('close', () => {
      if (!res.writableFinished) aborter.abort()
    })
    const outcome = await testMcpServer(deps.providers, id, aborter.signal)
    return 'error' in outcome ? refuse(outcome) : send(res, 200, { server: outcome })
  }

  if (method === 'POST' && (action === 'allow' || action === 'revoke')) {
    const parsed = mcpAllowRequestSchema.safeParse(await readJson(req))
    if (!parsed.success) return send(res, 400, { error: 'invalid_request', detail: parsed.error.issues })
    const { tools, by } = parsed.data
    const outcome = action === 'allow' ? allowMcpTools(deps.providers, id, tools, by) : revokeMcpTools(deps.providers, id, tools, by)
    return 'error' in outcome ? refuse(outcome) : send(res, 200, { server: outcome })
  }

  return send(res, 405, { error: 'method_not_allowed' })
}

/** Routes `/api/workspaces…`. */
async function handleWorkspaces(
  deps: HttpDeps,
  res: ServerResponse,
  method: string,
  id: string | undefined,
  action: string | undefined,
  req: IncomingMessage,
): Promise<void> {
  if (!id && method === 'GET') return send(res, 200, await listWorkspaces(deps.store, deps.config))
  if (id && action === 'remove' && method === 'POST') {
    const parsed = removeWorkspaceRequestSchema.safeParse(await readJson(req))
    if (!parsed.success) return send(res, 400, { error: 'invalid_request', issues: parsed.error.issues })
    const done = await removeWorkspace(deps, id, parsed.data)
    if ('error' in done) return send(res, done.status, { error: done.error, reason: done.reason })
    deps.log(`worktree ${done.workspace.branch} retiré par ${parsed.data.by}${parsed.data.force ? ' (forcé)' : ''}`)
    return send(res, 200, done)
  }
  return send(res, 405, { error: 'method_not_allowed' })
}

/**
 * Routes `/api/exec-allow…`. Un dossier qui n'est pas dans un dépôt Git est un
 * 400 : la liste blanche est rangée par dépôt, et il n'y en a pas.
 */
async function handleExecAllow(
  deps: HttpDeps,
  res: ServerResponse,
  method: string,
  url: URL,
  sub: string | undefined,
  req: IncomingMessage,
): Promise<void> {
  const refuse = (e: unknown) => send(res, 400, { error: 'not_a_repository', reason: (e as Error).message })
  if (!sub && method === 'GET') {
    const dir = url.searchParams.get('project_dir')
    if (!dir) return send(res, 400, { error: 'project_dir_required' })
    return execAllowFor(deps.store, deps.config, dir).then((body) => send(res, 200, body), refuse)
  }
  if (method !== 'POST' || (sub && sub !== 'remove')) return send(res, 405, { error: 'method_not_allowed' })
  const parsed = execAllowRequestSchema.safeParse(await readJson(req))
  if (!parsed.success) return send(res, 400, { error: 'invalid_request', issues: parsed.error.issues })
  let repoDir: string
  try {
    repoDir = (await execAllowFor(deps.store, deps.config, parsed.data.project_dir)).repo_dir
  } catch (e) {
    return refuse(e)
  }
  const { argv, by, prefix } = parsed.data
  if (sub === 'remove') {
    if (!deps.store.removeExecAllow(repoDir, argv)) return send(res, 404, { error: 'not_in_allowlist' })
    deps.log(`exec : « ${argv.join(' ')} » retirée de la liste blanche de ${repoDir} par ${by}`)
    return send(res, 200, await execAllowFor(deps.store, deps.config, repoDir))
  }
  // Rejugé ici même si la CLI l'a déjà fait : le daemon ne fait confiance à
  // aucun client, et un préfixe accepté vaut pour toutes les tâches à venir.
  const refusal = prefix ? execPrefixRefusal(argv) : null
  if (refusal) return send(res, 400, { error: 'prefix_refused', reason: refusal })
  const outcome = deps.store.addExecAllow(repoDir, argv, by, prefix)
  // Journalisé à chaque ajout ou élargissement : c'est une autorisation
  // durable, donnée une fois et appliquée à toutes les tâches à venir.
  const shown = formatExecRule({ argv, prefix })
  if (outcome === 'added') deps.log(`exec : « ${shown} » ajoutée sans approbation pour ${repoDir} par ${by}`)
  if (outcome === 'widened') deps.log(`exec : « ${argv.join(' ')} » élargie en préfixe « ${shown} » pour ${repoDir} par ${by}`)
  return send(res, 200, { ...(await execAllowFor(deps.store, deps.config, repoDir)), outcome })
}

/**
 * `POST /api/dialogs/directory` : l'humain choisit un dossier dans
 * l'explorateur de son système, et la route rend son chemin.
 *
 * La requête reste ouverte tant que le dialogue l'est — c'est l'humain qui
 * décide quand il a fini. Si le client part (page fermée, rechargée), le
 * dialogue est tué : personne ne lirait plus sa réponse. Le chemin choisi
 * passe par `checkProjectDir`, comme un chemin tapé : choisir son dossier
 * personnel dans le dialogue est refusé avec la même phrase.
 *
 * Aucune tâche n'est créée et rien n'est lu : le daemon n'apprend que le
 * chemin que l'humain a désigné lui-même.
 */
async function handlePickDirectory(deps: HttpDeps, res: ServerResponse, req: IncomingMessage): Promise<void> {
  const picker = deps.pickDirectory
  const unavailable = picker ? picker.available() : 'ce daemon n\'a pas de sélecteur de dossier'
  if (!picker || unavailable !== null) return send(res, 501, { error: 'picker_unavailable', reason: unavailable })
  const body = await readJson(req)
  const startDir = typeof body.start_dir === 'string' && body.start_dir.length <= 4096 ? body.start_dir : null
  // Lu et posé sans `await` entre les deux : deux requêtes simultanées ne
  // passent pas toutes les deux.
  if (openDialogs.has(picker)) {
    return send(res, 409, { error: 'dialog_open', reason: 'un sélecteur de dossier est déjà ouvert sur ce poste' })
  }
  openDialogs.add(picker)
  const aborter = new AbortController()
  res.on('close', () => {
    if (!res.writableFinished) aborter.abort()
  })
  try {
    const outcome = await picker.pick(startDir, aborter.signal)
    if ('unavailable' in outcome) return send(res, 501, { error: 'picker_unavailable', reason: outcome.unavailable })
    if ('cancelled' in outcome) return send(res, 200, { cancelled: true })
    const checked = checkProjectDir(outcome.dir, deps.config.userHome)
    if ('error' in checked) return send(res, 400, { error: 'invalid_project_dir', reason: checked.error })
    return send(res, 200, { dir: checked.dir })
  } finally {
    openDialogs.delete(picker)
  }
}

/** Routes `/api/tasks…`. */
async function handleTasks(
  deps: HttpDeps,
  res: ServerResponse,
  method: string,
  url: URL,
  id: string | undefined,
  action: string | undefined,
  req: IncomingMessage,
): Promise<void> {
  if (!id) {
    if (method === 'POST') {
      // Le serveur MCP valide déjà ces bornes ; le daemon revérifie, car il ne
      // doit jamais faire confiance à un client, même local.
      const parsed = createTaskRequestSchema.safeParse(await readJson(req))
      if (!parsed.success) {
        return send(res, 400, { error: 'invalid_request', detail: parsed.error.issues })
      }
      // Le dossier se vérifie ici, avant la création : un chemin tapé au
      // dashboard est une source nouvelle (Slice 5, décision 9). Pas pour le
      // profil simulé, qui ne lit rien et ignore ce champ.
      let projectDir = parsed.data.project_dir ?? null
      if (projectDir !== null && deps.store.getAgent(parsed.data.agent_id)?.kind !== 'simulated') {
        const checked = checkProjectDir(projectDir, deps.config.userHome)
        if ('error' in checked) return send(res, 400, { error: 'invalid_project_dir', reason: checked.error })
        projectDir = checked.dir
      }
      const created = deps.tasks.create({
        objective: parsed.data.objective.trim(),
        agentId: parsed.data.agent_id,
        context: parsed.data.context ?? null,
        projectDir,
        durationS: parsed.data.duration_s,
        needsApproval: parsed.data.needs_approval,
        conversation: parsed.data.conversation,
      })
      if ('error' in created) return send(res, created.status, { error: created.error, ...created.detail })
      return send(res, 201, deps.tasks.view(created.task))
    }
    if (method === 'GET') {
      const status = url.searchParams.get('status') ?? undefined
      const limit = Number(url.searchParams.get('limit') ?? 200)
      return send(res, 200, {
        tasks: deps.store.listTasks({
          ...(status ? { status: status as never } : {}),
          limit: Number.isFinite(limit) ? Math.min(Math.max(limit, 1), 500) : 200,
        }),
      })
    }
    return send(res, 405, { error: 'method_not_allowed' })
  }

  const view = deps.tasks.viewOf(id)
  if (!view) return send(res, 404, { error: 'task_not_found' })

  if (method === 'GET' && !action) return send(res, 200, view)
  if (method === 'GET' && action === 'events') return send(res, 200, { events: deps.tasks.events(id) })
  if (method === 'GET' && action === 'tools') return send(res, 200, { tool_calls: deps.tasks.toolCalls(id) })
  if (method === 'GET' && action === 'workspace') return send(res, 200, await workspaceView(deps.store, id))

  // Une image lue par un agent, pour le fil (Slice 7) : seule lecture de
  // fichier que l'API expose, sans méthode d'écriture. L'empreinte complète
  // accompagne les octets : le fil la compare à celle que l'outil a journalisée.
  if (method === 'GET' && action === 'files') {
    const sub = url.pathname.split('/').filter(Boolean)[4]
    if (sub !== 'image') return send(res, 404, { error: 'not_found' })
    try {
      const image = await taskImage(deps.store, view.task, url.searchParams.get('path') ?? '')
      return sendBytes(res, image.mediaType, image.bytes, { 'x-midgaard-sha256': image.sha256 })
    } catch (e) {
      if (e instanceof FileAccessError) return send(res, e.status, { error: e.code, reason: e.message })
      throw e
    }
  }

  if (method === 'GET' && action === 'wait') {
    const asked = Number(url.searchParams.get('timeout_ms') ?? 25_000)
    const timeoutMs = Math.min(Math.max(Number.isFinite(asked) ? asked : 25_000, 0), deps.maxWaitMs)
    // `0` par défaut : sans information du client, toute pause est nouvelle pour lui.
    const known = Math.max(Number(url.searchParams.get('known_approval') ?? 0) || 0, 0)

    // `res` et non `req` : `req` émet 'close' dès que le corps est lu, alors que
    // `res` ne l'émet qu'à la fin de la réponse ou quand le client coupe.
    const aborter = new AbortController()
    res.on('close', () => {
      if (!res.writableFinished) aborter.abort()
    })
    const result = await deps.tasks.wait(id, timeoutMs, known, aborter.signal)
    if (!result) return send(res, 404, { error: 'task_not_found' })
    return send(res, 200, result)
  }

  // Le navigateur d'une tâche (Slice 7). Couper est un acte humain, comme
  // approuver : aucun outil ne l'expose à un modèle. L'agent l'apprend à son
  // action suivante, avec le motif.
  if (action === 'browser') {
    const sub = url.pathname.split('/').filter(Boolean)[4]
    if (method === 'GET' && sub === undefined) {
      // Ce que montre la dernière capture, sans elle : l'adresse et le titre,
      // écrits par la page, que le dashboard affiche comme du texte.
      const frame = deps.browsers?.frame(id) ?? null
      return send(res, 200, {
        session: deps.browsers?.info(id) ?? null,
        frame: frame ? { url: frame.url, title: frame.title, at: new Date(frame.at).toISOString() } : null,
      })
    }
    // La capture elle-même, depuis la mémoire : aucune n'est écrite en base.
    if (method === 'GET' && sub === 'frame') {
      const frame = deps.browsers?.frame(id) ?? null
      if (!frame) return send(res, 404, { error: 'no_frame' })
      return sendBytes(res, 'image/jpeg', frame.jpeg)
    }
    if (method === 'POST' && sub === 'close') {
      const closed = (await deps.browsers?.close(id, 'cut by the human operator')) ?? false
      if (!closed) return send(res, 409, { error: 'no_browser_session' })
      return send(res, 200, { closed: true })
    }
    const known = sub === undefined || sub === 'close' || sub === 'frame'
    return send(res, known ? 405 : 404, { error: known ? 'method_not_allowed' : 'not_found' })
  }

  if (method === 'POST' && action === 'cancel') {
    const body = await readJson(req).catch(() => ({}) as Record<string, unknown>)
    const reason = typeof body.reason === 'string' ? body.reason : undefined
    const outcome = deps.tasks.cancel(id, reason)
    if ('error' in outcome) return send(res, outcome.status, { error: outcome.error, ...outcome.detail })
    return send(res, 200, outcome)
  }

  if (method === 'POST' && action === 'messages') {
    const parsed = postMessageRequestSchema.safeParse(await readJson(req))
    if (!parsed.success) return send(res, 400, { error: 'invalid_request', detail: parsed.error.issues })
    const outcome = deps.tasks.postMessage(id, parsed.data)
    if ('error' in outcome) return send(res, outcome.status, { error: outcome.error, ...outcome.detail })
    return send(res, 200, outcome)
  }

  if (method === 'POST' && action === 'continue') {
    // Le client n'envoie que son message : profil, dossier et contexte sont
    // repris de la tâche prolongée par le daemon, qui pose seul le lien.
    const parsed = continueTaskRequestSchema.safeParse(await readJson(req))
    if (!parsed.success) return send(res, 400, { error: 'invalid_request', detail: parsed.error.issues })
    const created = deps.tasks.continueTask(id, parsed.data)
    if ('error' in created) return send(res, created.status, { error: created.error, ...created.detail })
    return send(res, 201, deps.tasks.view(created.task))
  }

  return send(res, 405, { error: 'method_not_allowed' })
}

/** Routes `/api/approvals…`. Seul un humain les appelle : ni le serveur MCP, ni le modèle. */
async function handleApprovals(
  deps: HttpDeps,
  res: ServerResponse,
  method: string,
  id: string | undefined,
  action: string | undefined,
  req: IncomingMessage,
): Promise<void> {
  if (!id) {
    if (method !== 'GET') return send(res, 405, { error: 'method_not_allowed' })
    return send(res, 200, { approvals: deps.store.pendingApprovals() })
  }
  if (method !== 'POST' || (action !== 'approve' && action !== 'reject')) {
    return send(res, 405, { error: 'method_not_allowed' })
  }
  const body = await readJson(req).catch(() => ({}) as Record<string, unknown>)
  const by = typeof body.by === 'string' && body.by ? body.by : 'cli'
  const reason = typeof body.reason === 'string' ? body.reason : undefined
  const outcome = action === 'approve' ? deps.tasks.approve(id, by) : deps.tasks.reject(id, by, reason)
  if ('error' in outcome) return send(res, outcome.status, { error: outcome.error, ...outcome.detail })
  return send(res, 200, outcome)
}

/**
 * Routes `/api/agents…`. Les profils livrés d'office sont posés au démarrage,
 * et leur activation suit celle de leur fournisseur ; seuls le fournisseur et
 * le modèle se règlent ici (`PATCH`, Slice 5) — jamais les limites, que l'API
 * ne permet pas de relever.
 */
async function handleAgents(
  deps: HttpDeps,
  res: ServerResponse,
  method: string,
  id: string | undefined,
  action: string | undefined,
  req: IncomingMessage,
): Promise<void> {
  if (id && action === 'mcp') {
    if (method !== 'PUT') return send(res, 405, { error: 'method_not_allowed' })
    const parsed = setAgentMcpRequestSchema.safeParse(await readJson(req))
    if (!parsed.success) return send(res, 400, { error: 'invalid_request', detail: parsed.error.issues })
    const outcome = setAgentMcpServers(deps.store, id, parsed.data.servers, deps.log)
    if ('error' in outcome) return send(res, outcome.status, { error: outcome.error, ...outcome.detail })
    return send(res, 200, { agent: deps.tasks.agentView(outcome) })
  }
  if (action) return send(res, 404, { error: 'not_found' })
  if (!id) {
    if (method !== 'GET') return send(res, 405, { error: 'method_not_allowed' })
    // La vue, pas la ligne : `enabled` et `disabled_reason` disent si le
    // profil peut recevoir une tâche maintenant (Slice 7, un Navigator aveugle).
    return send(res, 200, { agents: deps.store.listAgents().map((a) => deps.tasks.agentView(a)) })
  }
  if (method === 'GET') {
    const agent = deps.store.getAgent(id)
    return agent ? send(res, 200, { agent: deps.tasks.agentView(agent) }) : send(res, 404, { error: 'agent_not_found' })
  }
  if (method === 'PATCH') {
    const parsed = updateAgentRequestSchema.safeParse(await readJson(req))
    if (!parsed.success) return send(res, 400, { error: 'invalid_request', detail: parsed.error.issues })
    const outcome = updateAgentModel(deps.store, id, parsed.data, deps.log)
    if ('error' in outcome) return send(res, outcome.status, { error: outcome.error, ...outcome.detail })
    // Un autre modèle, une autre vue : constatée avant de répondre, pour que
    // le dashboard montre tout de suite si le Navigator peut partir.
    await deps.tasks.probeVision(id)
    return send(res, 200, { agent: deps.tasks.agentView(deps.store.getAgent(id) ?? outcome) })
  }
  return send(res, 405, { error: 'method_not_allowed' })
}

/**
 * Routes `/api/providers…`.
 *
 * ⚠️ Ce que ces routes **rendent** ne contient jamais de clé : `ProviderConfig`
 * ne porte qu'un `secret_ref`. La seule clé qui circule ici est celle que
 * l'utilisateur dépose, dans le corps d'un `POST`, et elle part au coffre sans
 * être écrite nulle part ailleurs.
 */
async function handleProviders(
  deps: HttpDeps,
  res: ServerResponse,
  method: string,
  id: string | undefined,
  action: string | undefined,
  req: IncomingMessage,
): Promise<void> {
  if (!id) {
    if (method === 'GET') {
      const pricing = deps.providers.pricing()
      return send(res, 200, {
        providers: deps.store.listProviders(),
        pricing: {
          updated_at: pricing.updated_at,
          source: pricing.source,
          models: Object.keys(pricing.entries).length,
        },
      })
    }
    if (method === 'POST') {
      const parsed = upsertProviderRequestSchema.safeParse(await readJson(req))
      if (!parsed.success) return send(res, 400, { error: 'invalid_request', detail: parsed.error.issues })
      const outcome = await upsertProvider(deps.providers, parsed.data)
      if ('error' in outcome) return send(res, outcome.status, { error: outcome.error, ...outcome.detail })
      // Un fournisseur ajouté peut rattacher un Navigator : sa vue se constate.
      await deps.tasks.probeVision()
      return send(res, 200, { provider: outcome })
    }
    return send(res, 405, { error: 'method_not_allowed' })
  }

  if (method === 'DELETE' && !action) {
    const outcome = await deleteProvider(deps.providers, id)
    if ('error' in outcome) return send(res, outcome.status, { error: outcome.error, ...outcome.detail })
    return send(res, 200, outcome)
  }

  if (method === 'POST' && action === 'test') {
    // Un test de connexion sort sur le réseau : il peut durer. Le délai est
    // celui de l'adaptateur, et l'abandon du client coupe l'appel.
    const aborter = new AbortController()
    res.on('close', () => {
      if (!res.writableFinished) aborter.abort()
    })
    const outcome = await testProvider(deps.providers, id, aborter.signal)
    if ('error' in outcome) return send(res, outcome.status, { error: outcome.error, ...outcome.detail })
    return send(res, 200, outcome)
  }

  if (method === 'POST' && action === 'pricing') {
    const aborter = new AbortController()
    res.on('close', () => {
      if (!res.writableFinished) aborter.abort()
    })
    const outcome = await refreshPricing(deps.providers, id, aborter.signal)
    if ('error' in outcome) return send(res, outcome.status, { error: outcome.error, ...outcome.detail })
    return send(res, 200, outcome)
  }

  return send(res, 405, { error: 'method_not_allowed' })
}
