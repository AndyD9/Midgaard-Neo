/**
 * @file Protocole entre le serveur MCP, la CLI, le dashboard et le daemon :
 * version, formes des réponses HTTP et messages WebSocket.
 */
import { z } from 'zod'
import { taskEventSchema } from './events.ts'
import { approvalSchema } from './approvals.ts'
import { NEXT_ACTIONS, taskSchema, taskStatusSchema } from './task.ts'
import { agentSchema, requestedLimitsSchema } from './agent.ts'
import { connectionTestSchema, PROVIDER_PRESETS, providerConfigSchema, WEB_SEARCH_MODES } from './provider.ts'
import { pricingTableSchema } from './usage.ts'
import { toolCallSchema } from './tools.ts'
import { execAllowEntrySchema, workspaceDiffSchema, workspaceSchema } from './workspace.ts'

/**
 * Version du protocole, annoncée par `GET /api/health`.
 *
 * Le daemon survit aux mises à jour du code : un serveur MCP récent peut tomber
 * sur un daemon ancien dont il ne comprend plus les réponses. Celui qui trouve une
 * autre version arrête le daemon et en démarre un neuf.
 *
 * **À incrémenter à tout changement incompatible** de l'API HTTP, du modèle de
 * tâche ou du protocole WebSocket.
 *  - 1 : spike initial ;
 *  - 2 : pauses d'approbation numérotées (`approval_seq`, `known_approval`) ;
 *  - 3 : Slice 1 — persistance SQLite, journal d'événements, WebSocket, routes
 *        préfixées `/api`, statuts `preparing`/`cancel_requested`/`interrupted`/
 *        `timed_out`/`budget_exceeded` ;
 *  - 4 : Slice 2 — agents réels. La tâche porte `agent_id`, `context`, `limits`
 *        et `usage` ; le journal gagne `tool.*`, `usage.updated` et
 *        `task.budget_exceeded` ; les routes `/api/agents` et `/api/providers`
 *        apparaissent. Un daemon de protocole 3 ne sait rien de tout cela, et
 *        rendrait des tâches sans coût ni agent : il doit être remplacé ;
 *  - 5 : Slice 3, premier pas — le journal gagne `workspace.created`,
 *        `workspace.kept` et `workspace.removed`. Un daemon de protocole 4
 *        n'écrirait pas ces événements, et le dashboard servi par un daemon
 *        récent les attend ;
 *  - 6 : Slice 3, étape 4 — une approbation porte `operation_detail`, l'opération
 *        exacte sous forme structurée, et son empreinte en est tirée. Un daemon
 *        de protocole 5 rendrait des approbations sans ce champ, que le
 *        dashboard et le serveur MCP valident désormais ;
 *  - 7 : Slice 3, étape 5 — le profil `developer` (nouveau `kind`) et le
 *        résultat de tâche gagne `workspace` (branche, commit, ampleur) ;
 *  - 8 : Slice 4, étape 2 — un worktree porte `submodules`, les sous-modules
 *        laissés vides, dans sa ligne, son `workspace.created` et le résultat.
 *        Un daemon de protocole 7 ne les détecterait pas, et le dashboard servi
 *        par un daemon récent lit le champ sur chaque worktree ;
 *  - 9 : Slice 4, étape 6 — `/api/health` annonce `install` (dossier et
 *        version de l'installation), et `/api/shutdown` accepte `if_idle`, qui
 *        refuse l'arrêt tant qu'une tâche est active. Un daemon de protocole 8
 *        s'arrêterait sans condition : il doit être remplacé comme avant ;
 *  - 10 : Slice 5, étape 2 — une tâche porte `parent_task_id`, un profil peut
 *        être de type `orchestrator`, et `PATCH /api/agents/:id` choisit le
 *        fournisseur et le modèle d'un profil. Un daemon de protocole 9 rendrait
 *        des tâches sans le champ, que le serveur MCP et le dashboard valident
 *        désormais, et répondrait 405 au réglage du modèle ;
 *  - 11 : Slice 6, étape 1 — une tâche porte `mode` et `awaiting_input`, et peut
 *        être en `waiting_input`, un statut actif que les versions antérieures
 *        ne connaissent pas. Un daemon de protocole 10 rendrait des tâches sans
 *        ces champs, que le serveur MCP et le dashboard valident désormais ;
 *  - 12 : Slice 7, étape 2 — un profil porte `vision` (la déclaration de
 *        l'utilisateur), que `PATCH /api/agents/:id` accepte. Un daemon de
 *        protocole 11 rendrait des profils sans le champ, que le serveur MCP
 *        et le dashboard valident désormais ;
 *  - 13 : Slice 7, étape 5 — un profil peut être de type `navigator`, que les
 *        versions antérieures refuseraient à la validation, et
 *        `GET /api/agents` rend `disabled_reason`, le motif calculé par le
 *        daemon (fournisseur absent, ou modèle qui ne lit pas les images) ;
 *  - 14 : Slice 8, étape 2 — les routes `/api/mcp` (serveurs MCP déclarés,
 *        leur catalogue, les outils cochés). Un daemon de protocole 13
 *        répondrait 404 à `harness mcp` : la CLI doit le faire remplacer ;
 *  - 15 : Slice 8, étape 3 — un profil porte `mcp_servers`, que le serveur MCP
 *        et le dashboard valident, et `PUT /api/agents/:id/mcp` les règle. Un
 *        daemon de protocole 14 rendrait des profils sans le champ ;
 *  - 16 : Slice 8 — `PUT /api/agents/:id/limits` règle les limites d'un
 *        profil. Un daemon de protocole 15 répondrait 404 à
 *        `harness agents limits` et au dashboard ;
 *  - 17 : Slice 9, étape 1 — un profil porte `playbooks`, que le serveur MCP
 *        et le dashboard valident, `PUT /api/agents/:id/playbooks` les règle
 *        et `GET /api/playbooks` les liste. Un daemon de protocole 16
 *        rendrait des profils sans le champ, et répondrait 404 à
 *        `harness playbooks`.
 *  - 18 : Slice 9, étape 3 — la liste blanche `exec` a des **préfixes** :
 *        `POST /api/exec-allow` accepte `prefix`, une entrée porte `prefix`.
 *        Un daemon de protocole 17 ignorerait le champ et enregistrerait une
 *        entrée exacte en disant l'ajout réussi : la CLI doit le remplacer ;
 *  - 19 : Slice 9, étape 4 — une tâche porte `samples`, que le serveur MCP
 *        et le dashboard valident, et `POST /api/tasks` les accepte. Un
 *        daemon de protocole 18 ignorerait le champ : la tâche partirait sans
 *        ses échantillons, et sans que `exec` sache lesquels refuser ;
 *  - 20 : Slice 9, étape 5.2 — les routes `/api/windows` (VM Windows de
 *        test : déclaration, clé générée au coffre, test, retrait). Un daemon
 *        de protocole 19 répondrait 404 à `harness windows` : la CLI doit le
 *        faire remplacer ;
 *  - 21 : Slice 9, étape 5.3a — un profil porte `windows_host`, que le
 *        serveur MCP et le dashboard valident, et
 *        `PUT /api/agents/:id/windows` l'attache ou le détache. Un daemon de
 *        protocole 20 rendrait des profils sans le champ, et répondrait 404
 *        à `harness windows attach`.
 *  - 22 : Slice 10, étape 2 — les *findings* de première classe dans l'arbre
 *        d'un orchestrateur (table `findings`, événements `finding.*`, outils
 *        `record_finding`/`reject_finding`/`confirm_trace`/`list_findings`).
 *        La porte de traçage est mécanique : seul `confirm_trace`, avec une
 *        chaîne source→sink complète, mène à `trace_confirmed`, et seul ce
 *        statut entre dans le rapport. Un daemon de protocole 21 ignorerait ces
 *        outils et la table.
 *
 * Les briques des versions 17 (playbooks), 19 (échantillons) et 22 (findings)
 * ont été retirées depuis : l'historique reste, le numéro ne redescend pas.
 */
