/**
 * @file Une connexion à un serveur MCP stdio (Slice 8, étape 1) : lancer,
 * `initialize`, lire le catalogue, appeler un outil, arrêter.
 *
 * Le protocole est celui du SDK (`Client`), le transport celui de ce paquet
 * ({@link GuardedStdioTransport}), qui garde les processus. Ce module ajoute ce
 * que le daemon attend d'un outil :
 *
 *  - **chaque appel est borné** par un délai que l'appelant fixe — l'échéance
 *    de la tâche — et **annulable** par son signal. Le SDK envoie alors
 *    `notifications/cancelled` au serveur ; s'il continue quand même, l'arrêt
 *    de la connexion, à la fin de la tâche, tue son groupe ;
 *  - **le client ne déclare aucune capacité** : ni `sampling` (un serveur
 *    ferait appeler le modèle de l'agent, et dépenserait en son nom), ni
 *    `roots`, ni `elicitation`. Un serveur qui en demande reçoit « méthode
 *    inconnue » ;
 *  - **les échecs se disent en anglais**, avec leur cause — serveur sorti,
 *    délai, annulation, programme introuvable —, parce que c'est le modèle
 *    qui les lit. Ils ne contiennent jamais la sortie d'erreur du serveur :
 *    elle peut porter un secret, et c'est au daemon de l'expurger avant de la
 *    montrer ({@link McpConnection.stderrTail}).
 *
 * Ce module ne sait rien des approbations, de la liste blanche ni de
 * l'encadrement des résultats : c'est l'affaire des outils (étape 3).
 */
import { isAbsolute } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { ErrorCode, McpError, type CallToolResult, type Implementation, type Tool } from '@modelcontextprotocol/sdk/types.js'
import { GuardedStdioTransport, type ServerExit, type StdioServerSpec } from './transport.ts'

/** Délai par défaut de `initialize` : un serveur qui ne répond pas en 30 s ne répondra pas. */
export const DEFAULT_STARTUP_TIMEOUT_MS = 30_000
/** Délai par défaut d'une lecture du catalogue. */
export const DEFAULT_LIST_TIMEOUT_MS = 30_000
/**
 * Nombre maximal d'outils lus au catalogue. Au-delà, la lecture s'arrête et
 * le dit : un catalogue sans fin (pagination qui boucle) ne doit pas retenir
 * le daemon, et aucun modèle ne choisirait utilement parmi plus d'outils.
 */
export const MAX_TOOLS = 1_000

/** Les outils tels que le serveur les annonce : nom, description, schémas, annotations. */
export type McpTool = Tool
/** Le résultat brut d'un appel d'outil : contenu, contenu structuré, `isError`. */
export type McpCallResult = CallToolResult

/** Un échec de la connexion, à rendre à l'agent tel quel. En anglais : c'est le modèle qui le lit. */
export class McpClientError extends Error {
  /** `cancelled` et `timeout` ne disent rien du serveur ; `exited` et `start` disent qu'il ne sert plus. */
  readonly reason: 'start' | 'exited' | 'timeout' | 'cancelled' | 'protocol'
  /**
   * Pour un démarrage raté, la fin de la sortie d'erreur du serveur, **non
   * expurgée** : la connexion n'existe plus pour la demander, et c'est souvent
   * elle qui dit pourquoi (Java absent, module introuvable). À expurger avant
   * de la montrer.
   */
  readonly stderrTail: string

  constructor(reason: McpClientError['reason'], message: string, stderrTail = '') {
    super(message)
    this.name = 'McpClientError'
    this.reason = reason
    this.stderrTail = stderrTail
  }
}

/** Options de {@link McpConnection.open}. */
export interface OpenOptions {
  /** Délai de `initialize`, en millisecondes. */
  startupTimeoutMs?: number | undefined
  /** Annule le démarrage : le serveur est arrêté, son groupe compris. */
  signal?: AbortSignal | undefined
  /** Journalisation du daemon. Jamais la sortie standard : sur le serveur MCP, c'est le canal JSON-RPC. */
  log?: ((message: string) => void) | undefined
}

