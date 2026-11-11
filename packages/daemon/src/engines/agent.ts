/**
 * @file Moteur des agents réels : il relie la boucle d'exécution au daemon.
 *
 * Son travail tient en quatre points, et aucun n'est de la logique d'agent —
 * celle-là vit dans `@midgaard/agent-runtime`, qui ne connaît ni base ni daemon :
 *
 *  1. **Résoudre de quoi partir** : le fournisseur, sa clé dans le coffre, le
 *     tarif du modèle, la racine de lecture. Un échec ici arrête la tâche avec
 *     un message qui dit quoi faire, pas une trace de pile.
 *  2. **Traduire les crochets de la boucle en écritures du bus**, pour que tout
 *     ce que fait l'agent apparaisse dans la timeline en direct.
 *  3. **Faire attendre une décision humaine** : c'est le seul endroit où la
 *     boucle s'arrête sans consommer, et le seul que le modèle ne contourne pas.
 *  4. **Conclure** — en vérifiant d'abord que personne n'a conclu avant lui.
 *
 * Pour un Developer, deux temps s'ajoutent, et ils encadrent la boucle :
 *
 *  - **en `preparing`**, le worktree est créé et enregistré ; la racine des
 *    outils devient le worktree, et l'écriture y est ouverte ;
 *  - **à la fin**, le travail est commité sur la branche — seulement si la
 *    tâche a abouti : `submit_result` est l'acte qui fait d'une branche un
 *    résultat, et une tâche qui échoue ne doit pas laisser une branche qui en
 *    a l'air. Le worktree est conservé **dans tous les cas**, pour qu'on puisse
 *    lire ce que l'agent avait fait, même interrompu.
 *
 * Ce dernier point n'est pas de la prudence excessive. Un refus d'approbation ou
 * une expiration fait passer la tâche en `cancelled` ou `timed_out` **pendant**
 * que la boucle tourne encore ; elle rendra ensuite son propre verdict, sur une
 * tâche déjà terminée. Écrire alors ferait lever `IllegalTransitionError` et
 * remplacerait un historique juste par un historique faux.
 */
import type { Agent, AgentKind, Approval, PricingTable, ProviderConfig, Task, TaskWorkspace, Workspace } from '@midgaard/contracts'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRedactor, harnessCommand, isTerminal, type Usage } from '@midgaard/contracts'
import { agentIdentity, commitAll, createWorktree, diffWorktree, inspectRepository, WorkspaceError } from '@midgaard/workspace'
import { createAdapter, envVarFor, type ModelCapabilities } from '@midgaard/providers'
import { resolveApiKey, type SecretVault } from '@midgaard/secrets'
import { ASK_PARENT, BROWSER_TOOLS, VISION_TOOLS, WEB_TOOLS, type Tool, type ToolContext } from '@midgaard/tools'
import type { BrowserSessions } from '../browsers.ts'
import type { WebReaders } from '../web.ts'
import { MCP_CAPABLE_KINDS } from '../agents.ts'
import type { McpSessions } from '../mcp-sessions.ts'
import { execRulesForTask } from '../workspaces.ts'

/** Un profil qui a l'un de ces outils reçoit le navigateur de sa tâche (Slice 7). */
const hasBrowser = (tools: readonly string[]): boolean => tools.some((t) => (BROWSER_TOOLS as readonly string[]).includes(t))
/** Vrai si le profil a un outil du web lu par navigateur (`search_web`, `read_web_page`). */
const hasWeb = (tools: readonly string[]): boolean => tools.some((t) => (WEB_TOOLS as readonly string[]).includes(t))

/**
 * Le modèle de la tâche lit-il les images ? (Slice 7, décision 2.)
 *
 * Le catalogue du fournisseur l'emporte quand il publie la capacité : une
 * déclaration contraire serait une erreur de l'utilisateur, et l'image serait
 * facturée pour rien. Sinon, la déclaration du profil. Sinon, non — en disant
 * comment la faire. Le motif est lu par le modèle, d'où l'anglais.
 */
export function visionOf(
  caps: ModelCapabilities,
  declared: boolean | null,
  providerId: string,
  model: string,
): VisionVerdict {
  if (caps.vision === true) {
    return { enabled: true, source: 'catalog', reason: `the catalogue of provider "${providerId}" says model "${model}" reads images` }
  }
  if (caps.vision === false) {
    return {
      enabled: false,
      source: 'catalog',
      reason: `model "${model}" cannot read images (catalogue of provider "${providerId}"): use a model that can`,
    }
  }
  if (declared === true) {
    return { enabled: true, source: 'declared', reason: `declared on this profile: model "${model}" reads images` }
  }
  if (declared === false) {
    return { enabled: false, source: 'declared', reason: `declared on this profile: model "${model}" does not read images` }
  }
  return {
    enabled: false,
    source: 'unknown',
    reason:
      `provider "${providerId}" does not say whether model "${model}" reads images, and this profile does not ` +
      'declare it: no image can be shown to it'
  }
}
/**
 * Pourquoi un Navigator ne peut pas partir, en français : c'est l'erreur de
 * la tâche, lue par l'utilisateur. Elle dit d'où vient le constat et quoi
 * faire, comme un profil sans fournisseur.
 */