export const PROTOCOL_VERSION = 22

/** Contenu du fichier de découverte du daemon. **Secret** : il donne le contrôle du daemon. */
export const runtimeInfoSchema = z.object({
  pid: z.number().int().positive(),
  port: z.number().int().positive(),
  /** Jeton aléatoire de 256 bits, régénéré à chaque démarrage du daemon. */
  token: z.string().min(32),
  started_at: z.iso.datetime(),
  protocol: z.number().int().positive(),
  /** URL du dashboard, prête à être transmise à l'utilisateur. */
  dashboard_url: z.url(),
})
export type RuntimeInfo = z.infer<typeof runtimeInfoSchema>

/** Réponse de `GET /api/health`. */
export const healthSchema = z.object({
  ok: z.literal(true),
  pid: z.number().int(),
  protocol: z.number().int(),
  uptime_s: z.number().int(),
  port: z.number().int(),
  dashboard_url: z.url(),
  /**
   * Vrai si les fichiers du dashboard sont réellement servis. Sans cela, rien
   * ne doit renvoyer l'utilisateur vers cette URL : c'est la leçon du défaut
   * n° 1 de la Slice 0, où Claude a dirigé l'utilisateur vers un dashboard qui
   * n'existait pas encore.
   */
  dashboard_available: z.boolean(),
  tasks: z.object({ total: z.number().int(), active: z.number().int() }),
  /** Millisecondes restantes avant arrêt pour inactivité ; `null` si l'arrêt est désactivé. */
  idle_shutdown_in_ms: z.number().int().nullable(),
  db_path: z.string(),
  /**
   * L'installation d'où vient ce daemon (dossier du paquet `@midgaard/daemon`,
   * version). Un serveur MCP d'une autre installation le remplace s'il est
   * oisif, et s'en sert sinon : voir `ensureDaemon`.
   */
  install: z.object({ dir: z.string(), version: z.string() }),
})
export type Health = z.infer<typeof healthSchema>

