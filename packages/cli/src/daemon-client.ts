/**
 * @file Accès au daemon depuis la CLI : le trouver, le démarrer s'il n'est pas
 * là, le remplacer s'il est d'une autre version.
 *
 * Le daemon survit aux commandes qui l'ont lancé. Trois situations à
 * distinguer, et une seule façon de les trancher : l'interroger.
 *
 *  - il répond avec **notre** version de protocole → on l'utilise ;
 *  - il répond avec une **autre** version (le code a été mis à jour pendant qu'il
 *    tournait) → on l'arrête et on en démarre un neuf. Sans ça, un code récent
 *    dialoguerait avec un daemon périmé : en Slice 0, c'est exactement ce qui a
 *    fait qu'une pause d'approbation n'a jamais été signalée ;
 *  - il ne répond pas → on en démarre un.
 *
 * Ce module vivait dans l'ancien paquet `mcp-server` (la façade vers Claude
 * Code, retirée) ; la CLI en était déjà l'autre appelant.
 */
import { spawn } from 'node:child_process'
import { mkdirSync, openSync } from 'node:fs'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { installation, sameInstallation, type Installation } from '@midgaard/daemon/installation'
import {
  PROTOCOL_VERSION,
  daemonFetch,
  pidAlive,
  readRuntime,
  type HarnessConfig,
  type RuntimeInfo,
} from '@midgaard/contracts'

/** Délai maximal accordé à un daemon fraîchement lancé pour devenir joignable. */
const BOOT_MS = 8_000
/** Délai maximal accordé à un daemon d'une autre version pour s'arrêter. */
const STOP_MS = 3_000
/** Délai d'un appel de diagnostic `/api/health`. */
const PROBE_MS = 1_000

/**
 * Résout le point d'entrée du daemon et les arguments de son lancement.
 *
 * `import.meta.resolve` suit les conditions d'export du processus courant : en
 * développement il rend le `.ts` de `src/`, une fois compilé le `.js` de `dist/`.
 * Le processus fils doit hériter de la même condition, sinon il résoudrait ses
 * propres imports vers l'autre variante.
 */
function daemonCommand(): { args: string[] } {
  const entry = fileURLToPath(import.meta.resolve('@midgaard/daemon/main'))
  // Les conditions personnalisées ne sont pas héritées par un process enfant :
  // on les repose explicitement quand on tourne depuis les sources.
  return { args: entry.endsWith('.ts') ? ['--conditions=midgaard-dev', entry] : [entry] }
}

/**
 * État d'un daemon interrogé :
 *  - `ok` : même protocole, même installation ;
 *  - `foreign` : même protocole, **autre installation** — un clone et le paquet
 *    npm, ou le paquet avant et après une mise à jour (voir `installation.ts`) ;
 *  - `outdated` : autre protocole, on ne peut pas lui parler ;
 *  - `down` : il ne répond pas.
 */
type Probe = 'ok' | 'foreign' | 'outdated' | 'down'

/** L'installation du daemon que cette CLI lancerait elle-même. */
const mine = installation()

/** Interroge le daemon décrit par `rt`. */
async function probe(rt: RuntimeInfo): Promise<Probe> {
  try {
    const r = await daemonFetch(rt, '/api/health', { signal: AbortSignal.timeout(PROBE_MS) })
    if (!r.ok) return 'down'
    const body = (await r.json()) as { protocol?: number; install?: Installation }
    if (body.protocol !== PROTOCOL_VERSION) return 'outdated'
    return body.install && sameInstallation(body.install, mine) ? 'ok' : 'foreign'
  } catch {
    return 'down'
  }
}

/**
 * Demande à un daemon d'une autre installation de s'arrêter **s'il est oisif**.
 *
 * C'est le daemon qui décide (`if_idle`), entre la lecture de son compteur de
 * tâches et son arrêt : une tâche lancée au même instant, du dashboard par
 * exemple, ne peut pas être interrompue par ce remplacement.
 *
 * @returns vrai s'il a accepté de s'arrêter et a disparu ; faux s'il travaille
 */
