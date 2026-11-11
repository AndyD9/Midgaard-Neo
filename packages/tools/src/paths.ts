/**
 * @file Résolution de chemins : rester sous la racine, même face à un lien
 * symbolique posé entre la vérification et l'ouverture.
 *
 * ## Le piège que ce module existe pour fermer
 *
 * La vérification naïve — résoudre le chemin, comparer à la racine, puis
 * ouvrir — laisse une fenêtre : entre la comparaison et l'ouverture, le chemin
 * peut changer de cible. C'est le TOCTOU classique (*time of check to time of
 * use*), et le plan (§5) l'adresse explicitement : « `fs.realpath`
 * systématique, puis vérification que le chemin résolu est sous la racine
 * autorisée — **à l'ouverture du descripteur, pas seulement avant** ».
 *
 * {@link openUnderRoot} ferme la fenêtre : il résout, vérifie, ouvre, puis
 * **revérifie que le descripteur ouvert désigne bien le fichier vérifié**, en
 * comparant `dev` et `ino` du `fstat` à ceux du `stat` d'avant. Si quelqu'un a
 * substitué la cible entre-temps, l'identité ne correspond plus et l'ouverture
 * est refusée.
 *
 * Ce que ce module ne prétend **pas** être : une sandbox. Le daemon tourne sous
 * le compte de l'utilisateur ; un agent compromis qui contournerait ce module
 * lirait tout ce que l'utilisateur peut lire. C'est une frontière d'intention,
 * annoncée comme telle.
 */
import { open, realpath, stat } from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import { ToolError } from './types.ts'

/**
 * Chemin relatif à la racine, séparateur `/` quelle que soit la plateforme :
 * c'est la forme que le modèle lit, et qu'il repasse aux outils. Sous Windows,
 * `relative` rend `src\\a.ts` ; un même dépôt aurait alors deux écritures selon
 * la machine, et un modèle qui a vu `src/a.ts` ailleurs s'y perdrait. Constaté
 * en CI (docs/SLICE4.md, étape 5) : `search_files` rendait des `\\`.
 *
 * @returns `.` pour la racine elle-même
 */
export function toolPath(root: string, path: string): string {
  return relative(root, path).split(sep).join('/') || '.'
}

/**
 * Indique si `candidate` est la racine ou se trouve dessous.
 *
 * Compare des chemins **déjà canonicalisés**. Le test porte sur le chemin
 * relatif plutôt que sur un préfixe de chaîne : `/a/b` n'est pas sous `/a/bc`,
 * alors qu'une comparaison de préfixe le croirait.
 */
export function isUnder(root: string, candidate: string): boolean {
  if (candidate === root) return true
  const rel = relative(root, candidate)
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel) && !rel.split(sep).includes('..')
}

/**
 * Canonicalise un chemin donné par un agent et vérifie qu'il reste sous la racine.
 *
 * @param root     racine autorisée, **déjà canonicalisée** par {@link canonicalRoot}
 * @param given    chemin tel que le modèle l'a écrit, absolu ou relatif à la racine
 * @returns le chemin réel
 * @throws {ToolError} si le chemin sort de la racine, ou n'existe pas
 */
export async function resolveUnderRoot(root: string, given: string): Promise<string> {
  const joined = isAbsolute(given) ? given : resolve(root, given)
  let real: string
  try {
    real = await realpath(joined)
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code
    if (code === 'ENOENT') throw new ToolError(`no such path: ${given}`)
    if (code === 'EACCES') throw new ToolError(`permission denied: ${given}`)
    throw new ToolError(`cannot resolve ${given}: ${(e as Error).message}`)
  }
  if (!isUnder(root, real)) {
    // Le message ne révèle pas où mène le lien : un agent manipulé par un
    // contenu web n'a pas à apprendre l'arborescence de la machine.
    throw new ToolError(`path escapes the allowed project root: ${given}`)
  }
  return real
}

/**
 * Ouvre un fichier sous la racine, en vérifiant l'identité du descripteur.
 *
 * L'appelant **doit** fermer le descripteur rendu.
 *
 * @throws {ToolError} si le chemin sort de la racine, n'est pas un fichier
 *         ordinaire, ou si la cible a changé entre la vérification et l'ouverture
 */
export async function openUnderRoot(root: string, given: string): Promise<{ handle: FileHandle; path: string; size: number }> {
  const real = await resolveUnderRoot(root, given)
  const before = await stat(real)
  if (!before.isFile()) throw new ToolError(`not a regular file: ${given}`)

  const handle = await open(real, 'r')
  try {
    const after = await handle.stat()
    // L'identité d'un fichier, ce sont son périphérique et son inœud — pas son
    // chemin, qui peut désigner autre chose une milliseconde plus tard.
    if (after.ino !== before.ino || after.dev !== before.dev) {
      throw new ToolError(`path changed while opening it: ${given}`)
    }
    if (!after.isFile()) throw new ToolError(`not a regular file: ${given}`)
    return { handle, path: real, size: after.size }
  } catch (e) {
    await handle.close().catch(() => {})
    throw e
  }
}

/**
 * Canonicalise la racine d'un projet, une fois, au démarrage de la tâche.
 *
 * @throws {ToolError} si le dossier n'existe pas ou n'est pas un dossier
 */
export async function canonicalRoot(dir: string): Promise<string> {
  let real: string
  try {
    real = await realpath(dir)
  } catch {
    throw new ToolError(`project root does not exist: ${dir}`)
  }
  if (!(await stat(real)).isDirectory()) throw new ToolError(`project root is not a directory: ${dir}`)
  return real
}
