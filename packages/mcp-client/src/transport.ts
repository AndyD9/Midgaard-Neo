/**
 * @file Transport stdio d'un serveur MCP, lancé sous la garde des processus
 * (Slice 8, étape 1).
 *
 * Le SDK MCP fournit un `StdioClientTransport`, qu'on n'emploie pas : il lance
 * le serveur **dans le groupe du daemon** et ne tue que le processus
 * principal. Un serveur comme REA lance à son tour Ghidra, Hopper ou IDA ; ces
 * petits-enfants survivraient à la tâche, et un daemon tué net (`SIGKILL`)
 * ne tuerait plus rien du tout. Ce transport reprend la recette d'`exec`
 * (paquet `tools`) :
 *
 *  - le serveur est **chef de son propre groupe** (POSIX), donc ses fils aussi
 *    y sont, sauf s'ils s'en détachent eux-mêmes ;
 *  - la **garde** est armée avant le lancement, et le groupe lui est confié
 *    dès qu'il a un pid : si le daemon meurt net, c'est elle qui le tue ;
 *  - l'arrêt suit la séquence que la spécification MCP prescrit pour stdio —
 *    fermer l'entrée, attendre, `SIGTERM`, attendre, `SIGKILL` — mais adressée
 *    au **groupe**, pas au seul processus ;
 *  - le serveur principal sorti, ce qui reste de son groupe est tué aussitôt,
 *    comme pour une commande d'`exec`.
 *
 * Ce que le serveur écrit sur sa sortie d'erreur n'est **jamais** recopié sur
 * celle du daemon, encore moins sur sa sortie standard : on en garde la fin,
 * bornée, pour expliquer un échec. Le daemon l'expurgera avant de la
 * journaliser — ce paquet ne connaît pas l'expurgation.
 */
import { execFile, spawn, type ChildProcess } from 'node:child_process'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import { ReadBuffer, serializeMessage } from '@modelcontextprotocol/sdk/shared/stdio.js'
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js'
import { armGuard, guardGroup } from '@midgaard/tools'

/**
 * Délai laissé au serveur pour quitter seul une fois son entrée fermée, puis
 * après `SIGTERM`. Deux secondes, comme la grâce d'`exec` et de la garde.
 */
export const MCP_KILL_GRACE_MS = 2_000

/**
 * Taille maximale d'un message JSON-RPC reçu. Un catalogue d'outils complet
 * est gros — REA annonce des schémas de sortie détaillés pour des dizaines
 * d'outils —, mais un serveur qui n'envoie jamais de fin de ligne ne doit pas
 * faire grossir la mémoire du daemon sans limite. Au-delà, le transport se
 * ferme et le dit.
 */
export const MAX_MESSAGE_BYTES = 16 * 1024 * 1024

/** Ce qu'on garde de la sortie d'erreur du serveur : sa fin, pour expliquer un échec. */
export const STDERR_TAIL_BYTES = 8 * 1024

/** Le programme d'un serveur MCP stdio, tel que l'humain l'a déclaré. */
export interface StdioServerSpec {
  /** Chemin **absolu** du programme : jamais résolu par le `PATH` au lancement. */
  command: string
  /** Arguments, passés tels quels : aucun shell ne les interprète. */
  args: readonly string[]
  /**
   * Environnement **complet** du serveur, rien n'est hérité du daemon en plus.
   * À construire par {@link serverEnv}, qui écarte les secrets du daemon.
   */
  env: Record<string, string>
  /** Dossier courant du serveur. */
  cwd: string
}

/** Comment le serveur a fini : code de sortie ou signal, ou `null` s'il tourne. */
export interface ServerExit {
  code: number | null
  signal: NodeJS.Signals | null
}

/**
 * Transport MCP sur l'entrée et la sortie d'un processus lancé sous la garde.
 * Implémente l'interface `Transport` du SDK, que `Client` emploie.
 */
export class GuardedStdioTransport implements Transport {
  onclose?: (() => void) | undefined
  onerror?: ((error: Error) => void) | undefined
  onmessage?: ((message: JSONRPCMessage) => void) | undefined

  private readonly spec: StdioServerSpec
  private readonly log: (message: string) => void
  private readonly buffer = new ReadBuffer({ maxBufferSize: MAX_MESSAGE_BYTES })
  private child: ChildProcess | null = null
  private release: () => void = () => {}
  private stderrChunks: Buffer[] = []
  private stderrSize = 0
  private exited: ServerExit | null = null
  private closing: Promise<void> | null = null
  /** Résolue quand le processus est sorti **et** que ses tubes sont fermés : sa sortie d'erreur est alors complète. */
  private streamsDone: Promise<void> = Promise.resolve()
  private closedFired = false

  /**
   * @param spec programme, arguments, environnement et dossier du serveur
   * @param log  journalisation du daemon : dit une fois que la garde manque
   */
  constructor(spec: StdioServerSpec, log: (message: string) => void = () => {}) {
    this.spec = spec
    this.log = log
  }