export function navigatorBlindError(model: string, vision: VisionVerdict | undefined): string {
  const where = '(onglet Profils du dashboard, ou `PATCH /api/agents/navigator`)'
  if (vision?.source === 'catalog') {
    return `le modèle « ${model} » ne lit pas les images, d'après le catalogue de son fournisseur : choisis-en un qui les lit ${where}`
  }
  if (vision?.source === 'declared') {
    return `le modèle « ${model} » est déclaré ne pas lire les images : choisis-en un qui les lit ${where}`
  }
  return (
    `rien ne dit que le modèle « ${model} » lit les images : son fournisseur ne le publie pas. Déclare-le au ` +
    `profil s'il les lit, ou choisis un modèle qui les lit ${where}`
  )
}
import { runAgent, type ApprovalOutcome, type InputOutcome, type LoopHooks, type LoopOutcome } from '@midgaard/agent-runtime'
import type { EngineContext, TaskEngine, VisionVerdict } from './types.ts'

/**
 * La commande qui redépose la clé d'un fournisseur, prête à copier.
 *
 * Elle disait `harness providers set <id>` : la CLI refuse cette ligne sans
 * `--model`, et le binaire `harness` n'existe pas depuis les sources (Slice 4,
 * étape 7). Elle redit donc toute la déclaration, pour que la redéposer ne
 * change rien d'autre que la clé. Le daemon ne peut pas emprunter `cmd()` à la
 * CLI, qui dépend de lui : il emploie `harnessCommand`, commun aux trois. Lue au
 * dashboard, donc hors du clone, elle porte la racine du clone
 * (`npm --prefix`) et, s'il est désigné, le dossier runtime. Dans
 * l'application autonome, elle passe par le lanceur embarqué.
 *
 * @param provider le fournisseur tel qu'il est déclaré
 * @param home     dossier runtime si désigné (`config.homeIsExplicit`), sinon `null`
 * @param launcher lanceur de l'application autonome (`config.launcher`), sinon `null`
 */
export function keyCommand(
  provider: Pick<ProviderConfig, 'id' | 'preset' | 'default_model' | 'base_url'>,
  home: string | null = null,
  launcher: string | null = null,
): string {
  const args =
    `providers add ${provider.id} --preset ${provider.preset} --model ${provider.default_model}` +
    (provider.base_url ? ` --base-url ${provider.base_url}` : '')
  // packages/daemon/{src,dist}/engines/agent.* → racine du clone : même
  // profondeur depuis les sources et depuis le build.
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..')
  return harnessCommand(args, { repoRoot, home, launcher })
}

/** Ce que le moteur emprunte au daemon, en plus du contexte commun. */
export interface AgentEngineDeps {
  /**
   * Profil exécuté par cette instance. Le gérant range ses moteurs par type de
   * profil ; Researcher, Developer et Orchestrator partagent la même boucle,
   * avec une instance de ce moteur chacun.
   */
  kind: Extract<AgentKind, 'researcher' | 'developer' | 'orchestrator' | 'navigator'>
  ctx: EngineContext
  vault: SecretVault
  /** Lue à chaque tâche : un rafraîchissement des tarifs profite à la suivante. */
  pricing: () => PricingTable
  /** Environnement du daemon, consulté en dernier recours pour une clé. */
  env: NodeJS.ProcessEnv
  /**
   * Les sessions de navigateur du daemon (Slice 7). Absent, aucun profil ne
   * reçoit de navigateur, et ses outils refusent.
   */
  browsers?: BrowserSessions | undefined
  /**
   * Les navigateurs de lecture du web (`search_web`, `read_web_page`). Absent,
   * aucun profil n'en reçoit, et ces outils refusent.
   */
  web?: WebReaders | undefined
  /**
   * Les serveurs MCP des tâches (Slice 8). Absent, un profil qui a des
   * serveurs MCP échoue au départ, en le disant.
   */
  mcp?: McpSessions | undefined
}

/** État d'une tâche en vol dans ce processus. */
interface Running {
  abort: AbortController
  cancelled: boolean
  /** Résolution de l'attente d'approbation en cours, s'il y en a une. */
  decide: ((outcome: ApprovalOutcome) => void) | null
  /** Résolution de l'attente d'un message en cours, s'il y en a une (Slice 6). */
  reply: ((outcome: InputOutcome) => void) | null
  /**
   * Expurgation de la tâche, connue après la préparation. Un message reçu
   * passe par elle avant d'être écrit **et** avant d'être lu par le modèle.
   */
  redact: ((text: string) => string) | null
}

/** Exécute les profils qui appellent réellement un modèle. */
export class AgentEngine implements TaskEngine {
  readonly kind: AgentKind
  private readonly deps: AgentEngineDeps
  private readonly running = new Map<string, Running>()
  /** Vrai après {@link AgentEngine.stop} : la base va se fermer, ou l'est déjà. */
  private stopped = false