/** Options d'un appel. */
export interface CallOptions {
  /** Délai de l'appel, en millisecondes : le reste de l'échéance de la tâche. */
  timeoutMs: number
  /** Annulation de la tâche. */
  signal?: AbortSignal | undefined
  /** Progression annoncée par le serveur (`notifications/progress`). */
  onProgress?: ((progress: { progress: number; total?: number | undefined; message?: string | undefined }) => void) | undefined
}

/**
 * Une connexion ouverte à un serveur MCP stdio, et le processus qui la sert.
 * Une par tâche et par serveur (docs/SLICE8.md, décision 3).
 */
export class McpConnection {
  private readonly client: Client
  private readonly transport: GuardedStdioTransport
  private readonly spec: StdioServerSpec
  private closed = false

  private constructor(client: Client, transport: GuardedStdioTransport, spec: StdioServerSpec) {
    this.client = client
    this.transport = transport
    this.spec = spec
  }

  /**
   * Lance le serveur et fait la poignée de main `initialize`.
   *
   * @param spec    programme **absolu**, arguments, environnement, dossier
   * @param options délai, annulation, journalisation
   * @throws {McpClientError} `start` si le programme n'est pas absolu, ne se
   *         lance pas ou ne répond pas au protocole ; `cancelled` sur annulation
   */
  static async open(spec: StdioServerSpec, options: OpenOptions = {}): Promise<McpConnection> {
    // Le chemin est absolu : un `PATH` qui changerait entre la déclaration et
    // le lancement ne doit pas faire tourner un autre programme que celui que
    // l'humain a déclaré.
    if (!isAbsolute(spec.command)) {
      throw new McpClientError('start', `the MCP server command must be an absolute path, got ${JSON.stringify(spec.command)}`)
    }
    const log = options.log ?? (() => {})
    const transport = new GuardedStdioTransport(spec, log)
    // Aucune capacité déclarée : voir l'en-tête.
    const client = new Client({ name: 'midgaard', version: '0.1.0' }, { capabilities: {} })
    client.onerror = (e) => log(`serveur MCP ${spec.command} : ${e.message}`)
    const connection = new McpConnection(client, transport, spec)
    const timeoutMs = options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS
    try {
      if (options.signal?.aborted) throw new McpClientError('cancelled', 'the MCP server start was cancelled')
      await client.connect(transport, { timeout: timeoutMs, signal: options.signal })
      return connection
    } catch (e) {
      await connection.close()
      if (e instanceof McpClientError) throw e
      const translated = connection.translate(e, timeoutMs, options.signal)
      // Pendant le démarrage, sortir ou ne pas répondre veut dire la même
      // chose pour l'appelant : ce serveur n'est pas utilisable.
      throw translated.reason === 'cancelled'
        ? translated
        : new McpClientError(
            'start',
            `the MCP server ${spec.command} did not complete the MCP handshake: ${translated.message}`,
            connection.stderrTail(),
          )
    }
  }

  /** Nom et version que le serveur a annoncés à `initialize`. */
  get serverInfo(): Implementation | undefined {
    return this.client.getServerVersion()
  }

  /** Consignes que le serveur a jointes à `initialize`, **non fiables** : il les a écrites. */
  get instructions(): string | undefined {
    return this.client.getInstructions()
  }

  /** Pid du serveur, chef de son groupe sous POSIX. */
  get pid(): number | undefined {
    return this.transport.pid
  }

  /** Comment le serveur a fini, ou `null` s'il tourne. */
  get exit(): ServerExit | null {
    return this.transport.exit
  }

  /** Vrai une fois la connexion fermée, ou le serveur sorti de lui-même. */
  get isClosed(): boolean {
    return this.closed || this.transport.exit !== null
  }

  /**
   * La fin de la sortie d'erreur du serveur, **non expurgée** : à passer par
   * l'expurgation avant tout journal ou affichage.
   */
  stderrTail(): string {
    return this.transport.stderrTail()
  }

