/**
 * @file Outils de lecture du projet : `read_file`, `list_directory`, `search_files`.
 *
 * Tous passent par {@link resolveUnderRoot} ou {@link openUnderRoot} : aucun ne
 * manipule un chemin fourni par un modèle sans l'avoir canonicalisé et vérifié.
 * Aucun n'écrit : l'écriture vit dans `write.ts`, et n'opère que dans un worktree.
 *
 * Trois dossiers sont ignorés d'office à la recherche et au listage :
 * `node_modules`, `.git` et `dist`. Ce n'est pas de la sécurité, c'est de
 * l'économie — ils représentent l'essentiel des fichiers d'un dépôt et aucun de
 * ses réponses. Les lister ferait payer au modèle des jetons pour du bruit.
 */
import { readdir, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { z } from 'zod'
import type { ToolResult } from '@midgaard/contracts'
import { openUnderRoot, resolveUnderRoot, toolPath } from './paths.ts'
import { MAX_TOOL_RESULT_BYTES, ToolError, truncate, type Tool, type ToolContext } from './types.ts'

/** Dossiers écartés du listage et de la recherche : beaucoup de fichiers, aucune réponse. */
const SKIP_DIRECTORIES = new Set(['node_modules', '.git', 'dist', '.next', 'build', '.venv', '__pycache__'])

/** Entrées listées au maximum, pour qu'un dossier géant ne noie pas le contexte. */
const MAX_ENTRIES = 400
/** Résultats de recherche au maximum. */
const MAX_MATCHES = 80
/** Fichiers parcourus au maximum par une recherche. Borne le temps, pas seulement la sortie. */
const MAX_SCANNED_FILES = 4000

// --- read_file -------------------------------------------------------------

const readSchema = z.object({
  path: z.string().min(1).describe('File path, absolute or relative to the project root'),
})

/** Lit un fichier texte du projet. */
export const readFileTool: Tool<z.infer<typeof readSchema>> = {
  name: 'read_file',
  description:
    'Read one text file from the project. The path must stay inside the project root; ' +
    'symlinks pointing outside are refused. Large files are truncated, and the truncation is stated.',
  schema: readSchema,
  policy: () => ({ decision: 'allow', reason: 'lecture seule sous la racine du projet' }),

  async run(args, ctx): Promise<ToolResult> {
    const { handle, path, size } = await openUnderRoot(ctx.root, args.path)
    try {
      // On ne lit que ce qui sera rendu, plus une marge : charger cinquante
      // mégaoctets pour en rendre soixante kilo-octets serait absurde.
      const toRead = Math.min(size, MAX_TOOL_RESULT_BYTES + 1024)
      const buffer = Buffer.alloc(toRead)
      const { bytesRead } = await handle.read(buffer, 0, toRead, 0)
      const raw = buffer.subarray(0, bytesRead)
      // Un octet nul signe un binaire. Le rendre au modèle coûterait cher pour
      // du bruit, et masquerait la vraie raison de l'échec.
      if (raw.includes(0)) throw new ToolError(`not a text file: ${args.path}`)

      const { text } = truncate(raw.toString('utf8'))
      const shown = size > MAX_TOOL_RESULT_BYTES ? `${text}\n\n[…fichier de ${size} octets]` : text
      return {
        content: shown,
        bytes: size,
        summary: `${toolPath(ctx.root, path)} · ${size} octets`,
        // Le projet de l'utilisateur n'est pas plus suspect que le dépôt
        // lui-même : ce n'est pas du contenu venu du monde extérieur.
        untrusted: false,
      }
    } finally {
      await handle.close().catch(() => {})
    }
  },
}

// --- list_directory --------------------------------------------------------

const listSchema = z.object({
  path: z.string().default('.').describe('Directory path, relative to the project root'),
})

/** Liste le contenu d'un dossier du projet. */
export const listDirectoryTool: Tool<z.infer<typeof listSchema>> = {
  name: 'list_directory',
  description:
    'List the entries of one directory in the project. Dependency and build directories ' +
    '(node_modules, .git, dist…) are skipped. Does not recurse.',
  schema: listSchema,
  policy: () => ({ decision: 'allow', reason: 'lecture seule sous la racine du projet' }),

  async run(args, ctx): Promise<ToolResult> {
    const dir = await resolveUnderRoot(ctx.root, args.path)
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => {
      throw new ToolError(`not a directory: ${args.path}`)
    })

    const lines: string[] = []
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (SKIP_DIRECTORIES.has(entry.name)) continue
      if (lines.length >= MAX_ENTRIES) {
        lines.push(`[…${entries.length - lines.length} entrées supplémentaires]`)
        break
      }
      if (entry.isDirectory()) {
        lines.push(`${entry.name}/`)
      } else if (entry.isSymbolicLink()) {
        // Signalé comme tel : un lien peut mener hors de la racine, et sa
        // lecture sera alors refusée. Mieux vaut que le modèle le sache avant.
        lines.push(`${entry.name} (lien symbolique)`)
      } else {
        const size = await stat(join(dir, entry.name))
          .then((s) => `${s.size} o`)
          .catch(() => '?')
        lines.push(`${entry.name}  ${size}`)
      }
    }

    const shown = toolPath(ctx.root, dir)
    return {
      content: lines.length ? lines.join('\n') : '(dossier vide)',
      bytes: Buffer.byteLength(lines.join('\n')),
      summary: `${shown} · ${lines.length} entrée(s)`,
      untrusted: false,
    }
  },
}