  constructor(deps: AgentEngineDeps) {
    this.deps = deps
    this.kind = deps.kind
  }

  start(task: Task, agent: Agent): void {
    // Volontairement non attendu : un moteur qui bloque bloquerait le daemon
    // entier, long-polls compris. Les erreurs sont traitées dans `execute` —
    // sauf une, après l'arrêt : la boucle interrompue finit **après** la
    // fermeture de la base, et sa conclusion lève « database is not open ».
    // Non rattrapée, elle tuait le processus qui héberge le daemon : constaté
    // en CI sous Windows (Slice 7, étape 6), un daemon fermé en pleine tâche.
    // La tâche sera `interrupted` au prochain démarrage, comme toute autre.
    void this.execute(task, agent).catch((e: unknown) => {
      if (!this.stopped) this.deps.ctx.log(`tâche ${task.id.slice(0, 8)} : fin impossible`, e)
    })
  }

  /** Une approbation accordée débloque l'attente de la boucle, là où elle en était. */
  resume(task: Task): void {
    this.running.get(task.id)?.decide?.('approved')
  }

  /**
   * Remet un message à une tâche qui l'attend, et la relance.
   *
   * L'écriture du message et la reprise (`waiting_input → running`) sont **une
   * seule** écriture : un message au journal sans tâche relancée, ou l'inverse,
   * raconterait une conversation qui n'a pas eu lieu. Le texte est expurgé ici,
   * où l'on connaît la clé de la tâche : l'agent lit ce que le journal garde.
   */
  deliver(
    task: Task,
    text: string,
    kind: 'message.user' | 'message.agent',
    payload: Record<string, unknown>,
  ): Task | null {
    const state = this.running.get(task.id)
    if (!state?.reply || !state.redact) return null
    const clean = state.redact(text)
    const done = this.deps.ctx.bus.record(task.id, 'running', { type: kind, payload: { ...payload, text: clean } })
    if (!done) return null
    state.reply({ kind: 'message', text: clean })
    return done.task
  }

  /**
   * Accepte la proposition d'une tâche en revue. L'acceptation s'écrit comme un
   * message du parent (`message.agent`, `verdict: accepted`), avec la reprise :
   * la tâche repasse `running` le temps que la boucle conclue et que le moteur
   * commite — c'est ce qu'elle fait réellement.
   */
  accept(task: Task, payload: Record<string, unknown>): Task | null {
    const state = this.running.get(task.id)
    if (!state?.reply) return null
    const done = this.deps.ctx.bus.record(task.id, 'running', {
      type: 'message.agent',
      payload: { ...payload, verdict: 'accepted', text: 'Proposition acceptée.' },
    })
    if (!done) return null
    state.reply({ kind: 'accepted' })
    return done.task
  }

  /**
   * Annulation **coopérative** : on lève le drapeau et on coupe l'appel HTTP en
   * cours, mais c'est la boucle qui conclut, à son prochain point de contrôle.
   *
   * @returns toujours `false` : le gérant ne doit pas conclure à sa place, sinon
   *          la tâche serait marquée annulée pendant qu'un appel modèle tourne
   *          encore, et sa consommation ne serait jamais comptée
   */
  cancel(task: Task, approval: 'rejected' | 'expired' | 'cancelled' = 'cancelled'): boolean {
    const state = this.running.get(task.id)
    if (!state) return true
    state.cancelled = true
    state.decide?.(approval)
    state.reply?.({ kind: 'cancelled' })
    state.abort.abort()
    return false
  }

  stop(): void {
    this.stopped = true
    for (const state of this.running.values()) {
      state.cancelled = true
      state.decide?.('cancelled')
      state.reply?.({ kind: 'cancelled' })
      state.abort.abort()
    }
    this.running.clear()
  }

  // --- Exécution -----------------------------------------------------------

