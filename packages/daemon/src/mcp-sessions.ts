/**
 * @file Les serveurs MCP des tâches (Slice 8, étape 3) : lancés au départ
 * d'une tâche, fermés à sa fin, tous fermés à l'arrêt du daemon.
 *
 * **Un processus serveur par tâche et par serveur** (docs/SLICE8.md,
 * décision 3) : l'état d'un serveur — un binaire ouvert dans REA — ne fuit pas
 * d'une tâche à l'autre, et tuer une tâche tue ses serveurs, groupe de
 * processus compris (`@midgaard/mcp-client`).
 *
 * **Lancés au départ, pas au premier appel.** Il faut le catalogue pour
 * décrire les outils au modèle avant son premier appel ; et un serveur qui ne
 * démarre pas fait échouer la tâche **avant** tout appel de modèle, donc sans
 * rien coûter, avec la raison. Un agent de reverse sans REA ne ferait que
 * tourner en rond à nos frais.
 *
 * **La liste blanche se lit au départ**, comme celle d'`exec` : un outil coché
 * pendant qu'une tâche tourne vaut pour la suivante. Et le catalogue est figé
 * au départ : un serveur qui annonce de nouveaux outils en cours de route
 * (`notifications/tools/list_changed`) n'en donne aucun à la tâche en cours.
 */
import type { HarnessConfig } from '@midgaard/contracts'
import { mcpCatalogStatus } from '@midgaard/contracts'
import { McpClientError, type McpConnection } from '@midgaard/mcp-client'
import type { HarnessStore } from '@midgaard/persistence'
import type { SecretVault } from '@midgaard/secrets'
import { ToolError, mcpTools, type McpPort, type McpToolDescriptor, type Tool } from '@midgaard/tools'
import { connectMcpServer } from './mcp-servers.ts'

/** Ce dont les sessions ont besoin. */
export interface McpSessionsDeps {
  store: HarnessStore
  config: HarnessConfig
  vault: SecretVault
  /** Environnement du daemon : la source de `serverEnv`, jamais transmis tel quel. */
  env: NodeJS.ProcessEnv
  log: (...a: unknown[]) => void
}

/** Ce qu'une tâche reçoit de ses serveurs MCP. */
export interface McpTaskTools {
  port: McpPort
  tools: Tool<never>[]
  /** Outils écartés, avec leur raison : à dire dans la timeline. */
  excluded: { server: string; name: string; reason: string }[]
  /** Valeurs secrètes des serveurs : la tâche les ajoute à son expurgation. */
  secretValues: string[]
  /** Une ligne par serveur, pour la timeline : combien d'outils, combien libres. */
  summary: string[]
}

/** Les serveurs MCP de toutes les tâches en cours. */
export class McpSessions {
  private readonly deps: McpSessionsDeps
  private readonly live = new Map<string, Map<string, McpConnection>>()
  private stopped = false

  constructor(deps: McpSessionsDeps) {
    this.deps = deps
  }

  /**
   * Lance les serveurs d'une tâche et construit ses outils.
   *
   * Tout ou rien : un seul serveur qui ne démarre pas, et ceux déjà lancés
   * sont fermés — une tâche qui n'aurait qu'une partie de ses outils se
   * croirait complète.
   *
   * @param serverIds les serveurs du profil
   * @param cwd       le projet de la tâche (ou son worktree)
   * @returns les outils et le port, ou la raison de l'échec, en français
   */
  async openTask(
    taskId: string,
    serverIds: readonly string[],
    cwd: string,
    signal?: AbortSignal,
  ): Promise<McpTaskTools | { error: string }> {
    if (this.stopped) return { error: 'le daemon s\'arrête' }
    const connections = new Map<string, McpConnection>()
    this.live.set(taskId, connections)
    const descriptors: McpToolDescriptor[] = []
    const secretValues: string[] = []
    const summary: string[] = []
    for (const id of serverIds) {
      const server = this.deps.store.getMcpServer(id)
      if (!server) {
        await this.endTask(taskId)
        return { error: `le serveur MCP « ${id} » n'est plus déclaré : retire-le du profil, ou redéclare-le` }
      }
      const connected = await connectMcpServer(this.deps, server, cwd, signal)
      if ('error' in connected) {
        await this.endTask(taskId)
        return { error: `le serveur MCP « ${id} » n'a pas démarré : ${connected.error}` }
      }
      // La tâche a pu finir pendant le lancement (annulée, daemon arrêté) :
      // ses serveurs sont déjà fermés, et celui-ci ne doit pas leur survivre.
      if (this.live.get(taskId) !== connections) {
        await connected.connection.close()
        return { error: 'la tâche s\'est arrêtée pendant le lancement de ses serveurs MCP' }
      }
      connections.set(id, connected.connection)
      secretValues.push(...connected.secretValues)
      // Ce que l'humain a coché, lu **maintenant** et comparé au catalogue
      // annoncé **maintenant** : c'est là que l'empreinte fait son travail.
      const { tools } = mcpCatalogStatus(connected.catalog, this.deps.store.mcpToolAllow(id))
      for (const t of tools) {
        descriptors.push({
          server: id,
          name: t.name,
          description: t.description,
          input_schema: t.input_schema,
          fingerprint: t.fingerprint,
          status: t.status,
        })
      }
      const free = tools.filter((t) => t.status === 'allowed').length
      const changed = tools.filter((t) => t.status === 'changed').length
      summary.push(
        `serveur MCP ${id} : ${tools.length} outil(s), ${free} libre(s)` +
          (changed ? `, ${changed} coché(s) mais annoncé(s) autrement — approuvé(s) à chaque appel` : ''),
      )
    }
    const { tools, excluded } = mcpTools(descriptors)
    return { port: this.portFor(taskId), tools: tools as Tool<never>[], excluded, secretValues, summary }
  }

  /** Le port d'une tâche : il n'appelle que ses serveurs à elle. */
  private portFor(taskId: string): McpPort {
    return {
      call: async (server, tool, args, options) => {
        const connection = this.live.get(taskId)?.get(server)
        if (!connection) throw new ToolError(`the MCP server "${server}" is not running for this task`)
        try {
          const result = await connection.callTool(tool, args, options)
          return result as { content: unknown[]; structuredContent?: unknown; isError?: boolean }
        } catch (e) {
          // Le message de `McpClientError` est écrit pour le modèle ; la sortie
          // d'erreur du serveur n'y est jamais, elle peut porter un secret.
          throw new ToolError(e instanceof McpClientError ? e.message : `MCP call failed: ${(e as Error).message}`)
        }
      },
    }
  }

  /** Ferme les serveurs d'une tâche, groupes de processus compris. Sans effet s'il n'y en a pas. */
  async endTask(taskId: string): Promise<void> {
    const connections = this.live.get(taskId)
    if (!connections) return
    this.live.delete(taskId)
    await Promise.all([...connections.values()].map((c) => c.close()))
  }

  /** Ferme tout : le daemon s'arrête. */
  async closeAll(): Promise<void> {
    this.stopped = true
    await Promise.all([...this.live.keys()].map((id) => this.endTask(id)))
  }
}
