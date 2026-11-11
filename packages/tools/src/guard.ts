/**
 * @file Garde des commandes d'`exec` : elles meurent avec le daemon, même tué net.
 *
 * `exec` lance chaque commande dans son propre groupe de processus et le tue à
 * la fin, au délai et à l'annulation. Mais ces trois moments supposent que le
 * daemon vit encore. Tué par `SIGKILL` — un plantage, un `kill -9`, une
 * machine qui manque de mémoire —, il ne tue plus rien, et le groupe, détaché
 * de lui, continue : constaté (docs/SLICE4.md, étape 4), une commande a écrit
 * dans le worktree trois secondes après la mort du daemon, sans que personne
 * ne puisse le voir. Le redémarrage marque la tâche `interrupted` ; la commande,
 * elle, ignorait qu'elle l'était.
 *
 * ## Le moyen
 *
 * Un seul processus de garde par daemon, lancé à la première commande, dans
 * son propre groupe — un signal envoyé au groupe du daemon ne l'emporte pas.
 * Le daemon lui écrit sur un tube `+<pid>` à chaque commande lancée, `-<pid>` à
 * chaque commande finie. Quand le daemon meurt, **le système ferme le tube**,
 * quelle que soit la manière : la garde lit la fin du flux et tue chaque groupe
 * encore inscrit (`SIGTERM`, puis `SIGKILL` après un délai de grâce).
 *
 * Pourquoi pas les alternatives :
 *  - `prctl(PR_SET_PDEATHSIG)` n'existe que sous Linux, et Node ne l'expose pas ;
 *  - retrouver les groupes au redémarrage suppose de persister des pid, qu'un
 *    redémarrage de la machine rend à d'autres processus : on tuerait au hasard ;
 *  - un superviseur par commande coûterait un processus Node à chaque `exec`.
 *
 * ## Ce qu'elle ne couvre pas
 *
 * Si la garde ne peut pas démarrer, `exec` fonctionne comme avant, et le
 * journal du daemon le dit une fois. Si la garde elle-même est tuée, les
 * commandes restent tuées à leur fin, à leur délai et à l'annulation — seul le
 * cas du daemon tué net redevient ouvert. Sous Windows, elle passe par
 * `taskkill /T`, avec la limite annoncée dans le README de ce paquet.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import type { Socket } from 'node:net'

/** Délai entre `SIGTERM` et `SIGKILL`, côté garde : le même qu'`exec`. */
const GUARD_GRACE_MS = 2_000

/**
 * Le programme de la garde, passé à `node -e` : aucun fichier à résoudre,
 * qu'on tourne depuis les sources ou depuis `dist/`. Volontairement minimal —
 * il tourne sans que personne le surveille.
 */
const GUARD_SCRIPT = `
const { execFileSync } = require('node:child_process')
const live = new Set()
let pending = ''
const kill = (pid, signal) => {
  try {
    if (process.platform === 'win32') {
      execFileSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
    } else {
      process.kill(-pid, signal)
    }
  } catch {}
}
let reaping = false
const reap = () => {
  if (reaping) return
  reaping = true
  if (live.size === 0) process.exit(0)
  for (const pid of live) kill(pid, 'SIGTERM')
  setTimeout(() => {
    for (const pid of live) kill(pid, 'SIGKILL')
    process.exit(0)
  }, ${GUARD_GRACE_MS})
}
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  pending += chunk
  let i
  while ((i = pending.indexOf('\\n')) >= 0) {
    const line = pending.slice(0, i)
    pending = pending.slice(i + 1)
    const pid = Number(line.slice(1))
    if (!Number.isInteger(pid) || pid <= 0) continue
    if (line[0] === '+') live.add(pid)
    else if (line[0] === '-') live.delete(pid)
  }
})
process.stdin.on('end', reap)
process.stdin.on('error', reap)
`

let guard: ChildProcess | null = null
let warned = false

/**
 * Lance la garde si elle ne tourne pas.
 *
 * Elle ne retient pas le processus qui l'a lancée (`unref`, tube compris) : le
 * daemon doit pouvoir s'arrêter sur inactivité, et un test se terminer.
 *
 * @param log journalisation, pour dire une fois que la garde manque
 */
function ensureGuard(log: (message: string) => void): ChildProcess | null {
  if (guard && guard.exitCode === null && guard.signalCode === null && guard.stdin?.writable) return guard
  try {
    const started = spawn(process.execPath, ['-e', GUARD_SCRIPT], {
      stdio: ['pipe', 'ignore', 'ignore'],
      // Son propre groupe : un signal adressé au groupe du daemon ne la tue pas.
      detached: true,
      windowsHide: true,
      // Rien de l'environnement du daemon, et ses clés d'API encore moins.
      env: {
        PATH: process.env.PATH ?? '',
        ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
      },
    })
    started.on('error', () => {
      if (guard === started) guard = null
    })
    started.on('exit', () => {
      if (guard === started) guard = null
    })
    // Un tube rompu (garde morte) ne doit pas faire tomber le daemon.
    started.stdin!.on('error', () => {})
    started.unref()
    ;(started.stdin as Socket).unref()
    guard = started
    return guard
  } catch (e) {
    if (!warned) {
      warned = true
      log(`garde des commandes indisponible (${(e as Error).message}) : un daemon tué net laisserait ses commandes tourner`)
    }
    return null
  }
}

/**
 * Lance la garde **avant** la commande qu'elle surveillera.
 *
 * Lancée après, à la première commande d'un daemon, la garde démarrait
 * **entre** le lancement de la commande et son inscription, et allongeait
 * d'autant l'intervalle où un daemon tué net abandonne une commande que
 * personne ne connaît. Armée d'abord, il ne reste entre les deux que la fin de
 * `spawn` et une écriture sur un tube déjà ouvert.
 *
 * **Cet intervalle ne se ferme pas ici.** Instrumentée sous forte charge
 * (Slice 4, étape 7), la garde d'un cas perdu a démarré orpheline et n'a rien
 * reçu : le lanceur avait été suspendu par l'ordonnanceur entre `spawn` et
 * l'inscription, plus longtemps qu'il n'en faut à la commande pour démarrer,
 * puis tué. Une à deux fois sur 300 avec vingt processus de charge sur dix
 * cœurs ; aucune sur 48 sans charge. Le fermer exigerait que la commande attende
 * d'être inscrite avant de s'exécuter.
 *
 * @param log journalisation, pour dire une fois que la garde manque
 */
export function armGuard(log: (message: string) => void = () => {}): void {
  ensureGuard(log)
}

/**
 * Confie un groupe de processus à la garde, pour qu'il meure avec le daemon.
 * La garde doit avoir été armée avant le lancement ({@link armGuard}).
 *
 * @param pid pid du chef de groupe (POSIX) ou du processus (Windows)
 * @param log journalisation, pour dire une fois que la garde manque
 * @returns de quoi retirer le groupe de la garde, une fois la commande finie et
 *          son groupe tué — sans quoi la garde tuerait plus tard un groupe dont
 *          le numéro aurait été réattribué
 */
export function guardGroup(pid: number, log: (message: string) => void = () => {}): () => void {
  const g = ensureGuard(log)
  if (!g) return () => {}
  g.stdin!.write(`+${pid}\n`)
  let released = false
  return () => {
    if (released) return
    released = true
    if (g.stdin?.writable) g.stdin.write(`-${pid}\n`)
  }
}