  private async execute(task: Task, agent: Agent): Promise<void> {
    const { ctx } = this.deps
    const state: Running = { abort: new AbortController(), cancelled: false, decide: null, reply: null, redact: null }
    this.running.set(task.id, state)
    let workspace: Workspace | null = null
    let outcome: LoopOutcome | null = null

    /**
     * Point de contrôle de la préparation. Une annulation demandée pendant
     * l'une de ses attentes — lecture de la clé, création du worktree — laisse
     * la tâche en `cancel_requested`, d'où ni `preparing` ni `running` ne sont
     * permis : écrire l'une ou l'autre levait, et la tâche finissait `failed`
     * sur « erreur inattendue du moteur ». Trouvé par la suite de sécurité
     * (X5, Slice 5) : la cascade annule des sous-tâches qui viennent de naître.
     */
    const cancelledNow = (): boolean => {
      if (!state.cancelled) return false
      ctx.concludeCancellation(task.id)
      return true
    }

    try {
      const ready = await this.prepare(task, agent)
      if (cancelledNow()) return
      if ('error' in ready) {
        this.conclude(task.id, { status: 'failed', error: ready.error, usage: emptyish() })
        return
      }
      state.redact = ready.redact

      ctx.bus.record(task.id, 'preparing', {
        type: 'task.started',
        payload: {
          message: `exécution par ${agent.name} via ${ready.providerId} (${ready.model})`,
          agent_id: agent.id,
          provider_id: ready.providerId,
          model: ready.model,
        },
      })

      // Le worktree se crée **en `preparing`** : c'est un checkout complet, qui
      // peut durer, et une tâche qui afficherait `running` sans avoir commencé
      // mentirait sur ce qui la retient.
      if (agent.kind === 'developer') {
        const made = await this.makeWorkspace(task)
        if ('workspace' in made) workspace = made.workspace
        if (cancelledNow()) return
        if ('error' in made) {
          this.conclude(task.id, { status: 'failed', error: made.error, usage: emptyish() })
          return
        }
        workspace = made.workspace
        const allowed = execRulesForTask(ctx.config.execAllow, ctx.store.listExecAllow(workspace.repo_dir))
        ready.tools = {
          ...ready.tools,
          // La racine des outils devient le worktree — plus le sous-dossier
          // délégué, pour un monorepo ouvert sur `packages/api`. Lecture,
          // écriture et commandes s'y font ; le dépôt de l'utilisateur n'est
          // plus atteignable.
          root: made.root,
          writable: true,
          workspace: {
            path: workspace.worktree_path,
            baseCommit: workspace.base_commit,
            submodules: workspace.submodules,
          },
          // La liste blanche du dépôt s'ajoute à la globale. Lue ici, au départ
          // de la tâche : un ajout fait pendant qu'elle tourne vaut pour la
          // suivante, pas pour celle-ci — une autorisation ne s'élargit pas
          // en cours de route.
          execAllow: allowed.rules,
        }
        for (const i of allowed.ignored) {
          ctx.bus.record(task.id, null, {
            type: 'agent.message',
            payload: { message: `préfixe exec écarté, chaque commande qu'il couvrait attendra un humain : ${i.argv.join(' ')} — ${i.reason}`, note: true },
          })
        }
      }

      // Les serveurs MCP du profil (Slice 8) se lancent **en `preparing`**,
      // comme le worktree, et dans sa racine : un serveur qui ne démarre pas
      // fait échouer la tâche avant tout appel de modèle, sans rien coûter.
      let extraTools: Tool<never>[] = []
      if (agent.mcp_servers.length > 0 && MCP_CAPABLE_KINDS.includes(agent.kind)) {
        if (!this.deps.mcp) {
          this.conclude(task.id, { status: 'failed', error: 'ce daemon ne lance pas de serveur MCP', usage: emptyish() })
          return
        }
        const opened = await this.deps.mcp.openTask(task.id, agent.mcp_servers, ready.tools.root, state.abort.signal)
        if (cancelledNow()) return
        if ('error' in opened) {
          this.conclude(task.id, { status: 'failed', error: opened.error, usage: emptyish() })
          return
        }
        // Un serveur peut répéter sa variable secrète dans un résultat :
        // elle rejoint l'expurgation de la tâche, avant tout journal.
        const base = ready.redact
        const mcpRedact = createRedactor(opened.secretValues)
        ready.redact = (text) => mcpRedact(base(text))
        state.redact = ready.redact
        ready.tools = { ...ready.tools, mcp: opened.port }
        extraTools = opened.tools
        for (const line of opened.summary) {
          ctx.bus.record(task.id, null, { type: 'agent.message', payload: { message: line, note: true } })
        }
        for (const x of opened.excluded) {
          ctx.bus.record(task.id, null, {
            type: 'agent.message',
            payload: { message: `outil MCP ${x.server}.${x.name} écarté : ${x.reason}`, note: true },
          })
        }
      }

      // `preparing → running` tout de suite : la préparation est faite, et un
      // statut qui ne bouge plus pendant une minute d'appel modèle laisse
      // croire que rien ne se passe.
      ctx.bus.record(task.id, 'running', {
        type: 'task.progress',
        payload: { step: 0, message: 'appel du modèle' },
      })

      const hooks = this.hooks(task.id, state)

      // Un modèle qui ne lit pas les images ne se voit proposer ni
      // `read_image` ni le navigateur (Slice 7) : un outil qu'il ne peut que
      // se faire refuser lui coûterait une étape pour rien. La note le dit,
      // avec son motif.
      let tools = task.parent_task_id ? [...agent.tools, ASK_PARENT] : agent.tools
      const blind = tools.filter((t) => VISION_TOOLS.includes(t))
      if (blind.length > 0 && !ready.tools.vision?.enabled) {
        tools = tools.filter((t) => !VISION_TOOLS.includes(t))
        ctx.bus.record(task.id, null, {
          type: 'agent.message',
          payload: {
            message: `${blind.join(', ')} retiré(s) : ${ready.tools.vision?.reason ?? 'capacité inconnue'}`,
            note: true,
          },
        })
      }

      outcome = await runAgent({
        // Une sous-tâche reçoit `ask_parent` en plus de ses outils (Slice 6) :
        // ajouté ici, pas au profil, pour qu'un Developer délégué par Claude,
        // qui n'a personne à qui demander, ne le voie jamais.
        agent: {
          ...agent,
          tools,
        },
        delegated: task.parent_task_id !== null,
        continuation: task.continues_task_id !== null,
        extraTools,
        objective: task.objective,
        context: task.context,
        adapter: ready.adapter,
        tools: ready.tools,
        hooks,
        redact: ready.redact,
        signal: state.abort.signal,
        mode: task.mode,
        workspace: workspace
          ? {
              branch: workspace.branch,
              baseCommit: workspace.base_commit,
              baseDirty: workspace.base_dirty,
              submodules: submodulesUnder(workspace.submodules, workspace.subdir),
              originDir: task.project_dir ?? workspace.repo_dir,
            }
          : undefined,
      })
      // Le navigateur se ferme **avant** la conclusion : le journal raconte la
      // session close, puis la fin de la tâche, et aucun Chromium ne survit à
      // une tâche finie, même le temps d'un commit.
      await this.deps.browsers?.endTask(task.id, 'the task ended')
      await this.deps.web?.endTask(task.id)
      // Les serveurs MCP aussi : aucun processus d'une tâche finie ne doit
      // pouvoir écrire pendant le commit de son travail.
      await this.deps.mcp?.endTask(task.id)
      if (workspace && outcome.status === 'completed') outcome = await this.commitWork(task, agent, workspace, outcome)
      this.conclude(task.id, outcome)
    } catch (e) {
      ctx.log(`tâche ${task.id.slice(0, 8)} : erreur inattendue`, e)
      this.conclude(task.id, {
        status: 'failed',
        error: `erreur inattendue du moteur : ${(e as Error).message}`,
        usage: outcome?.usage ?? emptyish(),
      })
    } finally {
      // Filet pour le chemin d'erreur : sans effet si la session est déjà close.
      await this.deps.browsers?.endTask(task.id, 'the task ended').catch(() => {})
      await this.deps.web?.endTask(task.id).catch(() => {})
      await this.deps.mcp?.endTask(task.id).catch(() => {})
      this.running.delete(task.id)
      // Conservé dans tous les cas, jamais retiré : ce qu'il contient est
      // peut-être la seule trace de ce que l'agent avait fait (PLAN §9.4).
      if (workspace) {
        const final = ctx.store.getTask(task.id)
        ctx.bus.setWorkspaceStatus(workspace.id, 'kept', { reason: `tâche ${final?.status ?? 'terminée'}` })
      }
    }
  }