// --- search_files ----------------------------------------------------------

const searchSchema = z.object({
  pattern: z.string().min(1).describe('Regular expression to search for, JavaScript syntax'),
  path: z
    .string()
    .default('.')
    .describe(
      'Directory to search in, relative to the project root. Must be a directory, not a file: ' +
        'to search inside one file, pass its directory and narrow with glob, or read it with read_file.',
    ),
  glob: z
    .string()
    .optional()
    .describe('Optional file name suffix filter, for example ".ts" or ".md" ("*.ts" is accepted too)'),
})

/** Longueur d'une ligne rendue entière ; au-delà, on rend une fenêtre autour de chaque occurrence. */
const MAX_LINE_EXCERPT = 300
/** Contexte gardé avant une occurrence dans une ligne longue. */
const EXCERPT_LEAD = 120
/** Taille au-delà de laquelle un fichier n'est pas parcouru. */
const MAX_SEARCHED_FILE_BYTES = 2 * 1024 * 1024

/**
 * Le filtre de nom de `search_files`, à partir de ce que le modèle a écrit.
 *
 * Le schéma parle d'un **suffixe** (`.ts`), mais un modèle écrit volontiers un
 * motif de shell (`*.js`, `**\/*.js`). Au premier essai réel de la Slice 8,
 * l'orchestrateur l'a fait : le suffixe `*.js` ne terminait aucun nom, la
 * recherche a rendu « aucune correspondance » sept fois de suite, et il en a
 * conclu que l'outil était cassé. Un faux négatif est pire qu'un refus
 * (docs/SLICE2.md, défaut n° 1). D'où : les formes usuelles `*.ext` et
 * `**\/*.ext` sont ramenées au suffixe, et tout autre joker est **refusé** avec
 * la forme attendue, plutôt que pris à la lettre.
 *
 * @param glob ce que le modèle a passé, éventuellement absent
 * @returns le suffixe retenu, ou `null` s'il n'y a pas de filtre
 * @throws {ToolError} si le filtre contient un joker qu'on ne sait pas lire
 */
export function nameSuffix(glob: string | undefined): string | null {
  let suffix = glob?.trim() ?? ''
  while (suffix.startsWith('**/')) suffix = suffix.slice(3)
  if (suffix.startsWith('*')) suffix = suffix.slice(1)
  if (suffix === '') return null
  if (/[*?[\]{}/\\]/.test(suffix)) {
    throw new ToolError(
      `glob "${glob}" is not supported: it is a file name suffix such as ".js" or "*.js", ` +
        'without other wildcards or directories (narrow the directory with path instead)',
    )
  }
  return suffix
}

/**
 * Les extraits d'une ligne où le motif a été trouvé.
 *
 * Une ligne courte est rendue entière. Une ligne longue — un bundle minifié
 * tient sur une seule ligne d'un mégaoctet — est rendue **autour de chaque
 * occurrence**, avec sa colonne. Rendre son début, comme avant, montrait les
 * mêmes 300 premiers caractères pour chaque motif cherché : au premier essai
 * réel, quatre « correspondances » ne disaient rien de l'endroit trouvé.
 *
 * @param line  la ligne
 * @param regex le motif, sans drapeau `g`
 * @param max   nombre d'extraits au plus
 */
export function lineExcerpts(line: string, regex: RegExp, max: number): string[] {
  if (line.length <= MAX_LINE_EXCERPT) return regex.test(line) ? [line.trim()] : []
  const all = new RegExp(regex.source, `${regex.flags}g`)
  const out: string[] = []
  let match: RegExpExecArray | null
  while (out.length < max && (match = all.exec(line)) !== null) {
    // Une occurrence vide (`a*`) ne fait pas avancer `lastIndex` : sans ce pas,
    // la boucle tournerait sur place.
    if (match[0] === '') all.lastIndex++
    const start = Math.max(0, match.index - EXCERPT_LEAD)
    const end = Math.min(line.length, start + MAX_LINE_EXCERPT)
    out.push(`[col ${match.index + 1}] ${start > 0 ? '…' : ''}${line.slice(start, end)}${end < line.length ? '…' : ''}`)
  }
  return out
}

