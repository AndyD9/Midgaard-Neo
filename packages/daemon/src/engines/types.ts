/**
 * @file Moteurs de tâches enfichables : ce qui fait réellement avancer une tâche.
 *
 * La Slice 1 avait conçu `TaskManager.tick()` pour être remplacé sans toucher au
 * reste. La Slice 2 encaisse ce pari en coupant la frontière au bon endroit :
 *
 *  - le **gérant** (`TaskManager`) garde tout ce qui ne dépend pas de l'exécutant :
 *    la machine à états, l'attente bloquante, les décisions humaines, les
 *    expirations, l'annulation ;
 *  - le **moteur** décide seulement de ce qui se passe entre le démarrage et la
 *    fin : des étapes minutées pour le simulé, une boucle modèle pour l'agent réel.
 *
 * Il y a donc deux moteurs, et le simulé **reste** : c'est le seul moyen
 * d'exercer la machine à états, les approbations et l'attente longue en
 * intégration continue sans appeler de modèle, donc sans dépenser un centime ni
 * dépendre d'un réseau. Les douze scénarios de bout en bout de la Slice 1
 * continuent de tourner tels quels.
 */
import type { Agent, AgentKind, Approval, HarnessConfig, InputRequest, Task } from '@midgaard/contracts'
import type { HarnessStore } from '@midgaard/persistence'
import type { DelegationPort } from '@midgaard/tools'
import type { EventBus } from '../bus.ts'

/**
 * Ce que le daemon sait de la vue d'un modèle (Slice 7) : lit-il les images,
 * d'où le sait-on, et la phrase qui le dit — en anglais, c'est le modèle qui
 * la lit quand elle motive un refus d'outil.
 */
export interface VisionVerdict {
  enabled: boolean
  /** `catalog` : publié par le fournisseur ; `declared` : déclaré au profil ; `unknown` : ni l'un ni l'autre. */
  source: 'catalog' | 'declared' | 'unknown'
  reason: string
}

/**
 * Ce qu'un moteur emprunte au daemon.
 *
 * Il n'a **pas** accès au dépôt en écriture : toute écriture passe par le bus,
 * sinon un changement d'état échapperait aux long-polls et aux dashboards
 * connectés. C'est l'invariant central de la Slice 1, et un moteur n'y déroge pas.
 */
export interface EngineContext {
  config: HarnessConfig
  /** Lecture seule. Les écritures passent par {@link EngineContext.bus}. */
  store: HarnessStore
  bus: EventBus
  log: (...a: unknown[]) => void
  /**
   * Met la tâche en pause et crée la demande d'approbation correspondante.
   *
   * @param operation ce que l'humain autorise, en clair et sans abréviation
   * @param detail    la même opération, structurée : c'est d'elle que
   *                  l'empreinte est tirée, et elle est conservée avec la demande
   * @param payload   détail joint à l'événement `approval.requested`
   * @returns la demande créée, ou `null` si la tâche n'est plus en état de pauser
   */
  requestApproval(
    taskId: string,
    operation: string,
    detail: Record<string, unknown>,
    payload?: Record<string, unknown>,
  ): Approval | null
  /**
   * Conclut une annulation demandée, quand le moteur atteint un point de
   * contrôle en `cancel_requested`.
   *
   * C'est au moteur de décider **où** est ce point : lui seul sait ce qu'il a en
   * vol. C'est au gérant d'écrire la transition, pour que la machine à états
   * reste en un seul endroit.
   */
  concludeCancellation(taskId: string): void
  /**
   * Met la tâche en attente d'un message (Slice 6) : `running → waiting_input`,
   * avec l'événement `input.requested`.
   *
   * @param text  ce que le destinataire doit lire, **déjà expurgé** ; `null`
   *              pour un chat, dont la réplique est déjà au journal
   * @param extra ce qu'il lit en plus, déjà expurgé : le corps d'une proposition
   * @returns `false` si la tâche n'est plus en état d'attendre (annulée entre-temps)
   */
  requestInput(
    taskId: string,
    request: InputRequest,
    text: string | null,
    step: number,
    extra?: Record<string, unknown>,
  ): boolean
  /**
   * Le budget de l'arbre d'une tâche (Slice 8) : le plafond de l'orchestrateur
   * et ce qu'ont dépensé les **autres** tâches de l'arbre ; `null` hors arbre.
   * Lu avant chaque appel de modèle, comme les limites de la tâche.
   */
  treeBudget(taskId: string): { limit: number; others: number } | null
  /**
   * Le port de délégation d'une tâche `orchestrator` (Slice 5) : ce qu'elle
   * peut déléguer, attendre et annuler, rattaché à elle seule.
   *
   * @param redact l'expurgation de la tâche parente : ce que son modèle écrit
   *               dans une délégation est persisté, et passe donc par elle
   */
  delegationFor(parentTaskId: string, redact: (text: string) => string): DelegationPort
  /**
   * Retient ce que le moteur a constaté de la vue du modèle d'un profil
   * (Slice 7), pour le fournisseur et le modèle **effectifs** : le gérant
   * refuse ensuite un Navigator aveugle dès la création de la tâche, avec son
   * motif, et le montre désactivé.
   */
  noteVision(agentId: string, providerId: string, model: string, verdict: VisionVerdict): void
}

