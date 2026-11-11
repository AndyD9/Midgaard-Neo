/**
 * @file Serveurs MCP déclarés par l'humain (Slice 8, étape 2) : leur
 * déclaration, leur catalogue constaté, et les outils cochés « libres ».
 *
 * ## Ce que l'humain déclare, ce que le daemon constate
 *
 * La **déclaration** dit comment lancer le serveur : programme absolu,
 * arguments, variables d'environnement. Elle ne dit rien de ses outils. Le
 * **catalogue** est ce que le serveur a réellement annoncé au dernier « Tester
 * la connexion » (`tools/list`) : on ne décrit à personne un outil qu'on n'a
 * pas lu chez le serveur (docs/SLICE8.md, décision 4).
 *
 * ## Cocher un outil, c'est cocher ce qu'on a lu
 *
 * Un outil coché enregistre l'**empreinte** de ce que l'humain avait sous les
 * yeux : nom, titre, description, schéma d'entrée et annotations. Si le
 * serveur change l'un d'eux — une mise à jour de REA, ou un serveur qui
 * réécrit sa description pour détourner un modèle —, l'empreinte ne
 * correspond plus et l'outil n'est **plus libre** : il redemande une
 * approbation à chaque appel jusqu'à ce que l'humain le recoche (décision 5).
 * Les annotations en font partie parce que l'humain s'est appuyé dessus pour
 * cocher : un outil qui cesse de se dire « lecture seule » a changé.
 *
 * Le schéma de **sortie** n'en fait pas partie : il ne change ni ce que le
 * modèle lit pour décider d'appeler, ni ce que l'appel a le droit de faire.
 *
 * ## Les secrets ne sont pas ici
 *
 * Une variable d'environnement **secrète** (un jeton qu'un serveur exigerait)
 * n'est jamais en base : la déclaration n'en garde que le **nom**, la valeur
 * va au coffre, comme la clé d'un fournisseur. Les variables ordinaires, elles,
 * sont en clair — c'est dit à l'humain qui les déclare.
 */
import { createHash } from 'node:crypto'
import { z } from 'zod'
import { canonicalJson } from './approvals.ts'

/**
 * Identifiant d'un serveur : minuscules, chiffres, tiret. **Pas de souligné** :
 * un outil MCP devient `<serveur>__<outil>` (décision 9), et un identifiant
 * qui contiendrait `__` rendrait le découpage ambigu. **Une lettre en tête**
 * (Slice 8, étape 3) : Gemini refuse un nom de fonction qui commence par un
 * chiffre, et c'est l'identifiant qui ouvre le nom de chaque outil.
 */
export const MCP_SERVER_ID_PATTERN = /^[a-z][a-z0-9-]{0,31}$/

/** Nom d'une variable d'environnement : ce que tous les shells acceptent. */
export const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/

/** Transports pris en charge. stdio seulement pour l'instant (décision 2). */
export const MCP_TRANSPORTS = ['stdio'] as const
export type McpTransport = (typeof MCP_TRANSPORTS)[number]

/**
 * Ce que vaut un outil du catalogue pour un agent :
 *  - `allowed` : coché, et l'empreinte correspond — appelé sans approbation ;
 *  - `changed` : coché, mais le serveur l'annonce autrement qu'au moment où
 *    l'humain l'a coché — approuvé à chaque appel, comme s'il ne l'était pas ;
 *  - `approval` : jamais coché — approuvé à chaque appel.
 */
export const MCP_TOOL_STATUSES = ['allowed', 'changed', 'approval'] as const
export type McpToolStatus = (typeof MCP_TOOL_STATUSES)[number]

