/**
 * @file Gérant des tâches : la machine à états en marche, et la frontière avec
 * les exécutants.
 *
 * Ce module garde **tout ce qui ne dépend pas de l'exécutant** : création,
 * transitions, décisions humaines, expirations, annulation, attente bloquante.
 * Ce qui se passe entre le démarrage et la fin appartient à un
 * {@link TaskEngine} — étapes minutées pour le profil simulé, boucle modèle pour
 * un agent réel.
 *
 * Cette coupure est l'encaissement du pari de la Slice 1, qui avait conçu
 * `tick()` pour être remplacé sans toucher au reste. Elle l'a été ; le reste n'a
 * pas bougé.
 *
 * Toutes les écritures passent par le bus ({@link EventBus}), jamais par le
 * dépôt directement : c'est ce qui garantit qu'aucun changement d'état n'échappe
 * aux long-polls ni aux dashboards connectés.
 *
 * Depuis la Slice 5, il porte aussi la **délégation** d'un orchestrateur : le
 * port qu'il lui remet ({@link TaskManager.delegationFor}), les règles qui
 * rattachent une sous-tâche à son parent ({@link TaskManager.create}), et la
 * cascade qui ne laisse aucun orphelin.
 */
import type {
  Agent,
  Approval,
  HarnessConfig,
  PricingTable,
  InputRequest,
  Task,
  TaskEvent,
  ToolCall,
} from '@midgaard/contracts'
import {
  SIMULATED_AGENT_ID,
  isActionable,
  isTerminal,
  nextActionFor,
  operationHash,
} from '@midgaard/contracts'
import type { HarnessStore } from '@midgaard/persistence'
import { randomBytes } from 'node:crypto'
import type {
  CreateAgentRequest,
  CreatedAgentInfo,
  DelegableAgent,
  DelegationPort,
  DelegationRefusal,
  SubtaskAwaiting,
  SubtaskState,
  WaitStop,
} from '@midgaard/tools'
import { diffWorktree } from '@midgaard/workspace'
import type { EventBus } from './bus.ts'
import { SimulatedEngine, STEPS_TOTAL } from './engines/simulated.ts'
import type { EngineContext, TaskEngine, VisionVerdict } from './engines/types.ts'
import { navigatorBlindError } from './engines/agent.ts'
import { resolveCreatedAgent } from './agents.ts'
import { continuationRecord } from './continuation.ts'

/** Délai maximal d'un constat de vision attendu par une requête : le catalogue ne doit pas bloquer l'API. */
const VISION_PROBE_WAIT_MS = 5_000

export { STEPS_TOTAL, APPROVAL_STEP } from './engines/simulated.ts'

/**
 * Intervalle maximal de balayage des approbations expirées.
 *
 * Le balayage s'adapte au délai configuré : avec un délai court, attendre
 * quinze secondes pour constater une expiration de deux secondes rendrait le
 * comportement intestable.
 */
const MAX_EXPIRY_SWEEP_MS = 15_000

/** Issue d'une opération refusée, à traduire en code HTTP par l'appelant. */
export interface Refusal {
  error: string
  status: number
  detail?: Record<string, unknown>
}

/** Vue d'une tâche enrichie de sa consigne et de son approbation en cours. */
export interface TaskView {
  task: Task
  next_action: ReturnType<typeof nextActionFor>
  approval: Approval | null
}

/** Pilote les tâches et applique la machine à états. */
export class TaskManager {
  private readonly config: HarnessConfig
  private readonly store: HarnessStore
  private readonly bus: EventBus
  private readonly log: (...a: unknown[]) => void
  private readonly engines = new Map<string, TaskEngine>()
  private sweeper: NodeJS.Timeout | null = null
  /**
   * Ce que les moteurs ont constaté de la vue des modèles, par profil (Slice 7),
   * avec le fournisseur et le modèle constatés : un constat ne vaut que pour
   * eux, et tombe de lui-même quand le profil change de modèle. En mémoire
   * seulement — il se refait au démarrage.
   */
  /**
   * Tarifs en vigueur, posés par le daemon une fois lus (`usePricing`). Ils
   * servent à refuser à un agent créé un modèle sans tarif connu : son coût
   * échapperait au budget de l'arbre (Slice 8).
   */
  private pricing: () => PricingTable | null = () => null
  private readonly vision = new Map<string, { providerId: string; model: string; verdict: VisionVerdict }>()

  constructor(config: HarnessConfig, store: HarnessStore, bus: EventBus, log: (...a: unknown[]) => void) {
    this.config = config
    this.store = store
    this.bus = bus
    this.log = log
    this.register(new SimulatedEngine(this.engineContextFor()))
    // Aucun orphelin (Slice 5, décision 5) : une tâche qu'on annule, ou qui se
    // termine pour quelque raison que ce soit, emporte ses sous-tâches actives.
    // Écouter le bus plutôt que chaque chemin de fin : il y en a une dizaine
    // (moteurs, refus, expiration, annulation), et le bus les voit tous.
    this.bus.subscribe(({ task }) => {
      if (task.status !== 'cancel_requested' && !isTerminal(task.status)) return
      // Différé : le bus diffuse de façon synchrone, et annuler ici écrirait
      // les événements des enfants **pendant** la diffusion de celui du parent.
      // Les abonnés suivants — la WebSocket — recevraient alors des `seq` dans
      // le désordre, et un dashboard qui retient le dernier vu le perdrait.
      queueMicrotask(() => this.cancelChildren(task.id, task.status))
    })
  }

  /**
   * Le profil d'une tâche : un profil déclaré, ou un agent créé par un
   * orchestrateur (Slice 8), résolu à partir de son profil de base.
   *
   * @returns `null` si l'identifiant ne désigne ni l'un ni l'autre
   */
  agentFor(id: string): Agent | null {
    const profile = this.store.getAgent(id)
    if (profile) return profile
    const created = this.store.getCreatedAgent(id)
    return created ? resolveCreatedAgent(this.store, created) : null
  }

  /** Pose la source des tarifs en vigueur ; le daemon l'appelle une fois les tarifs lus. */
  usePricing(source: () => PricingTable): void {
    this.pricing = source
  }

  /**
   * Déclare un moteur pour un type de profil.
   *
   * Le moteur simulé est enregistré par le constructeur ; le daemon ajoute celui
   * des agents réels une fois le coffre ouvert et les fournisseurs lus. Un profil
   * dont le moteur n'est pas enregistré refuse les délégations plutôt que de
   * faire semblant de démarrer.
   */
  register(engine: TaskEngine): void {
    this.engines.set(engine.kind, engine)
  }

  /**
   * Ce que les moteurs empruntent au daemon.
   *
   * Public pour que le daemon puisse construire le moteur des agents réels, qui
   * a besoin de dépendances que le gérant n'a pas à connaître — le coffre et la
   * table de tarifs.
   */
  engineContextFor(): EngineContext {
    return {
      config: this.config,
      store: this.store,
      bus: this.bus,
      log: this.log,
      requestApproval: (taskId, operation, detail, payload) => this.openApproval(taskId, operation, detail, payload),
      concludeCancellation: (taskId) => {
        this.finishCancellation(taskId)
      },
      requestInput: (taskId, request, text, step, extra) => this.openInput(taskId, request, text, step, extra),
      delegationFor: (parentTaskId, redact) => this.delegationFor(parentTaskId, redact),
      noteVision: (agentId, providerId, model, verdict) => {
        this.vision.set(agentId, { providerId, model, verdict })
      },
    }
  }

