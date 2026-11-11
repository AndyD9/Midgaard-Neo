/**
 * @file Fichier de découverte du daemon : comment le trouver, et comment savoir
 * s'il est encore là.
 *
 * Le fichier contient le port, le jeton d'accès et le pid. Il est écrit en `0600`
 * dans un dossier en `0700` : quiconque peut le lire peut piloter le daemon.
 */
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { runtimeInfoSchema, type RuntimeInfo } from './protocol.ts'

/**
 * Lit le fichier de découverte et le valide.
 *
 * @param runtimeFile chemin du fichier (`config.runtimeFile`)
 * @returns les informations du daemon, ou `null` si le fichier est absent,
 *          illisible ou malformé. Un résultat non nul **ne garantit pas** que le
 *          daemon tourne encore : le fichier survit à un `SIGKILL`. Toujours
 *          confirmer par un appel `/api/health`.
 */
export function readRuntime(runtimeFile: string): RuntimeInfo | null {
  try {
    const parsed = runtimeInfoSchema.safeParse(JSON.parse(readFileSync(runtimeFile, 'utf8')))
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}

/**
 * Écrit le fichier de découverte de façon atomique : fichier temporaire puis
 * `rename`, pour qu'un lecteur simultané ne voie jamais un JSON à moitié écrit.
 */
export function writeRuntime(runtimeFile: string, info: RuntimeInfo): void {
  mkdirSync(dirname(runtimeFile), { recursive: true, mode: 0o700 })
  const tmp = `${runtimeFile}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(info, null, 2), { mode: 0o600 })
  renameSync(tmp, runtimeFile)
}

/** Supprime le fichier de découverte, en ignorant son absence. */
export function removeRuntime(runtimeFile: string): void {
  try {
    unlinkSync(runtimeFile)
  } catch {}
}

/**
 * Indique si un processus existe, sans lui envoyer de vrai signal (signal 0).
 * Sert à distinguer un verrou détenu d'un verrou périmé laissé par un daemon tué.
 */
export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    // EPERM : le processus existe mais appartient à un autre utilisateur.
    return (e as NodeJS.ErrnoException).code === 'EPERM'
  }
}