  /**
   * Lit tout le catalogue d'outils, pages comprises.
   *
   * @throws {McpClientError} si le serveur est sorti, ne répond pas, ou si la
   *         lecture est annulée ; `protocol` au-delà de {@link MAX_TOOLS}
   */
  async listTools(options: { timeoutMs?: number | undefined; signal?: AbortSignal | undefined } = {}): Promise<McpTool[]> {
    this.ensureOpen()
    const timeoutMs = options.timeoutMs ?? DEFAULT_LIST_TIMEOUT_MS
    const tools: McpTool[] = []
    const seen = new Set<string>()
    let cursor: string | undefined
    try {
      do {
        const page = await this.client.listTools(cursor === undefined ? {} : { cursor }, {
          timeout: timeoutMs,
          signal: options.signal,
        })
        tools.push(...page.tools)
        if (tools.length > MAX_TOOLS) {
          throw new McpClientError('protocol', `the MCP server announces more than ${MAX_TOOLS} tools`)
        }
        cursor = page.nextCursor
        // Un curseur déjà vu boucle : on s'arrête plutôt que tourner sans fin.
        if (cursor !== undefined) {
          if (seen.has(cursor)) throw new McpClientError('protocol', 'the MCP server returned the same page cursor twice')
          seen.add(cursor)
        }
      } while (cursor !== undefined)
    } catch (e) {
      throw this.translate(e, timeoutMs, options.signal)
    }
    return tools
  }

  /**
   * Appelle un outil du serveur.
   *
   * Un outil qui **échoue** rend un résultat avec `isError: true` — ce n'est
   * pas une exception : le modèle doit le lire. Une exception dit que l'appel
   * n'a pas abouti : serveur sorti, délai, annulation, réponse hors protocole.
   *
   * @param name nom de l'outil, **tel que le serveur l'annonce** (sans préfixe)
   * @param args arguments, déjà validés par l'appelant
   * @throws {McpClientError} si l'appel n'aboutit pas
   */
  async callTool(name: string, args: Record<string, unknown>, options: CallOptions): Promise<McpCallResult> {
    this.ensureOpen()
    try {
      const result = await this.client.callTool({ name, arguments: args }, undefined, {
        // Le délai est celui de la tâche : une progression ne le prolonge pas,
        // sans quoi un serveur bavard tiendrait la tâche au-delà de son échéance.
        timeout: options.timeoutMs,
        maxTotalTimeout: options.timeoutMs,
        resetTimeoutOnProgress: false,
        signal: options.signal,
        onprogress: options.onProgress,
      })
      return result as McpCallResult
    } catch (e) {
      throw this.translate(e, options.timeoutMs, options.signal)
    }
  }

  /**
   * Ferme la connexion et arrête le serveur, son groupe compris. Idempotente,
   * et ne lève pas.
   */
  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    await this.client.close().catch(() => {})
    // `Client.close` ferme le transport ; on attend ici la fin de son arrêt,
    // qui seule garantit que le groupe est tué.
    await this.transport.close()
  }

  private ensureOpen(): void {
    if (this.closed) throw new McpClientError('exited', 'the MCP server connection is closed')
    if (this.transport.exit !== null) throw new McpClientError('exited', this.exitMessage())
  }

  private exitMessage(): string {
    const exit = this.transport.exit
    const how = exit === null ? 'closed its connection' : exit.signal ? `was killed by ${exit.signal}` : `exited with code ${exit.code}`
    return `the MCP server ${this.spec.command} ${how}`
  }

  /** Traduit une erreur du SDK en {@link McpClientError}, la cause la plus utile d'abord. */
  private translate(e: unknown, timeoutMs: number, signal: AbortSignal | undefined): McpClientError {
    if (e instanceof McpClientError) return e
    if (signal?.aborted) return new McpClientError('cancelled', 'the MCP call was cancelled')
    if (e instanceof McpError) {
      if (e.code === ErrorCode.RequestTimeout) {
        return new McpClientError('timeout', `the MCP server did not answer within ${Math.round(timeoutMs / 1000)} s`)
      }
      if (e.code === ErrorCode.ConnectionClosed || this.transport.exit !== null) {
        return new McpClientError('exited', this.exitMessage())
      }
      return new McpClientError('protocol', `MCP error ${e.code}: ${e.message}`)
    }
    if (this.transport.exit !== null) return new McpClientError('exited', this.exitMessage())
    return new McpClientError('protocol', (e as Error).message ?? String(e))
  }
}