  /** Pid du serveur — chef de son groupe sous POSIX —, une fois lancé. */
  get pid(): number | undefined {
    return this.child?.pid
  }

  /** Comment le serveur a fini, ou `null` s'il tourne encore (ou n'a pas démarré). */
  get exit(): ServerExit | null {
    return this.exited
  }

  /** La fin de ce que le serveur a écrit sur sa sortie d'erreur, **non expurgée**. */
  stderrTail(): string {
    return Buffer.concat(this.stderrChunks).toString('utf8')
  }

  /**
   * Lance le serveur. Se résout quand le processus existe, pas quand il
   * répond : c'est `initialize`, envoyé par le client, qui le dira.
   *
   * @throws {Error} si le programme ne peut pas être lancé (absent, non exécutable)
   */
  start(): Promise<void> {
    if (this.child) throw new Error('the MCP server transport is already started')
    // La garde d'abord : armée après, elle laissait un intervalle où un daemon
    // tué net abandonnait un processus inscrit nulle part (voir `armGuard`).
    armGuard(this.log)
    let child: ChildProcess
    try {
      child = spawn(this.spec.command, [...this.spec.args], {
        cwd: this.spec.cwd,
        env: this.spec.env,
        stdio: ['pipe', 'pipe', 'pipe'],
        // Son propre groupe de processus (POSIX) : c'est ce qui permet de tuer
        // aussi ce que le serveur lance. Sous Windows, `taskkill /T` suit l'arbre.
        detached: process.platform !== 'win32',
        windowsHide: true,
        shell: false,
      })
    } catch (e) {
      // Sous Windows, un `.cmd` sans shell lève ici (`EINVAL`), pas par l'événement.
      return Promise.reject(new Error(`cannot start the MCP server ${this.spec.command}: ${(e as NodeJS.ErrnoException).code ?? (e as Error).message}`))
    }
    this.child = child
    this.streamsDone = new Promise((resolve) => child.once('close', () => resolve()))
    // Confié à la garde dès qu'il a un pid, avant même de savoir s'il a démarré.
    if (child.pid !== undefined) this.release = guardGroup(child.pid, this.log)

    return new Promise((resolve, reject) => {
      child.once('spawn', () => resolve())
      child.once('error', (e: NodeJS.ErrnoException) => {
        const error = new Error(`cannot start the MCP server ${this.spec.command}: ${e.code ?? e.message}`)
        // Aucun groupe à garder : le processus n'a jamais existé.
        this.release()
        reject(error)
        this.onerror?.(error)
      })
      child.stdout!.on('data', (chunk: Buffer) => {
        try {
          this.buffer.append(chunk)
        } catch (e) {
          // Message trop gros : on ne peut plus se resynchroniser sur le flux.
          this.onerror?.(new Error(`the MCP server sent a message over ${MAX_MESSAGE_BYTES} bytes: ${(e as Error).message}`))
          void this.close()
          return
        }
        this.drain()
      })
      child.stderr!.on('data', (chunk: Buffer) => this.keepStderr(chunk))
      // Un tube rompu (serveur mort) ne doit pas faire tomber le daemon : la
      // fermeture du processus le dira par `onclose`.
      child.stdin!.on('error', (e) => this.onerror?.(e))
      child.stdout!.on('error', (e) => this.onerror?.(e))
      child.on('exit', (code, signal) => {
        this.exited = { code, signal }
        // Le serveur principal a fini : ce qu'il a laissé dans son groupe est
        // tué tout de suite. Sans cela, `close` attendrait que ces survivants
        // ferment les tubes, c'est-à-dire peut-être jamais.
        killGroup(child, 'SIGKILL')
      })
      child.on('close', () => {
        this.release()
        this.fireClose()
      })
    })
  }

  /** Envoie un message JSON-RPC, en respectant la contre-pression du tube. */
  send(message: JSONRPCMessage): Promise<void> {
    const stdin = this.child?.stdin
    if (!stdin || !stdin.writable || this.exited) return Promise.reject(new Error('the MCP server is not running'))
    return new Promise((resolve) => {
      if (stdin.write(serializeMessage(message))) resolve()
      else stdin.once('drain', () => resolve())
    })
  }

  /**
   * Arrête le serveur et tout son groupe. Idempotente, et ne lève pas : un
   * arrêt qui échoue ne doit pas masquer la raison pour laquelle on arrêtait.
   *
   * La séquence est celle de la spécification MCP pour stdio — fermer
   * l'entrée, laisser le serveur quitter seul, puis `SIGTERM`, puis `SIGKILL` —
   * adressée au groupe entier. Le `SIGKILL` final part **toujours** vers le
   * groupe, même si le serveur a quitté seul : ses fils, eux, n'ont peut-être
   * pas suivi.
   */
  close(): Promise<void> {
    this.closing ??= this.stop()
    return this.closing
  }