/**
 * Corps de `POST /api/tasks`. Les mêmes bornes sont revérifiées côté daemon.
 *
 * `duration_s` et `needs_approval` ne concernent que le profil `simulated` ; un
 * agent réel s'arrête sur son résultat ou ses limites, et c'est sa politique
 * d'outils qui décide des approbations. Ils sont conservés parce que le profil
 * simulé reste le seul moyen d'exercer la machine à états sans dépenser de jetons.
 */
export const createTaskRequestSchema = z.object({
  // Pas de `parent_task_id` : seul le daemon rattache une tâche à son parent
  // (Slice 5, décision 8). zod écarte les clés inconnues, et
  // `tests/unit/http-agents.test.ts` vérifie qu'un client qui l'envoie ne
  // rattache rien.
  objective: z.string().min(1).max(4000),
  /** Profil d'agent. Par défaut `simulated`, qui n'appelle aucun modèle. */
  agent_id: z.string().min(1).max(64).default('simulated'),
  /** Contexte fourni par Claude : ce que l'agent n'a pas à redécouvrir lui-même. */
  context: z.string().max(100_000).optional(),
  /**
   * Dossier que l'agent pourra lire. Le serveur MCP y met son propre dossier de
   * travail, c'est-à-dire le dépôt ouvert dans la session Claude Code.
   */
  project_dir: z.string().max(4096).optional(),
  /** Limites demandées. Elles ne peuvent qu'**abaisser** celles du profil. */
  limits: requestedLimitsSchema.optional(),
  /** Tâche simulée seulement : durée totale. */
  duration_s: z.number().int().min(1).max(900).default(20),
  /** Tâche simulée seulement : insère une pause d'approbation. */
  needs_approval: z.boolean().default(false),
  /**
   * Ouvre une conversation (Slice 6). C'est une **demande** : le daemon pose le
   * mode `chat` lui-même, et refuse (`conversation_unsupported`) pour tout
   * profil autre qu'un orchestrateur. Le serveur MCP ne l'envoie jamais.
   */
  conversation: z.boolean().default(false),
})
export type CreateTaskRequest = z.infer<typeof createTaskRequestSchema>

/**
 * Corps de `POST /api/tasks/:id/messages` (Slice 6) : le message de
 * l'utilisateur à une conversation qui l'attend.
 *
 * `conclude` demande à l'agent de conclure : le harness ajoute la consigne, et
 * `text` peut alors être vide. Le texte est expurgé avant d'être écrit, et
 * l'agent lit la version expurgée.
 */
export const postMessageRequestSchema = z.object({
  text: z.string().max(20_000).default(''),
  conclude: z.boolean().default(false),
  /** Qui écrit : `dashboard` ou `cli`. Jamais un modèle — aucun outil n'atteint cette route. */
  by: z.string().min(1).max(32).default('dashboard'),
})
export type PostMessageRequest = z.infer<typeof postMessageRequestSchema>

/** Réponse portant une tâche et la consigne associée. */
export const taskViewSchema = z.object({
  task: taskSchema,
  next_action: z.enum(NEXT_ACTIONS),
  /** Approbation en cours, s'il y en a une. */
  approval: approvalSchema.nullable().default(null),
})
export type TaskView = z.infer<typeof taskViewSchema>