  /**
   * Crée et enregistre le worktree d'une tâche Developer.
   *
   * @returns le worktree et la racine de travail de l'agent, ou une phrase qui
   *          dit quoi faire — un dossier qui n'est pas un dépôt Git est l'échec
   *          le plus probable, et il doit se comprendre sans lire de trace
   */
  private async makeWorkspace(task: Task): Promise<{ workspace: Workspace; root: string } | { error: string }> {
    const { ctx } = this.deps
    if (!task.project_dir) {
      return { error: 'aucun dossier de projet transmis à la délégation : impossible de créer un worktree' }
    }
    try {
      const repo = await inspectRepository(task.project_dir)
      const made = await createWorktree({ repo, worktreesDir: ctx.config.worktreesDir, taskId: task.id })
      const recorded = ctx.bus.createWorkspace({
        taskId: task.id,
        repoDir: repo.toplevel,
        subdir: repo.subdir,
        worktreePath: made.path,
        branch: made.branch,
        baseCommit: made.baseCommit,
        baseRef: repo.ref,
        baseDirty: repo.dirty,
        submodules: made.submodules,
      })
      if (!recorded) return { error: 'tâche disparue pendant la création du worktree' }
      ctx.log(`tâche ${task.id.slice(0, 8)} : worktree ${made.branch} créé (${made.path})`)
      return { workspace: recorded.workspace, root: made.root }
    } catch (e) {
      const message = e instanceof WorkspaceError ? e.message : (e as Error).message
      return { error: `worktree impossible : ${message}` }
    }
  }

