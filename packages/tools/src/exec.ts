/**
 * @file `exec` : lancer une commande dans le worktree, sous approbation humaine.
 *
 * ## Ce que cet outil ne prétend pas être
 *
 * **Une sandbox.** La commande tourne sous le compte de l'utilisateur, avec son
 * dossier personnel : elle peut lire ce qu'il lit, écrire où il écrit, joindre
 * le réseau. Le plan l'a tranché dès le départ (pas de sandbox OS, PLAN §5).
 * La frontière n'est donc pas technique, elle est **humaine** : par défaut,
 * chaque commande attend une approbation, et l'humain voit exactement ce qui va
 * tourner — le binaire **résolu**, chaque argument, le dossier.
 *
 * Pourquoi l'approbation par défaut plutôt qu'une liste blanche (décision de la
 * Slice 3) : l'agent écrit dans le worktree, donc il peut réécrire
 * `package.json`. Autoriser `npm test` d'office, c'est autoriser sans regard ce
 * que l'agent a mis dans `scripts.test`. La liste blanche existe
 * (`MIDGAARD_EXEC_ALLOW`), vide par défaut, et se remplit en connaissance de cause.
 *
 * ## Ce qu'il garantit
 *
 *  1. **Jamais de shell.** `spawn` sans `shell` : `;`, `|`, `$()` et `&&` d'un
 *     argument restent des caractères. `sh -c "…"` reste possible — et se voit
 *     en entier dans la demande d'approbation.
 *  2. **Le binaire est résolu par le harness, avant la demande d'approbation**
 *     ({@link execTool}.`prepare`) : l'humain lit le chemin absolu du programme,
 *     et `run` lance ce chemin-là après avoir vérifié que le fichier n'a pas
 *     changé entre-temps (périphérique, inœud, taille, date). Les entrées
 *     **relatives** du `PATH` (`.`, `node_modules/.bin`) sont ignorées — elles
 *     feraient exécuter un fichier que l'agent vient d'écrire en le faisant
 *     passer pour une commande système.
 *  3. **Uniquement dans un worktree**, comme l'écriture. Hors worktree, refus
 *     sans demande : une commande dans le dépôt de l'utilisateur n'a rien de
 *     réversible.
 *  4. **Environnement reconstruit.** Les clés d'API du daemon, `GIT_DIR` et
 *     tout ce qui n'est pas nommé dans {@link execEnv} restent dehors.
 *  5. **Aucun processus ne survit à l'appel.** La commande a son propre groupe
 *     de processus ; à sa fin, à son délai ou à l'annulation de la tâche, le
 *     **groupe entier** est tué. Sans cela, `npm run dev` laisserait un serveur
 *     tourner après la tâche, et un `sleep 999 &` lancé par l'agent survivrait
 *     au harness lui-même. Et si le daemon meurt net, la garde
 *     ({@link guardGroup}) tue les groupes qu'il n'a pas pu tuer lui-même.
 *  6. **Délai borné par l'échéance de la tâche** : une commande ne peut pas
 *     faire durer une tâche au-delà de son `timeout_s`.
 *  7. **Sortie bornée, début et fin conservés** : la fin d'une sortie de test
 *     porte le verdict, son début la cause. Le milieu est retiré, et c'est dit.
 */
import { spawn, execFile, type ChildProcess } from 'node:child_process'
import { stat } from 'node:fs/promises'
import { delimiter, isAbsolute, join, relative, sep } from 'node:path'
import { z } from 'zod'
import { execRuleMatches, formatExecRule, type ExecAllowRule, type ToolResult } from '@midgaard/contracts'
export { parseExecAllow } from '@midgaard/contracts'
import { armGuard, guardGroup } from './guard.ts'
import { resolveUnderRoot } from './paths.ts'
import { ToolError, type PreparedOperation, type Tool, type ToolContext } from './types.ts'

/** Délai par défaut d'une commande, en secondes. Un `npm test` ordinaire tient en dessous. */
export const EXEC_DEFAULT_TIMEOUT_S = 120
/** Délai maximal qu'un agent peut demander. */
export const EXEC_MAX_TIMEOUT_S = 600
/**
 * Délai de grâce entre `SIGTERM` et `SIGKILL`. Assez pour qu'un serveur ferme
 * ses sockets, trop court pour qu'une commande qui ignore `SIGTERM` gagne du temps.
 */