  /**
   * Le constat de vision d'un profil, s'il vaut encore pour son fournisseur et
   * son modèle actuels ; `null` sinon.
   */
  private visionOf(agent: Agent): VisionVerdict | null {
    const seen = this.vision.get(agent.id)
    if (!seen || seen.providerId !== agent.provider_id) return null
    const model = agent.model ?? this.store.getProvider(seen.providerId)?.default_model
    return seen.model === model ? seen.verdict : null
  }

  /**
   * Pourquoi un profil activé ne peut quand même pas recevoir de tâche : un
   * Navigator dont le modèle est **constaté** aveugle (Slice 7). Sans constat,
   * `null` — le moteur tranchera au départ de la tâche, avant tout appel.
   */
  private blindReason(agent: Agent): { user: string; model: string } | null {
    if (agent.kind !== 'navigator') return null
    const verdict = this.visionOf(agent)
    if (!verdict || verdict.enabled) return null
    const model = agent.model ?? this.store.getProvider(agent.provider_id ?? '')?.default_model ?? '?'
    return {
      user: navigatorBlindError(model, verdict),
      model: `it sees the browser through screenshots, and ${verdict.reason}`,
    }
  }

  /**
   * Un profil tel que l'API le montre : `enabled` dit s'il peut recevoir une
   * tâche **maintenant**, et `disabled_reason` pourquoi sinon. Un Navigator
   * aveugle est montré désactivé, avec son motif, même si sa ligne en base est
   * active : c'est ce qu'il est (« ne rien décrire qui n'existe pas »).
   */
  agentView(agent: Agent): Agent {
    const blind = agent.enabled ? this.blindReason(agent) : null
    if (agent.enabled && !blind) return { ...agent, disabled_reason: null }
    return { ...agent, enabled: false, disabled_reason: blind?.user ?? this.whyDisabled(agent) }
  }