  /**
   * Commite le travail d'une tâche aboutie, et décrit le worktree dans son
   * résultat.
   *
   * Un commit qui échoue fait échouer la tâche : le résultat annoncerait sinon
   * une branche qui ne contient pas le travail, et Claude enverrait
   * l'utilisateur merger du vide. Le travail, lui, reste dans le worktree, et
   * le message d'erreur dit où.
   */
  private async commitWork(
    task: Task,
    agent: Agent,
    workspace: Workspace,
    outcome: Extract<LoopOutcome, { status: 'completed' }>,
  ): Promise<LoopOutcome> {
    const firstLine = task.objective.split('\n')[0]!.trim()
    const subject = firstLine.length > 72 ? `${firstLine.slice(0, 71)}…` : firstLine
    const message = `${subject}\n\n${outcome.result.summary}\n\nTâche Midgaard ${task.id}, agent ${agent.id}.`
    try {
      const commit = await commitAll(workspace.worktree_path, message, agentIdentity(agent.id))
      const diff = await diffWorktree(workspace.worktree_path, workspace.base_commit)
      const described: TaskWorkspace = {
        branch: workspace.branch,
        base_commit: workspace.base_commit,
        commit,
        worktree_path: workspace.worktree_path,
        files_changed: diff.files.length,
        additions: diff.additions,
        deletions: diff.deletions,
        base_dirty: workspace.base_dirty,
        submodules: workspace.submodules,
      }
      return { ...outcome, result: { ...outcome.result, workspace: described } }
    } catch (e) {
      return {
        status: 'failed',
        error:
          `l'agent a rendu son résultat, mais le commit de fin a échoué (${(e as Error).message}) : ` +
          `le travail est resté non commité dans ${workspace.worktree_path}, sur ${workspace.branch}`,
        usage: outcome.usage,
      }
    }
  }

  /**
   * Rassemble tout ce qu'il faut pour partir : fournisseur, clé, adaptateur,
   * contexte d'outils.
   *
   * Chaque échec rend une **phrase actionnable**. C'est le moment où
   * l'utilisateur apprend qu'il a oublié une clé, et un message du genre
   * « Cannot read property of undefined » ne le lui apprendrait pas.
   */
  private async prepare(
    task: Task,
    agent: Agent,
  ): Promise<
    | { error: string }
    | {
        adapter: ReturnType<typeof createAdapter>
        tools: ToolContext
        redact: (t: string) => string
        providerId: string
        model: string
      }
  > {
    const { ctx } = this.deps
    const resolved = await this.resolveProvider(agent)
    if ('error' in resolved) return resolved
    const { provider, key, model } = resolved

    // Tout ce qui sera journalisé ou persisté passe par là. La clé en est le
    // secret connu ; les motifs couvrent celles qu'on ne connaît pas et qui
    // pourraient traverser un outil.
    const redact = createRedactor([key])

    if (!task.project_dir) {
      return {
        error:
          // Le message ne nomme pas de client : depuis la Slice 5, une tâche
          // naît aussi du dashboard. Le cas reste celui d'un vieux serveur MCP.
          'aucun dossier de projet transmis à la création de la tâche : le serveur MCP ou le dashboard ' +
          'doit fournir project_dir (mets à jour Midgaard, puis rouvre la session de ton client MCP)',
      }
    }

    const adapter = createAdapter({ config: provider, apiKey: key, model, pricing: this.deps.pricing(), redact })
    // La capacité n'est cherchée que pour un profil qui pourrait s'en servir :
    // lire le catalogue coûte un aller-retour réseau à chaque tâche.
    const vision = agent.tools.some((t) => VISION_TOOLS.includes(t))
      ? visionOf(
          (await adapter.capabilities?.().catch(() => null)) ?? { vision: null, source: 'unknown' },
          agent.vision,
          provider.id,
          model,
        )
      : undefined
    if (vision) ctx.noteVision(agent.id, provider.id, model, vision)
    // Un Navigator voit le navigateur par des captures : aveugle, il ne
    // ferait que se faire refuser chaque outil. La tâche s'arrête avant tout
    // appel de modèle, donc sans rien coûter, en disant quoi faire.
    if (agent.kind === 'navigator' && !vision?.enabled) {
      return { error: navigatorBlindError(model, vision) }
    }

    return {
      adapter,
      tools: {
        vision,
        root: task.project_dir,
        httpPolicy: ctx.config.httpPolicy,
        allowHosts: ctx.config.allowHosts,
        // Aucun profil n'a encore de worktree : la racine est le dépôt de
        // l'utilisateur, où rien ne s'écrit jamais. Les outils d'écriture
        // refusent donc, même si un profil les recevait par erreur. Le profil
        // `developer` posera ces deux champs sur son worktree (Slice 3, étape 5).
        writable: false,
        workspace: null,
        execAllow: ctx.config.execAllow.map((argv) => ({ argv, prefix: false })),
        signal: undefined,
        // Le port de délégation n'est posé que pour un orchestrateur (Slice 5) :
        // tout autre profil qui recevrait `delegate_task` par erreur se verrait
        // refuser l'outil, sans approbation à la place.
        delegation: agent.kind === 'orchestrator' ? ctx.delegationFor(task.id, redact) : undefined,
        // Le navigateur n'est posé que pour un profil qui a ses outils
        // (Slice 7) : fermé par défaut, comme la délégation.
        browser: hasBrowser(agent.tools) ? this.deps.browsers?.portFor(task.id, redact) : undefined,
        // Le web lu par navigateur, de même : au profil qui en a les outils.
        web: hasWeb(agent.tools) ? this.deps.web?.portFor(task.id) : undefined,
        log: ctx.log,
      },
      redact,
      providerId: provider.id,
      model,
    }
  }