export const EXEC_KILL_GRACE_MS = 2_000

/** Octets conservés au début et à la fin de chaque flux. */
const STDOUT_HEAD = 8 * 1024
const STDOUT_TAIL = 32 * 1024
const STDERR_HEAD = 4 * 1024
const STDERR_TAIL = 12 * 1024

const execSchema = z.object({
  command: z
    .string()
    .min(1)
    .max(256)
    .describe('Program to run: a bare name looked up in PATH (e.g. "npm"), or a path inside your workspace'),
  args: z.array(z.string().max(4096)).max(64).default([]).describe('Arguments, passed as-is: no shell interprets them'),
  cwd: z.string().default('.').describe('Working directory, relative to your workspace root'),
  timeout_s: z
    .number()
    .int()
    .min(1)
    .max(EXEC_MAX_TIMEOUT_S)
    .default(EXEC_DEFAULT_TIMEOUT_S)
    .describe(`Seconds before the command and all its subprocesses are killed (max ${EXEC_MAX_TIMEOUT_S})`),
})
type ExecArgs = z.infer<typeof execSchema>

/**
 * La règle de la liste blanche qui couvre cet argv, ou `undefined`.
 *
 * Une entrée exacte d'abord : si l'argv est couvert des deux façons, la
 * timeline nomme la règle la plus étroite. Les préfixes ont été jugés à
 * l'ajout **et** au départ de la tâche (`execPrefixRefusal`) : ici, on ne fait
 * que comparer, mot à mot.
 */
export function execAllowed(argv: readonly string[], allow: readonly ExecAllowRule[]): ExecAllowRule | undefined {
  return allow.find((r) => !r.prefix && execRuleMatches(r, argv)) ?? allow.find((r) => execRuleMatches(r, argv))
}

/**
 * Affiche un argv comme une ligne de commande, pour un humain.
 *
 * **Affichage seulement** : rien ne passe jamais par un shell. Les guillemets
 * servent à ce qu'un argument contenant une espace ou un `;` se voie comme un
 * seul argument dans la demande d'approbation — sinon `["a;b"]` et `["a", ";", "b"]`
 * s'afficheraient pareil et l'humain approuverait l'un en croyant lire l'autre.
 */
