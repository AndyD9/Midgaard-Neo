/**
 * @file Lancement de `git`, avec les précautions qu'impose un dépôt dont un
 * agent écrit une partie.
 *
 * Toutes les opérations du paquet passent par {@link git}. Ce qui suit n'est pas
 * de la prudence générique : chaque règle ferme une porte précise.
 *
 *  1. **Aucun hook.** `core.hooksPath` est pointé vers le périphérique nul. Un
 *     dépôt peut ranger ses hooks **dans l'arbre de travail** (Husky le fait,
 *     sous `.husky/`) ; dans un worktree, cet arbre est écrit par l'agent. Sans
 *     cette règle, l'agent écrirait `.husky/pre-commit`, et le commit de fin de
 *     tâche du harness exécuterait son contenu — une exécution arbitraire sans
 *     aucune approbation, par la porte de service.
 *  2. **Aucun pilote de diff externe, aucune conversion de texte**
 *     (`--no-ext-diff --no-textconv`, posés par les appelants). Un
 *     `.gitattributes` écrit par l'agent peut désigner un pilote ; calculer un
 *     diff ne doit lancer aucun programme.
 *  3. **Environnement reconstruit.** `GIT_DIR`, `GIT_WORK_TREE` ou
 *     `GIT_INDEX_FILE` hérités du daemon redirigeraient chaque commande vers un
 *     autre dépôt, en silence. Seules passent les variables nommées dans
 *     {@link gitEnv}, chacune pour une raison écrite.
 *  4. **`execFile`-like, jamais de shell.** `spawn` sans `shell` : aucun
 *     argument ne peut devenir une commande.
 *  5. **Délai et plafond de sortie.** Un `git` bloqué — un verrou d'index tenu
 *     par l'éditeur de l'utilisateur, une invite d'identifiants — ne doit pas
 *     bloquer le daemon ; une sortie démesurée ne doit pas le noyer.
 *
 * Ce que ce module ne fait **pas** : neutraliser la configuration de
 * l'utilisateur. Ses filtres `clean`/`smudge` (Git LFS) et son identité restent
 * appliqués. Ils sont définis dans **sa** configuration, hors de portée de
 * l'agent ; les ignorer casserait un dépôt LFS sans rien protéger.
 */
import { spawn } from 'node:child_process'
import { devNull } from 'node:os'

/** Délai par défaut d'une commande `git`. Les appelants lents (checkout) passent le leur. */
export const GIT_TIMEOUT_MS = 30_000

/** Plafond par défaut de la sortie standard conservée, en octets. */
export const GIT_MAX_OUTPUT_BYTES = 8 * 1024 * 1024

/** Erreur d'espace de travail : un message pour l'humain, sans trace de pile. */
export class WorkspaceError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'WorkspaceError'
  }
}

/** Ce que rend une commande `git`. `code` vaut `null` si elle a été tuée. */
export interface GitOutcome {
  code: number | null
  stdout: string
  stderr: string
  /** Vrai si la sortie a dépassé le plafond : `stdout` n'en contient que le début. */
  truncated: boolean
  /** Taille réelle de la sortie standard, y compris la partie non conservée. */
  stdoutBytes: number
  timedOut: boolean
}

/** Options d'une commande `git`. */
export interface GitOptions {
  /** Dossier de travail de la commande. */
  cwd: string
  /** Variables ajoutées à {@link gitEnv} pour ce seul appel (index temporaire, identité). */
  env?: Record<string, string>
  timeoutMs?: number
  /** Au-delà, la sortie est tronquée et la commande **tuée** : rien ne sert de lire la suite. */
  maxOutputBytes?: number
}

/**
 * Arguments imposés avant ceux de l'appelant. Voir la règle n° 1 de l'en-tête.
 *
 * `devNull` vaut `/dev/null` ou `\\.\nul` : `git` y cherche `pre-commit` et ne
 * trouve rien, sur toutes les plateformes, sans dossier à créer ni à protéger.
 */
export const HARDENING_ARGS: readonly string[] = ['-c', `core.hooksPath=${devNull}`]

/**
 * Lance `git` et attend sa fin. Ne **lève pas** sur un code non nul : un
 * `git diff --quiet` qui sort en 1 répond, il n'échoue pas. Voir {@link gitOk}.
 *
 * @param args arguments, après {@link HARDENING_ARGS}
 * @throws {WorkspaceError} si `git` est introuvable
 */