  /**
   * Constate la vue des Navigator (Slice 7) : au démarrage, et après un
   * changement de modèle. Attendu au plus {@link VISION_PROBE_WAIT_MS} : un
   * catalogue lent ne doit pas faire attendre l'API ; le constat arrivera
   * ensuite, et la tâche suivante le verra.
   *
   * @param agentId un seul profil ; tous les Navigator sinon
   */
  async probeVision(agentId?: string): Promise<void> {
    const agents = this.store
      .listAgents()
      .filter((a) => a.kind === 'navigator' && a.enabled && (agentId === undefined || a.id === agentId))
    const probes = agents.map((a) =>
      (this.engines.get(a.kind)?.probeVision?.(a) ?? Promise.resolve()).catch((e: unknown) => {
        this.log(`profil « ${a.id} » : vision non constatée (${(e as Error).message})`)
      }),
    )
    let timer: NodeJS.Timeout | undefined
    await Promise.race([
      Promise.all(probes),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, VISION_PROBE_WAIT_MS)
        timer.unref()
      }),
    ])
    clearTimeout(timer)
  }

  /**
   * À appeler une fois au démarrage du daemon, **avant** d'accepter des requêtes.
   *
   * Toute tâche trouvée active vient d'un processus mort : ses minuteurs
   * n'existent plus et rien ne la reprendra. Elle est marquée `interrupted`,
   * jamais reprise ni considérée réussie.
   *
   * @returns le nombre de tâches interrompues
   */
  recoverFromRestart(): number {
    const interrupted = this.store.markInterrupted()
    if (interrupted.length) {
      this.log(`${interrupted.length} tâche(s) trouvée(s) en cours au démarrage → interrupted`)
    }
    // Les approbations encore en attente portent sur des tâches désormais
    // interrompues : les laisser « en attente » afficherait un bouton d'approbation
    // qui ne peut plus rien débloquer.
    for (const a of this.store.pendingApprovals()) {
      const resolved = this.store.resolveApproval(a.id, 'expired', 'daemon', 'daemon redémarré')
      if (resolved) this.bus.emitApproval(resolved)
    }
    // Les worktrees de ces tâches sont conservés pour inspection, jamais
    // nettoyés d'office : ce qu'ils contiennent est peut-être la seule trace de
    // ce que l'agent avait fait (PLAN §3).
    const kept = this.bus.keepActiveWorkspaces()
    if (kept.length) this.log(`${kept.length} worktree(s) d'une tâche interrompue conservé(s) pour inspection`)
    const sweepMs = Math.min(MAX_EXPIRY_SWEEP_MS, Math.max(500, Math.round(this.config.approvalTtlMs / 2)))
    this.sweeper = setInterval(() => {
      this.expireDueApprovals()
      this.expireIdleConversations()
    }, sweepMs)
    this.sweeper.unref()
    return interrupted.length
  }

  /** Arrête tous les moteurs. L'état reste en base ; les tâches actives seront
   * marquées `interrupted` au prochain démarrage. */
  stop(): void {
    for (const engine of this.engines.values()) engine.stop()
    if (this.sweeper) clearInterval(this.sweeper)
  }

  // --- Cycle de vie --------------------------------------------------------

  /**
   * Crée une tâche et la confie au moteur de son profil.
   *
   * Les refus arrivent **avant** la création : une tâche créée puis échouée
   * aussitôt parce que son agent n'existe pas pollue l'historique et oblige
   * Claude à lire un statut pour comprendre une erreur de saisie.
   *
   * **Une sous-tâche** (`parentTaskId`, posé par {@link delegationFor} et par
   * lui seul — jamais par une route HTTP) obéit à quatre règles de plus, ici
   * plutôt que dans l'outil pour qu'il n'en existe qu'une copie :
   *
   *  - son parent existe et est **encore actif** — ni fini, ni en cours
   *    d'annulation : un orchestrateur qui s'arrête ne lance plus rien ;
   *  - son parent est un **orchestrateur** ;
   *  - elle-même **n'en est pas un** : profondeur 1, pas d'arbre qui s'emballe
   *    (Slice 5, décision 1) ;
   *  - elle travaille sur le **dossier du parent**, jamais sur celui qu'on lui
   *    passerait (décision 9) : le modèle ne choisit pas où lit son enfant.
   *
   * @returns la tâche créée, ou un refus explicite
   */
  create(input: {
    objective: string
    agentId: string
    context: string | null
    projectDir: string | null
    durationS: number
    needsApproval: boolean
    parentTaskId?: string | null | undefined
    /**
     * Vrai pour ouvrir une conversation (mode `chat`, Slice 6). Réservé à un
     * orchestrateur de premier niveau : lui seul a un humain en face, et un
     * exécutant qui attendrait l'utilisateur au lieu de conclure retiendrait
     * son parent indéfiniment.
     */
    conversation?: boolean | undefined
    /**
     * Tâche terminée que celle-ci prolonge. Posé par {@link continueTask} et
     * par lui seul — jamais par une route qui le lirait d'un client —, après
     * vérification : la nouvelle tâche hérite des agents créés de celle-là.
     */
    continuesTaskId?: string | null | undefined
  }): { task: Task } | Refusal {
    const agent = this.agentFor(input.agentId)
    // Un agent créé ne sert qu'aux sous-tâches de l'orchestrateur qui l'a créé
    // (Slice 8, décision 15). Ailleurs — un autre arbre, une tâche lancée par
    // Claude ou du dashboard —, il n'existe pas : même réponse qu'un inconnu,
    // pour qu'un client n'apprenne rien des autres arbres.
    const created = agent ? this.store.getCreatedAgent(agent.id) : null
    if (!agent || (created && created.task_id !== input.parentTaskId)) {
      return {
        error: 'agent_not_found',
        status: 404,
        detail: { agent_id: input.agentId, available: this.store.listAgents().map((a) => a.id) },
      }
    }
    if (!agent.enabled) {
      return {
        error: 'agent_disabled',
        status: 409,
        detail: { agent_id: agent.id, reason: this.whyDisabled(agent) },
      }
    }
    // Un Navigator constaté aveugle est refusé ici, avant que la tâche existe :
    // rien n'est créé, rien n'est dépensé, et le motif dit quoi faire.
    const blind = this.blindReason(agent)
    if (blind) {
      return { error: 'agent_disabled', status: 409, detail: { agent_id: agent.id, reason: blind.user } }
    }
    let projectDir = input.projectDir
    if (input.parentTaskId) {
      const parent = this.store.getTask(input.parentTaskId)
      if (!parent) return { error: 'parent_not_found', status: 404, detail: { parent_task_id: input.parentTaskId } }
      if (isTerminal(parent.status) || parent.status === 'cancel_requested') {
        return { error: 'parent_not_active', status: 409, detail: { parent_task_id: parent.id, status: parent.status } }
      }
      if (this.agentFor(parent.agent_id)?.kind !== 'orchestrator') {
        return { error: 'parent_cannot_delegate', status: 409, detail: { parent_task_id: parent.id } }
      }
      if (agent.kind === 'orchestrator') {
        return { error: 'nested_orchestrator', status: 409, detail: { agent_id: agent.id } }
      }
      projectDir = parent.project_dir
    }
    if (!this.engines.has(agent.kind)) {
      return { error: 'engine_unavailable', status: 503, detail: { agent_id: agent.id, kind: agent.kind } }
    }
    if (input.conversation && (agent.kind !== 'orchestrator' || input.parentTaskId)) {
      return {
        error: 'conversation_unsupported',
        status: 409,
        detail: { agent_id: agent.id, reason: 'seul un orchestrateur lancé du dashboard peut converser' },
      }
    }

    const { task } = this.bus.createTask({
      objective: input.objective,
      agentId: agent.id,
      context: input.context,
      // Une tâche simulée ne lit rien : lui attribuer une racine laisserait
      // croire qu'elle y touche.
      projectDir: agent.kind === 'simulated' ? null : projectDir,
      durationS: input.durationS,
      // `steps_total` est le dénominateur affiché par la CLI et le dashboard.
      // L'exécutant simulé a ses étapes, comptées d'avance ; un agent réel
      // n'en a pas — rien ne borne ses appels de modèle — et `0` le dit :
      // l'affichage montre alors « étape 7 », sans dénominateur inventé.
      stepsTotal: agent.kind === 'simulated' ? STEPS_TOTAL : 0,
      needsApproval: input.needsApproval,
      parentTaskId: input.parentTaskId ?? null,
      continuesTaskId: input.continuesTaskId ?? null,
      // Le mode est décidé ici, jamais reçu tel quel : un client demande une
      // conversation, le daemon dit si elle en est une. Un Developer délégué
      // par un orchestrateur propose son travail au lieu de le livrer (Slice 6) ;
      // un Researcher rend toujours son résultat d'un coup.
      mode: input.conversation
        ? 'chat'
        : input.parentTaskId && agent.kind === 'developer'
          ? 'review'
          : 'oneshot',
    })
    this.log(
      `tâche ${short(task.id)} créée pour ${agent.id}` +
        (input.parentTaskId ? `, sous-tâche de ${short(input.parentTaskId)}` : '') +
        (input.continuesTaskId ? `, suite de ${short(input.continuesTaskId)}` : ''),
    )
    // Avant le départ du moteur : l'orchestrateur doit trouver ses exécutants
    // dès son premier `list_agents`.
    if (input.continuesTaskId) this.inheritCreatedAgents(input.continuesTaskId, task.id)
    this.engines.get(agent.kind)!.start(task, agent)
    return { task }
  }

  /**
   * Rebondit sur une tâche **terminée** d'un orchestrateur : crée la tâche qui
   * la prolonge, en conversation, avec le message de l'utilisateur pour
   * ouverture.
   *
   * La première tâche n'est pas rouverte — un statut final est sans sortie, et
   * sa conversation avec le modèle n'a vécu qu'en mémoire. La suite est une
   * tâche neuve, de premier niveau, qui reçoit :
   *  - le **profil** et le **dossier** de la première, jamais ceux d'un client ;
   *  - en contexte, le **relevé** de ce qu'elle a laissé en base
   *    ({@link continuationRecord}), où ce qu'un modèle a écrit est encadré ;
   *  - les **agents qu'elle avait créés**, recopiés dans le nouvel arbre.
   *
   * Refusé pour une tâche encore active (on lui écrit, ou on attend), pour une
   * sous-tâche (c'est son orchestrateur qu'on prolonge) et pour tout profil
   * qui n'est pas un orchestrateur : lui seul converse.
   *
   * @param by `dashboard` ou `cli` — jamais un modèle : aucun outil n'atteint cette route
   * @returns la tâche créée, ou un refus explicite
   */
  continueTask(sourceId: string, input: { text: string; by: string }): { task: Task } | Refusal {
    const source = this.store.getTask(sourceId)
    if (!source) return { error: 'task_not_found', status: 404 }
    if (!isTerminal(source.status)) {
      return { error: 'task_still_active', status: 409, detail: { status: source.status } }
    }
    if (source.parent_task_id !== null || this.agentFor(source.agent_id)?.kind !== 'orchestrator') {
      return {
        error: 'continuation_unsupported',
        status: 409,
        detail: { reason: 'seule une tâche d\'orchestrateur lancée par vous peut être prolongée' },
      }
    }
    const text = input.text.trim()
    if (!text) return { error: 'empty_message', status: 400 }
    const created = this.create({
      objective: text,
      agentId: source.agent_id,
      context: continuationRecord(this.store, source),
      projectDir: source.project_dir,
      durationS: source.duration_s,
      needsApproval: false,
      conversation: true,
      continuesTaskId: source.id,
    })
    if (!('error' in created)) this.log(`tâche ${short(created.task.id)} : suite demandée par ${input.by}`)
    return created
  }

  /**
   * Recopie dans une suite les agents que la tâche prolongée avait créés.
   *
   * Un agent créé n'existe que dans l'arbre de sa tâche : la suite est un
   * autre arbre, il lui faut donc les siens — nouveaux identifiants, même nom,
   * même base, même rôle. Chaque copie est **rejugée contre le profil de base
   * d'aujourd'hui**, parce qu'une copie est une création : un agent dont la
   * base ou le fournisseur a disparu n'est pas recopié, et un serveur MCP
   * détaché de la base depuis ne suit pas. Chaque copie s'écrit au journal de
   * la suite (`agent.created`, `inherited_from`), pour que l'humain voie dans
   * le nouvel arbre qui est là et d'où il vient.
   */
  private inheritCreatedAgents(fromTaskId: string, toTaskId: string): void {
    for (const old of this.store.createdAgentsOf(fromTaskId).slice(0, MAX_CREATED_AGENTS)) {
      const base = this.store.getAgent(old.base_agent_id)
      if (!base || !this.store.getProvider(old.provider_id)) continue
      const copy = this.store.createCreatedAgent({
        id: createdAgentId(old.name),
        task_id: toTaskId,
        name: old.name,
        base_agent_id: old.base_agent_id,
        provider_id: old.provider_id,
        model: old.model,
        role: old.role,
        mcp_servers: old.mcp_servers.filter((s) => base.mcp_servers.includes(s)),
      })
      this.bus.record(toTaskId, null, {
        type: 'agent.created',
        payload: {
          agent_id: copy.id,
          name: copy.name,
          base_agent_id: copy.base_agent_id,
          provider_id: copy.provider_id,
          model: copy.model,
          mcp_servers: copy.mcp_servers,
          role: copy.role,
          inherited_from: old.id,
        },
      })
    }
  }

  /** Pourquoi un profil est désactivé, en une phrase destinée à l'utilisateur. */
  private whyDisabled(agent: Agent): string {
    if (agent.provider_id === null) {
      return 'aucun fournisseur de modèle n\'est configuré pour ce profil'
    }
    if (!this.store.getProvider(agent.provider_id)) {
      return `le fournisseur « ${agent.provider_id} » n'existe plus`
    }
    return 'profil désactivé'
  }

  /**
   * Met une tâche en pause et crée la demande d'approbation correspondante.
   * Appelé par les moteurs via {@link EngineContext.requestApproval}.
   */
  private openApproval(
    taskId: string,
    operation: string,
    detail: Record<string, unknown>,
    payload: Record<string, unknown> = {},
  ): Approval | null {
    const task = this.store.getTask(taskId)
    if (!task || isTerminal(task.status) || task.status === 'waiting_approval') return null
    const seq = task.approval_seq + 1
    const approval = this.store.createApproval({
      taskId: task.id,
      seq,
      operation,
      operationDetail: detail,
      // L'empreinte lie la décision à cette opération précise, sous sa forme
      // structurée : le texte peut afficher pareil deux opérations différentes,
      // le détail canonique non.
      operationHash: operationHash(task.id, seq, detail),
      ttlMs: this.config.approvalTtlMs,
    })
    this.bus.record(
      task.id,
      'waiting_approval',
      {
        type: 'approval.requested',
        payload: { ...payload, approval_id: approval.id, operation, operation_hash: approval.operation_hash },
      },
      { approval_seq: seq, ...(typeof payload.step === 'number' ? { step: payload.step } : {}) },
    )
    this.bus.emitApproval(approval)
    this.log(`tâche ${short(task.id)} en attente d'approbation (${approval.id})`)
    return approval
  }

  /**
   * Met une tâche en attente d'un message. Appelé par les moteurs via
   * {@link EngineContext.requestInput}.
   *
   * @returns `false` si la tâche n'est plus `running` — annulée pendant la
   *          réplique qui précède l'attente : la boucle conclura l'annulation
   */
  private openInput(
    taskId: string,
    request: InputRequest,
    text: string | null,
    step: number,
    extra: Record<string, unknown> = {},
  ): boolean {
    const task = this.store.getTask(taskId)
    if (!task || task.status !== 'running') return false
    this.bus.record(
      taskId,
      'waiting_input',
      { type: 'input.requested', payload: { ...extra, request, step, ...(text !== null ? { text } : {}) } },
      { awaiting_input: request, step },
    )
    this.log(`tâche ${short(taskId)} en attente d'un message (${request})`)
    return true
  }

  /**
   * Remet le message de l'utilisateur à une conversation qui l'attend.
   *
   * Refusé hors de l'attente plutôt que mis de côté : un message glissé pendant
   * que l'agent travaille arriverait au milieu de son raisonnement, et l'agent
   * ne saurait pas à quoi il répond. Le dashboard n'ouvre la saisie que
   * lorsque la tâche attend.
   *
   * @param conclude vrai pour demander à l'agent de conclure : le harness ajoute
   *                 la consigne, et le texte de l'utilisateur peut être vide
   * @param by       `dashboard` ou `cli` — jamais un modèle
   */
  postMessage(taskId: string, input: { text: string; conclude: boolean; by: string }): TaskView | Refusal {
    const task = this.store.getTask(taskId)
    if (!task) return { error: 'task_not_found', status: 404 }
    if (task.mode !== 'chat') return { error: 'task_not_conversational', status: 409, detail: { mode: task.mode } }
    if (task.status !== 'waiting_input' || task.awaiting_input !== 'chat') {
      return { error: 'task_not_awaiting_user', status: 409, detail: { status: task.status } }
    }
    const text = input.conclude ? concludeText(input.text) : input.text
    if (!text.trim()) return { error: 'empty_message', status: 400 }
    const agent = this.agentFor(task.agent_id)
    const engine = agent ? this.engines.get(agent.kind) : undefined
    const resumed = engine?.deliver?.(task, text, 'message.user', { by: input.by, conclude: input.conclude })
    // L'attente n'est plus en vol dans ce processus : la tâche a été conclue
    // entre la lecture et la remise. Rien n'est écrit.
    if (!resumed) return { error: 'task_not_awaiting_user', status: 409, detail: { status: task.status } }
    this.log(`tâche ${short(taskId)} : message de ${input.by}${input.conclude ? ' (conclure)' : ''}`)
    return this.view(resumed)
  }

  // --- Décisions humaines --------------------------------------------------

  /**
   * Approuve une demande et relance la tâche.
   *
   * @param approvalId identifiant de la demande (pas de la tâche : une décision
   *                   porte sur une opération précise, pas sur « la tâche »)
   * @param by         `cli` ou `dashboard` — jamais le modèle
   * @returns la vue de la tâche relancée, ou un refus
   */
  approve(approvalId: string, by: string): TaskView | Refusal {
    const approval = this.store.getApproval(approvalId)
    if (!approval) return { error: 'approval_not_found', status: 404 }
    // La condition « encore en attente » est dans la requête SQL : deux décisions
    // simultanées ne peuvent pas aboutir toutes les deux.
    const resolved = this.store.resolveApproval(approvalId, 'approved', by)
    if (!resolved) return { error: 'approval_already_resolved', status: 409, detail: { status: approval.status } }
    this.bus.emitApproval(resolved)

    const task = this.store.getTask(resolved.task_id)
    if (!task || task.status !== 'waiting_approval') {
      return { error: 'task_not_waiting_approval', status: 409, detail: { status: task?.status ?? 'unknown' } }
    }
    const done = this.bus.record(
      task.id,
      'running',
      { type: 'approval.resolved', payload: { approval_id: approvalId, decision: 'approved', by } },
      { needs_approval: false },
    )!
    this.log(`approbation ${approvalId} accordée par ${by}, tâche ${short(task.id)} relancée`)
    const agent = this.agentFor(done.task.agent_id)
    const engine = agent ? this.engines.get(agent.kind) : undefined
    if (agent && engine) engine.resume(done.task, agent)
    return this.view(done.task)
  }

  /** Refuse une demande : la tâche s'arrête en `cancelled`, avec le motif. */
  reject(approvalId: string, by: string, reason?: string): TaskView | Refusal {
    const approval = this.store.getApproval(approvalId)
    if (!approval) return { error: 'approval_not_found', status: 404 }
    const resolved = this.store.resolveApproval(approvalId, 'rejected', by, reason)
    if (!resolved) return { error: 'approval_already_resolved', status: 409, detail: { status: approval.status } }
    this.bus.emitApproval(resolved)

    const task = this.store.getTask(resolved.task_id)
    if (!task || task.status !== 'waiting_approval') {
      return { error: 'task_not_waiting_approval', status: 409, detail: { status: task?.status ?? 'unknown' } }
    }
    const done = this.bus.record(
      task.id,
      'cancelled',
      { type: 'approval.resolved', payload: { approval_id: approvalId, decision: 'rejected', by, reason } },
      { needs_approval: false, error: reason ? `approbation refusée : ${reason}` : 'approbation refusée' },
    )!
    this.log(`approbation ${approvalId} refusée par ${by}`)
    const agent = this.agentFor(done.task.agent_id)
    const engine = agent ? this.engines.get(agent.kind) : undefined
    // Le seul cas où un humain a refusé : c'est ce que dira le journal de l'outil.
    engine?.cancel(done.task, 'rejected')
    return this.view(done.task)
  }

  /**
   * Annule une tâche.
   *
   * Une tâche en pause d'approbation s'arrête tout de suite : elle n'exécute
   * rien, il n'y a aucun point de contrôle à attendre. Une tâche en marche passe
   * par `cancel_requested` et s'arrête quand son moteur atteint un point de
   * contrôle — forme coopérative qu'exigent les agents réels, qu'on ne peut pas
   * interrompre au milieu d'un appel de modèle sans en perdre le coût déjà payé.
   */
  cancel(taskId: string, reason?: string): TaskView | Refusal {
    const task = this.store.getTask(taskId)
    if (!task) return { error: 'task_not_found', status: 404 }
    if (isTerminal(task.status)) return { error: 'already_terminal', status: 409, detail: { status: task.status } }
    if (task.status === 'cancel_requested') {
      return { error: 'cancel_already_requested', status: 409, detail: { status: task.status } }
    }

    const pending = this.store.pendingApprovalFor(taskId)
    if (pending) {
      const resolved = this.store.resolveApproval(pending.id, 'rejected', 'cancel', 'tâche annulée avant décision')
      if (resolved) this.bus.emitApproval(resolved)
    }

    const agent = this.agentFor(task.agent_id)
    const engine = agent ? this.engines.get(agent.kind) : undefined

    if (task.status === 'waiting_approval') {
      engine?.cancel(task)
      const done = this.bus.record(
        taskId,
        'cancelled',
        { type: 'task.cancelled', payload: { reason, from: task.status } },
        { error: reason ?? 'annulée pendant une pause d\'approbation' },
      )!
      this.log(`tâche ${short(taskId)} annulée (en pause)`)
      return this.view(done.task)
    }

    const requested = this.bus.record(taskId, 'cancel_requested', {
      type: 'task.cancelled',
      payload: { reason, phase: 'requested' },
    })!
    // Le moteur dit s'il s'est arrêté net ou s'il s'arrêtera à son prochain
    // point de contrôle. Dans le second cas la tâche reste `cancel_requested`,
    // et c'est exact : elle n'est pas encore arrêtée.
    const stoppedNow = engine ? engine.cancel(requested.task) : true
    const done = (stoppedNow ? this.finishCancellation(taskId, reason) : null) ?? requested
    this.log(`tâche ${short(taskId)} annulation ${stoppedNow ? 'effective' : 'demandée'}`)
    return this.view(done.task)
  }

  /** Conclut une annulation demandée. @returns `null` si la tâche a fini entre-temps */
  private finishCancellation(taskId: string, reason?: string) {
    const task = this.store.getTask(taskId)
    if (!task || task.status !== 'cancel_requested') return null
    // Le motif de la demande, quand c'est le moteur qui conclut à son point de
    // contrôle : sans lui, une sous-tâche emportée par la cascade se dirait
    // annulée « à la demande de l'utilisateur ».
    const why = reason ?? this.store.cancelRequestReason(taskId) ?? undefined
    return this.bus.record(
      taskId,
      'cancelled',
      { type: 'task.cancelled', payload: { reason: why, phase: 'done' } },
      { error: why ?? 'annulée à la demande de l\'utilisateur' },
    )
  }

  /**
   * Fait expirer les approbations dont le délai est écoulé, et arrête les tâches
   * correspondantes en `timed_out`.
   *
   * Sans cela, une tâche oubliée resterait en pause indéfiniment — et en Slice 3
   * elle retiendrait un worktree. Le statut est `timed_out` et non `failed` :
   * rien n'a échoué, c'est le délai de décision qui s'est écoulé, et le message
   * d'erreur le dit.
   */
  private expireDueApprovals(): void {
    for (const due of this.store.dueApprovals()) {
      const resolved = this.store.resolveApproval(due.id, 'expired', 'daemon', 'délai de décision écoulé')
      if (!resolved) continue
      this.bus.emitApproval(resolved)
      const task = this.store.getTask(due.task_id)
      if (!task || task.status !== 'waiting_approval') continue
      const agent = this.agentFor(task.agent_id)
      if (agent) this.engines.get(agent.kind)?.cancel(task, 'expired')
      this.bus.record(
        task.id,
        'timed_out',
        { type: 'approval.resolved', payload: { approval_id: due.id, decision: 'expired' } },
        { needs_approval: false, error: `aucune décision humaine en ${humanDelay(this.config.approvalTtlMs)}` },
      )
      this.log(`approbation ${due.id} expirée, tâche ${short(task.id)} → timed_out`)
    }
  }

  /**
   * Arrête en `timed_out` les conversations restées sans réponse de
   * l'utilisateur au-delà de `inputTtlMs`.
   *
   * Seules les attentes de l'utilisateur expirent ici. Celles d'une sous-tâche
   * envers son parent sont bornées par le parent lui-même : la cascade les
   * emporte quand il s'arrête.
   */
  private expireIdleConversations(): void {
    const now = Date.now()
    for (const task of this.store.listTasks({ status: 'waiting_input' })) {
      if (task.awaiting_input !== 'chat') continue
      if (now - Date.parse(task.updated_at) < this.config.inputTtlMs) continue
      const agent = this.agentFor(task.agent_id)
      const error = `aucune réponse de l'utilisateur en ${humanDelay(this.config.inputTtlMs)}`
      this.bus.record(task.id, 'timed_out', { type: 'task.timed_out', payload: { reason: error } }, { error })
      // Après l'écriture : la boucle réveillée trouvera une tâche finie, et son
      // propre verdict sera ignoré (`conclude`).
      if (agent) this.engines.get(agent.kind)?.cancel(task)
      this.log(`tâche ${short(task.id)} : conversation sans réponse → timed_out`)
    }
  }

  // --- Délégation (Slice 5) -------------------------------------------------

  /**
   * Le port de délégation d'une tâche `orchestrator`.
   *
   * Lié à **sa** tâche : il ne voit, n'attend et n'annule que les sous-tâches
   * dont `parent_task_id` est elle, et c'est lui qui pose ce champ. Ce qu'il
   * rend est lu par le modèle : en anglais.
   *
   * @param redact expurgation de la tâche parente. L'objectif, le contexte et
   *               le motif d'annulation sont **écrits par un modèle** qui a pu
   *               lire une clé dans le projet, puis persistés : ils passent par
   *               elle, comme tout ce que la boucle journalise (PLAN §8.4, X1).
   */
  delegationFor(parentId: string, redact: (text: string) => string): DelegationPort {
    /** La sous-tâche, si elle appartient bien à ce parent. */
    const own = (taskId: string): Task | DelegationRefusal => {
      const task = this.store.getTask(taskId)
      // Même réponse pour une tâche inconnue et pour celle d'un autre arbre :
      // un orchestrateur n'a pas à apprendre ce qui existe hors du sien.
      if (!task || task.parent_task_id !== parentId) return { refused: `no subtask ${taskId} belongs to your task` }
      return task
    }

    const delegable = (a: Agent, created = false): DelegableAgent => ({
      id: a.id,
      name: a.name,
      kind: a.kind,
      description: a.description,
      enabled: a.enabled && !this.blindReason(a),
      disabled_reason: !a.enabled ? this.whyDisabledForModel(a) : this.blindReason(a)?.model ?? null,
      mcp_servers: a.mcp_servers.map((id) => ({ id, name: this.store.getMcpServer(id)?.name ?? id })),
      ...(created ? { created: true } : {}),
    })

    return {
      // Les profils, puis les agents que **cette** tâche a créés (Slice 8) :
      // ceux d'un autre arbre n'existent pas pour elle.
      listAgents: () => [
        ...this.store
          .listAgents()
          .filter((a) => a.kind !== 'orchestrator')
          .map((a) => delegable(a)),
        ...this.store
          .createdAgentsOf(parentId)
          .map((c) => resolveCreatedAgent(this.store, c))
          .filter((a): a is Agent => a !== null)
          .map((a) => delegable(a, true)),
      ],

      createAgent: (request) => this.createAgent(parentId, request, redact),

      delegate: (request) => {
        // Les deux plafonds de l'arbre (Slice 8), vérifiés **avant** de créer
        // la sous-tâche, comme toute limite : une limite constatée après coup
        // a déjà été payée.
        const active = this.store.childTasks(parentId, { active: true }).length
        if (active >= this.config.maxActiveSubtasks) {
          return {
            refused:
              `${active} subtask(s) are already running, the maximum at the same time: ` +
              'wait for one with wait_for_task, or cancel one, before delegating again',
          }
        }
        const created = this.create({
          objective: redact(request.objective.trim()),
          agentId: request.agent_id,
          context: request.context === undefined ? null : redact(request.context),
          // Ignoré : `create` impose le dossier du parent à une sous-tâche.
          projectDir: null,
          durationS: 20,
          needsApproval: false,
          parentTaskId: parentId,
        })
        if ('error' in created) return { refused: this.refusalForModel(created) }
        return subtaskState(created.task)
      },

      wait: async (taskId, options) => {
        const child = own(taskId)
        if ('refused' in child) return child
        const started = Date.now()
        if (!isTerminal(child.status) && !awaitsParent(child)) {
          // Le statut du parent ne change pas (`running`) : sans cet événement,
          // le dashboard montrerait un orchestrateur immobile sans dire qui il
          // attend (décision 3).
          const parent = this.store.getTask(parentId)
          if (parent && !isTerminal(parent.status)) {
            this.bus.record(parentId, null, {
              type: 'subtask.waiting',
              payload: { task_id: child.id, agent_id: child.agent_id, status: child.status },
            })
          }
        }
        const stopped = await this.waitForEnd(taskId, options.signal, options.deadline)
        const now = this.store.getTask(taskId)!
        return { ...(await this.stateFor(now, redact)), waited_ms: Date.now() - started, stopped_by: stopped }
      },

      send: (taskId, message) => {
        const child = own(taskId)
        if ('refused' in child) return child
        if (child.status !== 'waiting_input' || child.awaiting_input === 'chat' || child.awaiting_input === null) {
          return { refused: `subtask ${taskId} is not waiting for you (status ${child.status}): call wait_for_task` }
        }
        const engine = this.engineFor(child)
        // Le texte est écrit par le modèle du parent, qui a pu lire une clé : il
        // passe par son expurgation, puis par celle de l'enfant (`deliver`).
        const resumed = engine?.deliver?.(child, redact(message), 'message.agent', {
          from_task_id: parentId,
          in_reply_to: child.awaiting_input,
        })
        if (!resumed) return { refused: `subtask ${taskId} is not waiting for you any more` }
        return subtaskState(resumed)
      },

      accept: async (taskId, options) => {
        const child = own(taskId)
        if ('refused' in child) return child
        if (child.status !== 'waiting_input' || child.awaiting_input !== 'proposal') {
          return {
            refused:
              `subtask ${taskId} has no proposal waiting for your review (status ${child.status}): ` +
              'call wait_for_task until its next_action is review_proposal',
          }
        }
        const resumed = this.engineFor(child)?.accept?.(child, { from_task_id: parentId })
        if (!resumed) return { refused: `subtask ${taskId} has no proposal waiting any more` }
        // Rendre la main une fois le commit fait : l'orchestrateur a besoin de la
        // branche et du commit pour les nommer à l'humain.
        const stopped = await this.waitForEnd(taskId, options.signal, options.deadline)
        return { ...subtaskState(this.store.getTask(taskId)!), stopped_by: stopped }
      },

      cancel: (taskId, reason) => {
        const child = own(taskId)
        if ('refused' in child) return child
        if (isTerminal(child.status)) return { refused: `subtask ${taskId} already ended (${child.status})` }
        if (child.status === 'cancel_requested') return subtaskState(child)
        const done = this.cancel(
          taskId,
          reason ? `annulée par l'orchestrateur : ${redact(reason)}` : 'annulée par l\'orchestrateur',
        )
        if ('error' in done) return { refused: this.refusalForModel(done) }
        return subtaskState(done.task)
      },
    }
  }

  /**
   * Crée un agent pour l'arbre d'un orchestrateur (Slice 8, décisions 12 à 16).
   *
   * Rien de ce qui est créé ne dépasse le profil de base, et tout dépassement
   * est **refusé avec son motif**, jamais réduit en silence : l'orchestrateur
   * doit savoir ce qu'il a obtenu. Le rôle est écrit par un modèle : il passe
   * par l'expurgation avant d'être persisté, comme un objectif délégué.
   */
  private createAgent(
    parentId: string,
    request: CreateAgentRequest,
    redact: (text: string) => string,
  ): CreatedAgentInfo | DelegationRefusal {
    const parent = this.store.getTask(parentId)
    if (!parent || isTerminal(parent.status) || parent.status === 'cancel_requested') {
      return { refused: 'your task is stopping: no new executor can be created' }
    }
    if (this.store.createdAgentsOf(parentId).length >= MAX_CREATED_AGENTS) {
      return { refused: `you already created ${MAX_CREATED_AGENTS} executors in this task: reuse one of them (list_agents)` }
    }
    const base = this.store.getAgent(request.base)
    if (!base) return { refused: `unknown base profile "${request.base}"` }
    if (!base.enabled) return { refused: `the base profile "${base.id}" is disabled: ${this.whyDisabledForModel(base)}` }

    // Le fournisseur : déclaré.
    const providerId = request.provider_id ?? base.provider_id
    const provider = providerId ? this.store.getProvider(providerId) : null
    if (!providerId || !provider) {
      const known = this.store.listProviders().map((p) => p.id)
      return { refused: `unknown model provider "${providerId ?? ''}"; configured: ${known.join(', ') || 'none'}` }
    }
    // Le modèle : celui du profil de base par défaut. Un autre doit être
    // offert par le fournisseur (constaté au dernier test de connexion) **et**
    // avoir un tarif connu : sinon son coût échapperait au budget de l'arbre.
    const baseModel = providerId === base.provider_id ? base.model : null
    const model = request.model ?? baseModel
    const effective = model ?? provider.default_model
    const baseEffective = base.provider_id === providerId ? (base.model ?? provider.default_model) : null
    if (effective !== baseEffective) {
      const offered = provider.last_test?.models ?? []
      if (model && model !== provider.default_model && !offered.includes(model)) {
        return {
          refused: offered.length
            ? `model "${model}" is not offered by provider "${providerId}"`
            : `the models of provider "${providerId}" are unknown: use its default model or the base profile's`,
        }
      }
    }
    // Les serveurs MCP : un sous-ensemble de ceux du profil de base.
    const servers = [...new Set(request.mcp_servers ?? [])]
    const foreign = servers.filter((s) => !base.mcp_servers.includes(s))
    if (foreign.length) {
      return {
        refused:
          `MCP server(s) ${foreign.join(', ')} not available to the base profile "${base.id}" ` +
          `(it has: ${base.mcp_servers.join(', ') || 'none'})`,
      }
    }
    const name = redact(request.name.trim()).slice(0, 60)
    const created = this.store.createCreatedAgent({
      id: createdAgentId(name),
      task_id: parentId,
      name,
      base_agent_id: request.base,
      provider_id: providerId,
      model,
      role: redact(request.role.trim()),
      mcp_servers: servers,
    })
    // Écrit dans le journal de l'orchestrateur : l'humain voit dans l'arbre
    // qui a été créé, à partir de quoi, et avec quel rôle (décision 14).
    this.bus.record(parentId, null, {
      type: 'agent.created',
      payload: {
        agent_id: created.id,
        name: created.name,
        base_agent_id: created.base_agent_id,
        provider_id: created.provider_id,
        model: created.model,
        mcp_servers: created.mcp_servers,
        role: created.role,
      },
    })
    return {
      agent_id: created.id,
      name: created.name,
      base: created.base_agent_id,
      provider_id: created.provider_id,
      model: created.model,
      mcp_servers: created.mcp_servers,
    }
  }

  /** Le moteur du profil d'une tâche, s'il est enregistré. */
  private engineFor(task: Task): TaskEngine | undefined {
    const agent = this.agentFor(task.agent_id)
    return agent ? this.engines.get(agent.kind) : undefined
  }

  /**
   * L'état d'une sous-tâche pour son parent, avec ce qu'elle attend de lui :
   * sa question, ou sa proposition et — pour un Developer — le diff de son
   * worktree, **non commité**. Le patch est écrit par l'enfant : il passe par
   * l'expurgation du parent avant d'entrer dans sa conversation.
   */
  private async stateFor(task: Task, redact: (text: string) => string): Promise<SubtaskState> {
    const state = subtaskState(task)
    if (!awaitsParent(task)) return state
    const asked = this.store.lastEventOfType(task.id, 'input.requested')
    const awaiting: SubtaskAwaiting = {
      request: task.awaiting_input as 'question' | 'proposal',
      text: typeof asked?.payload.text === 'string' ? asked.payload.text : '',
      ...(typeof asked?.payload.details === 'string' && asked.payload.details
        ? { details: asked.payload.details }
        : {}),
    }
    const workspace = task.awaiting_input === 'proposal' ? this.store.workspaceForTask(task.id) : null
    if (workspace) {
      try {
        const diff = await diffWorktree(workspace.worktree_path, workspace.base_commit, PROPOSAL_PATCH_BYTES)
        awaiting.diff = {
          files: diff.files.map((f) => ({ path: f.path, kind: f.kind, additions: f.additions, deletions: f.deletions })),
          additions: diff.additions,
          deletions: diff.deletions,
          patch: redact(diff.patch),
          patch_truncated: diff.patch_truncated,
        }
      } catch (e) {
        // Un diff illisible ne doit pas empêcher la revue : l'orchestrateur a
        // encore le résumé, et peut renvoyer la proposition.
        this.log(`sous-tâche ${short(task.id)} : diff de la proposition illisible`, e)
      }
    }
    return { ...state, awaiting }
  }

  /**
   * Attend qu'une tâche atteigne un statut final, **ou qu'elle attende son
   * parent** (Slice 6) : une question ou une proposition rend la main à
   * l'orchestrateur, qui seul peut répondre.
   *
   * **Une pause d'approbation n'interrompt pas l'attente** (décision 2) :
   * l'orchestrateur n'a aucun moyen d'approuver, et lui rendre la main ne
   * servirait qu'à lui faire payer une étape pour rappeler l'attente. Pas de
   * tranches non plus — la coupure à 60 s est propre aux clients MCP.
   *
   * @param signal   arrêt de la tâche parente
   * @param deadline échéance de la tâche parente, en millisecondes depuis l'époque
   */
  private waitForEnd(taskId: string, signal?: AbortSignal, deadline?: number): Promise<WaitStop> {
    return new Promise<WaitStop>((resolve) => {
      let settled = false
      let timer: NodeJS.Timeout | undefined
      const finish = (why: WaitStop) => {
        if (settled) return
        settled = true
        if (timer) clearTimeout(timer)
        unsubscribe()
        signal?.removeEventListener('abort', onAbort)
        resolve(why)
      }
      const unsubscribe = this.bus.subscribe(({ task }) => {
        if (task.id !== taskId) return
        if (isTerminal(task.status)) finish('ended')
        else if (awaitsParent(task)) finish('awaiting_you')
      })
      const onAbort = () => finish('parent_stopping')
      signal?.addEventListener('abort', onAbort, { once: true })
      if (deadline !== undefined) timer = setTimeout(() => finish('deadline'), Math.max(0, deadline - Date.now()))
      // Relecture après abonnement, comme pour `wait` : une fin survenue entre
      // la lecture de l'appelant et l'abonnement serait sinon manquée.
      const now = this.store.getTask(taskId)
      if (!now || isTerminal(now.status)) finish('ended')
      else if (awaitsParent(now)) finish('awaiting_you')
      else if (signal?.aborted) finish('parent_stopping')
    })
  }

  /**
   * Annule les sous-tâches actives d'une tâche qui s'arrête.
   *
   * Une sous-tâche déjà en `cancel_requested` est laissée à son moteur : la
   * redemander serait un refus (`cancel_already_requested`), pas une action.
   */
  private cancelChildren(parentId: string, parentStatus: Task['status']): void {
    for (const child of this.store.childTasks(parentId, { active: true })) {
      if (child.status === 'cancel_requested') continue
      const reason =
        parentStatus === 'cancel_requested' || parentStatus === 'cancelled'
          ? 'tâche parente annulée'
          : `tâche parente terminée (${parentStatus}) : sous-tâche annulée`
      const done = this.cancel(child.id, reason)
      this.log(
        `sous-tâche ${short(child.id)} de ${short(parentId)} : ` +
          ('error' in done ? `annulation impossible (${done.error})` : `annulation ${done.task.status}`),
      )
    }
  }

  /** Pourquoi un profil est désactivé, en anglais : c'est l'orchestrateur qui le lit. */
  private whyDisabledForModel(agent: Agent): string {
    if (agent.provider_id === null) return 'no model provider is configured for this profile'
    if (!this.store.getProvider(agent.provider_id)) return `its provider "${agent.provider_id}" no longer exists`
    return 'the profile is disabled'
  }

  /** Traduit un refus du gérant en phrase pour le modèle : ce qui bloque, et quoi faire. */
  private refusalForModel(refusal: Refusal): string {
    const d = refusal.detail ?? {}
    switch (refusal.error) {
      case 'agent_not_found':
        return `unknown profile "${String(d.agent_id)}": call list_agents to see the available ones`
      case 'agent_disabled': {
        const agent = this.agentFor(String(d.agent_id))
        const why = !agent ? 'unknown reason' : agent.enabled ? this.blindReason(agent)?.model ?? 'the profile is disabled' : this.whyDisabledForModel(agent)
        return `profile "${String(d.agent_id)}" is disabled: ${why}`
      }
      case 'nested_orchestrator':
        return 'you cannot delegate to an orchestrator profile: delegate to an executor instead'
      case 'parent_not_active':
        return 'your task is stopping: no new subtask can start'
      case 'engine_unavailable':
        return `profile "${String(d.agent_id)}" cannot run tasks in this version of the harness`
      default:
        return `refused by the harness (${refusal.error})`
    }
  }

  // --- Lecture et attente --------------------------------------------------

  /** Compose la vue d'une tâche : état, consigne, approbation en cours. */
  view(task: Task): TaskView {
    return {
      task,
      next_action: nextActionFor(task),
      approval: task.status === 'waiting_approval' ? this.store.pendingApprovalFor(task.id) : null,
    }
  }

  /** Vue d'une tâche par identifiant. @returns `null` si elle n'existe pas */
  viewOf(taskId: string): TaskView | null {
    const task = this.store.getTask(taskId)
    return task ? this.view(task) : null
  }

  /** Timeline complète d'une tâche. */
  events(taskId: string): TaskEvent[] {
    return this.store.taskEvents(taskId)
  }

  /** Appels d'outils d'une tâche, dans l'ordre. Vide pour une tâche simulée. */
  toolCalls(taskId: string): ToolCall[] {
    return this.store.toolCalls(taskId)
  }

  /**
   * Attend qu'une tâche atteigne un état « actionnable » pour Claude : une fin,
   * ou une pause d'approbation **plus récente** que `knownApproval`.
   *
   * @param timeoutMs      délai maximal ; à l'expiration, l'état courant est rendu
   * @param knownApproval  numéro de la dernière pause déjà signalée à ce client
   * @param signal         annulation : le client a abandonné son attente
   * @returns la vue finale et le temps réellement attendu, ou `null` si la tâche
   *          n'existe pas
   */
  async wait(
    taskId: string,
    timeoutMs: number,
    knownApproval: number,
    signal?: AbortSignal,
  ): Promise<(TaskView & { waited_ms: number }) | null> {
    const started = Date.now()
    const current = this.store.getTask(taskId)
    if (!current) return null
    if (isActionable(current, knownApproval)) return { ...this.view(current), waited_ms: 0 }

    const task = await new Promise<Task>((resolve) => {
      let settled = false
      const finish = (t: Task) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        unsubscribe()
        signal?.removeEventListener('abort', onAbort)
        resolve(t)
      }
      const unsubscribe = this.bus.subscribe(({ task: changed }) => {
        if (changed.id === taskId && isActionable(changed, knownApproval)) finish(changed)
      })
      const onAbort = () => finish(this.store.getTask(taskId) ?? current)
      const timer = setTimeout(() => finish(this.store.getTask(taskId) ?? current), timeoutMs)
      signal?.addEventListener('abort', onAbort, { once: true })
      // Relecture après abonnement : une transition survenue entre la première
      // lecture et l'abonnement serait sinon manquée, et l'attente irait au bout
      // de son délai pour rien.
      const after = this.store.getTask(taskId)
      if (after && isActionable(after, knownApproval)) finish(after)
    })

    return { ...this.view(task), waited_ms: Date.now() - started }
  }
}

