/**
 * @file Profils d'agents exécutants : qui exécute, avec quel modèle et quels
 * outils.
 *
 * Un profil ne porte **aucune limite** (décision de l'auteur, 2026-11-11) :
 * ni étapes, ni budget, ni délai. Une tâche s'arrête sur son résultat, une
 * annulation ou un refus du fournisseur ; un plafond de dépense se pose chez
 * le fournisseur. Voir {@link MAX_OUTPUT_TOKENS} pour le seul réglage d'appel
 * qui reste.
 *
 * Le profil `simulated` de la Slice 1 est conservé : il fait tourner la machine
 * à états, les approbations et l'attente bloquante sans appeler le moindre
 * modèle, donc sans dépenser un centime. C'est le seul moyen d'exercer le
 * harness lui-même en intégration continue.
 */
import { z } from 'zod'

/**
 * Profils livrés. `developer` (Slice 3) est le seul qui écrit — dans un
 * worktree Git créé pour la tâche, jamais dans le dépôt de l'utilisateur.
 *
 * `orchestrator` (Slice 5) délègue aux autres profils depuis le daemon, sur
 * n'importe quel modèle. Il ne lit que le projet, n'écrit rien, ne lance rien,
 * et ne se lance que du dashboard : le serveur MCP ne le montre pas à Claude.
 *
 * `navigator` (Slice 7) se sert du navigateur isolé, sous session approuvée.
 * Il lit le projet, n'écrit rien et ne lance rien ; sans modèle qui lit les
 * images, il est refusé avec son motif.
 */
export const AGENT_KINDS = ['simulated', 'researcher', 'developer', 'orchestrator', 'navigator'] as const
export type AgentKind = (typeof AGENT_KINDS)[number]

/** Identifiant du profil simulé, réservé : aucun fournisseur, aucun coût. */
export const SIMULATED_AGENT_ID = 'simulated'

/**
 * Jetons de sortie demandés au fournisseur à chaque appel de modèle.
 *
 * Ce n'est pas un plafond de tâche : l'API des fournisseurs veut une valeur,
 * et celle-ci est large — le contenu d'un `write_file` est payé en jetons de
 * sortie. **Midgaard ne borne plus une tâche** : ni étapes, ni budget, ni
 * délai (décision de l'auteur, 2026-11-11). Une tâche s'arrête sur son
 * résultat, sur une annulation, ou quand le fournisseur refuse — c'est chez
 * lui que se règle un plafond de dépense. Le coût reste mesuré et affiché.
 */
export const MAX_OUTPUT_TOKENS = 16_384

/** Un profil d'agent, tel que le daemon le stocke et l'expose à Claude. */
export const agentSchema = z.object({
  id: z.string().min(1).max(64).regex(/^[a-z0-9][a-z0-9_-]*$/, 'minuscules, chiffres, tiret ou souligné'),
  name: z.string().min(1).max(200),
  kind: z.enum(AGENT_KINDS),
  /** Ce que l'agent sait faire, en une phrase. C'est ce que Claude lit pour choisir. */
  description: z.string().max(500),
  /** Fournisseur employé ; `null` pour `simulated`, qui n'appelle aucun modèle. */
  provider_id: z.string().nullable(),
  /** Modèle employé ; `null` = celui par défaut du fournisseur. */
  model: z.string().nullable(),
  /** Consigne système du profil. Le contexte de la tâche vient de Claude, pas d'ici. */
  system_prompt: z.string(),
  /** Outils autorisés, par nom. Tout outil absent de cette liste est refusé, approbation ou pas. */
  tools: z.array(z.string()),
  /** Un profil désactivé reste visible et consultable, mais refuse les délégations. */
  enabled: z.boolean(),
  /**
   * Déclaration de l'utilisateur : le modèle de ce profil lit les images
   * (Slice 7). `null` tant que rien n'est déclaré. Ne sert que lorsque le
   * fournisseur ne publie pas la capacité ; le catalogue, quand il la publie,
   * l'emporte (docs/SLICE7.md, décision 2). Effacée quand le modèle change :
   * elle portait sur l'ancien.
   */
  vision: z.boolean().nullable(),
  /**
   * Serveurs MCP dont les agents de ce profil reçoivent les outils (Slice 8),
   * par identifiant. Posés par l'humain (`PUT /api/agents/:id/mcp`), jamais par
   * un agent ; vides pour l'orchestrateur, qui délègue à un profil qui les a
   * au lieu de les appeler (docs/SLICE8.md, décision 11).
   */
  mcp_servers: z.array(z.string()),
  /**
   * Pourquoi le profil ne peut pas recevoir de tâche, calculé par le daemon à
   * la lecture (Slice 7) ; `null` s'il le peut. Absent d'un profil lu en base :
   * ce n'est pas une colonne. Un profil peut être activé et refusé quand même —
   * un Navigator dont le modèle ne lit pas les images.
   */
  disabled_reason: z.string().nullable().optional(),
  created_at: z.iso.datetime(),
  updated_at: z.iso.datetime(),
})
export type Agent = z.infer<typeof agentSchema>