export function git(args: readonly string[], opts: GitOptions): Promise<GitOutcome> {
  const timeoutMs = opts.timeoutMs ?? GIT_TIMEOUT_MS
  const max = opts.maxOutputBytes ?? GIT_MAX_OUTPUT_BYTES
  return new Promise((resolve, reject) => {
    const child = spawn('git', [...HARDENING_ARGS, ...args], {
      cwd: opts.cwd,
      env: { ...gitEnv(), ...opts.env },
      // Aucune entrée : une commande qui voudrait poser une question lit une
      // fin de fichier et échoue tout de suite, au lieu d'attendre le délai.
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
    const out: Buffer[] = []
    const err: Buffer[] = []
    let kept = 0
    let total = 0
    let truncated = false
    let timedOut = false

    child.stdout.on('data', (chunk: Buffer) => {
      total += chunk.length
      if (truncated) return
      const room = max - kept
      if (chunk.length <= room) {
        out.push(chunk)
        kept += chunk.length
        return
      }
      out.push(chunk.subarray(0, room))
      kept = max
      truncated = true
      // La suite ne sera pas lue : inutile de laisser `git` la produire. Le
      // total reste donc un minimum, ce que l'appelant annonce comme tel.
      child.kill()
    })
    // La sortie d'erreur sert aux messages ; quelques kilo-octets suffisent.
    child.stderr.on('data', (chunk: Buffer) => {
      if (err.reduce((n, b) => n + b.length, 0) < 64 * 1024) err.push(chunk)
    })

    const timer = setTimeout(() => {
      timedOut = true
      child.kill()
    }, timeoutMs)

    child.on('error', (e: NodeJS.ErrnoException) => {
      clearTimeout(timer)
      reject(
        e.code === 'ENOENT'
          ? new WorkspaceError('git est introuvable dans le PATH du daemon : installe Git, puis redémarre le daemon')
          : e,
      )
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      const stderr = Buffer.concat(err).toString('utf8')
      resolve({
        code: truncated ? 0 : code,
        stdout: Buffer.concat(out).toString('utf8'),
        // Une commande tuée par le délai doit le **dire** : sans cela elle sort
        // « code null » avec une erreur vide, et on cherche la panne ailleurs
        // (leçon du coffre DPAPI, docs/SLICE2.md).
        stderr: timedOut ? `git n'a pas rendu la main en ${timeoutMs / 1000} s et a été tué. ${stderr}`.trim() : stderr,
        truncated,
        stdoutBytes: total,
        timedOut,
      })
    })
  })
}

/**
 * Lance `git` et exige un succès.
 *
 * @param what ce que la commande devait faire, en français, pour le message d'erreur
 * @returns la sortie standard
 * @throws {WorkspaceError} si la commande sort en erreur, avec la première ligne utile de `git`
 */
export async function gitOk(args: readonly string[], opts: GitOptions, what: string): Promise<string> {
  const r = await git(args, opts)
  if (r.code !== 0) throw new WorkspaceError(`${what} : ${firstLine(r.stderr) || `git a rendu le code ${r.code}`}`)
  return r.stdout
}

/** Première ligne non vide d'un message de `git`, préfixes `fatal:`/`error:` retirés. */
function firstLine(text: string): string {
  const line = text.split('\n').map((l) => l.trim()).find(Boolean) ?? ''
  return line.replace(/^(fatal|error):\s*/i, '')
}

/**
 * Environnement de `git`. Ce qui passe le fait pour une raison nommée.
 *
 * @param source environnement d'origine ; injecté pour les tests
 */
export function gitEnv(source: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const keep = [
    // `git` lui-même, et ce qu'il appelle (LFS) : trouvables comme dans le
    // terminal de l'utilisateur.
    'PATH', 'Path', 'SystemRoot', 'TEMP', 'TMP',
    // Sa configuration globale — identité, filtres LFS — vit sous le dossier
    // personnel ou sous XDG.
    'HOME', 'USERPROFILE', 'XDG_CONFIG_HOME',
  ]
  const env: Record<string, string> = {
    // Messages et sorties en anglais stable : certains sont analysés.
    LC_ALL: 'C',
    // Jamais d'invite d'identifiants : personne n'est là pour y répondre.
    GIT_TERMINAL_PROMPT: '0',
    // `git status` rafraîchit l'index et prend son verrou au passage. Dans le
    // dépôt de l'utilisateur, ce verrou ferait échouer le `git` qu'il lance au
    // même instant ; la lecture n'en a pas besoin.
    GIT_OPTIONAL_LOCKS: '0',
  }
  for (const k of keep) {
    const v = source[k]
    if (v !== undefined) env[k] = v
  }
  return env
}