async function retireIfIdle(rt: RuntimeInfo, log: (...a: unknown[]) => void): Promise<boolean> {
  const r = await daemonFetch(rt, '/api/shutdown', {
    method: 'POST',
    body: JSON.stringify({ if_idle: true }),
    signal: AbortSignal.timeout(PROBE_MS),
  }).catch(() => null)
  if (!r || r.status !== 200) {
    log(`daemon d'une autre installation (pid ${rt.pid}) en plein travail : utilisé tel quel, remplacé quand il sera oisif`)
    return false
  }
  log(`daemon d'une autre installation (pid ${rt.pid}), oisif : remplacement`)
  const deadline = Date.now() + STOP_MS
  while (pidAlive(rt.pid) && Date.now() < deadline) await sleep(50)
  return true
}

/**
 * Demande à un daemon d'une autre version de s'arrêter, puis attend que son
 * processus ait vraiment disparu : tant qu'il vit, il détient le verrou, et un
 * nouveau daemon renoncerait aussitôt à démarrer.
 */
async function retire(rt: RuntimeInfo, log: (...a: unknown[]) => void): Promise<void> {
  log(`daemon d'une autre version (pid ${rt.pid}), remplacement`)
  await daemonFetch(rt, '/api/shutdown', { method: 'POST', signal: AbortSignal.timeout(PROBE_MS) }).catch(() => {})
  const deadline = Date.now() + STOP_MS
  while (pidAlive(rt.pid) && Date.now() < deadline) await sleep(50)
}

/**
 * Renvoie un daemon joignable, en le démarrant si nécessaire.
 *
 * Le daemon est lancé **détaché** : il doit survivre à la commande qui le
 * démarre, puisqu'il porte les tâches et sert le dashboard. Si plusieurs
 * commandes le lancent en même temps, son verrou garantit qu'un seul survit,
 * et toutes finissent par lire le même fichier de découverte.
 *
 * @throws si aucun daemon ne répond après `BOOT_MS`
 */
export async function ensureDaemon(config: HarnessConfig, log: (...a: unknown[]) => void): Promise<RuntimeInfo> {
  const current = readRuntime(config.runtimeFile)
  const state = current ? await probe(current) : 'down'
  if (state === 'ok') return current!
  // Même protocole : on peut lui parler. On ne le remplace que s'il n'a rien en
  // cours — sinon une mise à jour, ou une commande lancée depuis un autre
  // clone, interromprait le travail en cours.
  if (state === 'foreign' && !(await retireIfIdle(current!, log))) return current!
  if (state === 'outdated') await retire(current!, log)

  log('daemon absent, démarrage')
  mkdirSync(config.home, { recursive: true, mode: 0o700 })
  const out = openSync(config.logFile, 'a', 0o600)
  const { args } = daemonCommand()
  // stdin ignoré, sorties vers le journal : la CLI garde sa propre sortie.
  // Le dossier runtime voyage explicitement : désigné par `--home`, la CLI ne
  // l'a pas dans son environnement, et le daemon lancé retombait sur
  // `~/.midgaard` — il y trouvait le verrou d'un autre daemon et sortait, son
  // journal écrit ici, dans le dossier demandé. Constaté en vérifiant à la main
  // la leçon n° 33 de la Slice 4. Seulement s'il est désigné : posé toujours,
  // il rendrait `homeIsExplicit` vrai dans le daemon, et chaque conseil
  // redirait `--home` pour le dossier par défaut.
  const env = config.homeIsExplicit ? { ...process.env, MIDGAARD_HOME: config.home } : process.env
  // `windowsHide` : lancé par l'application desktop, qui n'a pas de console,
  // un fils détaché en ouvrirait une sous Windows.
  spawn(process.execPath, args, { detached: true, stdio: ['ignore', out, out], env, windowsHide: true }).unref()

  const deadline = Date.now() + BOOT_MS
  while (Date.now() < deadline) {
    await sleep(100)
    const rt = readRuntime(config.runtimeFile)
    // `rt.pid !== current?.pid` : ignorer un fichier de découverte périmé laissé
    // par le daemon qu'on vient de remplacer.
    // `ok` seulement : c'est notre daemon qu'on attend, pas un autre qui aurait
    // gagné le verrou entre-temps — auquel cas on le reprendrait au prochain appel.
    if (rt && rt.pid !== current?.pid && (await probe(rt)) === 'ok') return rt
  }
  throw new Error(`le daemon n'a pas démarré en ${BOOT_MS} ms (voir ${config.logFile})`)
}