/** Un outil tel que le serveur l'a annoncé, et son empreinte. */
export const mcpToolSchema = z.object({
  name: z.string().min(1),
  title: z.string().nullable(),
  description: z.string(),
  /** Schéma JSON des arguments, tel quel : c'est ce que le modèle lira. */
  input_schema: z.record(z.string(), z.unknown()),
  /** `readOnlyHint`, `destructiveHint`… — des **indications** du serveur, jamais une autorisation. */
  annotations: z.record(z.string(), z.unknown()).nullable(),
  /** SHA-256 de ce qui précède, voir {@link mcpToolFingerprint}. */
  fingerprint: z.string().regex(/^[0-9a-f]{64}$/),
})
export type McpTool = z.infer<typeof mcpToolSchema>

/** Le dernier « Tester la connexion » d'un serveur. */
export const mcpTestSchema = z.object({
  /** Vrai seulement si le serveur a terminé `initialize` **et** rendu son catalogue. */
  ok: z.boolean(),
  /** Ce qui s'est passé, en clair, **expurgé** des secrets déclarés. */
  detail: z.string(),
  at: z.iso.datetime(),
  latency_ms: z.number().int().min(0).nullable(),
  /** Nom et version annoncés à `initialize`. */
  server: z.object({ name: z.string(), version: z.string() }).nullable(),
  /** Nombre d'outils annoncés. */
  tools: z.number().int().min(0),
})
export type McpTest = z.infer<typeof mcpTestSchema>

/** Un serveur MCP déclaré, tel que le daemon le stocke. Ne contient **aucun secret**. */
export const mcpServerSchema = z.object({
  id: z.string().regex(MCP_SERVER_ID_PATTERN, 'une lettre minuscule, puis minuscules, chiffres ou tiret, 32 caractères au plus'),
  name: z.string().min(1).max(200),
  transport: z.enum(MCP_TRANSPORTS),
  /** Programme **absolu**, jamais résolu par le `PATH`. */
  command: z.string().min(1),
  args: z.array(z.string()),
  /** Variables ordinaires, en clair. */
  env: z.record(z.string(), z.string()),
  /** **Noms** des variables secrètes ; leurs valeurs sont au coffre. */
  secret_env: z.array(z.string()),
  created_at: z.iso.datetime(),
  updated_at: z.iso.datetime(),
  /** `null` tant qu'aucun test n'a été lancé — et on ne prétend pas que ça marche. */
  last_test: mcpTestSchema.nullable(),
})
export type McpServer = z.infer<typeof mcpServerSchema>

/** Un outil du catalogue, et ce qu'il vaut pour un agent. */
export const mcpCatalogEntrySchema = mcpToolSchema.extend({
  status: z.enum(MCP_TOOL_STATUSES),
  /** Qui l'a coché, et quand ; `null` s'il ne l'est pas. */
  allowed_by: z.string().nullable(),
  allowed_at: z.iso.datetime().nullable(),
})
export type McpCatalogEntry = z.infer<typeof mcpCatalogEntrySchema>

/** Un outil coché dont le serveur n'annonce plus le nom : il ne sert plus, mais l'humain doit le voir. */
export const mcpMissingToolSchema = z.object({
  name: z.string(),
  allowed_by: z.string(),
  allowed_at: z.iso.datetime(),
})

/**
 * Un serveur avec son catalogue : ce que montrent la CLI et le dashboard.
 * `tools` est vide tant qu'aucun test n'a réussi.
 */
export const mcpServerViewSchema = mcpServerSchema.extend({
  /** Date du catalogue affiché ; `null` s'il n'y en a pas. */
  catalog_at: z.iso.datetime().nullable(),
  tools: z.array(mcpCatalogEntrySchema),
  /** Outils cochés que le dernier catalogue ne contient plus. */
  missing: z.array(mcpMissingToolSchema),
})
export type McpServerView = z.infer<typeof mcpServerViewSchema>

/** Réponse de `GET /api/mcp`. */
export const mcpServersResponseSchema = z.object({ servers: z.array(mcpServerViewSchema) })
export type McpServersResponse = z.infer<typeof mcpServersResponseSchema>

/** Réponse de `GET /api/mcp/:id`, `POST /api/mcp`, `…/test`, `…/allow`, `…/revoke`. */
export const mcpServerResponseSchema = z.object({ server: mcpServerViewSchema })
export type McpServerResponse = z.infer<typeof mcpServerResponseSchema>

