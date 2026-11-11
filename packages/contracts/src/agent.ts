/**
 * @file Profils d'agents exécutants : qui exécute, avec quel modèle, quels
 * outils et quelles limites.
 *
 * Un profil répond à trois questions, et les limites sont la troisième **parce
 * qu'elles sont une propriété du profil, pas une option de l'appel**. Si Claude
 * pouvait fixer le budget à chaque délégation, le budget ne protégerait plus
 * personne : il suffirait d'un modèle mal luné pour demander mille dollars. Une
 * délégation peut seulement **abaisser** les limites de son profil, jamais les
 * relever — voir {@link tightenLimits}.
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
 * Limites d'exécution. Chacune arrête la tâche **avant** l'appel qui les
 * dépasserait, jamais après : une limite constatée après coup a déjà été payée.
 */
export const agentLimitsSchema = z.object({
  /** Itérations de boucle, donc appels modèle au maximum. Garde-fou contre une boucle d'outils sans fin. */
  max_steps: z.number().int().min(1).max(100),
  /** Budget en dollars. Dépassement = statut `budget_exceeded`, pas `failed` : rien n'a échoué. */
  max_cost_usd: z.number().min(0).max(1000),
  /** Durée totale de la tâche, approbations comprises. */
  timeout_s: z.number().int().min(5).max(3600),
  /** Jetons de sortie par appel, transmis au fournisseur. Borne le coût d'une seule réponse. */
  max_output_tokens: z.number().int().min(64).max(200_000),
  /** Appels d'outils par itération. Les fournisseurs savent en demander plusieurs à la fois. */
  max_tool_calls_per_step: z.number().int().min(1).max(20),
})
export type AgentLimits = z.infer<typeof agentLimitsSchema>

/**
 * Limites par défaut d'un Researcher.
 *
 * Volontairement basses. Une première exécution qui coûte deux centimes et
 * s'arrête trop tôt s'ajuste ; une première exécution qui coûte vingt dollars ne
 * se rattrape pas. L'utilisateur relève ce qu'il veut, en connaissance de cause.
 */
export const DEFAULT_RESEARCHER_LIMITS: AgentLimits = Object.freeze({
  max_steps: 12,
  max_cost_usd: 0.5,
  timeout_s: 300,
  max_output_tokens: 4096,
  max_tool_calls_per_step: 5,
})

/**
 * Limites par défaut d'un Developer.
 *
 * Plus larges que celles du Researcher, pour trois raisons mesurables : écrire
 * du code demande de lire, modifier puis vérifier (plus d'étapes) ; le contenu
 * d'un `write_file` est payé en jetons de **sortie** (plafond par réponse plus
 * haut) ; et chaque `exec` peut attendre une approbation humaine jusqu'à dix
 * minutes, que le délai total compte. Elles restent un plafond que
 * l'utilisateur relève en connaissance de cause.
 */
export const DEFAULT_DEVELOPER_LIMITS: AgentLimits = Object.freeze({
  max_steps: 30,
  max_cost_usd: 1,
  timeout_s: 1800,
  max_output_tokens: 8192,
  max_tool_calls_per_step: 5,
})

/**
 * Limites par défaut d'un orchestrateur. Elles ne comptent que **ses propres**
 * appels : chaque sous-tâche a le budget de son profil (Slice 5, budgets
 * séparés).
 *
 *  - **le délai est le maximum permis** : l'orchestrateur attend ses
 *    sous-tâches, approbations humaines comprises, et un seul Developer a
 *    trente minutes ;
 *  - **étapes et appels par étape restent modestes**, parce que leur produit
 *    est le plafond théorique de l'arbre : un orchestrateur ne peut pas lancer
 *    plus de `max_steps × max_tool_calls_per_step` sous-tâches. 16 × 4 = 64,
 *    affiché comme tel au dashboard ;
 *  - **le budget est bas** : planifier, déléguer et synthétiser demande peu de
 *    jetons. Ce qui coûte, ce sont les sous-tâches, qui ont chacune le leur.
 */
export const DEFAULT_ORCHESTRATOR_LIMITS: AgentLimits = Object.freeze({
  max_steps: 16,
  max_cost_usd: 0.5,
  timeout_s: 3600,
  max_output_tokens: 4096,
  max_tool_calls_per_step: 4,
})

