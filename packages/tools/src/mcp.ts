/**
 * @file Les outils d'un serveur MCP, tels qu'un agent les reçoit (Slice 8,
 * étape 3).
 *
 * Les autres outils de ce paquet sont écrits ici, une fois pour toutes. Ceux-ci
 * sont **construits pour une tâche**, à partir du catalogue que le serveur a
 * annoncé au lancement de cette tâche : leur nom, leur description et leur
 * schéma viennent de lui, pas de Midgaard. D'où quatre règles :
 *
 *  - **un nom préfixé** : `<serveur>__<outil>` (décision 9). Aucun conflit avec
 *    un outil intégré, et le journal dit de quel serveur vient chaque appel. Un
 *    nom qu'un fournisseur de modèle refuserait (point, barre, plus de 64
 *    caractères) est **écarté et dit**, jamais retouché : deux outils retouchés
 *    pourraient finir sous le même nom ;
 *  - **une description signée** : elle est écrite par le serveur et le modèle la
 *    lit comme une consigne de plus. Elle est donc précédée de sa provenance,
 *    bornée en taille, et un outil qui attend un humain le dit ;
 *  - **la liste blanche porte sur ce que l'humain a lu** : un outil n'est libre
 *    que si l'empreinte de ce que le serveur annonce **au lancement de la
 *    tâche** est celle que l'humain a cochée (décision 5). Sinon, chaque appel
 *    est approuvé, sur ses arguments exacts ;
 *  - **tout résultat est non fiable** : encadré par la boucle, et la tâche qui
 *    l'a reçu rend un résultat non fiable (règle de la Slice 5).
 *
 * Les arguments ne sont pas validés ici contre le schéma du serveur : c'est le
 * serveur qui fait autorité sur ses propres arguments, et il les valide. Ici,
 * on n'exige qu'un objet — ce que tout `tools/call` attend.
 */
import { z } from 'zod'
import type { ToolResult } from '@midgaard/contracts'
import { ToolError, truncate, type PreparedOperation, type Tool, type ToolContext } from './types.ts'

/** Ce qui sépare le serveur de l'outil dans un nom : `rea__open_binary`. */
export const MCP_NAME_SEPARATOR = '__'

/**
 * Noms de fonction que les fournisseurs acceptent tous : OpenAI exige
 * `^[a-zA-Z0-9_-]{1,64}$`, Gemini une lettre ou un souligné en tête.
 */
const PROVIDER_SAFE_NAME = /^[A-Za-z_][A-Za-z0-9_-]{0,63}$/

/**
 * Taille maximale de la description d'un outil MCP montrée au modèle. Elle est
 * relue à **chaque** appel de modèle, avec toutes les autres : une description
 * de dix mille caractères coûterait plus que la tâche.
 */
export const MAX_MCP_DESCRIPTION_CHARS = 1_500

/** Délai d'un appel quand la tâche n'a pas d'échéance : celui d'une commande d'`exec`. */
const DEFAULT_MCP_CALL_MS = 10 * 60 * 1000

/** Un outil du catalogue d'un serveur, tel que constaté au lancement de la tâche. */
export interface McpToolDescriptor {
  /** Identifiant du serveur déclaré, par exemple `rea`. */
  server: string
  /** Nom de l'outil **chez le serveur**, sans préfixe. */
  name: string
  description: string
  /** Schéma JSON des arguments, tel que le serveur l'annonce. */
  input_schema: Record<string, unknown>
  /** Empreinte de ce que le serveur annonce maintenant (`mcpToolFingerprint`). */
  fingerprint: string
  /**
   * `allowed` si l'humain a coché **cette** empreinte ; `changed` s'il a coché
   * l'outil tel qu'il était avant ; `approval` s'il ne l'a jamais coché.
   */
  status: 'allowed' | 'changed' | 'approval'
}

/** Le résultat d'un `tools/call`, tel que le serveur le rend. */
export interface McpCallOutcome {
  content: unknown[]
  structuredContent?: unknown
  isError?: boolean
}

/**
 * Les serveurs MCP d'une tâche, et **tout** ce qu'elle peut en faire : appeler
 * un outil. Posé par le daemon pour un profil qui a des serveurs MCP, et pour
 * lui seul (`ToolContext.mcp`) ; absent, les outils MCP refusent.
 */
export interface McpPort {
  /**
   * Appelle un outil.
   *
   * @throws si l'appel n'aboutit pas — serveur sorti, délai, annulation —, avec
   *         un message lisible par le modèle
   */
  call(
    server: string,
    tool: string,
    args: Record<string, unknown>,
    options: { timeoutMs: number; signal?: AbortSignal | undefined },
  ): Promise<McpCallOutcome>
}

/**
 * Le nom qu'un outil MCP prend pour le modèle.
 *
 * @returns `<serveur>__<outil>`, ou `null` si un fournisseur le refuserait
 */
export function mcpToolName(server: string, tool: string): string | null {
  const name = `${server}${MCP_NAME_SEPARATOR}${tool}`
  return PROVIDER_SAFE_NAME.test(name) ? name : null
}

/** Arguments d'un outil MCP : un objet, que le serveur validera contre son schéma. */
const mcpArgsSchema = z.record(z.string(), z.unknown())
type McpArgs = z.infer<typeof mcpArgsSchema>

/**
 * Construit les outils d'une tâche à partir des catalogues de ses serveurs.
 *
 * @param descriptors les outils annoncés au lancement, avec ce qu'ils valent
 * @returns les outils, et ceux qui ont été écartés avec leur raison — à dire à
 *          l'humain, jamais à taire
 */