/**
 * Un moteur d'exécution.
 *
 * Toutes les méthodes rendent la main **tout de suite** : un moteur qui bloque
 * bloquerait le daemon entier, long-polls compris. Le travail réel se fait sur
 * minuteur ou en tâche de fond.
 */
export interface TaskEngine {
  /** Profil d'agent que ce moteur sait exécuter. */
  readonly kind: AgentKind
  /** Démarre une tâche fraîchement créée. */
  start(task: Task, agent: Agent): void
  /**
   * Reprend après une approbation accordée.
   * La tâche est déjà repassée en `running` quand cette méthode est appelée.
   */
  resume(task: Task, agent: Agent): void
  /**
   * Remet un message à une tâche en `waiting_input` (Slice 6). Le moteur
   * l'expurge avec le secret connu de la tâche, l'écrit au journal et relance
   * la boucle. Facultatif : un moteur qui ne converse pas ne l'implémente pas.
   *
   * @param kind `message.user` (l'utilisateur) ou `message.agent` (le parent)
   * @returns la tâche relancée, ou `null` si ce moteur n'a pas cette attente en vol
   */
  deliver?(task: Task, text: string, kind: 'message.user' | 'message.agent', payload: Record<string, unknown>): Task | null
  /**
   * Accepte la proposition d'une tâche en revue (Slice 6) : la boucle conclut,
   * et le moteur commite. Facultatif, comme {@link TaskEngine.deliver}.
   *
   * @returns la tâche relancée, ou `null` si ce moteur n'a pas cette attente en vol
   */
  accept?(task: Task, payload: Record<string, unknown>): Task | null
  /**
   * Constate, sans lancer de tâche, si le modèle d'un profil lit les images
   * (Slice 7), et le dit par {@link EngineContext.noteVision}. Facultatif :
   * un moteur sans modèle ne l'implémente pas.
   */
  probeVision?(agent: Agent): Promise<void>
  /**
   * Signale une demande d'annulation.
   *
   * @param approval comment se résout l'approbation que la tâche attend, s'il y
   *                 en a une : `rejected` quand un humain refuse **cette
   *                 opération**, `expired` quand personne n'a décidé à temps,
   *                 `cancelled` (défaut) quand la tâche est arrêtée avant la
   *                 décision — annulation, cascade d'un parent, arrêt. La
   *                 boucle l'écrit au journal de l'appel : une expiration ou une
   *                 cascade inscrite « refusé par un humain » affirmerait une
   *                 décision que personne n'a prise (vu aux essais réels des
   *                 Slices 7 et 8).
   * @returns `true` si le moteur s'est arrêté immédiatement et que le gérant peut
   *          conclure l'annulation ; `false` si l'arrêt sera **coopératif**, au
   *          prochain point de contrôle. Un appel de modèle en cours n'est pas
   *          interrompu : on l'a déjà payé, autant en récupérer le résultat et le
   *          compter.
   */
  cancel(task: Task, approval?: 'rejected' | 'expired' | 'cancelled'): boolean
  /** Arrête tout, sans rien conclure : les tâches en vol seront `interrupted` au prochain démarrage. */
  stop(): void
}