/**
 * Corps de `PATCH /api/agents/:id` : le fournisseur et le modèle d'un profil.
 *
 * **Rien d'autre ne se règle ici.** Les consignes et les outils appartiennent au harness, qui les réécrit à
 * chaque démarrage.
 *
 * Changer de fournisseur sans dire de modèle remet le modèle à `null` (celui
 * par défaut du nouveau fournisseur) : un nom de modèle n'a de sens que chez
 * un fournisseur, et le garder ferait échouer la tâche suivante sur un modèle
 * inconnu.
 */
export const updateAgentRequestSchema = z
  .object({
    /** Fournisseur déclaré, par identifiant. */
    provider_id: z.string().min(1).max(64).optional(),
    /** Modèle employé ; `null` = celui par défaut du fournisseur. */
    model: z.string().trim().min(1).max(200).nullable().optional(),
    /** Le modèle lit les images (Slice 7) ; `null` retire la déclaration. */
    vision: z.boolean().nullable().optional(),
  })
  // Un corps vide n'est pas une erreur de forme, mais il ne demande rien :
  // l'accepter laisserait croire qu'un réglage a été pris en compte.
  .refine((b) => b.provider_id !== undefined || b.model !== undefined || b.vision !== undefined, {
    message: 'provider_id, model ou vision est requis',
  })
export type UpdateAgentRequest = z.infer<typeof updateAgentRequestSchema>

/**
 * Types de base qu'un orchestrateur peut donner à un agent qu'il crée (Slice 8,
 * décision 12). Jamais `orchestrator` (profondeur 1), jamais `simulated`.
 */
export const CREATABLE_BASES = ['researcher', 'developer', 'navigator'] as const
export type CreatableBase = (typeof CREATABLE_BASES)[number]

/**
 * Un agent créé à la volée par un orchestrateur (Slice 8, étape 4).
 *
 * Il n'est pas un profil : il appartient à **un** arbre de tâches (`task_id`,
 * l'orchestrateur qui l'a créé), et n'apparaît ni dans `GET /api/agents` ni à
 * Claude. Il **dérive** d'un profil livré (`base_agent_id`), dont il garde les
 * outils et la consigne ; ce qu'il change ne fait que restreindre ou préciser
 * (décision 13) : un modèle d'un fournisseur configuré, une consigne de rôle
 * **ajoutée** à celle du profil, des limites abaissées, un sous-ensemble des
 * serveurs MCP du profil.
 */
export const createdAgentSchema = z.object({
  id: z.string().min(1).max(64),
  /** La tâche orchestrateur qui l'a créé : il ne sert que dans son arbre. */
  task_id: z.string(),
  name: z.string().min(1).max(60),
  base_agent_id: z.enum(CREATABLE_BASES),
  provider_id: z.string(),
  /** `null` : celui par défaut du fournisseur. */
  model: z.string().nullable(),
  /** Consigne de rôle, écrite par l'orchestrateur, **ajoutée** à celle du profil. */
  role: z.string(),
  mcp_servers: z.array(z.string()),
  created_at: z.iso.datetime(),
})
export type CreatedAgent = z.infer<typeof createdAgentSchema>

/**
 * Corps de `PUT /api/agents/:id/mcp` : la liste **complète** des serveurs MCP
 * d'un profil (Slice 8). Une route à part du `PATCH` : celui-ci porte sur le
 * modèle, et ses règles (un fournisseur est requis) n'ont rien à voir avec
 * celles-ci.
 */
export const setAgentMcpRequestSchema = z.object({
  servers: z.array(z.string().min(1).max(64)).max(8),
})
export type SetAgentMcpRequest = z.infer<typeof setAgentMcpRequestSchema>