/**
 * Limites par défaut d'un Navigator (Slice 7).
 *
 *  - **des étapes** : une page se lit en plusieurs captures, un formulaire en
 *    plusieurs clics et saisies ;
 *  - **le budget du Researcher** : chaque étape porte une capture, environ un
 *    millier de jetons d'entrée relevés à l'étape 1, et la boucle n'en garde
 *    qu'une — le coût croît avec les étapes, pas avec leur carré ;
 *  - **trente minutes** : la durée maximale d'une session de navigateur, que
 *    l'échéance de la tâche borne de toute façon ;
 *  - **trois appels par étape** : agir, puis regarder ce que l'action a fait.
 */
export const DEFAULT_NAVIGATOR_LIMITS: AgentLimits = Object.freeze({
  max_steps: 30,
  max_cost_usd: 0.5,
  timeout_s: 1800,
  max_output_tokens: 4096,
  max_tool_calls_per_step: 3,
})

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
  limits: agentLimitsSchema,
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
 * Limites effectives d'une délégation : celles du profil, abaissées par celles
 * que Claude demande.
 *
 * **Jamais relevées.** C'est l'invariant du budget : le profil est le plafond,
 * l'appel ne peut que serrer. Une demande plus large n'est pas une erreur — elle
 * est simplement sans effet, et l'interface montre la limite réellement
 * appliquée.
 *
 * @param base    limites du profil
 * @param asked   limites demandées à la délégation ; chaque champ est facultatif
 * @returns les limites à appliquer
 *
 * @example
 * tightenLimits({ max_cost_usd: 0.5, ... }, { max_cost_usd: 5 }).max_cost_usd // 0.5
 * tightenLimits({ max_cost_usd: 0.5, ... }, { max_cost_usd: 0.1 }).max_cost_usd // 0.1
 */
export function tightenLimits(base: AgentLimits, asked: Partial<AgentLimits> = {}): AgentLimits {
  const floor = (a: number, b: number | undefined) => (b === undefined ? a : Math.min(a, b))
  return {
    max_steps: floor(base.max_steps, asked.max_steps),
    max_cost_usd: floor(base.max_cost_usd, asked.max_cost_usd),
    timeout_s: floor(base.timeout_s, asked.timeout_s),
    max_output_tokens: floor(base.max_output_tokens, asked.max_output_tokens),
    max_tool_calls_per_step: floor(base.max_tool_calls_per_step, asked.max_tool_calls_per_step),
  }
}

/** Limites qu'une délégation peut demander. Toutes facultatives, toutes abaissantes. */
export const requestedLimitsSchema = agentLimitsSchema.partial()
export type RequestedLimits = z.infer<typeof requestedLimitsSchema>

/**
 * Corps de `PATCH /api/agents/:id` : le fournisseur et le modèle d'un profil.
 *
 * **Rien d'autre ne se règle ici.** Les limites ont leur route à elles
 * (`PUT /api/agents/:id/limits`, Slice 8) : glissées dans ce corps, elles sont
 * ignorées, pour qu'un réglage de modèle ne relève jamais un budget en passant.
 * Les consignes et les outils appartiennent au harness, qui les réécrit à
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
 * Corps de `PUT /api/agents/:id/limits` : les limites d'un profil, réglées par
 * l'humain (Slice 8, décision de l'auteur du 2026-11-05).
 *
 * **Ce qui revient sur la Slice 5.** Les limites étaient hors de l'API : le
 * dashboard est servi à tout onglet qui passe l'enveloppe, et un budget qu'un
 * client pourrait relever ne protégerait personne. Mais personne ne pouvait
 * plus les régler du tout, et un premier appel Ghidra (jusqu'à 330 s) dépasse
 * le délai du Researcher. L'auteur a choisi une route, utilisable par la CLI et
 * le dashboard, avec ces garde-fous :
 *
 *  - une route **à part** du `PATCH` du modèle, qui continue d'ignorer des
 *    limites glissées dans son corps ;
 *  - les **bornes** de {@link agentLimitsSchema}, sur chaque valeur ;
 *  - une **confirmation** avant tout relèvement, côté CLI et dashboard ;
 *  - chaque changement **journalisé**, valeurs d'avant et d'après, et son
 *    auteur ; seules les tâches **suivantes** sont concernées — une tâche
 *    garde les limites de sa création.
 *
 * Partiel : seules les limites données changent. Un corps vide est refusé.
 */
export const setAgentLimitsRequestSchema = agentLimitsSchema
  .partial()
  .extend({ by: z.string().min(1).max(64).default('api') })
  .refine((b) => Object.keys(b).some((k) => k !== 'by' && b[k as keyof typeof b] !== undefined), {
    message: 'au moins une limite est requise',
  })
export type SetAgentLimitsRequest = z.infer<typeof setAgentLimitsRequestSchema>

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
  limits: agentLimitsSchema,
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
