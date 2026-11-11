/**
 * @file Une image d'une tâche, **en lecture seule**, pour le fil du dashboard
 * (Slice 7) : celle qu'un agent a lue par `read_image`.
 *
 * Le chemin vient d'une requête HTTP : il est traité comme celui qu'écrit un
 * modèle, par les mêmes outils (`openUnderRoot` : racine canonique, identité
 * du descripteur revérifiée à l'ouverture). Deux règles de plus, propres à
 * cette route :
 *
 *  - **rien sous `.git`**, à aucun niveau, quelle que soit la casse — un
 *    système de fichiers insensible à la casse ouvre `.GIT/config` comme
 *    `.git/config`. Et la règle vaut pour le chemin **réel** aussi : un lien
 *    posé par l'agent dans son worktree (`x → .git/config`) reste sous la
 *    racine, et passerait sinon. Dans un worktree, `.git` est un fichier qui
 *    désigne le dépôt de l'utilisateur ;
 *  - celles de l'outil `read_image` : le type se lit dans les octets (PNG,
 *    JPEG, WebP, GIF — jamais un SVG, qui est du texte et peut porter un
 *    script), 4 Mo au plus.
 *
 * L'image est lue **sur le disque, maintenant** : aucune n'est gardée en base,
 * et son empreinte dit si c'est encore celle que l'agent a vue.
 */
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import type { Task } from '@midgaard/contracts'
import type { HarnessStore } from '@midgaard/persistence'
import type { ImageMediaType } from '@midgaard/contracts'
import {
  canonicalRoot, MAX_IMAGE_BYTES, openUnderRoot, sniffImageType, toolPath, ToolError,
} from '@midgaard/tools'

/** Un refus de lecture, à traduire en code HTTP par la route. */
export class FileAccessError extends Error {
  readonly status: number
  readonly code: string

  constructor(status: number, code: string, message: string) {
    super(message)
    this.name = 'FileAccessError'
    this.status = status
    this.code = code
  }
}

/**
 * La racine des fichiers d'une tâche : son worktree s'il en a un, sinon son
 * dossier de projet.
 *
 * @returns la source, ou la phrase qui dit pourquoi il n'y en a pas
 */
async function sourceOf(store: HarnessStore, task: Task): Promise<{ root: string } | { unavailable: string }> {
  const workspace = store.workspaceForTask(task.id)
  if (workspace) {
    if (workspace.status === 'removed') {
      return { unavailable: `worktree retiré ; la branche ${workspace.branch} reste dans le dépôt` }
    }
    if (!existsSync(workspace.worktree_path)) {
      return { unavailable: `le dossier du worktree a disparu (${workspace.worktree_path})` }
    }
    return { root: await canonicalRoot(workspace.worktree_path) }
  }
  if (!task.project_dir) return { unavailable: 'cette tâche ne lit aucun dossier' }
  if (!existsSync(task.project_dir)) return { unavailable: `le dossier du projet a disparu (${task.project_dir})` }
  return { root: await canonicalRoot(task.project_dir) }
}

/** Vrai si un chemin relatif (séparateur `/`) passe par `.git`, quelle que soit la casse. */
function touchesGit(rel: string): boolean {
  return rel.split('/').some((part) => part.toLowerCase() === '.git')
}

/**
 * Vérifie un chemin demandé **avant** tout accès au disque : relatif, sans
 * `..`, sans `.git`. Les deux séparateurs sont lus comme `/` : un `\` passerait
 * sinon pour un caractère du nom sous POSIX et pour un séparateur sous Windows.
 *
 * @returns le chemin normalisé, séparateur `/`
 * @throws {FileAccessError} 400 si le chemin est refusé
 */
export function checkRequestedPath(given: string): string {
  const unified = given.replaceAll('\\', '/')
  if (!unified || unified.startsWith('/') || /^[a-zA-Z]:/.test(unified)) {
    throw new FileAccessError(400, 'path_refused', 'le chemin doit être relatif à la racine de la tâche')
  }
  const parts = unified.split('/').filter((p) => p !== '' && p !== '.')
  if (parts.length === 0) throw new FileAccessError(400, 'path_refused', 'chemin vide')
  if (parts.includes('..')) throw new FileAccessError(400, 'path_refused', 'le chemin ne peut pas remonter (..)')
  const rel = parts.join('/')
  if (touchesGit(rel)) throw new FileAccessError(400, 'path_refused', 'rien ne se lit sous .git')
  return rel
}

/**
 * Lit une image de la tâche, sur le disque (Slice 7).
 *
 * @returns ses octets, son type lu dans les octets et son SHA-256 complet
 * @throws {FileAccessError} 400 pour un chemin refusé, 404 pour un fichier
 *         absent, 409 sans racine lisible, 413 au-delà de 4 Mo, 415 si ce
 *         n'est pas une image admise
 */
export async function taskImage(
  store: HarnessStore,
  task: Task,
  given: string,
): Promise<{ bytes: Buffer; mediaType: ImageMediaType; sha256: string }> {
  const rel = checkRequestedPath(given)
  const found = await sourceOf(store, task)
  if ('unavailable' in found) throw new FileAccessError(409, 'files_unavailable', found.unavailable)
  let opened: Awaited<ReturnType<typeof openUnderRoot>>
  try {
    opened = await openUnderRoot(found.root, rel)
  } catch (e) {
    if (e instanceof ToolError && /^no such path/.test(e.message)) {
      throw new FileAccessError(404, 'file_not_found', 'ce fichier n\'existe plus')
    }
    throw refusal(e)
  }
  try {
    if (touchesGit(toolPath(found.root, opened.path))) {
      throw new FileAccessError(400, 'path_refused', 'rien ne se lit sous .git')
    }
    if (opened.size > MAX_IMAGE_BYTES) {
      throw new FileAccessError(413, 'image_too_large', `image de ${opened.size} octets, plus que ${MAX_IMAGE_BYTES}`)
    }
    const buffer = Buffer.alloc(opened.size)
    const { bytesRead } = await opened.handle.read(buffer, 0, opened.size, 0)
    const bytes = buffer.subarray(0, bytesRead)
    const mediaType = sniffImageType(bytes)
    if (!mediaType) throw new FileAccessError(415, 'not_an_image', 'ni PNG, ni JPEG, ni WebP, ni GIF')
    return { bytes, mediaType, sha256: createHash('sha256').update(bytes).digest('hex') }
  } finally {
    await opened.handle.close().catch(() => {})
  }
}

/**
 * Traduit un refus des outils de chemin en refus HTTP. Le message ne dit pas
 * où mène un lien : le dashboard n'a pas à apprendre l'arborescence de la machine.
 */
function refusal(e: unknown): FileAccessError {
  if (e instanceof FileAccessError) return e
  if (e instanceof ToolError) {
    if (/escapes the allowed project root/.test(e.message)) {
      return new FileAccessError(400, 'path_refused', 'le chemin sort de la racine de la tâche')
    }
    if (/not a regular file/.test(e.message)) return new FileAccessError(400, 'not_a_file', 'ce n\'est pas un fichier')
    if (/changed while opening/.test(e.message)) {
      return new FileAccessError(409, 'path_changed', 'le fichier a changé pendant son ouverture')
    }
    return new FileAccessError(400, 'path_refused', e.message)
  }
  return new FileAccessError(500, 'read_failed', (e as Error).message)
}