export function formatArgv(argv: readonly string[]): string {
  return argv.map((a) => (/^[A-Za-z0-9_./:=@%+,-]+$/.test(a) ? a : `'${a.replace(/'/g, `'\\''`)}'`)).join(' ')
}

/**
 * Environnement d'une commande. Ce qui passe le fait pour une raison nommée.
 *
 * Le dossier personnel est transmis : `npm`, `cargo` ou `pip` y ont leur cache
 * et leur configuration, et sans eux la plupart des commandes de projet
 * échouent. C'est cohérent avec l'en-tête — l'approbation est la frontière,
 * pas l'environnement. Ce que l'environnement écarte, ce sont les **secrets du
 * daemon** et les variables qui redirigeraient silencieusement un outil.
 */
export function execEnv(source: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const keep = [
    'PATH', 'Path', 'PATHEXT', 'SystemRoot', 'SYSTEMROOT', 'WINDIR',
    'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME',
    'TMPDIR', 'TEMP', 'TMP', 'LANG',
  ]
  const env: Record<string, string> = {
    // Personne ne lira une invite : les outils qui le savent n'en posent pas.
    CI: '1',
    // Les codes de couleur coûtent des jetons et ne disent rien au modèle.
    NO_COLOR: '1',
    TERM: 'dumb',
    GIT_TERMINAL_PROMPT: '0',
  }
  for (const k of keep) {
    const v = source[k]
    if (v !== undefined) env[k] = v
  }
  return env
}

/**
 * Résout le programme à lancer, comme le ferait le système — mais **avant**,
 * pour que la demande d'approbation montre le binaire réel.
 *
 * @throws {ToolError} programme introuvable, chemin hors du worktree, ou script
 *         `.cmd`/`.bat` sous Windows (voir plus bas)
 */
export async function resolveCommand(command: string, cwd: string, root: string, env: Record<string, string>): Promise<string> {
  if (command.includes('/') || command.includes('\\')) {
    // Un chemin : il doit désigner un fichier du worktree. `/bin/rm` s'écrit `rm`.
    const real = await resolveUnderRoot(root, isAbsolute(command) ? command : join(relative(root, cwd) || '.', command))
    if (!(await stat(real)).isFile()) throw new ToolError(`not a file: ${command}`)
    return real
  }
  const pathVar = env.PATH ?? env.Path ?? ''
  const exts = candidateNames(command, process.platform, env.PATHEXT)
  for (const dir of pathVar.split(delimiter)) {
    // Règle n° 2 de l'en-tête : une entrée relative désigne le worktree.
    if (!dir || !isAbsolute(dir)) continue
    for (const name of exts) {
      const candidate = join(dir, name)
      const st = await stat(candidate).catch(() => null)
      if (!st?.isFile()) continue
      if (process.platform === 'win32' && /\.(cmd|bat)$/i.test(candidate)) {
        // Node refuse de lancer un `.cmd` sans shell depuis la CVE-2024-27980,
        // et le lancer avec un shell exposerait les arguments à `cmd.exe`, dont
        // les règles d'échappement ne se maîtrisent pas. `npm` sous Windows en
        // est un : c'est une limite, annoncée plutôt que contournée.
        throw new ToolError(
          `${candidate} is a Windows batch script, which cannot run without a shell. ` +
            'Run the underlying program instead (for example "node" with the script path).',
        )
      }
      return candidate
    }
  }
  throw new ToolError(`command not found in PATH: ${command}`)
}

/**
 * Noms à chercher dans chaque dossier du `PATH`.
 *
 * **Sous Windows, jamais le nom nu.** Windows n'exécute pas un fichier sans
 * extension, et le dossier de Node en contient justement un : `npm`, un script
 * `sh` pour les shells POSIX, posé à côté de `npm.cmd`. Chercher d'abord le nom
 * nu le « trouvait », puis échouait au lancement. Seules les extensions de
 * `PATHEXT` comptent, sauf si la commande en porte déjà une.
 *
 * @param platform injecté pour que la règle Windows se vérifie depuis un Mac
 */
export function candidateNames(command: string, platform: NodeJS.Platform, pathext?: string): string[] {
  if (platform !== 'win32') return [command]
  const exts = (pathext ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)
  const hasExt = exts.some((e) => command.toLowerCase().endsWith(e.toLowerCase()))
  return hasExt ? [command] : exts.map((e) => command + e)
}

/** Conserve le début et la fin d'un flux, et compte ce qui a été retiré entre les deux. */
class HeadTail {
  private readonly headMax: number
  private readonly tailMax: number
  private head: Buffer[] = []
  private headLen = 0
  private tail: Buffer[] = []
  private tailLen = 0
  total = 0

  constructor(headMax: number, tailMax: number) {
    this.headMax = headMax
    this.tailMax = tailMax
  }

  push(chunk: Buffer): void {
    this.total += chunk.length
    if (this.headLen < this.headMax) {
      const take = Math.min(chunk.length, this.headMax - this.headLen)
      this.head.push(chunk.subarray(0, take))
      this.headLen += take
      chunk = chunk.subarray(take)
    }
    if (!chunk.length) return
    this.tail.push(chunk)
    this.tailLen += chunk.length
    while (this.tailLen > this.tailMax && this.tail.length) {
      const first = this.tail[0]!
      const excess = this.tailLen - this.tailMax
      if (first.length <= excess) {
        this.tail.shift()
        this.tailLen -= first.length
      } else {
        this.tail[0] = first.subarray(excess)
        this.tailLen -= excess
      }
    }
  }

  /** Le texte conservé ; le retrait du milieu est **écrit** dedans. */
  text(): string {
    const omitted = this.total - this.headLen - this.tailLen
    const head = Buffer.concat(this.head).toString('utf8')
    const tail = Buffer.concat(this.tail).toString('utf8')
    return omitted > 0 ? `${head}\n[… ${omitted} bytes omitted …]\n${tail}` : head + tail
  }
}

/** Ce que rend une exécution. */
export interface ExecOutcome {
  /** Code de sortie ; `null` si la commande a été tuée. */
  code: number | null
  signal: NodeJS.Signals | null
  timedOut: boolean
  cancelled: boolean
  durationMs: number
  stdout: string
  stderr: string
  stdoutBytes: number
  stderrBytes: number
}

/**
 * Lance un programme déjà résolu et attend sa fin **et celle de son groupe**.
 *
 * Ne lève pas sur un code non nul : un test qui échoue est une réponse, que le
 * modèle doit lire pour corriger son code.
 *
 * @throws {ToolError} si le programme ne peut pas démarrer
 */
export function runCommand(input: {
  file: string
  args: readonly string[]
  cwd: string
  env: Record<string, string>
  timeoutMs: number
  signal?: AbortSignal | undefined
  /** Journalisation du daemon : dit une fois que la garde des commandes manque. */
  log?: ((message: string) => void) | undefined
  /**
   * Chaque morceau lu, au moment où il arrive (Slice 6). Appelé **en plus** de
   * la capture tête et queue, qui reste ce que rend la commande : le terminal
   * voit tout ce qui passe, le modèle ce qui tient.
   */
  onOutput?: ((stream: 'stdout' | 'stderr', chunk: Buffer) => void) | undefined
}): Promise<ExecOutcome> {
  return new Promise((resolve, reject) => {
    const started = Date.now()
    // La garde d'abord : démarrée après la commande, elle laissait un
    // intervalle où un daemon tué net abandonnait une commande inscrite nulle
    // part (voir `armGuard`).
    armGuard(input.log)
    let child: ChildProcess
    try {
      child = spawn(input.file, [...input.args], {
        cwd: input.cwd,
        env: input.env,
        stdio: ['ignore', 'pipe', 'pipe'],
        // Son propre groupe de processus (POSIX) : c'est ce qui permet de tuer
        // aussi ses enfants. Sous Windows, le groupe est atteint par `taskkill /T`.
        detached: process.platform !== 'win32',
        windowsHide: true,
        shell: false,
      })
    } catch (e) {
      return reject(new ToolError(`cannot start ${input.file}: ${(e as Error).message}`))
    }
    // Confié à la garde dès le lancement : si le daemon meurt net pendant la
    // commande, c'est elle qui tuera le groupe. Retiré une fois le groupe tué.
    const release = child.pid !== undefined ? guardGroup(child.pid, input.log) : () => {}
    const out = new HeadTail(STDOUT_HEAD, STDOUT_TAIL)
    const err = new HeadTail(STDERR_HEAD, STDERR_TAIL)
    // Un observateur qui lève ne doit ni perdre la sortie ni laisser la commande
    // sans fin : son erreur est journalisée, la capture continue.
    const observe = (stream: 'stdout' | 'stderr', c: Buffer) => {
      try {
        input.onOutput?.(stream, c)
      } catch (e) {
        input.log?.(`sortie en direct de ${input.file} interrompue : ${(e as Error).message}`)
      }
    }
    child.stdout!.on('data', (c: Buffer) => {
      out.push(c)
      observe('stdout', c)
    })
    child.stderr!.on('data', (c: Buffer) => {
      err.push(c)
      observe('stderr', c)
    })

    let timedOut = false
    let cancelled = false
    let escalation: NodeJS.Timeout | null = null
    const stop = () => {
      killGroup(child, 'SIGTERM')
      escalation ??= setTimeout(() => killGroup(child, 'SIGKILL'), EXEC_KILL_GRACE_MS)
    }
    const timer = setTimeout(() => {
      timedOut = true
      stop()
    }, input.timeoutMs)
    const onAbort = () => {
      cancelled = true
      stop()
    }
    input.signal?.addEventListener('abort', onAbort, { once: true })
    if (input.signal?.aborted) onAbort()

    // Le programme principal a fini : ce qu'il a laissé derrière lui dans son
    // groupe — un serveur lancé en tâche de fond — est tué tout de suite. Sans
    // cela, `close` attendrait que ces survivants ferment les tubes de sortie,
    // c'est-à-dire indéfiniment.
    child.on('exit', () => killGroup(child, 'SIGKILL'))

    child.on('error', (e: NodeJS.ErrnoException) => {
      release()
      clearTimeout(timer)
      if (escalation) clearTimeout(escalation)
      input.signal?.removeEventListener('abort', onAbort)
      reject(new ToolError(`cannot start ${input.file}: ${e.code ?? e.message}`))
    })
    child.on('close', (code, signal) => {
      release()
      clearTimeout(timer)
      if (escalation) clearTimeout(escalation)
      input.signal?.removeEventListener('abort', onAbort)
      resolve({
        code,
        signal,
        timedOut,
        cancelled,
        durationMs: Date.now() - started,
        stdout: out.text(),
        stderr: err.text(),
        stdoutBytes: out.total,
        stderrBytes: err.total,
      })
    })
  })
}

/**
 * Tue le groupe de processus d'une commande. Silencieux si le groupe n'existe
 * plus : tuer ce qui est déjà mort n'est pas une erreur.
 */
function killGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid === undefined) return
  if (process.platform === 'win32') {
    // `/T` descend dans l'arbre des enfants. Il ne retrouve plus ceux d'un
    // parent déjà mort : limite de la plateforme, annoncée dans le README.
    execFile('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true }, () => {})
    return
  }
  try {
    // Un pid négatif désigne le groupe entier.
    process.kill(-child.pid, signal)
  } catch {}
}

/** Politique de `exec`, évaluée sur l'argv réel. */
function execPolicy(args: ExecArgs, ctx: ToolContext): { decision: 'allow' | 'approval' | 'deny'; reason: string } {
  if (!ctx.writable) {
    return { decision: 'deny', reason: 'this agent has no workspace: it cannot run commands' }
  }
  const argv = [args.command, ...args.args]
  const where = args.cwd === '.' ? '' : ` (dans ${args.cwd})`
  const rule = execAllowed(argv, ctx.execAllow ?? [])
  if (rule) {
    // Un préfixe se nomme : l'humain qui relit la timeline doit savoir quelle
    // autorisation a laissé passer des arguments qu'il n'a jamais vus.
    const by = rule.prefix ? ` (préfixe « ${formatExecRule(rule)} »)` : ''
    return { decision: 'allow', reason: `commande en liste blanche${by} : ${formatArgv(argv)}${where}` }
  }
  // La raison est ce que l'humain lit avant de décider : la commande **exacte**.
  return { decision: 'approval', reason: `exécuter ${formatArgv(argv)}${where}` }
}

/** Ce que `prepare` fige pour `run`. */
interface ExecState {
  file: string
  cwd: string
  fingerprint: string
}

/**
 * Identité d'un fichier exécutable : périphérique, inœud, taille, date de
 * modification. Un binaire remplacé (`brew upgrade` pendant que la demande
 * attend) ou réécrit (un script du worktree) en change au moins un.
 */
function fingerprint(st: { dev: number; ino: number; size: number; mtimeMs: number }): string {
  return `${st.dev}:${st.ino}:${st.size}:${st.mtimeMs}`
}

/** Chemin relatif à la racine pour les résumés courts. */
function shortCwd(root: string, cwd: string): string {
  return relative(root, cwd).split(sep).join('/') || '.'
}

/** Lance une commande dans le worktree. */
export const execTool: Tool<ExecArgs> = {
  name: 'exec',
  description:
    'Run one program in your workspace, without a shell: arguments are passed as-is, so pipes, ' +
    'redirections and && do not work. A human must approve each command unless it is on the allowlist, ' +
    'so prefer few, meaningful commands (run the tests once you have a candidate, not after every edit). ' +
    'The program and all its subprocesses are killed at the end, on timeout, or if the task is cancelled. ' +
    'A non-zero exit code is returned, not an error: read the output and fix the cause.',
  schema: execSchema,
  policy: execPolicy,

  /**
   * Résout le dossier et le programme, et relève l'identité du binaire —
   * **avant** que l'humain ne soit sollicité. Ce qu'il lira est ce qui tournera.
   */
  async prepare(args, ctx): Promise<PreparedOperation> {
    if (!ctx.writable) throw new ToolError('this agent has no workspace')
    const cwd = await resolveUnderRoot(ctx.root, args.cwd)
    if (!(await stat(cwd)).isDirectory()) throw new ToolError(`not a directory: ${args.cwd}`)
    const file = await resolveCommand(args.command, cwd, ctx.root, execEnv())
    const id = fingerprint(await stat(file))
    const state: ExecState = { file, cwd, fingerprint: id }
    return {
      summary: `exécuter ${formatArgv([file, ...args.args])} dans ${cwd} (délai ${args.timeout_s} s)`,
      detail: {
        tool: 'exec',
        program: file,
        program_fingerprint: id,
        args: args.args,
        cwd,
        timeout_s: args.timeout_s,
      },
      state,
    }
  },

  async run(args, ctx, prepared): Promise<ToolResult> {
    if (!ctx.writable) throw new ToolError('this agent has no workspace')
    // Sans préparation (commande en liste blanche, ou appel direct), on prépare
    // ici : la vérification qui suit vaut alors pour quelques millisecondes.
    const op = (prepared ?? (await execTool.prepare!(args, ctx))).state as ExecState

    // Ce qui a été approuvé tient-il encore ? Le binaire peut avoir été
    // remplacé pendant que la demande attendait un humain — jusqu'à dix
    // minutes. On lance ce qui a été montré, ou rien.
    const now = await stat(op.file).catch(() => null)
    if (!now || fingerprint(now) !== op.fingerprint) {
      throw new ToolError(`the program changed since the command was approved: ${op.file}. Nothing was run.`)
    }
    if ((await resolveUnderRoot(ctx.root, args.cwd)) !== op.cwd) {
      throw new ToolError(`the working directory changed since the command was approved: ${args.cwd}. Nothing was run.`)
    }

    // Le délai demandé ne peut pas dépasser l'échéance de la tâche : une limite
    // vérifiée après coup a déjà été dépassée.
    const remaining = ctx.deadline !== undefined ? ctx.deadline - Date.now() : Infinity
    if (remaining <= 0) throw new ToolError('the task deadline has passed: no time left to run a command')
    const timeoutMs = Math.min(args.timeout_s * 1000, remaining)

    const r = await runCommand({
      file: op.file,
      args: args.args,
      cwd: op.cwd,
      env: execEnv(),
      timeoutMs,
      signal: ctx.signal,
      log: (m) => ctx.log(m),
      onOutput: ctx.output,
    })
    const argv = formatArgv([args.command, ...args.args])
    const ending = r.cancelled
      ? 'cancelled: the task was cancelled, the command and its subprocesses were killed'
      : r.timedOut
        ? `killed after ${Math.round(timeoutMs / 1000)} s (timeout), with all its subprocesses`
        : r.code !== null
          ? `exit code ${r.code}`
          : `killed by ${r.signal}`
    const where = shortCwd(ctx.root, op.cwd)
    const content =
      `$ ${argv}${where === '.' ? '' : `   (in ${where})`}\n` +
      `${ending} · ${(r.durationMs / 1000).toFixed(1)} s\n` +
      `--- stdout (${r.stdoutBytes} bytes) ---\n${r.stdout}\n` +
      `--- stderr (${r.stderrBytes} bytes) ---\n${r.stderr}`
    const verdict = r.timedOut ? 'délai dépassé' : r.cancelled ? 'annulée' : r.code !== null ? `code ${r.code}` : String(r.signal)
    return {
      content,
      bytes: r.stdoutBytes + r.stderrBytes,
      summary: `${argv} → ${verdict} en ${(r.durationMs / 1000).toFixed(1)} s${where === '.' ? '' : ` (${where})`}`,
      // Une sortie de commande peut contenir n'importe quoi : un message de
      // paquet installé, une page téléchargée par un test. Elle est encadrée
      // comme du contenu web, pour l'agent comme pour Claude.
      untrusted: true,
      exit_code: r.timedOut || r.cancelled ? null : r.code,
    }
  },
}
