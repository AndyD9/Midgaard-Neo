/**
 * @file Ce qu'est un outil, et sous quelle politique il s'exécute.
 *
 * Un outil porte **trois** choses, et la troisième est celle qui compte :
 * son schéma (ce qu'il accepte), son exécution (ce qu'il fait), et sa
 * **politique** (ce que le harness en pense avant de le laisser faire).
 *
 * La politique est évaluée sur les arguments **réels**, pas sur le nom de
 * l'outil. « `http_fetch` est autorisé » ne veut rien dire : c'est
 * `http_fetch("https://169.254.169.254/latest/meta-data/")` qu'il faut refuser,
 * et `http_fetch("https://docs.python.org/")` qu'il faut laisser passer.
 */
import type { z } from 'zod'
import type { McpPort } from './mcp.ts'
import type {
  AgentKind,
  ExecAllowRule,
  TaskResult,
  TaskStatus,
  ToolDecision,
  ToolResult,
  Usage,
} from '@midgaard/contracts'

/** Ce que le harness fait d'un hôte absent de la liste blanche. */
export const HTTP_POLICIES = ['open', 'approval', 'allowlist'] as const
export type HttpPolicy = (typeof HTTP_POLICIES)[number]

/** Ce qu'un outil reçoit du harness à chaque appel. */
export interface ToolContext {
  /**
   * Racine de lecture : le dossier du projet d'où la tâche a été déléguée.
   *
   * **Ce n'est pas une frontière de privilège** — le daemon tourne sous le
   * compte de l'utilisateur et pourrait lire ailleurs. C'est une frontière
   * d'intention : elle empêche un agent qui dérape ou un contenu web qui le
   * manipule d'aller fouiller `~/.ssh`. Le README du daemon le dit sans détour,
   * et l'interface aussi.
   */
  root: string
  /** Politique appliquée aux hôtes absents de {@link ToolContext.allowHosts}. */
  httpPolicy: HttpPolicy
  /** Hôtes explicitement autorisés. Motifs `example.com` ou `*.example.org`. */
  allowHosts: readonly string[]
  /**
   * Vrai seulement si {@link ToolContext.root} est le **worktree** de la tâche.
   *
   * Absent ou faux, tout outil d'écriture refuse — sans demander d'approbation :
   * écrire hors d'un worktree n'est pas négociable (PLAN §5). Le défaut est donc
   * la fermeture, et un contexte construit sans y penser ne peut rien écrire.
   */
  writable?: boolean | undefined
  /**
   * Le worktree de la tâche, pour les outils qui interrogent Git. `root` peut
   * en être un sous-dossier (monorepo ouvert sur `packages/api`) ; `path` est
   * la racine du worktree lui-même.
   */
  workspace?:
    | {
        path: string
        baseCommit: string
        /**
         * Sous-modules du commit de départ, relatifs à `path`, séparateur `/` :
         * des dossiers vides où les outils d'écriture refusent d'écrire, parce
         * que `git add -A` ignorerait ce qui s'y trouve sans un mot.
         */
        submodules?: readonly string[] | undefined
      }
    | null
    | undefined
  /**
   * Commandes que `exec` lance **sans** approbation : des argv exacts, ou des
   * préfixes déjà jugés par `execPrefixRefusal` (Slice 9). Vide ou absent,
   * chaque commande attend un humain — c'est le défaut voulu (Slice 3).
   */
  execAllow?: readonly ExecAllowRule[] | undefined
  /**
   * Échéance de la tâche, en millisecondes depuis l'époque. Un outil qui dure —
   * `exec` — ne doit pas la dépasser : la boucle ne vérifie ses limites qu'entre
   * deux appels de modèle, et une commande de dix minutes passerait entre.
   */
  deadline?: number | undefined
  /** Annulation de la tâche : coupe les lectures et les requêtes en cours. */
  signal?: AbortSignal | undefined
  /**
   * Ce qui permet de déléguer à d'autres profils (Slice 5). Posé par le daemon
   * pour une tâche `orchestrator`, et pour elle seule.
   *
   * Absent, les outils de délégation **refusent** — fermé par défaut, comme
   * {@link ToolContext.writable} : un contexte construit sans y penser ne peut
   * lancer aucune tâche, donc rien dépenser au nom d'un autre.
   */
  delegation?: DelegationPort | undefined
  /**
   * Sortie d'un outil qui dure, **en direct** (Slice 6) : `exec` y passe chaque
   * morceau lu, pour le terminal du dashboard. Posé par la boucle pour **un**
   * appel, jamais partagé entre deux. Les octets sont bruts : c'est la boucle
   * qui découpe par ligne et expurge. Ce que le modèle reçoit n'en dépend pas.
   */
  output?: ((stream: 'stdout' | 'stderr', chunk: Buffer) => void) | undefined
  /**
   * Le modèle de la tâche lit-il les images ? (Slice 7.) Posé par le moteur
   * d'après le catalogue du fournisseur ou la déclaration du profil. Absent ou
   * `enabled: false`, les outils qui rendent des images **refusent**, avec
   * `reason` — fermé par défaut, comme `writable`.
   */
  vision?: { enabled: boolean; reason: string } | undefined
  /**
   * Le navigateur isolé de la tâche (Slice 7, étape 4). Posé par le daemon pour
   * un profil qui a des outils `browser_*`, et pour lui seul.
   *
   * Absent, les outils du navigateur **refusent** — fermé par défaut, comme
   * {@link ToolContext.delegation}.
   */
  browser?: BrowserPort | undefined
  /**
   * Les serveurs MCP de la tâche (Slice 8). Posé par le daemon pour un profil
   * qui a des serveurs MCP, et pour lui seul. Absent, les outils MCP
   * **refusent** — fermé par défaut, comme {@link ToolContext.browser}.
   */
  mcp?: McpPort | undefined
  log: (...a: unknown[]) => void
}