/**
 * Réponse de `GET /api/tasks/:id/workspace` : le worktree d'une tâche et ce que
 * l'agent y a changé.
 *
 * Le diff est **calculé à la demande** contre le commit de départ, jamais lu
 * d'une copie figée : il dit ce qui est sur le disque au moment où on le lit,
 * travail non commité compris. Quand il ne peut pas l'être — tâche sans
 * worktree, worktree retiré ou supprimé à la main —, `unavailable` dit
 * pourquoi, et comment retrouver le travail s'il existe encore.
 */
export const taskWorkspaceResponseSchema = z.object({
  workspace: workspaceSchema.nullable(),
  diff: workspaceDiffSchema.nullable(),
  unavailable: z.string().nullable(),
})
export type TaskWorkspaceResponse = z.infer<typeof taskWorkspaceResponseSchema>

/** Un worktree tel que `harness workspaces` le montre : la ligne en base, et ce qu'il y a sur le disque. */
export const workspaceListingSchema = z.object({
  workspace: workspaceSchema,
  task_status: taskStatusSchema.nullable(),
  exists: z.boolean(),
  /** Chemins modifiés ou nouveaux non commités ; `null` si le worktree est absent ou illisible. */
  dirty: z.number().int().min(0).nullable(),
})
export type WorkspaceListing = z.infer<typeof workspaceListingSchema>

/** Réponse de `GET /api/workspaces`. */
export const workspacesResponseSchema = z.object({
  workspaces: z.array(workspaceListingSchema),
  /**
   * Dossiers sous `worktreesDir` qu'aucune ligne ne référence : reste d'un
   * crash entre la création du worktree et son enregistrement. **Montrés,
   * jamais supprimés d'office** — rien ne dit à qui ils sont.
   */
  orphans: z.array(z.string()),
  worktrees_dir: z.string(),
})
export type WorkspacesResponse = z.infer<typeof workspacesResponseSchema>

/** Corps de `POST /api/workspaces/:id/remove`. */
export const removeWorkspaceRequestSchema = z.object({
  /** Retirer même avec du travail non commité, que la branche ne contient pas. */
  force: z.boolean().default(false),
  by: z.string().min(1).max(64).default('cli'),
})

/** Réponse de `GET /api/exec-allow?project_dir=`. */
export const execAllowResponseSchema = z.object({
  repo_dir: z.string(),
  entries: z.array(execAllowEntrySchema),
  /**
   * Liste blanche globale (`MIDGAARD_EXEC_ALLOW`), qui s'ajoute à celle du
   * dépôt. Des argv **exacts** seulement : la variable n'a pas de forme préfixe.
   */
  global: z.array(z.array(z.string())),
  /**
   * Ce qu'a fait un ajout : `added`, `widened` (une entrée exacte devenue
   * préfixe), `unchanged` (déjà là, ou déjà couverte par le même préfixe).
   * Absent d'une simple lecture.
   */
  outcome: z.enum(['added', 'widened', 'unchanged']).optional(),
})
export type ExecAllowResponse = z.infer<typeof execAllowResponseSchema>

/** Corps de `POST /api/exec-allow` et `POST /api/exec-allow/remove`. */
export const execAllowRequestSchema = z.object({
  project_dir: z.string().min(1).max(4096),
  argv: z.array(z.string().min(1).max(4096)).min(1).max(64),
  /**
   * Ajout seulement : `true` pour un préfixe (Slice 9). Le daemon le rejuge
   * par `execPrefixRefusal` : un refus est un 400 avec son motif.
   */
  prefix: z.boolean().default(false),
  by: z.string().min(1).max(64).default('cli'),
})

/** Réponse de `GET /api/agents`. */
export const agentsResponseSchema = z.object({ agents: z.array(agentSchema) })
export type AgentsResponse = z.infer<typeof agentsResponseSchema>

/** Réponse de `GET /api/agents/:id` et de `PATCH /api/agents/:id`. */
export const agentResponseSchema = z.object({ agent: agentSchema })
export type AgentResponse = z.infer<typeof agentResponseSchema>