  /**
   * Le fournisseur d'un profil, sa clé et le modèle effectif — ou une phrase
   * qui dit quoi faire.
   */
  private async resolveProvider(
    agent: Agent,
  ): Promise<{ error: string } | { provider: ProviderConfig; key: string; model: string }> {
    const { ctx } = this.deps
    if (!agent.provider_id) {
      return { error: `le profil « ${agent.id} » n'a aucun fournisseur configuré` }
    }
    const provider = ctx.store.getProvider(agent.provider_id)
    if (!provider) {
      return { error: `le fournisseur « ${agent.provider_id} » n'existe plus ; reconfigure le profil` }
    }
    const envVar = envVarFor(provider)
    const found = await resolveApiKey(this.deps.vault, provider.secret_ref, envVar, this.deps.env)
    if (!found) {
      return {
        error:
          `aucune clé d'API pour « ${provider.id} » : dépose-la avec ` +
          `\`${keyCommand(provider, ctx.config.homeIsExplicit ? ctx.config.home : null, ctx.config.launcher)}\`, ` +
          `ou définis ${envVar} dans l'environnement du daemon`,
      }
    }
    if (found.source === 'env') {
      ctx.log(`fournisseur ${provider.id} : clé lue dans ${envVar} (dépannage), pas dans le coffre`)
    }
    return { provider, key: found.key, model: agent.model ?? provider.default_model }
  }

  /**
   * Constate si le modèle d'un profil lit les images, sans lancer de tâche
   * (Slice 7) : au démarrage du daemon et après un changement de modèle, pour
   * qu'un Navigator aveugle soit montré refusé **avant** qu'on lui délègue.
   * Un profil sans fournisseur ou sans clé n'est pas constaté : son refus est
   * déjà dit par ailleurs.
   */
  async probeVision(agent: Agent): Promise<void> {
    const resolved = await this.resolveProvider(agent)
    if ('error' in resolved) return
    const { provider, key, model } = resolved
    const adapter = createAdapter({
      config: provider, apiKey: key, model, pricing: this.deps.pricing(), redact: createRedactor([key]),
    })
    const caps = (await adapter.capabilities?.().catch(() => null)) ?? { vision: null, source: 'unknown' as const }
    this.deps.ctx.noteVision(agent.id, provider.id, model, visionOf(caps, agent.vision, provider.id, model))
  }

  /** Traduit les crochets de la boucle en écritures du bus. */
  private hooks(taskId: string, state: Running): LoopHooks {
    const { ctx } = this.deps
    return {
      onAgentMessage: (text, step) => {
        ctx.bus.record(taskId, null, { type: 'agent.message', payload: { message: text, step } }, { step })
      },

      onNote: (message, step) => {
        ctx.bus.record(taskId, null, { type: 'agent.message', payload: { message, step, note: true } })
      },

      onUsage: (usage: Usage, step) => {
        // La consommation est écrite **dans la tâche** en même temps que
        // l'événement : le dashboard voit le budget se remplir pendant la tâche,
        // au lieu de découvrir la facture à la fin.
        ctx.bus.record(taskId, null, { type: 'usage.updated', payload: { usage, step } }, { usage, step })
      },

      onToolRequested: (input) => {
        const call = ctx.store.createToolCall({
          taskId,
          step: input.step,
          callId: input.callId,
          name: input.name,
          decision: input.decision,
          status: input.status,
          argumentsJson: input.argumentsJson,
        })
        ctx.bus.record(taskId, null, {
          type: 'tool.requested',
          payload: {
            tool_call_id: call.id,
            name: input.name,
            decision: input.decision,
            arguments: input.argumentsJson,
            step: input.step,
            // Seulement pour un appel passé sans humain : la règle qui l'a
            // permis (une liste blanche, un préfixe), lisible à la timeline.
            ...(input.allowReason ? { allow_reason: input.allowReason } : {}),
          },
        })
        return call.id
      },

      onToolCompleted: (id, input) => {
        ctx.store.finishToolCall(id, {
          status: input.status,
          summary: input.summary,
          bytes: input.bytes,
          durationMs: input.durationMs,
          error: input.error,
        })
        ctx.bus.record(taskId, null, {
          type: 'tool.completed',
          payload: {
            tool_call_id: id,
            status: input.status,
            summary: input.summary,
            duration_ms: input.durationMs,
            error: input.error,
          },
        })
      },

      onToolOutput: (id, batch) => {
        // Le statut ne change pas : la sortie se lit dans la timeline et le
        // terminal, et elle est rejouée à la reconnexion comme tout événement.
        ctx.bus.record(taskId, null, { type: 'exec.output', payload: { tool_call_id: id, ...batch } })
      },

      requestApproval: ({ operation, detail }, step) =>
        new Promise<ApprovalOutcome>((resolve) => {
          const approval: Approval | null = ctx.requestApproval(taskId, operation, detail, { step })
          // Aucune demande créée : la tâche ne peut plus pauser (délai écoulé,
          // annulation). Personne n'a rien refusé — le dire ainsi au journal.
          if (!approval) return resolve('not_asked')
          // La décision arrivera par `resume` (accordée) ou par `cancel`
          // (refusée, annulée, expirée). Résolue une seule fois : la seconde
          // tentative ne doit pas relancer une boucle déjà repartie.
          let settled = false
          state.decide = (outcome) => {
            if (settled) return
            settled = true
            state.decide = null
            resolve(outcome)
          }
        }),

      awaitInput: (request, text, step, extra) =>
        new Promise<InputOutcome>((resolve) => {
          if (!ctx.requestInput(taskId, request, text, step, extra)) return resolve({ kind: 'cancelled' })
          // Le message arrivera par `deliver`, l'annulation ou l'expiration par
          // `cancel`. Résolue une seule fois, comme une approbation.
          let settled = false
          state.reply = (outcome) => {
            if (settled) return
            settled = true
            state.reply = null
            resolve(outcome)
          }
        }),

      finishBlocked: () => {
        // Une sous-tâche qui attend sa réponse ou son verdict serait emportée
        // par la cascade dès la fin du parent, travail non commité compris.
        const waiting = ctx.store.childTasks(taskId, { active: true }).filter((c) => c.status === 'waiting_input')
        if (waiting.length === 0) return null
        const ids = waiting.map((c) => `${c.id} (${c.awaiting_input})`).join(', ')
        return (
          `${waiting.length} subtask(s) wait for you: ${ids}. Answer a question or send a proposal back with ` +
          'send_message, accept a proposal with accept_result, or cancel_task, before you finish.'
        )
      },

      isCancelled: () => {
        if (state.cancelled) return true
        // Une tâche devenue terminale pendant qu'on tournait — refus humain,
        // expiration, annulation — doit arrêter la boucle au point de contrôle
        // suivant, avant qu'un appel modèle de plus ne soit payé pour rien.
        const current = ctx.store.getTask(taskId)
        return !current || isTerminal(current.status)
      },
    }
  }