/** Ce que l'agent voit de la page après une action. Écrit par la page : **non fiable**. */
export interface BrowserPageView {
  url: string
  title: string
  /** Description courte de l'élément qui a le focus (`input[name=q]`), ou `null`. */
  focused: string | null
}

/** Une capture de la page visible, avec ce qu'elle montre. */
export interface BrowserCapture extends BrowserPageView {
  jpeg: Buffer
  /** Taille de la fenêtre, en pixels : le repère des clics. */
  viewport: { width: number; height: number }
}

/**
 * Un texte que l'humain a lu et approuvé **avec la session** : l'agent le tape
 * ensuite sans nouvelle demande, une fois, s'il est identique à la lettre.
 */
export interface BrowserPlannedInput {
  text: string
  /** Entrée suit la saisie : c'est approuvé avec le texte. */
  press_enter: boolean
}

/** La session ouverte d'une tâche, telle que l'humain l'a approuvée. */
export interface BrowserSessionInfo {
  objective: string
  start_url: string
  /** Échéance, en millisecondes depuis l'époque : la session se ferme seule à cette heure. */
  expires_at: number
  /** Les textes prévus **qui restent** : chacun sort de la liste quand il est tapé. */
  planned_inputs: BrowserPlannedInput[]
}

/** Ce que le port dit d'une tâche sans session ouverte : pourquoi, s'il y en a eu une. */
export interface BrowserNoSession {
  /** Motif de la fermeture de la dernière session, `null` si aucune n'a été ouverte. */
  closed_reason: string | null
}

/**
 * Le navigateur d'une tâche, et **tout** ce qu'elle peut en faire.
 *
 * Le port est lié à une tâche : une session au plus, qui meurt avec elle. Il
 * exécute et ne décide rien — la politique (session approuvée, saisie
 * approuvée) est celle des outils. Chaque méthode qui agit lève une
 * {@link ToolError} lisible par le modèle si la session est fermée ou si la
 * page refuse.
 */