/** Cherche un motif dans les fichiers du projet. */
export const searchFilesTool: Tool<z.infer<typeof searchSchema>> = {
  name: 'search_files',
  description:
    'Search the project for a regular expression and return matching lines with their file and line number. ' +
    'Dependency and build directories are skipped, and results are capped.',
  schema: searchSchema,
  policy: () => ({ decision: 'allow', reason: 'lecture seule sous la racine du projet' }),

  async run(args, ctx): Promise<ToolResult> {
    let regex: RegExp
    try {
      // Pas de drapeau `g` : il rend `test` et `exec` dépendants d'un état
      // interne, et on veut juger chaque ligne indépendamment.
      regex = new RegExp(args.pattern, 'i')
    } catch (e) {
      throw new ToolError(`invalid regular expression: ${(e as Error).message}`)
    }

    const suffix = nameSuffix(args.glob)
    const root = await resolveUnderRoot(ctx.root, args.path)

    // `walk` tolère un dossier illisible : une recherche ne doit pas mourir
    // parce qu'un dossier parmi mille refuse le listage. À la **racine** de la
    // recherche, cette même tolérance rendait un chiffre faux — `readdir` lève
    // `ENOTDIR` sur un fichier, le `catch` l'avalait, et le modèle recevait
    // « 0 correspondance » au lieu d'une erreur. Un faux négatif est pire qu'un
    // refus : il a l'air d'une réponse, et le modèle le croit. Mesuré en vraie
    // session — l'agent a cherché un symbole qui existait, l'a cru absent, et y
    // a laissé son budget d'étapes (docs/SLICE2.md, § défaut n° 1).
    //
    // Ce `stat` n'est pas un contrôle de sécurité : `resolveUnderRoot` a déjà
    // vérifié la racine, et chaque fichier parcouru est rouvert sous contrôle par
    // `openUnderRoot`. Il ne sert qu'à refuser proprement plutôt qu'à mentir.
    if (!(await stat(root)).isDirectory()) {
      const parent = dirname(args.path) || '.'
      throw new ToolError(
        `search_files searches a directory, and "${args.path}" is not one. ` +
          `Search "${parent}" instead and narrow with glob, or read the file with read_file.`,
      )
    }

    const matches: string[] = []
    let scanned = 0
    let capped = false
    // Les fichiers écartés le sont **en le disant** : un fichier trop gros ou
    // binaire que la recherche saute en silence est un faux négatif de plus.
    let tooLarge = 0
    let binary = 0

    const walk = async (dir: string): Promise<void> => {
      if (capped || ctx.signal?.aborted) return
      const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
      for (const entry of entries) {
        if (capped) return
        if (SKIP_DIRECTORIES.has(entry.name) || entry.name.startsWith('.')) continue
        const full = join(dir, entry.name)
        if (entry.isDirectory()) {
          await walk(full)
          continue
        }
        // Les liens symboliques ne sont pas suivis : ils peuvent sortir de la
        // racine, et une boucle de liens ferait tourner la recherche sans fin.
        if (!entry.isFile()) continue
        if (suffix && !entry.name.endsWith(suffix)) continue
        if (++scanned > MAX_SCANNED_FILES) {
          capped = true
          return
        }
        await scan(full)
      }
    }

    const scan = async (file: string): Promise<void> => {
      const { handle, size } = await openUnderRoot(ctx.root, file).catch(() => ({ handle: null, size: 0 }))
      if (!handle) return
      try {
        if (size > MAX_SEARCHED_FILE_BYTES) {
          tooLarge++
          return
        }
        const buffer = Buffer.alloc(size)
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
        const raw = buffer.subarray(0, bytesRead)
        if (raw.includes(0)) {
          binary++
          return
        }
        const lines = raw.toString('utf8').split('\n')
        for (let i = 0; i < lines.length; i++) {
          for (const excerpt of lineExcerpts(lines[i]!, regex, MAX_MATCHES - matches.length)) {
            matches.push(`${toolPath(ctx.root, file)}:${i + 1}: ${excerpt}`)
          }
          if (matches.length >= MAX_MATCHES) {
            capped = true
            return
          }
        }
      } finally {
        await handle.close().catch(() => {})
      }
    }

    await walk(root)

    // Zéro fichier parcouru n'est pas « aucune correspondance » : c'est le
    // filtre, pas le motif, qui n'a rien retenu, et le modèle doit le savoir.
    const empty =
      scanned === 0 && suffix
        ? `(no file name ends with "${suffix}" under "${args.path}": nothing was searched)`
        : '(aucune correspondance)'
    const body = matches.length ? matches.join('\n') : empty
    const skipped = [
      tooLarge ? `${tooLarge} file(s) over 2 MB not searched` : '',
      binary ? `${binary} binary file(s) not searched` : '',
    ].filter(Boolean)
    const note =
      (capped ? `\n\n[…arrêté à ${matches.length} correspondance(s) ou ${scanned} fichier(s)]` : '') +
      (skipped.length ? `\n\n[${skipped.join(' ; ')}]` : '')
    return {
      content: body + note,
      bytes: Buffer.byteLength(body),
      summary: `${matches.length} correspondance(s) dans ${scanned} fichier(s)`,
      untrusted: false,
    }
  },
}