/** Réponse de `GET /api/providers`. Ne contient **aucune clé**, seulement des références. */
export const providersResponseSchema = z.object({
  providers: z.array(providerConfigSchema),
  /** Tarifs en vigueur, avec leur date de relevé : l'interface doit pouvoir dire s'ils ont vieilli. */
  pricing: z.object({ updated_at: z.iso.datetime(), source: z.string(), models: z.number().int().min(0) }),
})
export type ProvidersResponse = z.infer<typeof providersResponseSchema>

/**
 * Corps de `POST /api/providers` — déclaration ou mise à jour d'un fournisseur.
 *
 * `api_key` est le **seul** endroit du protocole où une clé circule, et elle n'y
 * fait que passer : le daemon la dépose dans le coffre système et n'en garde
 * qu'une référence. Elle n'est jamais relue, jamais renvoyée, jamais journalisée.
 */
export const upsertProviderRequestSchema = z.object({
  id: z.string().min(1).max(64),
  name: z.string().min(1).max(200).optional(),
  preset: z.enum(PROVIDER_PRESETS).default('venice'),
  base_url: z.url().optional(),
  default_model: z.string().min(1),
  api_key: z.string().min(1).optional(),
  web_search: z.enum(WEB_SEARCH_MODES).optional(),
})
export type UpsertProviderRequest = z.infer<typeof upsertProviderRequestSchema>

/** Réponse de `POST /api/providers/:id/test` — le « Test connection » du plan. */
export const connectionTestResponseSchema = z.object({
  provider: providerConfigSchema,
  test: connectionTestSchema,
})
export type ConnectionTestResponse = z.infer<typeof connectionTestResponseSchema>

/** Réponse de `GET /api/tasks/:id/tools` — les appels d'outils d'une tâche. */
export const toolCallsResponseSchema = z.object({ tool_calls: z.array(toolCallSchema) })
export type ToolCallsResponse = z.infer<typeof toolCallsResponseSchema>

/** Réponse de `GET /api/pricing`. */
export const pricingResponseSchema = z.object({ pricing: pricingTableSchema })
export type PricingResponse = z.infer<typeof pricingResponseSchema>

/** Réponse de `GET /api/tasks/:id/wait`. */
export const waitResponseSchema = taskViewSchema.extend({
  waited_ms: z.number().int().min(0),
})
export type WaitResponse = z.infer<typeof waitResponseSchema>

// --- WebSocket -------------------------------------------------------------

/**
 * Sous-protocole WebSocket. Les navigateurs ne permettent pas de poser un
 * en-tête `Authorization` sur une connexion WebSocket : le jeton passe donc par
 * le sous-protocole, seul champ que l'API du navigateur laisse remplir.
 */
export const WS_SUBPROTOCOL = 'midgaard.v1'
/** Préfixe du second sous-protocole, qui porte le jeton : `midgaard-token.<jeton>`. */
export const WS_TOKEN_PREFIX = 'midgaard-token.'

/**
 * Messages envoyés par le daemon au dashboard.
 *
 * `snapshot` est toujours le premier : il porte l'état complet des tâches et les
 * événements manqués depuis le `since` demandé. `event` suit en temps réel.
 * Le client retient `seq` et le renvoie à la reconnexion — c'est ce qui garantit
 * qu'une coupure ne laisse pas de trou dans la timeline.
 */
export type ServerMessage =
  | {
      type: 'snapshot'
      /** Dernière séquence globale connue du serveur au moment du snapshot. */
      seq: number
      tasks: z.infer<typeof taskSchema>[]
      approvals: z.infer<typeof approvalSchema>[]
      /** Événements d'après le `since` demandé, dans l'ordre. Vide à la première connexion. */
      events: z.infer<typeof taskEventSchema>[]
      /** Vrai si `since` était trop ancien pour être rejoué : le client doit repartir du snapshot. */
      truncated: boolean
      health: Health
    }
  | { type: 'event'; event: z.infer<typeof taskEventSchema>; task: z.infer<typeof taskSchema> }
  | { type: 'approval'; approval: z.infer<typeof approvalSchema> }
  | { type: 'health'; health: Health }

/** Messages envoyés par le dashboard au daemon. Le ping sert à garder la connexion vivante. */
export type ClientMessage = { type: 'ping' }

/**
 * Nombre maximal d'événements rejoués lors d'une reprise. Au-delà, le serveur
 * répond `truncated: true` plutôt que de déverser tout le journal : le client
 * repart alors du snapshot, qui est de toute façon complet pour l'état courant.
 */
export const MAX_REPLAY_EVENTS = 2000