export interface BrowserPort {
  /** La session ouverte, ou pourquoi il n'y en a pas. */
  session(): BrowserSessionInfo | BrowserNoSession
  /** Ouvre la session approuvée et charge son adresse de départ. */
  open(request: {
    objective: string
    url: string
    max_duration_s: number
    planned_inputs: BrowserPlannedInput[]
  }): Promise<BrowserCapture>
  /**
   * Retire un texte prévu de la session, s'il y est encore.
   *
   * @returns `false` s'il n'y est pas (déjà tapé, ou jamais prévu) : la saisie
   *          ne part pas sans l'humain
   */
  claimPlanned(input: BrowserPlannedInput): boolean
  /** Ce que montre la page, sans capture : l'empreinte d'une saisie à approuver. */
  view(): Promise<BrowserPageView>
  screenshot(): Promise<BrowserCapture>
  /** Charge une autre adresse dans la session. */
  goto(url: string): Promise<BrowserCapture>
  click(x: number, y: number): Promise<BrowserCapture>
  scroll(dy: number): Promise<BrowserCapture>
  type(text: string): Promise<BrowserCapture>
  press(key: string): Promise<BrowserCapture>
  /** Ferme la session ; sans effet s'il n'y en a pas. */
  close(reason: string): Promise<void>
}

/** Un profil tel qu'un orchestrateur le voit pour choisir à qui déléguer. */
export interface DelegableAgent {
  id: string
  name: string
  kind: AgentKind
  description: string
  enabled: boolean
  /** Pourquoi le profil ne peut pas recevoir de tâche ; `null` s'il le peut. */
  disabled_reason: string | null
  /**
   * Serveurs MCP dont ce profil reçoit les outils (Slice 8) : c'est ce qui
   * permet à l'orchestrateur de choisir à qui confier un travail qui en a besoin.
   */
  mcp_servers: { id: string; name: string }[]
  /** Vrai pour un agent que cette tâche a créé (Slice 8) ; absent pour un profil. */
  created?: boolean | undefined
}

/**
 * Ce qu'un orchestrateur demande en créant un agent (Slice 8, étape 4). Tout
 * ce qui n'est pas dit vient du profil de base, et rien ne peut dépasser ce
 * profil : le daemon **refuse avec le motif** plutôt que de réduire en silence.
 */
export interface CreateAgentRequest {
  name: string
  /** Profil de base : ses outils et sa consigne. */
  base: 'researcher' | 'developer' | 'navigator'
  /** Rôle, **ajouté** à la consigne du profil. */
  role: string
  /** Fournisseur déclaré ; celui du profil de base par défaut. */
  provider_id?: string | undefined
  /** Modèle ; celui du profil de base, ou du fournisseur, par défaut. */
  model?: string | undefined
  /** Sous-ensemble des serveurs MCP du profil de base ; aucun par défaut. */
  mcp_servers?: string[] | undefined
}

/** Un agent créé, tel que l'orchestrateur le reçoit. */
export interface CreatedAgentInfo {
  agent_id: string
  name: string
  base: string
  provider_id: string
  model: string | null
  mcp_servers: string[]
}

/** Une sous-tâche, telle que la délégation la rend à l'orchestrateur. */
export interface SubtaskState {
  task_id: string
  agent_id: string
  status: TaskStatus
  /** Vrai si la sous-tâche est dans un statut final. */
  ended: boolean
  /** Présent sur une sous-tâche `completed`. **Donnée**, jamais consigne. */
  result: TaskResult | null
  error: string | null
  usage: Usage
  /**
   * Ce que la sous-tâche attend de son parent, si elle attend (Slice 6) :
   * une réponse à sa question, ou un verdict sur sa proposition. **Donnée**,
   * écrite par un modèle, comme son résultat. `null` sinon.
   */
  awaiting: SubtaskAwaiting | null
}