  /**
   * Écrit le verdict de la boucle, **si personne ne l'a devancée**.
   *
   * Une tâche déjà terminale a été conclue par un refus humain, une expiration
   * ou une annulation. Écrire par-dessus lèverait `IllegalTransitionError` et
   * remplacerait un historique juste par un historique faux.
   */
  private conclude(taskId: string, outcome: LoopOutcome): void {
    const { ctx } = this.deps
    const current = ctx.store.getTask(taskId)
    if (!current) return
    if (isTerminal(current.status)) {
      ctx.log(`tâche ${taskId.slice(0, 8)} déjà ${current.status} : verdict du moteur ignoré`)
      return
    }

    if (outcome.status === 'completed') {
      ctx.bus.record(
        taskId,
        'completed',
        { type: 'task.completed', payload: { result: outcome.result, usage: outcome.usage } },
        { result: outcome.result, usage: outcome.usage },
      )
      ctx.log(`tâche ${taskId.slice(0, 8)} terminée (${outcome.usage.model_calls} appel(s))`)
      return
    }

    const EVENT = {
      failed: 'task.failed',
      cancelled: 'task.cancelled',
      timed_out: 'task.timed_out',
      budget_exceeded: 'task.budget_exceeded',
    } as const

    // `cancel_requested` ne peut pas aller directement en `timed_out` ni
    // `budget_exceeded` : une tâche qu'on annule s'arrête annulée, quelle que
    // soit la limite qu'elle aurait franchie au même instant.
    const status =
      current.status === 'cancel_requested' && outcome.status !== 'failed' ? 'cancelled' : outcome.status
    // Une annulation dit sa cause — « tâche parente annulée », le motif d'un
    // orchestrateur —, puis où la boucle s'est arrêtée.
    const asked = status === 'cancelled' ? ctx.store.cancelRequestReason(taskId) : null
    const error = asked ? `${asked} (${outcome.error})` : outcome.error

    ctx.bus.record(
      taskId,
      status,
      { type: EVENT[status], payload: { reason: error, usage: outcome.usage } },
      { error, usage: outcome.usage },
    )
    ctx.log(`tâche ${taskId.slice(0, 8)} → ${status} : ${error}`)
  }
}

/** Consommation nulle, pour les échecs survenus avant tout appel modèle. */
function emptyish(): Usage {
  return {
    model_calls: 0,
    input_tokens: 0,
    output_tokens: 0,
    reasoning_tokens: 0,
    cached_tokens: 0,
    web_searches: 0,
    cost_usd: 0,
    cost_source: 'unknown',
    cost_usd_estimated: null,
    cost_usd_reported: null,
  }
}

/**
 * Sous-modules vus depuis la racine de l'agent, qui peut être un sous-dossier
 * du dépôt (`subdir`, avec `/` final ou vide) : ceux qui sont hors de ce
 * sous-dossier ne le concernent pas, les autres perdent son préfixe.
 */
export function submodulesUnder(submodules: readonly string[], subdir: string): string[] {
  return submodules.filter((p) => p.startsWith(subdir)).map((p) => p.slice(subdir.length))
}