/**
 * Corps de `POST /api/mcp` : déclaration ou mise à jour d'un serveur.
 *
 * `secret_env` est la liste **complète** des noms de variables secrètes ;
 * `secrets` porte les valeurs nouvelles ou remplacées, et n'y fait que
 * passer : elles partent au coffre. Un nom de `secret_env` sans valeur doit
 * déjà être au coffre ; un nom retiré de la liste en est effacé.
 */
export const upsertMcpServerRequestSchema = z.object({
  id: z.string().regex(MCP_SERVER_ID_PATTERN, 'une lettre minuscule, puis minuscules, chiffres ou tiret, 32 caractères au plus'),
  name: z.string().min(1).max(200).optional(),
  command: z.string().min(1).max(4096),
  args: z.array(z.string().max(4096)).max(64).default([]),
  env: z.record(z.string().regex(ENV_NAME_PATTERN), z.string().max(4096)).default({}),
  secret_env: z.array(z.string().regex(ENV_NAME_PATTERN)).max(16).default([]),
  secrets: z.record(z.string().regex(ENV_NAME_PATTERN), z.string().min(1).max(4096)).default({}),
})
export type UpsertMcpServerRequest = z.infer<typeof upsertMcpServerRequestSchema>

/** Corps de `POST /api/mcp/:id/allow` et `…/revoke` : des noms d'outils exacts. */
export const mcpAllowRequestSchema = z.object({
  tools: z.array(z.string().min(1).max(200)).min(1).max(1000),
  by: z.string().min(1).max(64).default('cli'),
})
export type McpAllowRequest = z.infer<typeof mcpAllowRequestSchema>

/**
 * Empreinte d'un outil : SHA-256 du JSON **canonique** de son nom, son titre,
 * sa description, son schéma d'entrée et ses annotations. Canonique, pour
 * qu'un serveur qui rend les mêmes clés dans un autre ordre ne change pas
 * d'empreinte ; et un champ absent vaut `null`, pour qu'un titre ajouté la
 * change.
 *
 * @param tool l'outil tel que le serveur l'annonce
 * @returns 64 caractères hexadécimaux
 */
export function mcpToolFingerprint(tool: {
  name: string
  title?: string | null | undefined
  description?: string | null | undefined
  input_schema: unknown
  annotations?: unknown
}): string {
  const seen = {
    name: tool.name,
    title: tool.title ?? null,
    description: tool.description ?? null,
    input_schema: tool.input_schema ?? null,
    annotations: tool.annotations ?? null,
  }
  return createHash('sha256').update(canonicalJson(seen)).digest('hex')
}

/**
 * Ce que vaut chaque outil d'un catalogue, au vu de ceux que l'humain a cochés.
 *
 * @param catalog outils annoncés au dernier test réussi
 * @param allowed outils cochés, avec l'empreinte de ce que l'humain a lu
 * @returns le catalogue annoté, et les outils cochés qu'il ne contient plus
 */
export function mcpCatalogStatus(
  catalog: readonly McpTool[],
  allowed: readonly { tool_name: string; fingerprint: string; added_by: string; added_at: string }[],
): { tools: McpCatalogEntry[]; missing: z.infer<typeof mcpMissingToolSchema>[] } {
  const byName = new Map(allowed.map((a) => [a.tool_name, a]))
  const tools = catalog.map((t): McpCatalogEntry => {
    const a = byName.get(t.name)
    return {
      ...t,
      status: !a ? 'approval' : a.fingerprint === t.fingerprint ? 'allowed' : 'changed',
      allowed_by: a?.added_by ?? null,
      allowed_at: a?.added_at ?? null,
    }
  })
  const announced = new Set(catalog.map((t) => t.name))
  const missing = allowed
    .filter((a) => !announced.has(a.tool_name))
    .map((a) => ({ name: a.tool_name, allowed_by: a.added_by, allowed_at: a.added_at }))
  return { tools, missing }
}