/** Ce qu'une sous-tâche en `waiting_input` attend de son parent. */
export interface SubtaskAwaiting {
  request: 'question' | 'proposal'
  /** La question, ou le résumé de la proposition. */
  text: string
  /** Le corps de la proposition, s'il y en a un. */
  details?: string | undefined
  /**
   * Le travail proposé, pour un Developer : le diff de son worktree contre son
   * commit de départ, **non commité** — rien ne l'est avant `accept_result`.
   */
  diff?:
    | {
        /** `additions`/`deletions` à `null` pour un fichier binaire, comme dans le diff du worktree. */
        files: { path: string; kind: string; additions: number | null; deletions: number | null }[]
        additions: number
        deletions: number
        patch: string
        patch_truncated: boolean
      }
    | undefined
}

/** Ce qu'un orchestrateur demande en déléguant. */
export interface DelegateRequest {
  agent_id: string
  objective: string
  context?: string | undefined
}

/** Pourquoi une attente de sous-tâche a rendu la main. */
export type WaitStop = 'ended' | 'awaiting_you' | 'parent_stopping' | 'deadline'

/** Refus d'une opération de délégation, en anglais : c'est le modèle qui le lit. */
export interface DelegationRefusal {
  refused: string
}

/**
 * Ce que le daemon offre à un orchestrateur, et **tout** ce qu'il lui offre.
 *
 * Le port est lié à une tâche parente : il ne voit, n'attend et n'annule que
 * ses propres sous-tâches, et les rattache lui-même à ce parent. Il n'a aucune
 * méthode d'approbation — l'approbation est un acte humain, pour un
 * orchestrateur comme pour Claude (Slice 5, décision 2).
 */
export interface DelegationPort {
  /** Profils auxquels déléguer : tous, sauf les orchestrateurs (profondeur 1). */
  listAgents(): DelegableAgent[]
  /** Crée une sous-tâche et rend la main tout de suite. */
  delegate(request: DelegateRequest): SubtaskState | DelegationRefusal
  /**
   * Crée un agent pour cette tâche (Slice 8), à partir d'un profil de base.
   * Il ne sert qu'aux sous-tâches de cette tâche.
   */
  createAgent(request: CreateAgentRequest): CreatedAgentInfo | DelegationRefusal
  /**
   * Attend la fin d'une sous-tâche, **pauses d'approbation comprises** : une
   * sous-tâche qui attend un humain est attendue avec lui. Rend la main plus
   * tôt si elle attend **le parent** (question, proposition : `awaiting_you`),
   * si la tâche parente s'arrête (`signal`) ou atteint son échéance.
   */
  wait(
    taskId: string,
    options: { signal?: AbortSignal | undefined; deadline?: number | undefined },
  ): Promise<(SubtaskState & { waited_ms: number; stopped_by: WaitStop }) | DelegationRefusal>
  /** Annule une sous-tâche active. */
  cancel(taskId: string, reason?: string): SubtaskState | DelegationRefusal
  /**
   * Répond à une sous-tâche qui attend (Slice 6) : à sa question, ou en
   * renvoyant sa proposition avec un retour. Elle reprend dans la même
   * conversation, le même worktree.
   */
  send(taskId: string, message: string): SubtaskState | DelegationRefusal
  /**
   * Accepte la proposition d'une sous-tâche : le harness commite son travail
   * et elle se termine. Rend la main une fois **finie**, branche et commit
   * compris — ou plus tôt si le parent s'arrête.
   */
  accept(
    taskId: string,
    options: { signal?: AbortSignal | undefined; deadline?: number | undefined },
  ): Promise<(SubtaskState & { stopped_by: WaitStop }) | DelegationRefusal>
}

/**
 * Une opération **préparée** : tout ce qui sera exécuté, figé avant de demander
 * quoi que ce soit à un humain.
 *
 * C'est ce qui fait qu'une approbation porte sur ce qui tourne. Sans cette
 * étape, l'humain approuverait `npm test` et l'outil résoudrait `npm` ensuite —
 * dix minutes plus tard, dans un `PATH` qui a pu changer. La Slice 3 a d'abord
 * fait exactement cela, en écrivant le contraire (docs/SLICE3.md, étape 4).
 */