/**
 * Taille du patch d'une proposition remis à l'orchestrateur. Sa réponse entière
 * est bornée à 60 Ko (`MAX_TOOL_RESULT_BYTES`) ; le patch en laisse pour le
 * résumé et les détails.
 */
const PROPOSAL_PATCH_BYTES = 30_000

/** Vrai si une sous-tâche attend son parent : une question, ou un verdict. */
function awaitsParent(task: Task): boolean {
  return task.status === 'waiting_input' && (task.awaiting_input === 'question' || task.awaiting_input === 'proposal')
}

/** Ce qu'une sous-tâche montre à son orchestrateur ; `awaiting` est complété par `stateFor`. */
function subtaskState(task: Task): SubtaskState {
  return {
    awaiting: null,
    task_id: task.id,
    agent_id: task.agent_id,
    status: task.status,
    ended: isTerminal(task.status),
    result: task.result,
    error: task.error,
    usage: task.usage,
  }
}

/** Identifiant du profil simulé, réexporté pour les appelants du daemon. */
export { SIMULATED_AGENT_ID }

/**
 * Délai en texte lisible. En minutes au-delà d'une minute, en secondes en deçà :
 * un délai de test réduit à deux secondes ne doit pas s'afficher « 0 minutes ».
 */
function humanDelay(ms: number): string {
  return ms < 60_000 ? `${Math.round(ms / 1000)} secondes` : `${Math.round(ms / 60_000)} minutes`
}

/**
 * Le message remis à l'agent quand l'utilisateur demande de conclure. En
 * anglais : c'est le modèle qui le lit. Ce que l'utilisateur a écrit avec, s'il
 * a écrit quelque chose, vient en premier.
 */
function concludeText(userText: string): string {
  const instruction =
    'The user asks you to conclude now. Call submit_result with your answer for the whole conversation: ' +
    'what was decided, what each subtask did, which branches hold changes, and what is left undone.'
  return userText.trim() ? `${userText.trim()}\n\n${instruction}` : instruction
}

/** Identifiant abrégé pour les journaux : lisible sans être ambigu en pratique. */
function short(id: string): string {
  return id.slice(0, 8)
}

/** Agents qu'un orchestrateur peut créer dans une tâche : de quoi spécialiser, pas de quoi submerger. */
export const MAX_CREATED_AGENTS = 8

/**
 * Identifiant d'un agent créé : son nom en minuscules, puis six caractères
 * aléatoires — lisible dans l'arbre, unique, et dans l'alphabet des profils.
 */
function createdAgentId(name: string): string {
  const slug = name
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
  return `${slug || 'agent'}-${randomBytes(3).toString('hex')}`
}

