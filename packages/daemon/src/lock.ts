/**
 * @file Verrou d'instance unique : un seul daemon vivant par dossier runtime,
 * quel que soit le nombre de sessions Claude Code ouvertes.
 *
 * Le mécanisme est repris tel quel de la Slice 0, où il a été corrigé puis
 * vérifié par 40 manches de concurrence (voir `docs/SLICE0.md`). Il tient en deux
 * temps :
 *
 *  1. **Création atomique avec contenu.** Le pid est écrit dans un fichier
 *     temporaire, puis `link` vers le nom du verrou — `link` échoue si le nom
 *     existe. Un concurrent ne peut donc jamais lire un verrou vide. La première
 *     version créait le verrou puis le remplissait : un concurrent qui lisait
 *     entre les deux y trouvait un pid vide et le croyait périmé.
 *  2. **Bail vérifié chaque seconde.** Un daemon qui ne lit plus son propre pid
 *     dans le verrou a perdu une course et s'arrête. C'est ce qui rattrape la
 *     course que le point 1 ne peut pas exclure : quand plusieurs daemons
 *     récupèrent *le même* verrou périmé, l'un peut supprimer le verrou tout neuf
 *     d'un autre en le croyant périmé, et les deux se croient détenteurs.
 *
 * Conséquence assumée : deux daemons peuvent coexister **au plus une seconde**,
 * au démarrage, sans tâche en cours. À reconsidérer si le daemon devenait un
 * service distribué.
 *
 * `link` exige un système de fichiers qui gère les liens physiques : APFS, ext4
 * et NTFS oui ; FAT et exFAT non.
 */
import { linkSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { pidAlive } from '@midgaard/contracts'

/**
 * Crée le verrou de façon atomique, **contenu compris**.
 * @returns `true` si le verrou a été créé, `false` s'il existait déjà
 */
export function tryCreateLock(lockFile: string): boolean {
  mkdirSync(dirname(lockFile), { recursive: true, mode: 0o700 })
  const tmp = `${lockFile}.${process.pid}.tmp`
  writeFileSync(tmp, String(process.pid), { mode: 0o600 })
  try {
    linkSync(tmp, lockFile)
    return true
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EEXIST') return false
    throw e
  } finally {
    unlinkSync(tmp)
  }
}

/**
 * Lit le pid inscrit dans le verrou.
 * @returns le pid, ou `null` si le verrou est absent ou illisible
 */
export function readLockPid(lockFile: string): number | null {
  try {
    const pid = Number(readFileSync(lockFile, 'utf8').trim())
    return Number.isInteger(pid) && pid > 0 ? pid : null
  } catch {
    return null
  }
}

/**
 * Prend le verrou au démarrage.
 *
 * Si le verrou existe et que son détenteur est vivant, on renonce. S'il est
 * périmé (détenteur mort, typiquement après un `SIGKILL`), on le supprime et on
 * retente — la course que cela ouvre est rattrapée par le bail.
 *
 * @returns `true` si ce processus détient le verrou
 */
export function acquireLock(lockFile: string, log: (msg: string) => void = () => {}): boolean {
  for (let attempt = 0; attempt < 3; attempt++) {
    if (tryCreateLock(lockFile)) return true
    const holder = readLockPid(lockFile)
    if (holder !== null && pidAlive(holder)) return false
    log(`verrou périmé (pid ${holder}), récupération`)
    try {
      unlinkSync(lockFile)
    } catch (e) {
      // ENOENT : un concurrent l'a déjà supprimé, on retente simplement.
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e
    }
  }
  return false
}

/** Supprime le verrou, **uniquement s'il est le nôtre** : un daemon qui s'arrête
 * après avoir perdu une course ne doit pas effacer celui du gagnant. */
export function releaseLock(lockFile: string): void {
  try {
    if (readLockPid(lockFile) === process.pid) unlinkSync(lockFile)
  } catch {}
}