  private async stop(): Promise<void> {
    const child = this.child
    if (!child) {
      this.fireClose()
      return
    }
    const closed = new Promise<void>((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) resolve()
      else child.once('exit', () => resolve())
    })
    try {
      child.stdin?.end()
    } catch {}
    if (!(await settles(closed, MCP_KILL_GRACE_MS))) {
      killGroup(child, 'SIGTERM')
      if (!(await settles(closed, MCP_KILL_GRACE_MS))) killGroup(child, 'SIGKILL')
    }
    killGroup(child, 'SIGKILL')
    // On attend la fermeture des tubes, pas seulement la sortie : ce que le
    // serveur a écrit sur sa sortie d'erreur juste avant de mourir arrive
    // après `exit`, et c'est souvent ce qui explique l'échec.
    await settles(this.streamsDone, MCP_KILL_GRACE_MS)
    // Le groupe est tué : il peut quitter la garde. Libérer avant de tuer
    // laisserait un daemon tué entre les deux abandonner le groupe.
    this.release()
    this.buffer.clear()
    this.fireClose()
  }

  /** Lit tous les messages complets du tampon. Un message mal formé est signalé, pas fatal. */
  private drain(): void {
    for (;;) {
      let message: JSONRPCMessage | null
      try {
        message = this.buffer.readMessage()
      } catch (e) {
        this.onerror?.(new Error(`the MCP server sent an invalid message: ${(e as Error).message}`))
        continue
      }
      if (message === null) return
      this.onmessage?.(message)
    }
  }

  /** Garde la fin de la sortie d'erreur, sans jamais dépasser {@link STDERR_TAIL_BYTES}. */
  private keepStderr(chunk: Buffer): void {
    this.stderrChunks.push(chunk)
    this.stderrSize += chunk.length
    while (this.stderrSize > STDERR_TAIL_BYTES && this.stderrChunks.length > 0) {
      const first = this.stderrChunks[0]!
      const excess = this.stderrSize - STDERR_TAIL_BYTES
      if (first.length <= excess) {
        this.stderrChunks.shift()
        this.stderrSize -= first.length
      } else {
        this.stderrChunks[0] = first.subarray(excess)
        this.stderrSize -= excess
      }
    }
  }

  /** `onclose` une seule fois, qu'on ferme ou que le serveur meure de lui-même. */
  private fireClose(): void {
    if (this.closedFired) return
    this.closedFired = true
    this.onclose?.()
  }
}

/**
 * Environnement d'un serveur MCP. Ce qui passe le fait pour une raison nommée,
 * comme pour `exec` (`execEnv`, paquet `tools`).
 *
 * Le dossier personnel et le `PATH` passent : un serveur Node comme REA y
 * trouve son cache npm, Java et Ghidra. Ce qui ne passe **pas**, ce sont les
 * secrets du daemon (clés d'API d'un fournisseur posées dans son
 * environnement) et tout le reste de ce qu'il a hérité de qui l'a lancé. Ce
 * dont un serveur a besoin en plus, l'humain le **déclare**, et la
 * déclaration l'emporte.
 *
 * @param source   l'environnement du daemon, injecté (seuls les `main.ts` lisent `process.env`)
 * @param declared les variables déclarées par l'humain pour ce serveur
 * @returns l'environnement complet du serveur
 */
export function serverEnv(source: NodeJS.ProcessEnv, declared: Record<string, string> = {}): Record<string, string> {
  const keep = [
    'PATH', 'Path', 'PATHEXT', 'SystemRoot', 'SYSTEMROOT', 'WINDIR',
    'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_RUNTIME_DIR',
    'USER', 'LOGNAME', 'USERNAME', 'TMPDIR', 'TEMP', 'TMP', 'LANG',
  ]
  // Les codes de couleur coûtent des jetons et ne disent rien au modèle.
  const env: Record<string, string> = { NO_COLOR: '1' }
  for (const k of keep) {
    const v = source[k]
    if (v !== undefined) env[k] = v
  }
  return { ...env, ...declared }
}

/**
 * Tue le groupe de processus du serveur. Silencieux si le groupe n'existe plus :
 * tuer ce qui est déjà mort n'est pas une erreur.
 */
function killGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid === undefined) return
  if (process.platform === 'win32') {
    // `/T` descend dans l'arbre des enfants ; il ne retrouve plus ceux d'un
    // parent déjà mort — même limite qu'`exec`, annoncée dans le README.
    execFile('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true }, () => {})
    return
  }
  try {
    // Un pid négatif désigne le groupe entier.
    process.kill(-child.pid, signal)
  } catch {}
}

/** Vrai si la promesse se résout avant `ms` ; ne la rejette jamais. */
async function settles(p: Promise<void>, ms: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), ms)
  })
  try {
    return await Promise.race([p.then(() => true as const), timeout])
  } finally {
    clearTimeout(timer)
  }
}