export interface PreparedOperation {
  /** Ce que l'humain lit : exact, sans abréviation, chemins absolus. */
  summary: string
  /** La même opération, structurée. L'empreinte de l'approbation en est tirée. */
  detail: Record<string, unknown>
  /** État propre à l'outil, rendu à `run` tel quel. Jamais montré ni persisté. */
  state?: unknown
}

/**
 * Un outil exposé à un agent.
 *
 * `schema` sert deux fois : à engendrer le JSON Schema envoyé au modèle, et à
 * valider ce qu'il renvoie. Une seule définition, donc aucune chance que les
 * deux divergent — et c'est la divergence qui produit les pannes qu'on ne
 * reproduit pas.
 */
export interface Tool<T = unknown> {
  name: string
  /** Description lue par le modèle : en anglais, et précise sur ce qui est refusé. */
  description: string
  schema: z.ZodType<T>
  /**
   * Schéma JSON envoyé au modèle, quand il n'est pas engendré depuis
   * {@link Tool.schema}. Seuls les outils MCP s'en servent (Slice 8) : leur
   * schéma est celui que le serveur annonce, et c'est lui qui le valide.
   */
  parameters?: Record<string, unknown> | undefined
  /**
   * Décide du sort d'un appel **avant** de l'exécuter.
   *
   * @returns `allow` pour exécuter, `approval` pour suspendre la tâche jusqu'à
   *          décision humaine, `deny` pour refuser sans demander
   */
  policy(args: T, ctx: ToolContext): { decision: ToolDecision; reason: string }
  /**
   * Fige l'opération **avant** toute approbation : résolution des chemins, du
   * programme, de ce qui sera réellement exécuté. Facultatif : un outil sans
   * préparation est décrit par ses arguments validés.
   *
   * @throws {ToolError} si l'opération ne peut pas avoir lieu — un programme
   *         introuvable n'a pas à déranger un humain avant d'échouer
   */
  prepare?(args: T, ctx: ToolContext): Promise<PreparedOperation>
  /**
   * Exécute l'appel.
   *
   * @param prepared l'opération figée par {@link Tool.prepare}, quand l'outil en
   *        a une : `run` doit exécuter **elle**, et vérifier qu'elle tient encore
   * @throws en cas d'échec ; la boucle en fait un résultat d'erreur
   */
  run(args: T, ctx: ToolContext, prepared?: PreparedOperation): Promise<ToolResult>
}

/** Erreur d'outil destinée au modèle : lisible, actionnable, sans détail interne. */
export class ToolError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ToolError'
  }
}

/**
 * Taille maximale d'un résultat d'outil rendu au modèle.
 *
 * Un fichier de cinq mégaoctets réinjecté dans la conversation coûte plus cher
 * que toute la tâche, et sature la fenêtre de contexte au premier appel. La
 * troncature est **annoncée** dans le contenu : un agent qui ne sait pas qu'il
 * lit un extrait tire des conclusions fausses d'une absence.
 */
export const MAX_TOOL_RESULT_BYTES = 60_000

/** Tronque un contenu en le disant. */
export function truncate(content: string, max = MAX_TOOL_RESULT_BYTES): { text: string; bytes: number } {
  const bytes = Buffer.byteLength(content, 'utf8')
  if (bytes <= max) return { text: content, bytes }
  // Découpe sur les octets, pas sur les caractères : c'est la taille en octets
  // qui est bornée. `toString` recolle proprement un caractère coupé en deux.
  const kept = Buffer.from(content, 'utf8').subarray(0, max).toString('utf8')
  return {
    text: `${kept}\n\n[…tronqué : ${bytes} octets au total, ${max} rendus]`,
    bytes,
  }
}