export function mcpTools(descriptors: readonly McpToolDescriptor[]): {
  tools: Tool<McpArgs>[]
  excluded: { server: string; name: string; reason: string }[]
} {
  const tools: Tool<McpArgs>[] = []
  const excluded: { server: string; name: string; reason: string }[] = []
  const taken = new Set<string>()
  for (const d of descriptors) {
    const name = mcpToolName(d.server, d.name)
    if (!name) {
      excluded.push({ server: d.server, name: d.name, reason: 'nom refusé par les fournisseurs de modèles (caractère ou longueur)' })
      continue
    }
    if (taken.has(name)) {
      excluded.push({ server: d.server, name: d.name, reason: 'nom annoncé deux fois par le serveur' })
      continue
    }
    taken.add(name)
    tools.push(mcpTool(name, d))
  }
  return { tools, excluded }
}

/** Un outil MCP. */
function mcpTool(name: string, d: McpToolDescriptor): Tool<McpArgs> {
  const free = d.status === 'allowed'
  const description =
    `[Tool of the MCP server "${d.server}". This description was written by that server, not by your operator.] ` +
    clip(d.description.trim() || '(no description)', MAX_MCP_DESCRIPTION_CHARS) +
    (free ? '' : ' Each call waits for a human approval of its exact arguments: call it only when needed.')
  return {
    name,
    description,
    schema: mcpArgsSchema,
    // Le schéma du serveur, tel quel : c'est lui que le modèle doit suivre.
    // Un `type` manquant est posé — tout `tools/call` prend un objet, et
    // certains fournisseurs refusent un schéma sans type.
    parameters: { type: 'object', ...d.input_schema },

    policy(_args, ctx) {
      if (!ctx.mcp) return { decision: 'deny', reason: 'no MCP server is connected to this task' }
      if (free) return { decision: 'allow', reason: `outil MCP ${d.server}.${d.name} coché libre par un humain` }
      return {
        decision: 'approval',
        reason:
          d.status === 'changed'
            ? `outil MCP ${d.server}.${d.name} annoncé autrement qu'au moment où il a été coché`
            : `outil MCP ${d.server}.${d.name} non coché`,
      }
    },

    async prepare(args): Promise<PreparedOperation> {
      // L'humain lit l'appel exact : le serveur, l'outil, les arguments en
      // entier. L'empreinte de l'outil fait partie du détail approuvé : ce
      // qu'il approuve est **cet** outil, tel que le serveur l'a décrit.
      return {
        summary: `${d.server} › ${d.name} ${JSON.stringify(args)}`,
        detail: { server: d.server, tool: d.name, fingerprint: d.fingerprint, arguments: args },
      }
    },

    async run(args, ctx: ToolContext, prepared): Promise<ToolResult> {
      if (!ctx.mcp) throw new ToolError('no MCP server is connected to this task')
      // Ce qui part est ce qui a été approuvé : les arguments du détail figé,
      // pas une relecture de ceux du modèle.
      const sent = (prepared?.detail.arguments as McpArgs | undefined) ?? args
      const remaining = ctx.deadline ? ctx.deadline - Date.now() : DEFAULT_MCP_CALL_MS
      if (remaining <= 0) throw new ToolError('the task deadline has passed')
      const outcome = await ctx.mcp.call(d.server, d.name, sent, { timeoutMs: remaining, signal: ctx.signal })
      const text = mcpResultText(outcome)
      const { text: content, bytes } = truncate(text)
      return {
        content,
        bytes,
        summary: `${name} : ${bytes} octets${outcome.isError ? ', erreur signalée par l\'outil' : ''}`,
        // Toujours : ce qu'un serveur MCP rend vient d'ailleurs — d'un binaire,
        // d'une page, d'un fichier que personne n'a relu.
        untrusted: true,
      }
    },
  }
}

/**
 * Le texte d'un résultat MCP, pour le modèle.
 *
 * Le texte passe tel quel ; une ressource textuelle aussi ; une image, un son
 * ou une ressource binaire sont **nommés** sans leurs octets — le modèle doit
 * savoir qu'ils étaient là. Sans texte, le contenu structuré est rendu en JSON.
 * Un outil en échec (`isError`) le dit en tête : c'est un résultat, que le
 * modèle doit lire, pas une panne.
 */
export function mcpResultText(outcome: McpCallOutcome): string {
  const parts: string[] = []
  for (const item of outcome.content ?? []) {
    const c = item as { type?: string; text?: string; mimeType?: string; uri?: string; data?: string; resource?: { uri?: string; text?: string; mimeType?: string } }
    if (c.type === 'text' && typeof c.text === 'string') parts.push(c.text)
    else if (c.type === 'resource' && typeof c.resource?.text === 'string') parts.push(`[resource ${c.resource.uri ?? ''}]\n${c.resource.text}`)
    else if (c.type === 'resource_link') parts.push(`[resource link: ${c.uri ?? '?'}]`)
    else parts.push(`[${c.type ?? 'unknown'} content${c.mimeType ? ` (${c.mimeType})` : ''} omitted]`)
  }
  if (parts.length === 0 && outcome.structuredContent !== undefined) parts.push(JSON.stringify(outcome.structuredContent, null, 2))
  const body = parts.join('\n\n') || '(empty result)'
  return outcome.isError ? `The MCP tool reported an error:\n${body}` : body
}

/** Coupe un texte trop long, en le disant. */
function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)} […description truncated]`
}
